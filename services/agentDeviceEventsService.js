const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeText } = require('./agentAuth');
const { COMMAND_TYPES } = require('../contracts/agentBridgeContract');
const { buildDedupKey } = require('../contracts/agentDeviceEventsContract');
const { resolvePersonIdForIdentifier } = require('./identityResolver');
const { shouldRequireIdentityMappingForProvider } = require('./identityMappingPolicy');
const { invalidateAttendanceCache } = require('./cacheInvalidation');
const { logBridgeEvent } = require('./bridgeLogger');
const {
  reconcileAgentCommandLifecycle,
  getActiveManagingAgentBinding
} = require('./agentBridgeDb');
const { evaluateCommandIssuanceGate } = require('./executionGating');
const {
  ensureCapabilityReportingSchemaReady,
  upsertDeviceRuntimeReportedState,
  upsertDeviceRuntimeCapabilityReportedState
} = require('./reportedStateDb');
const {
  MANAGEABILITY_STATUS,
  mapPullOutcomeToManageability
} = require('./deviceManageability');
const {
  CAPABILITY_STATUS,
  DEVICE_PATH_CAPABILITY_KEYS
} = require('../contracts/capabilityContract');
const {
  deriveAndUpsertDirectionAttachmentForFactEvent
} = require('./historicalDirectionWorkerService');

const PULL_COMMAND_INFLIGHT_ERROR = 'command_already_in_flight';

const PULL_CAPABILITY_UNSUPPORTED_REASONS = new Set([
  'runtime_capability_unsupported',
  'device_path_capability_unsupported',
  'command_unsupported',
  'unsupported_vendor',
  'protocol_variant_mismatch'
]);

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value) {
  if (!value) {
    return {};
  }
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed : {};
    } catch (err) {
      return {};
    }
  }
  return {};
}

function parseJsonArray(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }
  return [];
}

function parseRtTimeContract(sourceMetadata) {
  const metadata = parseJson(sourceMetadata);
  return {
    version: normalizeText(metadata.rt_time_contract_version),
    observedTrust: normalizeText(metadata.rt_time_observed_trust),
    observedBasis: normalizeText(metadata.rt_time_observed_basis)
  };
}

function scrubOptionsForTrace(options) {
  const source = isPlainObject(options) ? { ...options } : {};
  if ('auth_password' in source) {
    source.auth_password = '[REDACTED]';
  }
  return source;
}

function parseLimit(value, fallback = 50, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function parseOffset(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function shouldPersistUnsupportedPullCapability(reasonCode) {
  const normalized = normalizeText(reasonCode).toLowerCase();
  if (!normalized) {
    return false;
  }
  return PULL_CAPABILITY_UNSUPPORTED_REASONS.has(normalized);
}

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseBoundedInt(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

function normalizeIsoUtc(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function normalizeDedupKey(value) {
  const raw = normalizeText(value).toLowerCase();
  return raw || null;
}

function parseHistoryDrainState(value) {
  const raw = parseJson(value);
  return {
    session_id: normalizeText(raw.session_id) || null,
    status: normalizeText(raw.status) || null,
    boundary_before_utc_exclusive: normalizeIsoUtc(raw.boundary_before_utc_exclusive),
    boundary_before_dedup_key_exclusive: normalizeDedupKey(raw.boundary_before_dedup_key_exclusive),
    last_page_fingerprint: normalizeText(raw.last_page_fingerprint) || null,
    no_progress_pages: parseBoundedInt(raw.no_progress_pages, { min: 0, max: 100000, fallback: 0 }),
    sent_timeout_retries: parseBoundedInt(raw.sent_timeout_retries, { min: 0, max: 100000, fallback: 0 }),
    last_command_id: normalizeText(raw.last_command_id) || null,
    last_batch_id: normalizeText(raw.last_batch_id) || null,
    stop_reason: normalizeText(raw.stop_reason) || null,
    updated_at: normalizeIsoUtc(raw.updated_at)
  };
}

function buildHistoryDrainPageFingerprint(events) {
  const source = Array.isArray(events) ? events : [];
  const tuples = source
    .map(event => {
      const utc = normalizeIsoUtc(event && event.event_time_utc);
      const dedupKey = normalizeDedupKey(event && event.dedup_key);
      if (!utc || !dedupKey) {
        return null;
      }
      return `${utc}|${dedupKey}`;
    })
    .filter(Boolean)
    .sort();
  if (tuples.length === 0) {
    return null;
  }
  return crypto.createHash('sha256').update(tuples.join('\n')).digest('hex');
}

function resolveOldestHistoryBoundaryTuple(events) {
  const source = Array.isArray(events) ? events : [];
  let oldest = null;
  for (const event of source) {
    const utc = normalizeIsoUtc(event && event.event_time_utc);
    const dedupKey = normalizeDedupKey(event && event.dedup_key);
    if (!utc || !dedupKey) {
      continue;
    }
    const utcMs = new Date(utc).getTime();
    if (!Number.isFinite(utcMs)) {
      continue;
    }
    if (!oldest) {
      oldest = {
        utc,
        utc_ms: utcMs,
        dedup_key: dedupKey
      };
      continue;
    }
    if (utcMs < oldest.utc_ms) {
      oldest = {
        utc,
        utc_ms: utcMs,
        dedup_key: dedupKey
      };
      continue;
    }
    if (utcMs === oldest.utc_ms && dedupKey < oldest.dedup_key) {
      oldest = {
        utc,
        utc_ms: utcMs,
        dedup_key: dedupKey
      };
    }
  }
  if (!oldest) {
    return null;
  }
  return {
    boundary_before_utc_exclusive: oldest.utc,
    boundary_before_dedup_key_exclusive: oldest.dedup_key
  };
}

function isSameHistoryBoundaryTuple(left, right) {
  const leftUtc = normalizeIsoUtc(left && left.boundary_before_utc_exclusive);
  const rightUtc = normalizeIsoUtc(right && right.boundary_before_utc_exclusive);
  const leftDedup = normalizeDedupKey(left && left.boundary_before_dedup_key_exclusive);
  const rightDedup = normalizeDedupKey(right && right.boundary_before_dedup_key_exclusive);
  return leftUtc === rightUtc && leftDedup === rightDedup;
}

function envFlagEnabled(name, fallback = false) {
  const raw = normalizeText(process.env[name]).toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parseAllowlist(value) {
  return String(value || '')
    .split(',')
    .map(item => normalizeText(item))
    .filter(Boolean);
}

function resolveK80Rt01f4RealtimePolicy(deviceUid) {
  const flagEnabled = envFlagEnabled('K80_RT_01F4_INGEST_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const windowRaw = Number.parseInt(normalizeText(process.env.K80_RT_01F4_RECONCILE_WINDOW_MS), 10);
  const reconcileWindowMs = Number.isInteger(windowRaw) && windowRaw > 0
    ? Math.min(windowRaw, 60000)
    : 2000;
  return {
    enabled: flagEnabled && scopeAllowed,
    flag_enabled: flagEnabled,
    allowlist_size: allowlist.length,
    scope_allowed: scopeAllowed,
    reconcile_window_ms: reconcileWindowMs
  };
}

function resolveK80RequestedSinceSourceFixPolicy({ deviceUid, vendor, attlogSequence }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === 'zktime_k80';
  const flagEnabled = envFlagEnabled('K80_REQUESTED_SINCE_SOURCE_FIX_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_REQUESTED_SINCE_SOURCE_FIX_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const backfillRaw = Number.parseInt(normalizeText(process.env.K80_REQUESTED_SINCE_SOURCE_FIX_BACKFILL_MINUTES), 10);
  const backfillMinutes = Number.isInteger(backfillRaw) && backfillRaw > 0
    ? Math.min(backfillRaw, 10080)
    : 1440;
  return {
    enabled: vendorOk && sequenceOk && flagEnabled && scopeAllowed,
    backfill_minutes: backfillMinutes
  };
}

function resolveK80CursorSourceFixPolicy({ deviceUid, vendor, protocolDiagnostics }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const parityReached = isPlainObject(protocolDiagnostics)
    && protocolDiagnostics.zktime_dynamic_05e0_payload_app_parity_family_reached === true;
  const flagEnabled = envFlagEnabled('K80_CURSOR_SOURCE_FIX_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_CURSOR_SOURCE_FIX_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: vendorOk && parityReached && flagEnabled && scopeAllowed
  };
}

function resolveK80QueueTimeCursorBypassPolicy({ deviceUid, vendor, attlogSequence }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === 'zktime_k80';
  const flagEnabled = envFlagEnabled('K80_QUEUE_TIME_CURSOR_BYPASS_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_QUEUE_TIME_CURSOR_BYPASS_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const backfillRaw = Number.parseInt(normalizeText(process.env.K80_QUEUE_TIME_CURSOR_BYPASS_BACKFILL_MINUTES), 10);
  const backfillMinutes = Number.isInteger(backfillRaw) && backfillRaw > 0
    ? Math.min(backfillRaw, 20160)
    : 10080;
  return {
    enabled: vendorOk && sequenceOk && flagEnabled && scopeAllowed,
    backfill_minutes: backfillMinutes
  };
}

function resolveK80QueueBypassStateSnapshotPolicy({ deviceUid, vendor, attlogSequence }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === 'zktime_k80';
  const flagEnabled = envFlagEnabled('K80_QUEUE_BYPASS_STATE_SNAPSHOT_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_QUEUE_BYPASS_STATE_SNAPSHOT_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  // Deprecated/obsolete diagnostics control kept for compatibility until later safe removal.
  // This policy does not alter queue/ingest decisions; it only gates optional debug snapshot payload.
  return {
    enabled: vendorOk && sequenceOk && flagEnabled && scopeAllowed
  };
}

function resolveK80HistoryDrainModePolicy({ deviceUid, vendor, attlogSequence }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === 'zktime_k80';
  const flagEnabled = envFlagEnabled('K80_HISTORY_DRAIN_MODE_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_HISTORY_DRAIN_MODE_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const noProgressPagesLimit = parseBoundedInt(
    process.env.K80_HISTORY_DRAIN_NO_PROGRESS_PAGES_LIMIT,
    { min: 1, max: 20, fallback: 3 }
  );
  const duplicateReplayPagesLimit = parseBoundedInt(
    process.env.K80_HISTORY_DRAIN_DUPLICATE_REPLAY_PAGES_LIMIT,
    { min: 1, max: 20, fallback: noProgressPagesLimit }
  );
  return {
    enabled: vendorOk && sequenceOk && flagEnabled && scopeAllowed,
    no_progress_pages_limit: noProgressPagesLimit,
    duplicate_replay_pages_limit: duplicateReplayPagesLimit
  };
}

function resolveK80PostPunchFactAnchorPolicy({ deviceUid, vendor }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const flagEnabled = envFlagEnabled('K80_POST_PUNCH_PULL_GUARANTEE_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_POST_PUNCH_PULL_GUARANTEE_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const minIntervalSeconds = parseBoundedInt(
    process.env.K80_POST_PUNCH_PULL_GUARANTEE_MIN_INTERVAL_SECONDS,
    { min: 10, max: 3600, fallback: 120 }
  );
  const lookbackMinutes = parseBoundedInt(
    process.env.K80_POST_PUNCH_PULL_GUARANTEE_LOOKBACK_MINUTES,
    { min: 1, max: 1440, fallback: 30 }
  );
  const safetyWindowMinutes = parseBoundedInt(
    process.env.K80_POST_PUNCH_PULL_GUARANTEE_SAFETY_WINDOW_MINUTES,
    { min: 0, max: 120, fallback: 5 }
  );
  const maxEvents = parseBoundedInt(
    process.env.K80_POST_PUNCH_PULL_GUARANTEE_MAX_EVENTS,
    { min: 1, max: 2000, fallback: 500 }
  );
  return {
    enabled: vendorOk && flagEnabled && scopeAllowed,
    flag_enabled: flagEnabled,
    allowlist_size: allowlist.length,
    scope_allowed: scopeAllowed,
    min_interval_seconds: minIntervalSeconds,
    lookback_minutes: lookbackMinutes,
    safety_window_minutes: safetyWindowMinutes,
    max_events: maxEvents
  };
}

function defaultPullCommandTtlSeconds() {
  return parsePositiveInt(process.env.PULL_COMMAND_TTL_SECONDS) || 1800;
}

function defaultPullCommandSentStaleSeconds() {
  return parsePositiveInt(process.env.PULL_COMMAND_SENT_STALE_SECONDS) || 300;
}

function getMaxIsoUtc(values) {
  let max = null;
  for (const value of values) {
    const raw = normalizeText(value);
    if (!raw) {
      continue;
    }
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      continue;
    }
    const iso = parsed.toISOString();
    if (!max || parsed.getTime() > new Date(max).getTime()) {
      max = iso;
    }
  }
  return max;
}

function shiftIsoMinutes(iso, minutes) {
  const base = new Date(iso);
  if (Number.isNaN(base.getTime())) {
    return null;
  }
  return new Date(base.getTime() - minutes * 60 * 1000).toISOString();
}

function resolveConnectionHost(device, options) {
  const explicitHost = normalizeText(options.host);
  if (explicitHost) {
    return explicitHost;
  }
  const discoveryMeta = parseJson(device.discovery_metadata);
  if (normalizeText(discoveryMeta.ip)) {
    return normalizeText(discoveryMeta.ip);
  }
  const metadata = parseJson(device.metadata);
  if (normalizeText(metadata.ip)) {
    return normalizeText(metadata.ip);
  }
  return '';
}

function resolveConnectionPort(device, options) {
  if (Number.isInteger(options.port)) {
    return options.port;
  }
  const discoveryMeta = parseJson(device.discovery_metadata);
  if (isPlainObject(discoveryMeta.protocol) && Number.isInteger(discoveryMeta.protocol.port)) {
    return discoveryMeta.protocol.port;
  }
  const metadata = parseJson(device.metadata);
  const metadataPort = parseIntegerField(metadata.port);
  if (Number.isInteger(metadataPort) && metadataPort >= 1 && metadataPort <= 65535) {
    return metadataPort;
  }
  const metadataConnection = parseJson(metadata.connection);
  const metadataConnectionPort = parseIntegerField(metadataConnection.port);
  if (Number.isInteger(metadataConnectionPort) && metadataConnectionPort >= 1 && metadataConnectionPort <= 65535) {
    return metadataConnectionPort;
  }
  return 4370;
}

function normalizeTransport(value) {
  const raw = normalizeText(value).toLowerCase();
  if (raw === 'udp' || raw === 'tcp' || raw === 'auto') {
    return raw;
  }
  return '';
}

function resolveConnectionTransport(device, options) {
  const explicitTransport = normalizeTransport(options.transport);
  if (explicitTransport) {
    return explicitTransport;
  }

  const discoveryMeta = parseJson(device.discovery_metadata);
  const discoveryTransport = normalizeTransport(discoveryMeta.transport);
  if (discoveryTransport) {
    return discoveryTransport;
  }

  const metadata = parseJson(device.metadata);
  const metadataTransport = normalizeTransport(metadata.transport);
  if (metadataTransport) {
    return metadataTransport;
  }

  return '';
}

function parseIntegerField(value) {
  if (Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return null;
}

function resolveConnectionAuthPassword(device, options) {
  const optionPassword = parseIntegerField(options.auth_password);
  if (optionPassword !== null) {
    return optionPassword;
  }

  const discoveryMeta = parseJson(device.discovery_metadata);
  const discoveryPassword = parseIntegerField(discoveryMeta.auth_password);
  if (discoveryPassword !== null) {
    return discoveryPassword;
  }

  const metadata = parseJson(device.metadata);
  const metadataPassword = parseIntegerField(metadata.auth_password);
  if (metadataPassword !== null) {
    return metadataPassword;
  }

  return null;
}

function normalizeAttlogSequence(value) {
  const raw = normalizeText(value).toLowerCase();
  if (raw === 'off' || raw === 'deviceid_platform' || raw === 'deviceid_platform_version' || raw === 'zktime_k80') {
    return raw;
  }
  return '';
}

function resolveConnectionAttlogSequence(device, options) {
  const explicitSequence = normalizeAttlogSequence(options.attlog_sequence);
  if (explicitSequence) {
    return explicitSequence;
  }

  const discoveryMeta = parseJson(device.discovery_metadata);
  const discoverySequence = normalizeAttlogSequence(discoveryMeta.attlog_sequence);
  if (discoverySequence) {
    return discoverySequence;
  }

  const metadata = parseJson(device.metadata);
  const metadataSequence = normalizeAttlogSequence(metadata.attlog_sequence);
  if (metadataSequence) {
    return metadataSequence;
  }

  return '';
}

function resolveConnectionDeviceNumber(device, options) {
  const explicitDeviceNumber = parseIntegerField(options.device_number);
  if (explicitDeviceNumber !== null) {
    return explicitDeviceNumber;
  }

  const discoveryMeta = parseJson(device.discovery_metadata);
  const discoveryDeviceNumber = parseIntegerField(discoveryMeta.device_number);
  if (discoveryDeviceNumber !== null) {
    return discoveryDeviceNumber;
  }

  const metadata = parseJson(device.metadata);
  const metadataDeviceNumber = parseIntegerField(metadata.device_number);
  if (metadataDeviceNumber !== null) {
    return metadataDeviceNumber;
  }

  return null;
}

async function resolveCompanyTimezone(db, companyId) {
  try {
    const res = await db.query(
      `
      SELECT company_timezone
      FROM company_config
      WHERE company_id = $1
      LIMIT 1
      `,
      [companyId]
    );
    const value = res.rows[0] && res.rows[0].company_timezone
      ? String(res.rows[0].company_timezone).trim()
      : '';
    return value || 'Africa/Tunis';
  } catch (err) {
    return 'Africa/Tunis';
  }
}

async function updateDeviceManageabilityFromPull(db, {
  companyId,
  deviceUid,
  transition,
  proofAtUtc
}) {
  if (!transition || !transition.status) {
    return;
  }

  await db.query(
    `
    UPDATE devices
    SET manageability_status = CASE
          WHEN devices.manageability_status = $7 AND $1 = $8 THEN devices.manageability_status
          ELSE $1
        END,
        manageability_reason = CASE
          WHEN devices.manageability_status = $7 AND $1 = $8 THEN devices.manageability_reason
          ELSE $2
        END,
        manageability_updated_at = now(),
        manageability_last_proven_at = CASE
          WHEN $3::boolean THEN GREATEST(COALESCE(manageability_last_proven_at, 'epoch'::timestamptz), COALESCE($4::timestamptz, now()))
          ELSE manageability_last_proven_at
        END,
        updated_at = now()
    WHERE company_id = $5
      AND device_uid = $6
    `,
    [
      transition.status,
      transition.reason,
      transition.proven === true,
      proofAtUtc || null,
      companyId,
      deviceUid,
      MANAGEABILITY_STATUS.INGESTING,
      MANAGEABILITY_STATUS.MANAGEABLE
    ]
  );
}

async function resolveCanonicalDeviceUid(db, { companyId, deviceUid }) {
  const requestedDeviceUid = normalizeText(deviceUid);
  if (!requestedDeviceUid) {
    return {
      requested_device_uid: '',
      canonical_device_uid: '',
      resolved_by: 'unresolved',
      alias_kind: null,
      alias_status: null
    };
  }

  const directRes = await db.query(
    `
    SELECT device_uid, identity_status, superseded_by_device_uid
    FROM devices
    WHERE company_id = $1
      AND device_uid = $2
    LIMIT 1
    `,
    [companyId, requestedDeviceUid]
  );
  const directRow = directRes.rows[0] || null;
  if (directRow && normalizeText(directRow.device_uid)) {
    const identityStatus = normalizeText(directRow.identity_status).toLowerCase();
    const supersededByDeviceUid = normalizeText(directRow.superseded_by_device_uid);
    if (identityStatus === 'superseded') {
      if (supersededByDeviceUid) {
        return {
          requested_device_uid: requestedDeviceUid,
          canonical_device_uid: supersededByDeviceUid,
          resolved_by: 'superseded_redirect',
          alias_kind: 'device_uid',
          alias_status: 'superseded'
        };
      }
      return {
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: requestedDeviceUid,
        resolved_by: 'superseded_without_canonical',
        alias_kind: 'device_uid',
        alias_status: 'superseded'
      };
    }
    return {
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: normalizeText(directRow.device_uid),
      resolved_by: 'direct',
      alias_kind: null,
      alias_status: null
    };
  }

  const aliasRes = await db.query(
    `
    SELECT
      a.canonical_device_uid,
      a.alias_kind,
      a.status
    FROM device_identity_aliases a
    WHERE a.company_id = $1
      AND lower(a.alias_value_normalized) = lower($2)
      AND a.status IN ('active', 'superseded')
    ORDER BY
      CASE a.status
        WHEN 'active' THEN 0
        WHEN 'superseded' THEN 1
        ELSE 2
      END,
      CASE a.alias_kind
        WHEN 'device_uid' THEN 0
        WHEN 'serial_number' THEN 1
        WHEN 'mac' THEN 2
        WHEN 'ip' THEN 3
        WHEN 'legacy' THEN 4
        WHEN 'manual' THEN 5
        ELSE 6
      END,
      a.updated_at DESC,
      a.created_at DESC,
      a.id DESC
    LIMIT 1
    `,
    [companyId, requestedDeviceUid]
  );
  const aliasRow = aliasRes.rows[0] || null;
  if (!aliasRow || !normalizeText(aliasRow.canonical_device_uid)) {
    return {
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: requestedDeviceUid,
      resolved_by: 'unresolved',
      alias_kind: null,
      alias_status: null
    };
  }

  return {
    requested_device_uid: requestedDeviceUid,
    canonical_device_uid: normalizeText(aliasRow.canonical_device_uid),
    resolved_by: 'alias',
    alias_kind: normalizeText(aliasRow.alias_kind) || null,
    alias_status: normalizeText(aliasRow.status).toLowerCase() || null
  };
}

async function getManagedDevice(db, { companyId, deviceUid }) {
  const res = await db.query(
    `
    SELECT
      company_id,
      device_uid,
      site_id,
      provider,
      managed_status,
      active,
      metadata,
      discovery_metadata
    FROM devices
    WHERE company_id = $1
      AND device_uid = $2
    LIMIT 1
    `,
    [companyId, deviceUid]
  );
  return res.rows[0] || null;
}

async function ensureAgentDeviceSyncState(db, {
  companyId,
  agentId,
  deviceUid,
  vendor,
  safetyWindowSeconds
}) {
  const res = await db.query(
    `
    INSERT INTO agent_device_sync_states (
      company_id, agent_id, device_uid, vendor, sync_mode, status, safety_window_seconds, metadata
    )
    VALUES ($1, $2, $3, $4, 'pull', 'idle', $5, '{}'::jsonb)
    ON CONFLICT (company_id, agent_id, device_uid) DO UPDATE
      SET vendor = EXCLUDED.vendor,
          safety_window_seconds = EXCLUDED.safety_window_seconds,
          updated_at = now()
    RETURNING *
    `,
    [companyId, agentId, deviceUid, vendor, safetyWindowSeconds]
  );
  return res.rows[0];
}

async function queuePullDeviceEventsCommand(db, {
  companyId,
  agentId,
  deviceUid,
  options,
  createdByKeyId,
  traceToken
}) {
  const safeOptions = isPlainObject(options) ? options : {};
  await db.query('BEGIN');
  try {
    const agentRes = await db.query(
      `
      SELECT id, company_id, agent_name, status, site_id
      FROM agent_nodes
      WHERE id = $1 AND company_id = $2
      LIMIT 1
      `,
      [agentId, companyId]
    );
    const agent = agentRes.rows[0];
    if (!agent) {
      await db.query('ROLLBACK');
      return { error: 'agent_not_found' };
    }
    if (agent.status !== 'active') {
      await db.query('ROLLBACK');
      return { error: 'agent_not_active' };
    }

    const canonicalResolution = await resolveCanonicalDeviceUid(db, { companyId, deviceUid });
    if (canonicalResolution.resolved_by === 'superseded_without_canonical') {
      await db.query('ROLLBACK');
      return {
        error: 'device_uid_superseded_without_canonical',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalResolution.canonical_device_uid,
          canonical_resolved_by: canonicalResolution.resolved_by
        }
      };
    }
    const canonicalDeviceUid = canonicalResolution.canonical_device_uid;
    const device = await getManagedDevice(db, { companyId, deviceUid: canonicalDeviceUid });
    if (!device) {
      await db.query('ROLLBACK');
      return { error: 'device_not_found' };
    }
    if (String(device.managed_status || '').toLowerCase() !== 'managed') {
      await db.query('ROLLBACK');
      return { error: 'device_not_managed' };
    }
    const provider = String(device.provider || '').toLowerCase();
    if (provider && provider !== 'zkteco') {
      await db.query('ROLLBACK');
      return { error: 'unsupported_vendor' };
    }
    const activeBinding = await getActiveManagingAgentBinding(db, {
      companyId,
      deviceUid: canonicalDeviceUid
    });
    if (!activeBinding) {
      await db.query('ROLLBACK');
      return {
        error: 'device_managing_agent_binding_missing',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by,
          canonical_alias_kind: canonicalResolution.alias_kind,
          canonical_alias_status: canonicalResolution.alias_status
        }
      };
    }
    if (String(activeBinding.agent_id) !== String(agentId)) {
      await db.query('ROLLBACK');
      return {
        error: 'device_managing_agent_binding_conflict',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          requested_agent_id: agentId,
          bound_agent_id: activeBinding.agent_id
        }
      };
    }
    const executionGate = await evaluateCommandIssuanceGate(db, {
      companyId,
      targetAgentId: agentId,
      commandType: COMMAND_TYPES.PULL_DEVICE_EVENTS,
      deviceUid: canonicalDeviceUid,
      deviceSiteId: device.site_id || null,
      agentSiteId: agent.site_id || null,
      bindingAgentId: activeBinding.agent_id || null
    });
    if (!executionGate.allowed) {
      await db.query('ROLLBACK');
      return {
        error: executionGate.reason_code,
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by,
          canonical_alias_kind: canonicalResolution.alias_kind,
          canonical_alias_status: canonicalResolution.alias_status,
          execution_gate: executionGate.details
        }
      };
    }

    const lookbackMinutes = Number.isInteger(safeOptions.lookback_minutes)
      ? safeOptions.lookback_minutes
      : 1440;
    const safetyWindowMinutes = Number.isInteger(safeOptions.safety_window_minutes)
      ? safeOptions.safety_window_minutes
      : 5;
    const safetyWindowSeconds = Math.max(0, safetyWindowMinutes) * 60;
    const maxEvents = Number.isInteger(safeOptions.max_events)
      ? safeOptions.max_events
      : 500;

    const syncState = await ensureAgentDeviceSyncState(db, {
      companyId,
      agentId,
      deviceUid: canonicalDeviceUid,
      vendor: 'zkteco',
      safetyWindowSeconds
    });

    await reconcileAgentCommandLifecycle(db, {
      companyId,
      agentId
    });

    const host = resolveConnectionHost(device, safeOptions);
    if (!host) {
      await db.query('ROLLBACK');
      return { error: 'device_host_unknown' };
    }
    const port = resolveConnectionPort(device, safeOptions);
    const transport = resolveConnectionTransport(device, safeOptions);
    const authPassword = resolveConnectionAuthPassword(device, safeOptions);
    const attlogSequence = resolveConnectionAttlogSequence(device, safeOptions);
    const deviceNumber = resolveConnectionDeviceNumber(device, safeOptions);
    const timezone = normalizeText(safeOptions.device_timezone) || await resolveCompanyTimezone(db, companyId);

    syncState.metadata = parseJson(syncState.metadata);
    const syncMetadata = parseJson(syncState && syncState.metadata);
    const historyDrainState = parseHistoryDrainState(syncMetadata.history_drain);
    const requestedHistoryMode = normalizeText(safeOptions.history_mode).toLowerCase();
    const historyDrainRequested = requestedHistoryMode === 'history_drain';
    const explicitHistoryBeforeUtc = normalizeIsoUtc(safeOptions.history_before_utc);
    const explicitHistoryBeforeDedupKey = normalizeDedupKey(safeOptions.history_before_dedup_key);
    const historyDrainPolicy = resolveK80HistoryDrainModePolicy({
      deviceUid: canonicalDeviceUid,
      vendor: 'zkteco',
      attlogSequence
    });
    const historyDrainModeRecognized = historyDrainRequested && historyDrainPolicy.enabled;
    const historyBoundaryBeforeUtcExclusive = historyDrainModeRecognized
      ? (explicitHistoryBeforeUtc || historyDrainState.boundary_before_utc_exclusive || null)
      : null;
    const historyBoundaryBeforeDedupKeyExclusive = historyDrainModeRecognized
      ? (explicitHistoryBeforeDedupKey || historyDrainState.boundary_before_dedup_key_exclusive || null)
      : null;
    const historyModeForPayload = historyDrainRequested ? 'history_drain' : null;
    const historyBoundaryBeforeUtcForPayload = explicitHistoryBeforeUtc || historyBoundaryBeforeUtcExclusive || null;
    const historyBoundaryBeforeDedupKeyForPayload = explicitHistoryBeforeDedupKey || historyBoundaryBeforeDedupKeyExclusive || null;

    try {
      const tracePath = path.join(__dirname, '..', 'logs', 'pull-device-events-options-trace.log');
      fs.appendFileSync(tracePath, `${JSON.stringify({
        ts: new Date().toISOString(),
        trace_token: traceToken || null,
        stage: 'queue_entry_options',
        agent_id: agentId,
        device_uid: canonicalDeviceUid,
        options: scrubOptionsForTrace(options),
        safe_options: scrubOptionsForTrace(safeOptions),
        requested_history_mode: requestedHistoryMode || null,
        history_mode_for_payload: historyModeForPayload || null
      })}\n`);
    } catch (err) {
      console.warn('pull-device-events options trace failed (queue)', err);
    }

    if (historyDrainModeRecognized && historyDrainState.last_command_id) {
      const timeoutRes = await db.query(
        `
        SELECT status, failure_reason
        FROM agent_commands
        WHERE id = $1
          AND company_id = $2
          AND agent_id = $3
          AND command_type = $4
        LIMIT 1
        `,
        [historyDrainState.last_command_id, companyId, agentId, COMMAND_TYPES.PULL_DEVICE_EVENTS]
      );
      const timeoutRow = timeoutRes.rows[0] || null;
      const timeoutStatus = normalizeText(timeoutRow && timeoutRow.status).toLowerCase();
      const timeoutReason = normalizeText(timeoutRow && timeoutRow.failure_reason).toLowerCase();
      if (
        timeoutStatus === 'failed'
        && timeoutReason === 'sent_timeout'
        && historyDrainState.stop_reason !== 'sent_timeout'
      ) {
        historyDrainState.sent_timeout_retries += 1;
        historyDrainState.stop_reason = 'sent_timeout';
        historyDrainState.updated_at = new Date().toISOString();
      }
    }

    const syncCursorIso = syncState && syncState.cursor_event_time_utc
      ? new Date(syncState.cursor_event_time_utc).toISOString()
      : '';
    const explicitSinceUtc = normalizeText(safeOptions.since_utc) || '';
    const syncSinceUtc = normalizeText(syncCursorIso) || '';
    let requestedSinceOriginalSource = explicitSinceUtc
      ? 'options.since_utc'
      : (syncSinceUtc ? 'sync_state.cursor_event_time_utc' : 'lookback_default');
    let sinceBase = explicitSinceUtc
      || syncSinceUtc
      || new Date(Date.now() - lookbackMinutes * 60 * 1000).toISOString();
    let requestedSinceOriginalUtc = shiftIsoMinutes(sinceBase, safetyWindowMinutes) || sinceBase;
    if (historyDrainModeRecognized) {
      requestedSinceOriginalSource = explicitSinceUtc ? 'options.since_utc' : 'history_drain_unbounded';
      sinceBase = explicitSinceUtc || '';
      requestedSinceOriginalUtc = explicitSinceUtc
        ? (shiftIsoMinutes(explicitSinceUtc, safetyWindowMinutes) || explicitSinceUtc)
        : null;
    }
    const lastLatestEventTimeUtc = normalizeText(syncMetadata.last_latest_event_time_utc);
    const syncCursorMs = syncSinceUtc ? new Date(syncSinceUtc).getTime() : Number.NaN;
    const lastLatestEventMs = lastLatestEventTimeUtc ? new Date(lastLatestEventTimeUtc).getTime() : Number.NaN;
    const cursorAtLatestSeenHead = Number.isFinite(syncCursorMs)
      && Number.isFinite(lastLatestEventMs)
      && syncCursorMs >= lastLatestEventMs;
    const queueTimeCursorBypassPolicy = resolveK80QueueTimeCursorBypassPolicy({
      deviceUid: canonicalDeviceUid,
      vendor: 'zkteco',
      attlogSequence
    });
    const queueBypassStateSnapshotPolicy = resolveK80QueueBypassStateSnapshotPolicy({
      deviceUid: canonicalDeviceUid,
      vendor: 'zkteco',
      attlogSequence
    });
    let queueTimeCursorBypassEntered = false;
    let queueTimeCursorBypassReason = null;
    let requestedSinceBypassSource = requestedSinceOriginalSource;
    let requestedSinceBypassUtc = requestedSinceOriginalUtc;
    if (
      !historyDrainModeRecognized
      &&
      queueTimeCursorBypassPolicy.enabled
      && !explicitSinceUtc
      && requestedSinceOriginalSource === 'sync_state.cursor_event_time_utc'
    ) {
      queueTimeCursorBypassEntered = true;
      queueTimeCursorBypassReason = Number.isFinite(syncCursorMs)
        ? (cursorAtLatestSeenHead
          ? 'sync_cursor_at_or_after_last_latest_event_time'
          : 'sync_cursor_source_without_explicit_since')
        : 'sync_cursor_source_without_explicit_since';
      requestedSinceBypassSource = 'k80_queue_time_cursor_bypass_backfill';
      requestedSinceBypassUtc = new Date(Date.now() - (queueTimeCursorBypassPolicy.backfill_minutes * 60 * 1000)).toISOString();
    }
    let queueBypassPredicateFalseReason = null;
    if (!queueTimeCursorBypassEntered) {
      if (historyDrainModeRecognized) {
        queueBypassPredicateFalseReason = 'history_drain_mode';
      } else if (!queueTimeCursorBypassPolicy.enabled) {
        queueBypassPredicateFalseReason = 'policy_disabled_or_not_allowlisted';
      } else if (explicitSinceUtc) {
        queueBypassPredicateFalseReason = 'explicit_since_present';
      } else if (requestedSinceOriginalSource !== 'sync_state.cursor_event_time_utc') {
        queueBypassPredicateFalseReason = 'requested_since_source_not_sync_cursor';
      } else if (!cursorAtLatestSeenHead) {
        queueBypassPredicateFalseReason = 'cursor_not_at_or_after_last_latest_event_time';
      } else {
        queueBypassPredicateFalseReason = 'predicate_false_unclassified';
      }
    }
    const requestedSinceSourceFixPolicy = resolveK80RequestedSinceSourceFixPolicy({
      deviceUid: canonicalDeviceUid,
      vendor: 'zkteco',
      attlogSequence
    });
    let requestedSinceUtc = requestedSinceBypassUtc;
    let requestedSinceSourceFixEntered = false;
    let requestedSinceEffectiveSource = requestedSinceBypassSource;
    if (!historyDrainModeRecognized && requestedSinceSourceFixPolicy.enabled && !explicitSinceUtc) {
      requestedSinceSourceFixEntered = true;
      const requestedSinceMs = requestedSinceBypassUtc
        ? new Date(requestedSinceBypassUtc).getTime()
        : null;
      const floorMs = Date.now() - (requestedSinceSourceFixPolicy.backfill_minutes * 60 * 1000);
      if (Number.isFinite(requestedSinceMs) && Number.isFinite(floorMs) && requestedSinceMs > floorMs) {
        requestedSinceUtc = new Date(floorMs).toISOString();
        requestedSinceEffectiveSource = requestedSinceBypassSource === 'k80_queue_time_cursor_bypass_backfill'
          ? 'k80_queue_time_cursor_bypass_backfill_clamped'
          : 'k80_source_fix_backfill_clamp';
      }
    }
    const ttlSeconds = parsePositiveInt(safeOptions.command_ttl_seconds) || defaultPullCommandTtlSeconds();
    const sentStaleSeconds = parsePositiveInt(safeOptions.sent_stale_seconds) || defaultPullCommandSentStaleSeconds();

    const commandPayload = {
      device_uid: canonicalDeviceUid,
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      connection: {
        host,
        port,
        ...(transport ? { transport } : {}),
        ...(authPassword !== null ? { auth_password: authPassword } : {}),
        ...(attlogSequence ? { attlog_sequence: attlogSequence } : {}),
        ...(deviceNumber !== null ? { device_number: deviceNumber } : {})
      },
      pull: {
        requested_since_utc: requestedSinceUtc,
        requested_since_utc_source: requestedSinceOriginalSource,
        requested_since_utc_original: requestedSinceOriginalUtc,
        requested_since_utc_bypass_source: requestedSinceBypassSource,
        requested_since_utc_bypass_value: requestedSinceBypassUtc,
        requested_since_utc_queue_bypass_entered: queueTimeCursorBypassEntered,
        requested_since_utc_queue_bypass_reason: queueTimeCursorBypassReason,
        requested_since_utc_queue_bypass_backfill_minutes: queueTimeCursorBypassPolicy.backfill_minutes,
        requested_since_utc_effective_source: requestedSinceEffectiveSource,
        requested_since_utc_source_fix_entered: requestedSinceSourceFixEntered,
        ...(queueBypassStateSnapshotPolicy.enabled
          ? {
            // Deprecated diagnostics-only snapshot block (no known consumer/read path).
            queue_bypass_state_snapshot: {
              cursor_event_time_utc: syncSinceUtc || null,
              last_latest_event_time_utc: lastLatestEventTimeUtc || null,
              explicitSinceUtc: explicitSinceUtc || null,
              requestedSinceOriginalSource,
              queueTimeCursorBypassPolicyEnabled: queueTimeCursorBypassPolicy.enabled,
              syncCursorMs: Number.isFinite(syncCursorMs) ? syncCursorMs : null,
              lastLatestEventMs: Number.isFinite(lastLatestEventMs) ? lastLatestEventMs : null,
              cursorAtLatestSeenHead,
              finalPredicateResult: queueTimeCursorBypassEntered,
              falseReason: queueBypassPredicateFalseReason
            }
          }
          : {}),
        lookback_minutes: lookbackMinutes,
        safety_window_minutes: safetyWindowMinutes,
        max_events: maxEvents,
        ...(historyModeForPayload ? { history_mode: historyModeForPayload } : {}),
        ...(historyBoundaryBeforeUtcForPayload ? { history_before_utc: historyBoundaryBeforeUtcForPayload } : {}),
        ...(historyBoundaryBeforeDedupKeyForPayload ? { history_before_dedup_key: historyBoundaryBeforeDedupKeyForPayload } : {}),
        device_timezone: timezone,
        sent_stale_seconds: sentStaleSeconds,
        ...(safeOptions.connect_only_probe === true ? { connect_only_probe: true } : {}),
        ...(Number.isInteger(safeOptions.connect_only_probe_hold_ms)
          ? { connect_only_probe_hold_ms: safeOptions.connect_only_probe_hold_ms }
          : {})
      },
      options: {
        mode: 'pull',
        enable_realtime: safeOptions.enable_realtime === true
      },
      runtime_context: {
        site_id: executionGate.details.site_id || null,
        active_site_agent_id: executionGate.details.active_site_agent_id || null,
        bound_agent_id: activeBinding.agent_id || null,
        runtime_health_status: executionGate.details.runtime_health_status || null,
        version_support_status: executionGate.details.version_support_status || null,
        runtime_capability_key: executionGate.details.required_runtime_capability_key || null,
        runtime_capability_status: executionGate.details.runtime_capability_status || null,
        runtime_capability_reason: executionGate.details.runtime_capability_reason || null,
        device_path_capability_key: executionGate.details.required_device_capability_key || null,
        device_path_capability_status: executionGate.details.device_path_capability_status || null,
        device_path_capability_reason: executionGate.details.device_path_capability_reason || null
      }
    };

    try {
      const tracePath = path.join(__dirname, '..', 'logs', 'pull-device-events-options-trace.log');
      fs.appendFileSync(tracePath, `${JSON.stringify({
        ts: new Date().toISOString(),
        trace_token: traceToken || null,
        stage: 'queue_command_payload_pull',
        agent_id: agentId,
        device_uid: canonicalDeviceUid,
        pull: commandPayload.pull
      })}\n`);
    } catch (err) {
      console.warn('pull-device-events options trace failed (payload)', err);
    }

    const inFlightRes = await db.query(
      `
      SELECT id, status
      FROM agent_commands
      WHERE company_id = $1
        AND agent_id = $2
        AND command_type = $3
        AND status IN ('queued', 'sent')
        AND COALESCE(command_payload->>'device_uid', '') = $4
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `,
      [companyId, agentId, COMMAND_TYPES.PULL_DEVICE_EVENTS, canonicalDeviceUid]
    );
    if (inFlightRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return {
        error: PULL_COMMAND_INFLIGHT_ERROR,
        value: {
          command_id: inFlightRes.rows[0].id,
          status: inFlightRes.rows[0].status
        }
      };
    }

    const commandRes = await db.query(
      `
      INSERT INTO agent_commands (
        company_id, agent_id, command_type, command_payload, status, created_by_key_id, expires_at
      )
      VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, now() + ($6::text || ' seconds')::interval)
      RETURNING id, company_id, agent_id, command_type, command_payload, status, created_at, expires_at
      `,
      [
        companyId,
        agentId,
        COMMAND_TYPES.PULL_DEVICE_EVENTS,
        JSON.stringify(commandPayload),
        createdByKeyId || null,
        String(ttlSeconds)
      ]
    );
    const command = commandRes.rows[0];
    const historyDrainMetadata = historyDrainModeRecognized
      ? {
        session_id: historyDrainState.session_id || crypto.randomUUID(),
        status: 'running',
        boundary_before_utc_exclusive: historyBoundaryBeforeUtcExclusive || null,
        boundary_before_dedup_key_exclusive: historyBoundaryBeforeDedupKeyExclusive || null,
        last_page_fingerprint: historyDrainState.last_page_fingerprint || null,
        no_progress_pages: historyDrainState.no_progress_pages,
        sent_timeout_retries: historyDrainState.sent_timeout_retries,
        last_command_id: command.id,
        last_batch_id: historyDrainState.last_batch_id || null,
        stop_reason: null,
        updated_at: new Date().toISOString()
      }
      : null;

    await db.query(
      `
      UPDATE agent_device_sync_states
      SET metadata = metadata || $1::jsonb,
          updated_at = now()
      WHERE company_id = $2
        AND agent_id = $3
        AND device_uid = $4
      `,
      [
        JSON.stringify({
          last_queued_command_id: command.id,
          last_queued_command_expires_at: command.expires_at,
          last_requested_since_utc: requestedSinceUtc,
          last_requested_since_utc_source: requestedSinceOriginalSource,
          last_requested_since_utc_original: requestedSinceOriginalUtc,
          last_requested_since_utc_bypass_source: requestedSinceBypassSource,
          last_requested_since_utc_bypass_value: requestedSinceBypassUtc,
          last_requested_since_utc_queue_bypass_entered: queueTimeCursorBypassEntered,
          last_requested_since_utc_queue_bypass_reason: queueTimeCursorBypassReason,
          last_requested_since_utc_queue_bypass_backfill_minutes: queueTimeCursorBypassPolicy.backfill_minutes,
          last_requested_since_utc_effective_source: requestedSinceEffectiveSource,
          last_requested_since_utc_source_fix_entered: requestedSinceSourceFixEntered,
          ...(historyDrainMetadata ? { history_drain: historyDrainMetadata } : {})
        }),
        companyId,
        agentId,
        canonicalDeviceUid
      ]
    );

    await db.query('COMMIT');
    logBridgeEvent('bridge.events.command.pull_device_events.queued', {
      company_id: companyId,
      agent_id: agentId,
      device_uid: canonicalDeviceUid,
      requested_device_uid: canonicalResolution.requested_device_uid,
      canonical_resolved_by: canonicalResolution.resolved_by,
      canonical_alias_kind: canonicalResolution.alias_kind,
      canonical_alias_status: canonicalResolution.alias_status,
      managing_agent_id: activeBinding.agent_id,
      command_id: command.id,
      requested_since_utc: requestedSinceUtc,
      history_mode: historyDrainModeRecognized ? 'history_drain' : 'normal',
      history_before_utc: historyBoundaryBeforeUtcExclusive || null,
      history_before_dedup_key: historyBoundaryBeforeDedupKeyExclusive || null
    });
    return { value: command };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function appendBatchDiagnostics(db, { batchId, diagnostics }) {
  if (!batchId || !isPlainObject(diagnostics)) {
    return;
  }
  await db.query(
    `
    UPDATE agent_device_event_batches
    SET payload = jsonb_set(
      jsonb_set(
        COALESCE(payload, '{}'::jsonb),
        '{summary}',
        COALESCE(payload->'summary', '{}'::jsonb),
        true
      ),
      '{summary,diagnostics}',
      COALESCE(payload->'summary'->'diagnostics', '{}'::jsonb) || $1::jsonb,
      true
    )
    WHERE id = $2::uuid
    `,
    [JSON.stringify(diagnostics), batchId]
  );
}

async function persistPostPunchTriggerState(db, {
  companyId,
  agentId,
  deviceUid,
  triggerState
}) {
  if (!isPlainObject(triggerState)) {
    return;
  }
  await db.query(
    `
    UPDATE agent_device_sync_states
    SET metadata = metadata || $1::jsonb,
        updated_at = now()
    WHERE company_id = $2
      AND agent_id = $3
      AND device_uid = $4
    `,
    [
      JSON.stringify({
        post_punch_fact_anchor_trigger: triggerState
      }),
      companyId,
      agentId,
      deviceUid
    ]
  );
}

async function maybeQueuePostPunchFactAnchorPull(db, {
  companyId,
  agentId,
  deviceUid,
  vendor,
  batchId,
  insertedRealtimeRows
}) {
  const policy = resolveK80PostPunchFactAnchorPolicy({
    deviceUid,
    vendor
  });
  const nowIso = new Date().toISOString();
  const diagnostics = {
    k80_post_punch_fact_anchor_trigger_seen: insertedRealtimeRows > 0,
    k80_post_punch_fact_anchor_policy_flag_enabled: policy.flag_enabled === true,
    k80_post_punch_fact_anchor_policy_allowlist_applied: policy.allowlist_size > 0,
    k80_post_punch_fact_anchor_policy_scope_allowed: policy.scope_allowed === true,
    k80_post_punch_fact_anchor_policy_enabled: policy.enabled === true,
    k80_post_punch_fact_anchor_min_interval_seconds: policy.min_interval_seconds,
    k80_post_punch_fact_anchor_lookback_minutes: policy.lookback_minutes,
    k80_post_punch_fact_anchor_safety_window_minutes: policy.safety_window_minutes,
    k80_post_punch_fact_anchor_max_events: policy.max_events,
    k80_post_punch_fact_anchor_queue_attempted: false,
    k80_post_punch_fact_anchor_queue_suppressed: false,
    k80_post_punch_fact_anchor_queue_suppressed_reason: null,
    k80_post_punch_fact_anchor_queue_succeeded: false,
    k80_post_punch_fact_anchor_queued_command_id: null,
    k80_post_punch_fact_anchor_queue_error: null,
    k80_post_punch_fact_anchor_last_attempt_at: nowIso
  };

  if (insertedRealtimeRows <= 0) {
    diagnostics.k80_post_punch_fact_anchor_queue_suppressed = true;
    diagnostics.k80_post_punch_fact_anchor_queue_suppressed_reason = 'no_realtime_rows_inserted';
    return diagnostics;
  }

  if (!policy.enabled) {
    diagnostics.k80_post_punch_fact_anchor_queue_suppressed = true;
    diagnostics.k80_post_punch_fact_anchor_queue_suppressed_reason = 'policy_disabled_or_scope_blocked';
    return diagnostics;
  }

  const syncStateRes = await db.query(
    `
    SELECT metadata
    FROM agent_device_sync_states
    WHERE company_id = $1
      AND agent_id = $2
      AND device_uid = $3
    LIMIT 1
    `,
    [companyId, agentId, deviceUid]
  );
  const syncMetadata = parseJson(syncStateRes.rows[0] && syncStateRes.rows[0].metadata);
  const triggerState = parseJson(syncMetadata.post_punch_fact_anchor_trigger);
  const lastAttemptAt = normalizeIsoUtc(triggerState.last_attempt_at);
  if (lastAttemptAt) {
    const elapsedMs = Date.now() - new Date(lastAttemptAt).getTime();
    const minIntervalMs = policy.min_interval_seconds * 1000;
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < minIntervalMs) {
      diagnostics.k80_post_punch_fact_anchor_queue_suppressed = true;
      diagnostics.k80_post_punch_fact_anchor_queue_suppressed_reason = 'min_interval_not_elapsed';
      return diagnostics;
    }
  }

  diagnostics.k80_post_punch_fact_anchor_queue_attempted = true;
  try {
    const queueResult = await queuePullDeviceEventsCommand(db, {
      companyId,
      agentId,
      deviceUid,
      options: {
        lookback_minutes: policy.lookback_minutes,
        safety_window_minutes: policy.safety_window_minutes,
        max_events: policy.max_events
      },
      createdByKeyId: null,
      traceToken: `post-punch-${batchId || crypto.randomUUID()}`
    });
    if (queueResult.error) {
      diagnostics.k80_post_punch_fact_anchor_queue_suppressed = true;
      diagnostics.k80_post_punch_fact_anchor_queue_suppressed_reason = queueResult.error === PULL_COMMAND_INFLIGHT_ERROR
        ? 'pull_inflight_dedupe'
        : 'queue_guard_blocked';
      diagnostics.k80_post_punch_fact_anchor_queue_error = queueResult.error;
      return diagnostics;
    }
    diagnostics.k80_post_punch_fact_anchor_queue_succeeded = true;
    diagnostics.k80_post_punch_fact_anchor_queued_command_id =
      normalizeText(queueResult.value && queueResult.value.id) || null;
    return diagnostics;
  } catch (err) {
    diagnostics.k80_post_punch_fact_anchor_queue_suppressed = true;
    diagnostics.k80_post_punch_fact_anchor_queue_suppressed_reason = 'queue_exception';
    diagnostics.k80_post_punch_fact_anchor_queue_error = normalizeText(err && err.message) || 'unknown_error';
    return diagnostics;
  }
}

async function queueDevicePathPullCapabilityRefreshCommand(db, {
  companyId,
  agentId,
  deviceUid,
  options,
  createdByKeyId
}) {
  const safeOptions = isPlainObject(options) ? options : {};
  await db.query('BEGIN');
  try {
    const agentRes = await db.query(
      `
      SELECT id, company_id, agent_name, status, site_id
      FROM agent_nodes
      WHERE id = $1 AND company_id = $2
      LIMIT 1
      `,
      [agentId, companyId]
    );
    const agent = agentRes.rows[0];
    if (!agent) {
      await db.query('ROLLBACK');
      return { error: 'agent_not_found' };
    }
    if (agent.status !== 'active') {
      await db.query('ROLLBACK');
      return { error: 'agent_not_active' };
    }

    const canonicalResolution = await resolveCanonicalDeviceUid(db, { companyId, deviceUid });
    if (canonicalResolution.resolved_by === 'superseded_without_canonical') {
      await db.query('ROLLBACK');
      return {
        error: 'device_uid_superseded_without_canonical',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalResolution.canonical_device_uid,
          canonical_resolved_by: canonicalResolution.resolved_by
        }
      };
    }
    const canonicalDeviceUid = canonicalResolution.canonical_device_uid;
    const device = await getManagedDevice(db, { companyId, deviceUid: canonicalDeviceUid });
    if (!device) {
      await db.query('ROLLBACK');
      return { error: 'device_not_found' };
    }
    if (String(device.managed_status || '').toLowerCase() !== 'managed') {
      await db.query('ROLLBACK');
      return { error: 'device_not_managed' };
    }
    const provider = String(device.provider || '').toLowerCase();
    if (provider && provider !== 'zkteco') {
      await db.query('ROLLBACK');
      return { error: 'unsupported_vendor' };
    }
    const activeBinding = await getActiveManagingAgentBinding(db, {
      companyId,
      deviceUid: canonicalDeviceUid
    });
    if (!activeBinding) {
      await db.query('ROLLBACK');
      return {
        error: 'device_managing_agent_binding_missing',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by
        }
      };
    }
    if (String(activeBinding.agent_id) !== String(agentId)) {
      await db.query('ROLLBACK');
      return {
        error: 'device_managing_agent_binding_conflict',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          requested_agent_id: agentId,
          bound_agent_id: activeBinding.agent_id
        }
      };
    }

    const executionGate = await evaluateCommandIssuanceGate(db, {
      companyId,
      targetAgentId: agentId,
      commandType: COMMAND_TYPES.REFRESH_DEVICE_PATH_PULL_CAPABILITY,
      deviceUid: canonicalDeviceUid,
      deviceSiteId: device.site_id || null,
      agentSiteId: agent.site_id || null,
      bindingAgentId: activeBinding.agent_id || null
    });
    if (!executionGate.allowed) {
      await db.query('ROLLBACK');
      return {
        error: executionGate.reason_code,
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by,
          execution_gate: executionGate.details
        }
      };
    }

    await reconcileAgentCommandLifecycle(db, { companyId, agentId });

    const host = resolveConnectionHost(device, safeOptions);
    if (!host) {
      await db.query('ROLLBACK');
      return { error: 'device_host_unknown' };
    }
    const port = resolveConnectionPort(device, safeOptions);
    const transport = resolveConnectionTransport(device, safeOptions);
    const authPassword = resolveConnectionAuthPassword(device, safeOptions);
    const attlogSequence = resolveConnectionAttlogSequence(device, safeOptions);
    const deviceNumber = resolveConnectionDeviceNumber(device, safeOptions);
    const timezone = normalizeText(safeOptions.device_timezone) || await resolveCompanyTimezone(db, companyId);
    const ttlSeconds = parsePositiveInt(safeOptions.command_ttl_seconds) || defaultPullCommandTtlSeconds();
    const sentStaleSeconds = parsePositiveInt(safeOptions.sent_stale_seconds) || defaultPullCommandSentStaleSeconds();
    const requestedSinceUtc = normalizeText(safeOptions.since_utc)
      || new Date(Date.now() - (5 * 60 * 1000)).toISOString();

    const inFlightRes = await db.query(
      `
      SELECT id, status
      FROM agent_commands
      WHERE company_id = $1
        AND agent_id = $2
        AND command_type = $3
        AND status IN ('queued', 'sent')
        AND COALESCE(command_payload->>'device_uid', '') = $4
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `,
      [companyId, agentId, COMMAND_TYPES.REFRESH_DEVICE_PATH_PULL_CAPABILITY, canonicalDeviceUid]
    );
    if (inFlightRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return {
        error: 'device_path_capability_refresh_already_in_flight',
        value: {
          command_id: inFlightRes.rows[0].id,
          status: inFlightRes.rows[0].status
        }
      };
    }

    const commandPayload = {
      device_uid: canonicalDeviceUid,
      vendor: 'zkteco',
      capability_refresh: {
        capability_key: DEVICE_PATH_CAPABILITY_KEYS.PULL_DEVICE_EVENTS,
        probe_mode: 'bounded_pull_path_probe_v1',
        evidence_required: 'pull_result_ok'
      },
      connection: {
        host,
        port,
        ...(transport ? { transport } : {}),
        ...(authPassword !== null ? { auth_password: authPassword } : {}),
        ...(attlogSequence ? { attlog_sequence: attlogSequence } : {}),
        ...(deviceNumber !== null ? { device_number: deviceNumber } : {})
      },
      pull: {
        requested_since_utc: requestedSinceUtc,
        requested_since_utc_source: 'device_path_capability_refresh_probe',
        max_events: Math.max(1, Math.min(parsePositiveInt(safeOptions.max_events) || 1, 5)),
        device_timezone: timezone,
        sent_stale_seconds: sentStaleSeconds
      },
      options: {
        mode: 'device_path_capability_refresh',
        enable_realtime: false
      },
      runtime_context: {
        site_id: executionGate.details.site_id || null,
        active_site_agent_id: executionGate.details.active_site_agent_id || null,
        bound_agent_id: activeBinding.agent_id || null,
        runtime_health_status: executionGate.details.runtime_health_status || null,
        version_support_status: executionGate.details.version_support_status || null,
        runtime_capability_key: executionGate.details.required_runtime_capability_key || null,
        runtime_capability_status: executionGate.details.runtime_capability_status || null,
        runtime_capability_reason: executionGate.details.runtime_capability_reason || null,
        device_path_capability_key: null,
        device_path_capability_status: null,
        device_path_capability_reason: null
      }
    };

    const commandRes = await db.query(
      `
      INSERT INTO agent_commands (
        company_id, agent_id, command_type, command_payload, status, created_by_key_id, expires_at
      )
      VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, now() + ($6::text || ' seconds')::interval)
      RETURNING id, company_id, agent_id, command_type, command_payload, status, created_at, expires_at
      `,
      [
        companyId,
        agentId,
        COMMAND_TYPES.REFRESH_DEVICE_PATH_PULL_CAPABILITY,
        JSON.stringify(commandPayload),
        createdByKeyId || null,
        String(ttlSeconds)
      ]
    );

    await db.query('COMMIT');
    return { value: commandRes.rows[0] };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function ingestDevicePathPullCapabilityProbeResult(db, {
  companyId,
  agentId,
  payload
}) {
  const safePayload = isPlainObject(payload) ? payload : {};
  const commandId = normalizeText(safePayload.command_id);
  const requestedDeviceUid = normalizeText(safePayload.device_uid);
  const result = isPlainObject(safePayload.result) ? safePayload.result : {};
  const success = result.success === true;
  const reasonCode = normalizeText(result.reason_code) || (success
    ? 'fresh_pull_path_probe_succeeded'
    : 'fresh_pull_path_probe_failed');
  const completedAt = normalizeIsoUtc(safePayload.completed_at) || new Date().toISOString();
  if (!commandId || !requestedDeviceUid) {
    return { error: 'invalid_probe_result' };
  }

  await db.query('BEGIN');
  try {
    const commandRes = await db.query(
      `
      SELECT id, command_payload, status
      FROM agent_commands
      WHERE id = $1
        AND company_id = $2
        AND agent_id = $3
        AND command_type = $4
      LIMIT 1
      FOR UPDATE
      `,
      [commandId, companyId, agentId, COMMAND_TYPES.REFRESH_DEVICE_PATH_PULL_CAPABILITY]
    );
    const commandRow = commandRes.rows[0] || null;
    if (!commandRow) {
      await db.query('ROLLBACK');
      return { error: 'probe_command_not_found' };
    }
    const commandPayload = parseJson(commandRow.command_payload);
    const commandDeviceUid = normalizeText(commandPayload.device_uid);
    if (commandDeviceUid && commandDeviceUid !== requestedDeviceUid) {
      await db.query('ROLLBACK');
      return { error: 'probe_device_uid_mismatch' };
    }

    await db.query(
      `
      UPDATE agent_commands
      SET status = 'acknowledged',
          acknowledged_at = COALESCE(acknowledged_at, now()),
          result_payload = COALESCE(result_payload, '{}'::jsonb) || $1::jsonb,
          failure_reason = CASE WHEN $2::boolean THEN failure_reason ELSE $3 END
      WHERE id = $4
        AND company_id = $5
        AND agent_id = $6
      `,
      [
        JSON.stringify({
          capability_refresh: {
            ok: success,
            reason_code: reasonCode,
            capability_key: DEVICE_PATH_CAPABILITY_KEYS.PULL_DEVICE_EVENTS,
            completed_at: completedAt,
            diagnostics: isPlainObject(result.diagnostics) ? result.diagnostics : {}
          }
        }),
        success,
        reasonCode,
        commandId,
        companyId,
        agentId
      ]
    );

    if (success) {
      await ensureCapabilityReportingSchemaReady(db, {
        runtimePath: 'agent.device_path_pull_capability_probe_result'
      });
      await upsertDeviceRuntimeCapabilityReportedState(db, {
        companyId,
        deviceUid: requestedDeviceUid,
        siteId: commandPayload.runtime_context && commandPayload.runtime_context.site_id
          ? commandPayload.runtime_context.site_id
          : null,
        reportingAgentId: agentId,
        capabilityKey: DEVICE_PATH_CAPABILITY_KEYS.PULL_DEVICE_EVENTS,
        capabilityStatus: CAPABILITY_STATUS.SUPPORTED,
        capabilityReason: 'fresh_pull_path_probe_succeeded',
        reportedAt: completedAt,
        metadata: {
          source: 'agent.device_path_pull_capability_probe_result',
          command_id: commandId,
          reason_code: reasonCode,
          probe_mode: commandPayload.capability_refresh
            ? commandPayload.capability_refresh.probe_mode || null
            : null,
          diagnostics: isPlainObject(result.diagnostics) ? result.diagnostics : {}
        }
      });
    }

    await db.query('COMMIT');
    return {
      value: {
        command_id: commandId,
        command_status: 'acknowledged',
        device_uid: requestedDeviceUid,
        capability_key: DEVICE_PATH_CAPABILITY_KEYS.PULL_DEVICE_EVENTS,
        capability_status: success ? CAPABILITY_STATUS.SUPPORTED : CAPABILITY_STATUS.UNKNOWN,
        capability_reason: success ? 'fresh_pull_path_probe_succeeded' : reasonCode,
        result: {
          success,
          reason_code: reasonCode,
          diagnostics: isPlainObject(result.diagnostics) ? result.diagnostics : {}
        }
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function listDeviceSyncStates(db, {
  companyId,
  agentId,
  deviceUid,
  limit,
  offset
}) {
  const safeLimit = parseLimit(limit);
  const safeOffset = parseOffset(offset);
  const params = [companyId];
  const where = ['s.company_id = $1'];

  if (normalizeText(agentId)) {
    params.push(normalizeText(agentId));
    where.push(`s.agent_id = $${params.length}`);
  }
  if (normalizeText(deviceUid)) {
    params.push(normalizeText(deviceUid));
    where.push(`s.device_uid = $${params.length}`);
  }

  params.push(safeLimit);
  params.push(safeOffset);

  const res = await db.query(
    `
    SELECT
      s.id,
      s.company_id,
      s.agent_id,
      s.device_uid,
      s.vendor,
      s.sync_mode,
      s.status,
      s.cursor_event_time_utc,
      s.safety_window_seconds,
      s.last_sync_started_at,
      s.last_sync_completed_at,
      s.last_event_time_utc,
      s.last_event_time_local,
      s.last_pull_count,
      s.last_submit_count,
      s.consecutive_failures,
      s.failure_reason,
      s.last_error_at,
      s.metadata,
      s.created_at,
      s.updated_at
    FROM agent_device_sync_states s
    WHERE ${where.join(' AND ')}
    ORDER BY s.updated_at DESC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
    `,
    params
  );
  return res.rows;
}

function summarizeRejectionSamples(samples) {
  const source = parseJsonArray(samples);
  return source.slice(0, 5).map(item => ({
    code: normalizeText(item && item.code) || null,
    device_person_id: normalizeText(item && item.device_person_id) || null,
    event_time_utc: normalizeText(item && item.event_time_utc) || null
  }));
}

function summarizeRealtimeBatchDiagnostics(payload) {
  const safePayload = isPlainObject(payload) ? payload : {};
  const summary = isPlainObject(safePayload.summary) ? safePayload.summary : {};
  const diagnostics = isPlainObject(summary.diagnostics) ? summary.diagnostics : {};
  const ingestMethod = normalizeText(summary.ingest_method || safePayload.ingest_method || safePayload.ingestMethod);
  const eventsReceivedRaw = summary.events_received_count
    ?? diagnostics.realtime_provisional_events_received
    ?? diagnostics.session_rt01f4_frames_count
    ?? summary.events_count
    ?? safePayload.events_count;
  const insertedRaw = summary.inserted_count
    ?? diagnostics.realtime_provisional_events_inserted
    ?? safePayload.inserted_count;
  const eventsReceived = Number.parseInt(eventsReceivedRaw, 10);
  const inserted = Number.parseInt(insertedRaw, 10);
  if (ingestMethod !== 'agent_realtime' && !diagnostics.k80_rt_ingest_policy_enabled) {
    return null;
  }
  return {
    ingest_method: ingestMethod || null,
    events_received_count: Number.isNaN(eventsReceived) ? 0 : eventsReceived,
    inserted_count: Number.isNaN(inserted) ? 0 : inserted,
    k80_rt_ingest_policy_enabled: typeof diagnostics.k80_rt_ingest_policy_enabled === 'boolean'
      ? diagnostics.k80_rt_ingest_policy_enabled
      : null,
    k80_rt_ingest_insert_path_skipped: diagnostics.k80_rt_ingest_insert_path_skipped === true,
    k80_rt_ingest_insert_path_skip_reason: normalizeText(diagnostics.k80_rt_ingest_insert_path_skip_reason)
      || normalizeText(diagnostics.skip_reason)
      || null
  };
}

function buildBatchResultFromRow(row, {
  manageabilityStatus = null,
  manageabilityReason = null,
  replayedDelivery = false
} = {}) {
  const payload = parseJson(row && row.payload);
  return {
    batch_id: row ? row.id : null,
    delivery_id: row ? normalizeText(row.delivery_id) || null : null,
    replayed_delivery: replayedDelivery,
    batch_status: row ? row.status : null,
    pull_ok: isPlainObject(payload.summary) ? payload.summary.pull_ok !== false : true,
    manageability_status: manageabilityStatus,
    manageability_reason: manageabilityReason,
    inserted_count: row ? parsePositiveInt(row.inserted_count) || 0 : 0,
    deduped_count: row ? parsePositiveInt(row.deduped_count) || 0 : 0,
    rejected_count: row ? parsePositiveInt(row.rejected_count) || 0 : 0,
    latest_event_time_utc: row && row.latest_event_time_utc ? row.latest_event_time_utc : null,
    rejection_samples: summarizeRejectionSamples(payload.rejection_samples)
  };
}

async function listDeviceEventBatches(db, {
  companyId,
  agentId,
  deviceUid,
  status,
  createdFrom,
  createdTo,
  pullCompletedFrom,
  pullCompletedTo,
  limit,
  offset
}) {
  const safeLimit = parseLimit(limit);
  const safeOffset = parseOffset(offset);
  const params = [companyId];
  const where = ['b.company_id = $1'];

  if (normalizeText(agentId)) {
    params.push(normalizeText(agentId));
    where.push(`b.agent_id = $${params.length}`);
  }
  if (normalizeText(deviceUid)) {
    params.push(normalizeText(deviceUid));
    where.push(`b.device_uid = $${params.length}`);
  }
  if (normalizeText(status)) {
    params.push(normalizeText(status).toLowerCase());
    where.push(`b.status = $${params.length}`);
  }
  if (normalizeText(createdFrom)) {
    params.push(normalizeText(createdFrom));
    where.push(`b.created_at >= $${params.length}::timestamptz`);
  }
  if (normalizeText(createdTo)) {
    params.push(normalizeText(createdTo));
    where.push(`b.created_at <= $${params.length}::timestamptz`);
  }
  if (normalizeText(pullCompletedFrom)) {
    params.push(normalizeText(pullCompletedFrom));
    where.push(`b.pull_completed_at >= $${params.length}::timestamptz`);
  }
  if (normalizeText(pullCompletedTo)) {
    params.push(normalizeText(pullCompletedTo));
    where.push(`b.pull_completed_at <= $${params.length}::timestamptz`);
  }

  params.push(safeLimit);
  params.push(safeOffset);

  const res = await db.query(
    `
    SELECT
      b.id,
      b.company_id,
      b.agent_id,
      b.device_uid,
      b.command_id,
      b.status,
      b.failure_reason,
      b.inserted_count,
      b.deduped_count,
      b.rejected_count,
      b.pull_completed_at,
      b.created_at,
      b.payload,
      COALESCE(b.payload->'rejection_samples', '[]'::jsonb) AS rejection_samples
    FROM agent_device_event_batches b
    WHERE ${where.join(' AND ')}
    ORDER BY b.created_at DESC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
    `,
    params
  );

  return res.rows.map(row => {
    const rejectionSamples = summarizeRejectionSamples(row.rejection_samples);
    return {
      id: row.id,
      company_id: row.company_id,
      agent_id: row.agent_id,
      device_uid: row.device_uid,
      command_id: row.command_id,
      status: row.status,
      failure_reason: row.failure_reason,
      inserted_count: row.inserted_count,
      deduped_count: row.deduped_count,
      rejected_count: row.rejected_count,
      pull_completed_at: row.pull_completed_at,
      created_at: row.created_at,
      rt_diagnostics_summary: summarizeRealtimeBatchDiagnostics(row.payload),
      rejection_sample_count: parseJsonArray(row.rejection_samples).length,
      rejection_samples: rejectionSamples
    };
  });
}

async function listRecentDeviceEvents(db, {
  companyId,
  deviceUid,
  limit
}) {
  const safeLimit = parseLimit(limit, 20, 50);
  const requestedDeviceUid = normalizeText(deviceUid);
  let canonicalResolution = null;
  let canonicalDeviceUid = '';

  if (requestedDeviceUid) {
    canonicalResolution = await resolveCanonicalDeviceUid(db, {
      companyId,
      deviceUid: requestedDeviceUid
    });
    canonicalDeviceUid = normalizeText(canonicalResolution.canonical_device_uid) || requestedDeviceUid;
  }

  const params = [companyId];
  const where = ['e.company_id = $1'];
  if (canonicalDeviceUid) {
    params.push(canonicalDeviceUid);
    where.push(`e.device_uid = $${params.length}`);
  }
  params.push(safeLimit);

  const res = await db.query(
    `
    SELECT
      e.id,
      e.company_id,
      e.device_uid,
      e.person_id,
      e.device_person_id,
      e.event_time_utc,
      e.event_time_local,
      e.direction,
      e.verify_state,
      e.verify_method,
      e.vendor,
      e.created_at,
      d.id AS derived_attachment_id,
      d.derived_direction AS derived_direction,
      d.confidence_basis AS derived_confidence_basis,
      d.conflict_flag AS derived_conflict_flag,
      d.source_refs AS derived_source_refs,
      d.source_metadata AS derived_source_metadata,
      d.artifact_outcome AS derived_artifact_outcome
    FROM device_events e
    LEFT JOIN derived_direction_attachments d
      ON d.company_id = e.company_id
     AND d.fact_event_id = e.id
    WHERE ${where.join(' AND ')}
    ORDER BY e.event_time_utc DESC, e.created_at DESC
    LIMIT $${params.length}
    `,
    params
  );

  return {
    requested_device_uid: requestedDeviceUid || null,
    canonical_device_uid: canonicalDeviceUid || null,
    canonical_resolved_by: canonicalResolution ? canonicalResolution.resolved_by : null,
    canonical_alias_kind: canonicalResolution ? canonicalResolution.alias_kind : null,
    canonical_alias_status: canonicalResolution ? canonicalResolution.alias_status : null,
    rows: res.rows.map(row => ({
      ...row,
      legacy_direction: row.direction,
      legacy_direction_authority: 'legacy_fact_lane_not_automatically_authoritative',
      derived_direction_attachment: row.derived_attachment_id
        ? {
          id: row.derived_attachment_id,
          derived_direction: row.derived_direction,
          confidence_basis: row.derived_confidence_basis,
          conflict_flag: row.derived_conflict_flag === true,
          artifact_outcome: row.derived_artifact_outcome || null,
          source_refs: isPlainObject(row.derived_source_refs) ? row.derived_source_refs : {},
          source_metadata: isPlainObject(row.derived_source_metadata) ? row.derived_source_metadata : {}
        }
        : null
    }))
  };
}

async function ingestAgentEventBatch(db, {
  companyId,
  agentId,
  payload
}) {
  let insertAttempted = false;
  const ingestTrace = {
    company_id: companyId,
    agent_id: agentId,
    command_id: normalizeText(payload && payload.command_id) || null,
    device_uid: normalizeText(payload && payload.device_uid) || null,
    delivery_id: normalizeText(payload && payload.delivery_id) || null
  };
  const insertedFactEventIds = [];
  await db.query('BEGIN');
  try {
    await ensureCapabilityReportingSchemaReady(db, {
      runtimePath: '/api/agent/device-events/batch'
    });

    const deliveryId = normalizeText(payload.delivery_id) || null;
    const deliveryAttempt = Number.isInteger(payload.delivery_attempt)
      ? payload.delivery_attempt
      : null;
    const canonicalResolution = await resolveCanonicalDeviceUid(db, {
      companyId,
      deviceUid: payload.device_uid
    });
    const canonicalDeviceUid = canonicalResolution.canonical_device_uid;
    const device = await getManagedDevice(db, {
      companyId,
      deviceUid: canonicalDeviceUid
    });
    if (!device) {
      await db.query('ROLLBACK');
      return { error: 'device_not_found' };
    }
    if (String(device.managed_status || '').toLowerCase() !== 'managed') {
      await db.query('ROLLBACK');
      return { error: 'device_not_managed' };
    }

    const syncState = await ensureAgentDeviceSyncState(db, {
      companyId,
      agentId,
      deviceUid: canonicalDeviceUid,
      vendor: payload.vendor || 'zkteco',
      safetyWindowSeconds: 300
    });
    syncState.metadata = parseJson(syncState.metadata);

    if (deliveryId) {
      const replayRes = await db.query(
        `
        SELECT
          id,
          delivery_id,
          status,
          failure_reason,
          inserted_count,
          deduped_count,
          rejected_count,
          latest_event_time_utc,
          payload
        FROM agent_device_event_batches
        WHERE company_id = $1
          AND agent_id = $2
          AND delivery_id = $3
        LIMIT 1
        `,
        [companyId, agentId, deliveryId]
      );
      const replayRow = replayRes.rows[0] || null;
      if (replayRow) {
        const replayFailureReason = normalizeText(replayRow.failure_reason) || null;
        const replayManageability = mapPullOutcomeToManageability({
          batchStatus: replayRow.status,
          pullOk: parseJson(replayRow.payload).summary
            ? parseJson(replayRow.payload).summary.pull_ok !== false
            : true,
          insertedCount: Number.parseInt(replayRow.inserted_count, 10) || 0,
          dedupedCount: Number.parseInt(replayRow.deduped_count, 10) || 0,
          failureReason: replayFailureReason
        });

        await db.query('COMMIT');
        return {
          value: buildBatchResultFromRow(replayRow, {
            manageabilityStatus: replayManageability.status,
            manageabilityReason: replayManageability.reason,
            replayedDelivery: true
          })
        };
      }
    }

    let commandStatusBeforeAcknowledge = null;
    let queuedCommandPayload = null;
    let queuedCommandCreatedByKeyId = null;
    let queuedRequestedSinceUtc = null;
    let queuedRequestedSinceSource = null;
    let queuedRequestedSinceOriginal = null;
    let queuedRequestedSinceEffectiveSource = null;
    let queuedRequestedSinceSourceFixEntered = false;
    let queuedRequestedSinceQueueBypassBackfillMinutes = null;
    let queuedHistoryMode = null;
    let queuedHistoryBeforeUtc = null;
    let queuedHistoryBeforeDedupKey = null;
    let historyDrainModeRecognized = false;
    let historyDrainPolicy = null;
    const currentHistoryDrainState = parseHistoryDrainState(syncState.metadata && syncState.metadata.history_drain);
    const payloadSummary = isPlainObject(payload.summary) ? payload.summary : {};
    const payloadDiagnostics = isPlainObject(payloadSummary.diagnostics) ? payloadSummary.diagnostics : {};
    const payloadHistoryDrain = isPlainObject(payloadDiagnostics.history_drain) ? payloadDiagnostics.history_drain : null;
    const payloadProtocol = isPlainObject(payloadDiagnostics.protocol) ? payloadDiagnostics.protocol : null;
    const payloadHistoryDrainRecognized = payloadHistoryDrain && typeof payloadHistoryDrain.mode_recognized === 'boolean'
      ? payloadHistoryDrain.mode_recognized
      : (payloadProtocol && typeof payloadProtocol.zktime_history_drain_mode_recognized === 'boolean'
        ? payloadProtocol.zktime_history_drain_mode_recognized
        : null);
    if (payload.command_id) {
      const commandStatusRes = await db.query(
        `
        SELECT status, command_payload, created_by_key_id
        FROM agent_commands
        WHERE id = $1
          AND company_id = $2
          AND agent_id = $3
          AND command_type = $4
        LIMIT 1
        `,
        [payload.command_id, companyId, agentId, COMMAND_TYPES.PULL_DEVICE_EVENTS]
      );
      commandStatusBeforeAcknowledge = normalizeText(commandStatusRes.rows[0] && commandStatusRes.rows[0].status)
        .toLowerCase() || null;
      queuedCommandPayload = parseJson(commandStatusRes.rows[0] && commandStatusRes.rows[0].command_payload);
      queuedCommandCreatedByKeyId = normalizeText(commandStatusRes.rows[0] && commandStatusRes.rows[0].created_by_key_id) || null;
      const queuedPull = parseJson(queuedCommandPayload.pull);
      const queuedConnection = parseJson(queuedCommandPayload.connection);
      queuedRequestedSinceUtc = normalizeText(queuedPull.requested_since_utc) || null;
      queuedRequestedSinceSource = normalizeText(queuedPull.requested_since_utc_source) || null;
      queuedRequestedSinceOriginal = normalizeText(queuedPull.requested_since_utc_original) || queuedRequestedSinceUtc;
      const queuedRequestedSinceBypassSource = normalizeText(queuedPull.requested_since_utc_bypass_source) || queuedRequestedSinceSource;
      const queuedRequestedSinceBypassValue = normalizeText(queuedPull.requested_since_utc_bypass_value) || queuedRequestedSinceUtc;
      const queuedRequestedSinceQueueBypassEntered = queuedPull.requested_since_utc_queue_bypass_entered === true;
      const queuedRequestedSinceQueueBypassReason = normalizeText(queuedPull.requested_since_utc_queue_bypass_reason) || null;
      queuedRequestedSinceQueueBypassBackfillMinutes = Number.isInteger(queuedPull.requested_since_utc_queue_bypass_backfill_minutes)
        ? queuedPull.requested_since_utc_queue_bypass_backfill_minutes
        : null;
      queuedRequestedSinceEffectiveSource = normalizeText(queuedPull.requested_since_utc_effective_source) || queuedRequestedSinceSource;
      queuedRequestedSinceSourceFixEntered = queuedPull.requested_since_utc_source_fix_entered === true;
      queuedHistoryMode = normalizeText(queuedPull.history_mode).toLowerCase() || null;
      queuedHistoryBeforeUtc = normalizeIsoUtc(queuedPull.history_before_utc);
      queuedHistoryBeforeDedupKey = normalizeDedupKey(queuedPull.history_before_dedup_key);
      historyDrainPolicy = resolveK80HistoryDrainModePolicy({
        deviceUid: canonicalDeviceUid,
        vendor: payload.vendor || 'zkteco',
        attlogSequence: normalizeAttlogSequence(queuedConnection.attlog_sequence)
      });
      historyDrainModeRecognized = payloadHistoryDrainRecognized !== null
        ? payloadHistoryDrainRecognized
        : (queuedHistoryMode === 'history_drain' && historyDrainPolicy.enabled);
      syncState.metadata = parseJson(syncState.metadata);
      syncState.metadata._queued_requested_since_bypass_source = queuedRequestedSinceBypassSource;
      syncState.metadata._queued_requested_since_bypass_value = queuedRequestedSinceBypassValue;
      syncState.metadata._queued_requested_since_queue_bypass_entered = queuedRequestedSinceQueueBypassEntered;
      syncState.metadata._queued_requested_since_queue_bypass_reason = queuedRequestedSinceQueueBypassReason;
    }

    insertAttempted = true;
    const batchRes = await db.query(
      `
      INSERT INTO agent_device_event_batches (
        company_id,
        agent_id,
        device_uid,
        delivery_id,
        command_id,
        vendor,
        ingest_method,
        requested_since_utc,
        latest_event_time_utc,
        pull_started_at,
        pull_completed_at,
        events_received_count,
        payload
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz, $12, $13::jsonb)
      RETURNING id
      `,
      [
        companyId,
        agentId,
        canonicalDeviceUid,
        deliveryId,
        payload.command_id || null,
        payload.vendor,
        payload.ingest_method,
        payload.cursor.requested_since_utc,
        payload.cursor.latest_event_time_utc,
        payload.pull_started_at,
        payload.pull_completed_at,
        payload.events.length,
        JSON.stringify({
          run_id: payload.run_id || null,
          delivery_id: deliveryId,
          delivery_attempt: deliveryAttempt,
          summary: payload.summary || {},
          cursor: payload.cursor,
          events: payload.events
        })
      ]
    );
    const batchId = batchRes.rows[0].id;
    const realtimePolicy = resolveK80Rt01f4RealtimePolicy(canonicalDeviceUid);
    const isRealtimeIngest = payload.ingest_method === 'agent_realtime';

    let insertedCount = 0;
    let dedupedCount = 0;
    let rejectedCount = 0;
      let realtimeProvisionalReconciledByPull = 0;
      const rejectionSamples = [];
      const eventTimesSeen = [];
      const insertedEventTimesSeen = [];
      let latestEventLocal = null;
      let k80RtIngestInsertPathEntered = false;
      let k80RtIngestInsertPathSkipped = false;
      let k80RtIngestInsertPathSkipReason = null;

    for (const event of payload.events) {
      const provider = payload.vendor;
      const requireMappings = !isRealtimeIngest && shouldRequireIdentityMappingForProvider(provider);
      const personResolution = await resolvePersonIdForIdentifier(db, {
        companyId,
        provider,
        identifierType: 'pin',
        identifierValue: event.device_person_id,
        requireMappings
      });
      if (!isRealtimeIngest && personResolution.error === 'identity_mapping_missing') {
        rejectedCount += 1;
        if (rejectionSamples.length < 50) {
          rejectionSamples.push({
            code: 'identity_mapping_missing',
            device_person_id: event.device_person_id,
            event_time_utc: event.event_time_utc
          });
        }
        continue;
      }

        const personId = personResolution.person_id || (isRealtimeIngest ? null : event.device_person_id);
        if (isRealtimeIngest) {
          if (!realtimePolicy.enabled) {
            k80RtIngestInsertPathSkipped = true;
            k80RtIngestInsertPathSkipReason = 'k80_rt_ingest_policy_disabled';
            eventTimesSeen.push(event.event_time_utc);
            latestEventLocal = event.event_time_local;
            continue;
          }
          k80RtIngestInsertPathEntered = true;
          const rawEvent = isPlainObject(event.raw) ? event.raw : {};
          const ingestChronologyUtc = new Date().toISOString();
        const sourceMetadata = {
          ingest_method: payload.ingest_method,
          run_id: payload.run_id || null,
          delivery_id: deliveryId,
          delivery_attempt: deliveryAttempt,
          mapped_person_id: personId,
          mapping_applied: personResolution.applied === true,
          mapping_reason: personResolution.reason || personResolution.error || null,
          parser: normalizeText(rawEvent.parser) || null,
          k80_rt_basis: normalizeText(rawEvent.k80_rt_basis) || null,
          k80_rt_person_parse_required: rawEvent.k80_rt_person_parse_required === true,
          k80_rt_person_parse_ok: rawEvent.k80_rt_person_parse_ok === true,
          k80_rt_person_parse_value: rawEvent.k80_rt_person_parse_value || null,
          k80_rt_correlation_source: rawEvent.k80_rt_correlation_source || null,
          k80_rt_correlation_confidence: rawEvent.k80_rt_correlation_confidence || null,
          rt_time_contract_version: 'dual_time_v1',
          rt_time_observed_basis: 'decoded_device_time_provisional',
          rt_time_observed_trust: 'untrusted',
          rt_time_decoded_basis: normalizeText(rawEvent.k80_rt_basis) || normalizeText(rawEvent.parser) || null,
          rt_time_decoded_local: event.event_time_local || null,
          rt_time_decoded_utc: event.event_time_utc || null,
          rt_time_chronology_utc: ingestChronologyUtc,
          rt_time_chronology_source: 'server_ingest_clock',
          rt_time_wall_clock_event_trust: 'unproven'
        };
        const rawPayload = {
          source: payload.ingest_method,
          run_id: payload.run_id || null,
          command_id: payload.command_id || null,
          cursor: payload.cursor,
          event: event
        };
        const insertRes = await db.query(
          `
          INSERT INTO device_realtime_direction_observations (
            company_id,
            agent_id,
            device_uid,
            batch_id,
            command_id,
            vendor,
            observed_at_utc,
            observed_at_local,
            device_timezone,
            device_person_id,
            person_id,
            rt_state_code,
            rt_state_label_provisional,
            direction_provisional,
            confidence,
            source,
            source_metadata,
            raw_payload
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, $11,
            $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb
          )
          ON CONFLICT DO NOTHING
          RETURNING id
          `,
          [
            companyId,
            agentId,
            canonicalDeviceUid,
            batchId,
            payload.command_id || null,
            payload.vendor,
            event.event_time_utc,
            event.event_time_local,
            event.device_timezone,
            event.device_person_id || null,
            personId,
            rawEvent.k80_rt_state_code || null,
            rawEvent.k80_rt_state_label_provisional || null,
            event.direction || null,
            rawEvent.k80_rt_correlation_confidence || null,
            rawEvent.k80_rt_basis || rawEvent.parser || null,
            JSON.stringify(sourceMetadata),
            JSON.stringify(rawPayload)
          ]
        );
        if (insertRes.rowCount === 1) {
          insertedCount += 1;
        } else {
          dedupedCount += 1;
        }
        eventTimesSeen.push(event.event_time_utc);
        latestEventLocal = event.event_time_local;
        continue;
      }

      const dedupKey = normalizeText(event.dedup_key) || buildDedupKey({
        vendor: payload.vendor,
        deviceUid: canonicalDeviceUid,
        devicePersonId: event.device_person_id,
        eventTimeUtc: event.event_time_utc,
        direction: event.direction,
        verifyState: event.verify_state || '',
        verifyMethod: event.verify_method || ''
      });

      const rawPayload = {
        source: payload.ingest_method,
        run_id: payload.run_id || null,
        command_id: payload.command_id || null,
        cursor: payload.cursor,
        event: event.raw || {}
      };

      const sourceMetadata = {
        ingest_method: payload.ingest_method,
        mapped_person_id: personId,
        mapping_applied: personResolution.applied === true,
        mapping_reason: personResolution.reason || null
      };
      if (payload.ingest_method === 'agent_pull') {
        const eventRaw = isPlainObject(event.raw) ? event.raw : {};
        const directionBasisValue = Object.prototype.hasOwnProperty.call(eventRaw, 'status_code')
          ? eventRaw.status_code
          : null;
        sourceMetadata.direction_contract_version =
          normalizeText(eventRaw.direction_provenance_contract_version) || 'pull_direction_provenance_v1';
        sourceMetadata.direction_source_lane =
          normalizeText(eventRaw.direction_source_lane) || 'pull_attlog_status';
        sourceMetadata.direction_basis =
          normalizeText(eventRaw.direction_basis) || 'attendance_status_map';
        sourceMetadata.direction_basis_field =
          normalizeText(eventRaw.direction_basis_field) || 'status_code';
        sourceMetadata.direction_basis_value = directionBasisValue;
        sourceMetadata.direction_flattened_value = normalizeText(event.direction) || null;
        sourceMetadata.direction_authority =
          normalizeText(eventRaw.direction_authority) || 'non_authoritative';
        sourceMetadata.direction_confidence =
          normalizeText(eventRaw.direction_confidence) || 'low';
      }

      if (payload.ingest_method === 'agent_pull' && realtimePolicy.enabled) {
        const reconcileRes = await db.query(
          `
          SELECT id
          FROM device_events
          WHERE company_id = $1
            AND device_uid = $2
            AND ingest_method = 'agent_realtime'
            AND device_person_id = $3
            AND direction = $4
            AND ABS(EXTRACT(EPOCH FROM (event_time_utc - $5::timestamptz)) * 1000.0) <= $6
            AND COALESCE(source_metadata->>'reconciled_by_pull', 'false') <> 'true'
          ORDER BY ABS(EXTRACT(EPOCH FROM (event_time_utc - $5::timestamptz)) * 1000.0) ASC, event_time_utc ASC
          LIMIT 1
          FOR UPDATE
          `,
          [
            companyId,
            canonicalDeviceUid,
            event.device_person_id,
            event.direction,
            event.event_time_utc,
            realtimePolicy.reconcile_window_ms
          ]
        );
        const reconcileTarget = reconcileRes.rows[0] || null;
        if (reconcileTarget && reconcileTarget.id) {
          await db.query(
            `
            UPDATE device_events
            SET source_metadata = COALESCE(source_metadata, '{}'::jsonb) || $1::jsonb
            WHERE id = $2
            `,
            [
              JSON.stringify({
                reconciled_by_pull: true,
                reconciled_by_pull_batch_id: batchId,
                reconciled_by_pull_command_id: payload.command_id || null,
                reconciled_by_pull_event_time_utc: event.event_time_utc,
                reconciled_by_pull_at: new Date().toISOString()
              }),
              reconcileTarget.id
            ]
          );
          dedupedCount += 1;
          realtimeProvisionalReconciledByPull += 1;
          eventTimesSeen.push(event.event_time_utc);
          latestEventLocal = event.event_time_local;
          continue;
        }
      }

      const insertRes = await db.query(
        `
        INSERT INTO device_events (
          company_id,
          person_id,
          event_time_utc,
          direction,
          vendor,
          device_uid,
          raw_payload,
          source_agent_id,
          ingest_method,
          dedup_key,
          received_at,
          event_time_local,
          device_timezone,
          device_person_id,
          verify_state,
          verify_method,
          source_metadata
        )
        VALUES (
          $1, $2, $3::timestamptz, $4, $5, $6, $7::jsonb, $8, $9, $10, now(), $11, $12, $13, $14, $15, $16::jsonb
        )
        ON CONFLICT DO NOTHING
        RETURNING id
        `,
        [
          companyId,
          personId,
          event.event_time_utc,
          event.direction,
          payload.vendor,
          canonicalDeviceUid,
          JSON.stringify(rawPayload),
          agentId,
          payload.ingest_method,
          dedupKey,
          event.event_time_local,
          event.device_timezone,
          event.device_person_id,
          event.verify_state,
          event.verify_method,
          JSON.stringify(sourceMetadata)
        ]
      );

      if (insertRes.rowCount === 1) {
        insertedCount += 1;
        insertedEventTimesSeen.push(event.event_time_utc);
        const insertedFactId = normalizeText(insertRes.rows[0] && insertRes.rows[0].id) || null;
        if (insertedFactId) {
          insertedFactEventIds.push(insertedFactId);
        }
        await invalidateAttendanceCache(db, personId, event.event_time_utc, { companyId });
      } else {
        dedupedCount += 1;
      }

      eventTimesSeen.push(event.event_time_utc);
      latestEventLocal = event.event_time_local;
    }

    const latestSeenUtc = getMaxIsoUtc(eventTimesSeen);
    const latestInsertedSeenUtc = getMaxIsoUtc(insertedEventTimesSeen);
    const summaryBaseForCursor = isPlainObject(payload.summary) ? payload.summary : {};
    const summaryDiagnosticsForCursor = isPlainObject(summaryBaseForCursor.diagnostics)
      ? summaryBaseForCursor.diagnostics
      : {};
    const protocolDiagnosticsForCursor = isPlainObject(summaryDiagnosticsForCursor.protocol)
      ? summaryDiagnosticsForCursor.protocol
      : {};
    const cursorSourceFixPolicy = resolveK80CursorSourceFixPolicy({
      deviceUid: canonicalDeviceUid,
      vendor: payload.vendor || 'zkteco',
      protocolDiagnostics: protocolDiagnosticsForCursor
    });
    const originalCursorSourceLayer = 'payload_events_latest_seen_utc';
    const originalCursorSourceValue = latestSeenUtc;
    let effectiveCursorSourceLayer = originalCursorSourceLayer;
    let effectiveCursorSourceValue = originalCursorSourceValue;
    let cursorSourceFixEntered = false;
    if (cursorSourceFixPolicy.enabled && !isRealtimeIngest) {
      cursorSourceFixEntered = true;
      if (latestInsertedSeenUtc) {
        effectiveCursorSourceLayer = 'inserted_events_latest_seen_utc';
        effectiveCursorSourceValue = latestInsertedSeenUtc;
      } else {
        effectiveCursorSourceLayer = 'cursor_hold_no_inserted_rows';
        effectiveCursorSourceValue = null;
      }
    }
    let cursorBlockerClassification = 'insufficient_evidence';
    if (!cursorSourceFixPolicy.enabled) {
      cursorBlockerClassification = 'cursor_fix_not_entered';
    } else if (!cursorSourceFixEntered) {
      cursorBlockerClassification = 'cursor_fix_not_entered';
    } else if (normalizeText(effectiveCursorSourceValue) === normalizeText(originalCursorSourceValue)
      && normalizeText(effectiveCursorSourceLayer) === normalizeText(originalCursorSourceLayer)) {
      cursorBlockerClassification = 'cursor_fix_no_effect';
    } else if ((payload.events || []).length > 1) {
      cursorBlockerClassification = 'more_rows_survive_after_cursor_fix';
    } else {
      cursorBlockerClassification = 'cursor_fix_applied';
    }

    const pullOk = !isPlainObject(payload.summary) || payload.summary.pull_ok !== false;
    let batchStatus = 'accepted';
    if (payload.events.length === 0) {
      batchStatus = pullOk ? 'accepted' : 'rejected';
    } else if (rejectedCount >= payload.events.length) {
      batchStatus = 'rejected';
    } else if (rejectedCount > 0) {
      batchStatus = 'partial';
    }
    let historyDrainMetadataPatch = null;
    let historyDrainAutoProgressionAttempted = false;
    let historyDrainAutoProgressionOccurred = false;
    let historyDrainAutoProgressionNextCommandId = null;
    let historyDrainAutoProgressionSkipReason = null;
    if (historyDrainModeRecognized) {
      const boundaryUsed = {
        boundary_before_utc_exclusive: queuedHistoryBeforeUtc || currentHistoryDrainState.boundary_before_utc_exclusive,
        boundary_before_dedup_key_exclusive: queuedHistoryBeforeDedupKey || currentHistoryDrainState.boundary_before_dedup_key_exclusive
      };
      const nextBoundary = resolveOldestHistoryBoundaryTuple(payload.events);
      const currentFingerprint = buildHistoryDrainPageFingerprint(payload.events);
      const previousFingerprint = normalizeText(currentHistoryDrainState.last_page_fingerprint) || null;
      let noProgressPages = currentHistoryDrainState.no_progress_pages;
      let sentTimeoutRetries = currentHistoryDrainState.sent_timeout_retries;
      let status = 'running';
      let stopReason = null;
      let boundaryBeforeUtcExclusive = boundaryUsed.boundary_before_utc_exclusive || null;
      let boundaryBeforeDedupKeyExclusive = boundaryUsed.boundary_before_dedup_key_exclusive || null;

      if (batchStatus === 'accepted') {
        if (!Array.isArray(payload.events) || payload.events.length === 0 || !nextBoundary) {
          status = 'stopped';
          stopReason = 'history_exhausted';
        } else {
          boundaryBeforeUtcExclusive = nextBoundary.boundary_before_utc_exclusive;
          boundaryBeforeDedupKeyExclusive = nextBoundary.boundary_before_dedup_key_exclusive;
          const boundaryUnchanged = isSameHistoryBoundaryTuple(nextBoundary, boundaryUsed);
          const fingerprintUnchanged = Boolean(previousFingerprint)
            && previousFingerprint === currentFingerprint;
          if (boundaryUnchanged && fingerprintUnchanged) {
            noProgressPages += 1;
          } else {
            noProgressPages = 0;
            sentTimeoutRetries = 0;
          }
          const noProgressLimit = historyDrainPolicy && Number.isInteger(historyDrainPolicy.no_progress_pages_limit)
            ? historyDrainPolicy.no_progress_pages_limit
            : 3;
          const duplicateReplayLimit = historyDrainPolicy && Number.isInteger(historyDrainPolicy.duplicate_replay_pages_limit)
            ? historyDrainPolicy.duplicate_replay_pages_limit
            : noProgressLimit;
          const duplicateReplayLikely = boundaryUnchanged
            && fingerprintUnchanged
            && insertedCount === 0
            && dedupedCount > 0;
          if (duplicateReplayLikely && noProgressPages >= duplicateReplayLimit) {
            status = 'stopped';
            stopReason = 'duplicate_replay';
          } else if (noProgressPages >= noProgressLimit) {
            status = 'stopped';
            stopReason = 'no_progress';
          }
        }
      }

      historyDrainMetadataPatch = {
        session_id: currentHistoryDrainState.session_id || crypto.randomUUID(),
        status,
        boundary_before_utc_exclusive: boundaryBeforeUtcExclusive || null,
        boundary_before_dedup_key_exclusive: boundaryBeforeDedupKeyExclusive || null,
        last_page_fingerprint: currentFingerprint || previousFingerprint || null,
        no_progress_pages: noProgressPages,
        sent_timeout_retries: sentTimeoutRetries,
        last_command_id: payload.command_id || currentHistoryDrainState.last_command_id || null,
        last_batch_id: batchId,
        stop_reason: stopReason,
        updated_at: new Date().toISOString()
      };

      if (
        batchStatus === 'accepted'
        && status === 'running'
      ) {
        historyDrainAutoProgressionAttempted = true;
        if (!boundaryBeforeUtcExclusive || !boundaryBeforeDedupKeyExclusive) {
          historyDrainAutoProgressionSkipReason = 'missing_next_boundary_tuple';
        } else {
          const inFlightRes = await db.query(
            `
            SELECT
              id,
              COALESCE(command_payload->'pull'->>'history_mode', 'normal') AS history_mode
            FROM agent_commands
            WHERE company_id = $1
              AND agent_id = $2
              AND command_type = $3
              AND status IN ('queued', 'sent')
              AND COALESCE(command_payload->>'device_uid', '') = $4
              AND id <> COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            `,
            [companyId, agentId, COMMAND_TYPES.PULL_DEVICE_EVENTS, canonicalDeviceUid, payload.command_id || null]
          );
          const inFlightRows = inFlightRes.rows || [];
          const hasNormalInFlight = inFlightRows.some(row => normalizeText(row.history_mode).toLowerCase() !== 'history_drain');
          if (hasNormalInFlight) {
            historyDrainAutoProgressionSkipReason = 'normal_pull_inflight';
          } else if (inFlightRows.length > 0) {
            historyDrainAutoProgressionSkipReason = 'drain_pull_inflight';
          } else if (!isPlainObject(queuedCommandPayload) || !isPlainObject(queuedCommandPayload.pull)) {
            historyDrainAutoProgressionSkipReason = 'missing_queued_command_payload';
          } else {
            const queuedPull = parseJson(queuedCommandPayload.pull);
            const nextPull = {
              ...queuedPull,
              requested_since_utc: null,
              requested_since_utc_source: 'history_drain_unbounded',
              requested_since_utc_original: null,
              requested_since_utc_bypass_source: 'history_drain_unbounded',
              requested_since_utc_bypass_value: null,
              requested_since_utc_queue_bypass_entered: false,
              requested_since_utc_queue_bypass_reason: null,
              requested_since_utc_effective_source: 'history_drain_unbounded',
              requested_since_utc_source_fix_entered: false,
              history_mode: 'history_drain',
              history_before_utc: boundaryBeforeUtcExclusive,
              history_before_dedup_key: boundaryBeforeDedupKeyExclusive
            };
            const nextCommandPayload = {
              ...queuedCommandPayload,
              device_uid: canonicalDeviceUid,
              ingest_method: 'agent_pull',
              vendor: payload.vendor || queuedCommandPayload.vendor || 'zkteco',
              pull: nextPull,
              connection: parseJson(queuedCommandPayload.connection),
              options: parseJson(queuedCommandPayload.options),
              runtime_context: parseJson(queuedCommandPayload.runtime_context)
            };
            const nextCommandRes = await db.query(
              `
              INSERT INTO agent_commands (
                company_id, agent_id, command_type, command_payload, status, created_by_key_id, expires_at
              )
              VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, now() + ($6::text || ' seconds')::interval)
              RETURNING id
              `,
              [
                companyId,
                agentId,
                COMMAND_TYPES.PULL_DEVICE_EVENTS,
                JSON.stringify(nextCommandPayload),
                queuedCommandCreatedByKeyId,
                String(defaultPullCommandTtlSeconds())
              ]
            );
            historyDrainAutoProgressionOccurred = true;
            historyDrainAutoProgressionNextCommandId = nextCommandRes.rows[0].id;
            historyDrainMetadataPatch.last_command_id = historyDrainAutoProgressionNextCommandId;
            historyDrainMetadataPatch.updated_at = new Date().toISOString();
          }
        }
      }
    }
    const summaryFailureReason = isPlainObject(payload.summary)
      ? normalizeText(payload.summary.failure_reason || payload.summary.pull_failure_reason)
      : '';
    const diagnosticsFailureReason = isPlainObject(payload.summary) && isPlainObject(payload.summary.diagnostics)
      ? normalizeText(payload.summary.diagnostics.failure_reason)
      : '';
    const realtimeProvisionalReceived = payload.ingest_method === 'agent_realtime'
      ? payload.events.length
      : 0;
    const realtimeProvisionalSkippedNoPerson = payload.ingest_method === 'agent_realtime'
      && isPlainObject(payload.summary)
      && isPlainObject(payload.summary.diagnostics)
      && Number.isInteger(payload.summary.diagnostics.realtime_provisional_events_skipped_no_person)
      ? payload.summary.diagnostics.realtime_provisional_events_skipped_no_person
      : 0;
    let realtimeProvisionalLeftUnreconciled = payload.ingest_method === 'agent_realtime'
      ? insertedCount
      : 0;
    let realtimeDualTimeRows = 0;
    let realtimeLegacyTimeRows = 0;
    if (payload.ingest_method === 'agent_realtime') {
      const rtRowsRes = await db.query(
        `
        SELECT source_metadata
        FROM device_realtime_direction_observations
        WHERE company_id = $1
          AND batch_id = $2::uuid
        `,
        [companyId, batchId]
      );
      for (const row of rtRowsRes.rows || []) {
        const contract = parseRtTimeContract(row.source_metadata);
        if (contract.version === 'dual_time_v1') {
          realtimeDualTimeRows += 1;
        } else {
          realtimeLegacyTimeRows += 1;
        }
      }
    }
    if (payload.ingest_method === 'agent_pull' && realtimePolicy.enabled) {
      const unreconciledRes = await db.query(
        `
        SELECT COUNT(*)::int AS count
        FROM device_events
        WHERE company_id = $1
          AND device_uid = $2
          AND ingest_method = 'agent_realtime'
          AND COALESCE(source_metadata->>'reconciled_by_pull', 'false') <> 'true'
        `,
        [companyId, canonicalDeviceUid]
      );
      realtimeProvisionalLeftUnreconciled = Number.isInteger(unreconciledRes.rows[0] && unreconciledRes.rows[0].count)
        ? unreconciledRes.rows[0].count
        : 0;
    }
    const summaryBase = isPlainObject(payload.summary) ? payload.summary : {};
    const summaryDiagnosticsBase = isPlainObject(summaryBase.diagnostics) ? summaryBase.diagnostics : {};
    const historyDrainProtocol = isPlainObject(summaryDiagnosticsBase.protocol)
      ? summaryDiagnosticsBase.protocol
      : null;
    const historyDrainModeRequested = normalizeText(historyDrainProtocol && historyDrainProtocol.zktime_history_mode_requested) || null;
    const historyDrainModeEffective = normalizeText(historyDrainProtocol && historyDrainProtocol.zktime_history_mode_effective) || null;
    const historyDrainPolicyEnabled = historyDrainProtocol && typeof historyDrainProtocol.zktime_history_drain_policy_enabled === 'boolean'
      ? historyDrainProtocol.zktime_history_drain_policy_enabled
      : null;
    const historyDrainModeRecognizedFromProtocol = historyDrainProtocol && typeof historyDrainProtocol.zktime_history_drain_mode_recognized === 'boolean'
      ? historyDrainProtocol.zktime_history_drain_mode_recognized
      : null;
      const summaryWithCounters = {
        ...summaryBase,
        diagnostics: {
          ...summaryDiagnosticsBase,
          realtime_policy_enabled: realtimePolicy.enabled === true,
          realtime_policy_flag_enabled: realtimePolicy.flag_enabled === true,
          realtime_policy_allowlist_size: Number.isInteger(realtimePolicy.allowlist_size)
            ? realtimePolicy.allowlist_size
            : 0,
          realtime_policy_scope_allowed: realtimePolicy.scope_allowed === true,
          k80_rt_ingest_policy_flag_enabled: realtimePolicy.flag_enabled === true,
          k80_rt_ingest_policy_allowlist_applied: Number.isInteger(realtimePolicy.allowlist_size)
            ? realtimePolicy.allowlist_size > 0
            : false,
          k80_rt_ingest_policy_device_match: realtimePolicy.scope_allowed === true,
          k80_rt_ingest_policy_enabled: realtimePolicy.enabled === true,
          k80_rt_ingest_insert_path_entered: k80RtIngestInsertPathEntered === true,
          k80_rt_ingest_insert_path_skipped: k80RtIngestInsertPathSkipped === true,
          k80_rt_ingest_insert_path_skip_reason: normalizeText(k80RtIngestInsertPathSkipReason) || null,
          cursor_source_fix: {
            enabled: cursorSourceFixPolicy.enabled,
            entered: cursorSourceFixEntered,
            original_cursor_source_layer: originalCursorSourceLayer,
          original_cursor_source_value: originalCursorSourceValue,
          effective_cursor_source_layer: effectiveCursorSourceLayer,
          effective_cursor_source_value: effectiveCursorSourceValue,
          queued_requested_since_utc_source: queuedRequestedSinceSource,
          queued_requested_since_utc_value: queuedRequestedSinceUtc,
          queued_requested_since_utc_original_value: queuedRequestedSinceOriginal,
          queued_requested_since_utc_effective_source: queuedRequestedSinceEffectiveSource,
          queued_requested_since_utc_source_fix_entered: queuedRequestedSinceSourceFixEntered,
          blocker_classification: cursorBlockerClassification
        },
        queue_time_cursor_bypass: {
          original_queue_source: queuedRequestedSinceSource,
          original_queue_value: queuedRequestedSinceOriginal,
          entered: syncState.metadata && syncState.metadata._queued_requested_since_queue_bypass_entered === true,
          effective_queue_source: syncState.metadata && syncState.metadata._queued_requested_since_bypass_source
            ? syncState.metadata._queued_requested_since_bypass_source
            : queuedRequestedSinceSource,
          effective_queue_value: syncState.metadata && syncState.metadata._queued_requested_since_bypass_value
            ? syncState.metadata._queued_requested_since_bypass_value
            : queuedRequestedSinceUtc,
          reason_applied: syncState.metadata && syncState.metadata._queued_requested_since_queue_bypass_reason
            ? syncState.metadata._queued_requested_since_queue_bypass_reason
            : null,
          backfill_minutes_used: queuedRequestedSinceQueueBypassBackfillMinutes,
          blocker_classification: (!syncState.metadata || syncState.metadata._queued_requested_since_queue_bypass_entered !== true)
            ? 'queue_bypass_not_entered'
            : (
              normalizeText(syncState.metadata._queued_requested_since_bypass_value) === normalizeText(queuedRequestedSinceOriginal)
                ? 'queue_bypass_no_effect'
                : ((payload.events || []).length > 1 ? 'more_rows_survive_after_queue_bypass' : 'queue_bypass_applied')
            )
        },
        history_drain: {
          mode_requested: historyDrainModeRequested,
          mode_effective: historyDrainModeEffective,
          policy_enabled: historyDrainPolicyEnabled,
          mode_recognized: historyDrainModeRecognizedFromProtocol !== null
            ? historyDrainModeRecognizedFromProtocol
            : historyDrainModeRecognized,
          boundary_before_utc_exclusive_used: queuedHistoryBeforeUtc || currentHistoryDrainState.boundary_before_utc_exclusive || null,
          boundary_before_dedup_key_exclusive_used:
            queuedHistoryBeforeDedupKey || currentHistoryDrainState.boundary_before_dedup_key_exclusive || null,
          state_written: historyDrainMetadataPatch !== null,
          state_status: historyDrainMetadataPatch ? historyDrainMetadataPatch.status : null,
          state_stop_reason: historyDrainMetadataPatch ? historyDrainMetadataPatch.stop_reason : null,
          state_no_progress_pages: historyDrainMetadataPatch ? historyDrainMetadataPatch.no_progress_pages : null,
          state_sent_timeout_retries: historyDrainMetadataPatch ? historyDrainMetadataPatch.sent_timeout_retries : null,
          auto_progression_attempted: historyDrainAutoProgressionAttempted,
          auto_progression_occurred: historyDrainAutoProgressionOccurred,
          auto_progression_next_command_id: historyDrainAutoProgressionNextCommandId,
          auto_progression_skip_reason: historyDrainAutoProgressionSkipReason
        },
        realtime_provisional_events_received: realtimeProvisionalReceived,
        realtime_provisional_events_inserted: payload.ingest_method === 'agent_realtime' ? insertedCount : 0,
        realtime_provisional_events_skipped_no_person: realtimeProvisionalSkippedNoPerson,
        realtime_provisional_events_reconciled_by_pull: realtimeProvisionalReconciledByPull,
        realtime_provisional_events_left_unreconciled: realtimeProvisionalLeftUnreconciled,
        rt_time_contract_version: payload.ingest_method === 'agent_realtime' ? 'dual_time_v1' : null,
        rt_time_observed_basis: payload.ingest_method === 'agent_realtime'
          ? 'decoded_device_time_provisional'
          : null,
        rt_time_observed_trust: payload.ingest_method === 'agent_realtime' ? 'untrusted' : null,
        rt_time_chronology_source: payload.ingest_method === 'agent_realtime' ? 'server_ingest_clock' : null,
        rt_dual_time_rows: payload.ingest_method === 'agent_realtime' ? realtimeDualTimeRows : 0,
        rt_legacy_time_rows: payload.ingest_method === 'agent_realtime' ? realtimeLegacyTimeRows : 0
      }
    };
    const failureReason = rejectionSamples[0]
      ? rejectionSamples[0].code
      : (summaryFailureReason || diagnosticsFailureReason || null);
    const manageabilityTransition = mapPullOutcomeToManageability({
      batchStatus,
      pullOk,
      insertedCount,
      dedupedCount,
      failureReason
    });

    await db.query(
      `
      UPDATE agent_device_event_batches
      SET latest_event_time_utc = $1::timestamptz,
          inserted_count = $2,
          deduped_count = $3,
          rejected_count = $4,
          status = $5,
          failure_reason = $6,
          payload = payload || $7::jsonb
      WHERE id = $8
      `,
      [
        latestSeenUtc,
        insertedCount,
        dedupedCount,
        rejectedCount,
        batchStatus,
        failureReason,
        JSON.stringify({
          rejection_samples: rejectionSamples,
          summary: summaryWithCounters,
          realtime_provisional_events_received: realtimeProvisionalReceived,
          realtime_provisional_events_inserted:
            payload.ingest_method === 'agent_realtime' ? insertedCount : 0,
          realtime_provisional_events_skipped_no_person: realtimeProvisionalSkippedNoPerson,
          realtime_provisional_events_reconciled_by_pull: realtimeProvisionalReconciledByPull,
          realtime_provisional_events_left_unreconciled: realtimeProvisionalLeftUnreconciled
        }),
        batchId
      ]
    );

    const syncStatus = batchStatus === 'rejected' ? 'error' : 'idle';
    const preserveNormalCursor = isRealtimeIngest || historyDrainModeRecognized;
    await db.query(
      `
      UPDATE agent_device_sync_states
      SET status = $1,
          cursor_event_time_utc = CASE
            WHEN $11::boolean THEN cursor_event_time_utc
            WHEN $2::timestamptz IS NULL THEN cursor_event_time_utc
            ELSE GREATEST(COALESCE(cursor_event_time_utc, 'epoch'::timestamptz), $2::timestamptz)
          END,
          last_sync_completed_at = now(),
          last_event_time_utc = CASE
            WHEN $11::boolean THEN last_event_time_utc
            WHEN $2::timestamptz IS NULL THEN last_event_time_utc
            ELSE GREATEST(COALESCE(last_event_time_utc, 'epoch'::timestamptz), $2::timestamptz)
          END,
          last_event_time_local = COALESCE($3, last_event_time_local),
          last_pull_count = $4,
          last_submit_count = $5,
          consecutive_failures = CASE
            WHEN $1 = 'error' THEN consecutive_failures + 1
            ELSE 0
          END,
          failure_reason = CASE
            WHEN $1 = 'error' THEN $6
            ELSE NULL
          END,
          last_error_at = CASE
            WHEN $1 = 'error' THEN now()
            ELSE last_error_at
          END,
          metadata = metadata || $7::jsonb,
          updated_at = now()
      WHERE company_id = $8
        AND agent_id = $9
        AND device_uid = $10
      `,
      [
        syncStatus,
        effectiveCursorSourceValue,
        latestEventLocal,
        payload.events.length,
        insertedCount + dedupedCount,
        failureReason,
        JSON.stringify({
          last_batch_id: batchId,
          last_command_id: payload.command_id || null,
          last_batch_status: batchStatus,
          last_pull_ok: pullOk,
          ...(historyDrainModeRecognized ? {} : { last_latest_event_time_utc: latestSeenUtc }),
          last_ingest_method: payload.ingest_method || null,
          last_summary: isPlainObject(payload.summary) ? payload.summary : {},
          ...(historyDrainMetadataPatch ? { history_drain: historyDrainMetadataPatch } : {})
        }),
        companyId,
        agentId,
        canonicalDeviceUid,
        preserveNormalCursor
      ]
    );

    if (!isRealtimeIngest) {
      const pullCompletedAt = normalizeText(payload.pull_completed_at) || new Date().toISOString();
      const reportedPullStatus = batchStatus === 'accepted'
        ? 'accepted'
        : (batchStatus === 'partial' ? 'partial' : 'rejected');
      const reportedHealthStatus = (pullOk && batchStatus === 'accepted')
        ? 'healthy'
        : (batchStatus === 'partial' ? 'degraded' : 'blocked');
      const reportedHealthReason = failureReason
        || (pullOk && batchStatus === 'accepted' ? 'pull_succeeded' : 'pull_failed');

      await upsertDeviceRuntimeReportedState(db, {
        companyId,
        deviceUid: canonicalDeviceUid,
        siteId: device.site_id || null,
        reportingAgentId: agentId,
        lastPullStatus: reportedPullStatus,
        lastPullReason: failureReason,
        lastSuccessfulPullAt: (pullOk && batchStatus !== 'rejected') ? pullCompletedAt : undefined,
        lastLocalContactAt: pullCompletedAt,
        reportedHealthStatus,
        reportedHealthReason,
        reportedAt: pullCompletedAt,
        metadata: {
          source: 'agent.device_event_batch',
          batch_id: batchId,
          command_id: payload.command_id || null,
          batch_status: batchStatus,
          pull_ok: pullOk
        }
      });

      const normalizedFailureReason = normalizeText(failureReason).toLowerCase();
      if (pullOk && (batchStatus === 'accepted' || batchStatus === 'partial')) {
        await upsertDeviceRuntimeCapabilityReportedState(db, {
          companyId,
          deviceUid: canonicalDeviceUid,
          siteId: device.site_id || null,
          reportingAgentId: agentId,
          capabilityKey: DEVICE_PATH_CAPABILITY_KEYS.PULL_DEVICE_EVENTS,
          capabilityStatus: CAPABILITY_STATUS.SUPPORTED,
          capabilityReason: 'pull_succeeded',
          reportedAt: pullCompletedAt,
          metadata: {
            source: 'agent.device_event_batch',
            batch_id: batchId,
            command_id: payload.command_id || null,
            batch_status: batchStatus,
            pull_ok: pullOk
          }
        });
      } else if (
        normalizedFailureReason === 'device_path_capability_disabled'
        || normalizedFailureReason === 'runtime_capability_disabled'
      ) {
        await upsertDeviceRuntimeCapabilityReportedState(db, {
          companyId,
          deviceUid: canonicalDeviceUid,
          siteId: device.site_id || null,
          reportingAgentId: agentId,
          capabilityKey: DEVICE_PATH_CAPABILITY_KEYS.PULL_DEVICE_EVENTS,
          capabilityStatus: CAPABILITY_STATUS.DISABLED,
          capabilityReason: normalizedFailureReason,
          reportedAt: pullCompletedAt,
          metadata: {
            source: 'agent.device_event_batch',
            batch_id: batchId,
            command_id: payload.command_id || null,
            batch_status: batchStatus,
            pull_ok: pullOk
          }
        });
      } else if (shouldPersistUnsupportedPullCapability(normalizedFailureReason)) {
        await upsertDeviceRuntimeCapabilityReportedState(db, {
          companyId,
          deviceUid: canonicalDeviceUid,
          siteId: device.site_id || null,
          reportingAgentId: agentId,
          capabilityKey: DEVICE_PATH_CAPABILITY_KEYS.PULL_DEVICE_EVENTS,
          capabilityStatus: CAPABILITY_STATUS.UNSUPPORTED,
          capabilityReason: normalizedFailureReason,
          reportedAt: pullCompletedAt,
          metadata: {
            source: 'agent.device_event_batch',
            batch_id: batchId,
            command_id: payload.command_id || null,
            batch_status: batchStatus,
            pull_ok: pullOk
          }
        });
      }

      await updateDeviceManageabilityFromPull(db, {
        companyId,
        deviceUid: canonicalDeviceUid,
        transition: manageabilityTransition,
        proofAtUtc: latestSeenUtc || payload.pull_completed_at || null
      });

      if (latestSeenUtc) {
        await db.query(
          `
          UPDATE devices
          SET last_seen_at = GREATEST(COALESCE(last_seen_at, 'epoch'::timestamptz), $1::timestamptz),
              updated_at = now()
          WHERE company_id = $2
            AND device_uid = $3
          `,
          [latestSeenUtc, companyId, canonicalDeviceUid]
        );
      }
    }

    if (payload.command_id) {
      await db.query(
        `
        UPDATE agent_commands
        SET status = 'acknowledged',
            acknowledged_at = COALESCE(acknowledged_at, now()),
            result_payload = COALESCE(result_payload, '{}'::jsonb) || $1::jsonb
        WHERE id = $2
          AND company_id = $3
          AND agent_id = $4
          AND command_type = $5
        `,
        [
          JSON.stringify({
            batch_id: batchId,
            delivery_id: deliveryId,
            delivery_attempt: deliveryAttempt,
            command_status_before_acknowledge: commandStatusBeforeAcknowledge,
            late_result_after_reconcile: commandStatusBeforeAcknowledge === 'failed'
              || commandStatusBeforeAcknowledge === 'expired',
            batch_status: batchStatus,
            pull_ok: pullOk,
            inserted_count: insertedCount,
            deduped_count: dedupedCount,
            rejected_count: rejectedCount,
            latest_event_time_utc: latestSeenUtc
          }),
          payload.command_id,
          companyId,
          agentId,
          COMMAND_TYPES.PULL_DEVICE_EVENTS
        ]
      );
    }

    await db.query('COMMIT');

    let freshFactAttachmentDiagnostics = null;
    if (!isRealtimeIngest && insertedFactEventIds.length > 0) {
      const attachmentAttemptedAt = new Date().toISOString();
      const attachmentIds = [];
      const failedFactEventIds = [];
      const failureSamples = [];
      let attemptedCount = 0;
      let succeededCount = 0;
      for (const factEventId of insertedFactEventIds) {
        attemptedCount += 1;
        try {
          const derivedRes = await deriveAndUpsertDirectionAttachmentForFactEvent(db, {
            companyId,
            agentId,
            deviceUid: canonicalDeviceUid
          }, {
            factEventId,
            laneSessionId: batchId,
            derivationRunId: `fresh-fact-attachment-${batchId || new Date().toISOString()}`
          });
          const attachmentId = normalizeText(derivedRes && derivedRes.attachment_id) || null;
          if (attachmentId) {
            attachmentIds.push(attachmentId);
          }
          succeededCount += 1;
        } catch (attachmentErr) {
          failedFactEventIds.push(factEventId);
          if (failureSamples.length < 5) {
            failureSamples.push({
              fact_event_id: factEventId,
              error: normalizeText(attachmentErr && attachmentErr.message) || 'unknown_error'
            });
          }
          console.error('fresh_fact_attachment_trigger_failed', {
            company_id: companyId,
            agent_id: agentId,
            device_uid: canonicalDeviceUid,
            batch_id: batchId,
            fact_event_id: factEventId,
            error_name: attachmentErr && attachmentErr.name ? attachmentErr.name : null,
            error_message: attachmentErr && attachmentErr.message ? attachmentErr.message : null
          });
        }
      }
      freshFactAttachmentDiagnostics = {
        k80_fresh_fact_attachment_trigger_seen: true,
        k80_fresh_fact_attachment_attempted_at: attachmentAttemptedAt,
        k80_fresh_fact_attachment_inserted_fact_count: insertedFactEventIds.length,
        k80_fresh_fact_attachment_trigger_attempted_count: attemptedCount,
        k80_fresh_fact_attachment_trigger_succeeded_count: succeededCount,
        k80_fresh_fact_attachment_trigger_failed_count: failedFactEventIds.length,
        k80_fresh_fact_attachment_trigger_success:
          attemptedCount > 0 && failedFactEventIds.length === 0,
        k80_fresh_fact_attachment_attachment_ids: attachmentIds,
        k80_fresh_fact_attachment_failed_fact_event_ids: failedFactEventIds,
        k80_fresh_fact_attachment_failure_samples: failureSamples
      };
      await appendBatchDiagnostics(db, {
        batchId,
        diagnostics: freshFactAttachmentDiagnostics
      });
    }

    let postPunchTriggerDiagnostics = null;
    if (isRealtimeIngest) {
      postPunchTriggerDiagnostics = await maybeQueuePostPunchFactAnchorPull(db, {
        companyId,
        agentId,
        deviceUid: canonicalDeviceUid,
        vendor: payload.vendor || 'zkteco',
        batchId,
        insertedRealtimeRows: insertedCount
      });
      if (isPlainObject(postPunchTriggerDiagnostics)) {
        await appendBatchDiagnostics(db, {
          batchId,
          diagnostics: postPunchTriggerDiagnostics
        });
        await persistPostPunchTriggerState(db, {
          companyId,
          agentId,
          deviceUid: canonicalDeviceUid,
          triggerState: {
            last_attempt_at: postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_last_attempt_at || null,
            last_batch_id: batchId,
            last_trigger_seen: postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_trigger_seen === true,
            last_policy_enabled: postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_policy_enabled === true,
            last_queue_attempted: postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_queue_attempted === true,
            last_queue_succeeded: postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_queue_succeeded === true,
            last_queue_suppressed_reason:
              normalizeText(postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_queue_suppressed_reason) || null,
            last_queue_error:
              normalizeText(postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_queue_error) || null,
            last_queued_command_id:
              normalizeText(postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_queued_command_id) || null
          }
        });
      }
    }

    logBridgeEvent('bridge.events.batch.ingested', {
      company_id: companyId,
      agent_id: agentId,
      device_uid: canonicalDeviceUid,
      requested_device_uid: canonicalResolution.requested_device_uid,
      canonical_resolved_by: canonicalResolution.resolved_by,
      canonical_alias_kind: canonicalResolution.alias_kind,
      canonical_alias_status: canonicalResolution.alias_status,
      batch_id: batchId,
      delivery_id: deliveryId,
      command_id: payload.command_id || null,
      batch_status: batchStatus,
      pull_ok: pullOk,
      manageability_status: manageabilityTransition.status,
      manageability_reason: manageabilityTransition.reason,
      inserted_count: insertedCount,
      deduped_count: dedupedCount,
      rejected_count: rejectedCount,
      latest_event_time_utc: latestSeenUtc,
      post_punch_fact_anchor_trigger_seen:
        isPlainObject(postPunchTriggerDiagnostics)
          ? postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_trigger_seen === true
          : false,
      post_punch_fact_anchor_queue_attempted:
        isPlainObject(postPunchTriggerDiagnostics)
          ? postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_queue_attempted === true
          : false,
      post_punch_fact_anchor_queue_succeeded:
        isPlainObject(postPunchTriggerDiagnostics)
          ? postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_queue_succeeded === true
          : false,
      post_punch_fact_anchor_queue_suppressed_reason:
        isPlainObject(postPunchTriggerDiagnostics)
          ? postPunchTriggerDiagnostics.k80_post_punch_fact_anchor_queue_suppressed_reason || null
          : null,
      fresh_fact_attachment_attempted:
        isPlainObject(freshFactAttachmentDiagnostics)
          ? freshFactAttachmentDiagnostics.k80_fresh_fact_attachment_trigger_attempted_count || 0
          : 0,
      fresh_fact_attachment_succeeded:
        isPlainObject(freshFactAttachmentDiagnostics)
          ? freshFactAttachmentDiagnostics.k80_fresh_fact_attachment_trigger_succeeded_count || 0
          : 0,
      fresh_fact_attachment_failed:
        isPlainObject(freshFactAttachmentDiagnostics)
          ? freshFactAttachmentDiagnostics.k80_fresh_fact_attachment_trigger_failed_count || 0
          : 0
    });
    return {
      value: {
        ...buildBatchResultFromRow({
          id: batchId,
          delivery_id: deliveryId,
          status: batchStatus,
          inserted_count: insertedCount,
          deduped_count: dedupedCount,
          rejected_count: rejectedCount,
          latest_event_time_utc: latestSeenUtc,
          payload: {
            summary: payload.summary || {},
            rejection_samples: rejectionSamples
          }
        }, {
          manageabilityStatus: manageabilityTransition.status,
          manageabilityReason: manageabilityTransition.reason,
          replayedDelivery: false
        })
      }
    };
  } catch (err) {
    const stage = insertAttempted ? 'during_insert' : 'before_insert';
    const capture = {
      ...ingestTrace,
      stage,
      error_name: err && err.name ? err.name : null,
      error_message: err && err.message ? err.message : null,
      error_stack: err && err.stack ? err.stack : null
    };
    console.error('ingest_agent_event_batch_exception', capture);
    await db.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  queuePullDeviceEventsCommand,
  queueDevicePathPullCapabilityRefreshCommand,
  listDeviceSyncStates,
  listDeviceEventBatches,
  listRecentDeviceEvents,
  ingestAgentEventBatch,
  ingestDevicePathPullCapabilityProbeResult,
  PULL_COMMAND_INFLIGHT_ERROR,
  __test: {
    shiftIsoMinutes,
    resolveConnectionHost,
    resolveConnectionPort,
    resolveConnectionTransport,
    resolveConnectionAuthPassword,
    resolveConnectionAttlogSequence,
    resolveConnectionDeviceNumber,
    parseIntegerField,
    getMaxIsoUtc,
    resolveCanonicalDeviceUid,
    summarizeRealtimeBatchDiagnostics
  }
};
