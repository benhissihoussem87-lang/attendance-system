const { hashSecret, randomToken, normalizeText } = require('./agentAuth');
const { COMMAND_TYPES, MANAGED_STATUS } = require('../contracts/agentBridgeContract');
const { logBridgeEvent } = require('./bridgeLogger');
const {
  MANAGEABILITY_STATUS,
  MANUAL_REMEDIATION_STATUS,
  mapDiscoveryOutcomeToManageability
} = require('./deviceManageability');
const {
  defaultSiteRuntimeReportedStaleMinutes,
  defaultDeviceRuntimeReportedStaleMinutes,
  toSiteRuntimeReportedReadModel,
  toDeviceRuntimeReportedReadModel,
  getDeviceRuntimeReportedState,
  ensureCapabilityReportingSchemaReady,
  upsertDeviceRuntimeReportedState,
  upsertSiteRuntimeReportedStateFromAgent,
  upsertAgentRuntimeCapabilityReportedState,
  upsertDeviceRuntimeCapabilityReportedState
} = require('./reportedStateDb');
const {
  defaultAgentVersionReportedStaleMinutes,
  evaluateAgentVersionSupport,
  normalizeRolloutChannel
} = require('./versionGovernance');
const {
  getEffectiveAgentVersionPolicy,
  upsertCompanyAgentVersionPolicy,
  upsertAgentRuntimeVersionReportedState,
  extractVersionReportFromHeartbeatPayload
} = require('./versionGovernanceDb');
const {
  evaluateCommandIssuanceGate,
  evaluateCommandAcceptanceGate
} = require('./executionGating');
const {
  CAPABILITY_STATUS,
  RUNTIME_CAPABILITY_KEYS,
  DEVICE_PATH_CAPABILITY_KEYS,
  parseCapabilityReportMap
} = require('../contracts/capabilityContract');

const COMMAND_STATUS = Object.freeze({
  QUEUED: 'queued',
  SENT: 'sent',
  ACKNOWLEDGED: 'acknowledged',
  FAILED: 'failed',
  EXPIRED: 'expired'
});

const COMMAND_FAILURE_REASON = Object.freeze({
  EXPIRED: 'command_expired',
  SENT_TIMEOUT: 'sent_timeout'
});

const MANUAL_VALIDATION_STATUS = Object.freeze({
  NEVER_RUN: 'never_run',
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  FAILED: 'failed',
  SUCCEEDED: 'succeeded'
});

const MANUAL_ONBOARDING_STATE = Object.freeze({
  CANDIDATE_UNCONFIGURED: 'candidate_unconfigured',
  CANDIDATE_CONFIGURED: 'candidate_configured',
  VALIDATION_FAILED: 'validation_failed',
  VALIDATION_SUCCEEDED: 'validation_succeeded',
  MANAGED_UNBOUND: 'managed_unbound',
  MANAGED_PULL_READY: 'managed_pull_ready'
});

const LIFECYCLE_REQUIRED_MIGRATIONS = Object.freeze([
  '20260318_device_lifecycle_coherence_phase2_slice21.sql',
  '20260318_device_lifecycle_coherence_phase2_slice25.sql'
]);

const LIFECYCLE_INTEGRITY_STRICT_CHECKS = Object.freeze([
  {
    check_name: 'superseded_without_canonical',
    description: 'Superseded device rows missing superseded_by_device_uid redirect.'
  },
  {
    check_name: 'canonical_with_superseded_pointer',
    description: 'Canonical device rows carrying a superseded_by_device_uid pointer.'
  },
  {
    check_name: 'managed_bridge_missing_active_binding',
    description: 'Managed bridge_ops devices missing an active managing-agent binding.'
  },
  {
    check_name: 'active_binding_on_non_bridge_or_non_managed_device',
    description: 'Active managing-agent bindings attached to non-bridge or non-managed devices.'
  },
  {
    check_name: 'canonical_device_missing_active_device_uid_alias',
    description: 'Canonical devices missing active self device_uid aliases.'
  },
  {
    check_name: 'active_alias_points_to_superseded_canonical',
    description: 'Active aliases still pointing to superseded canonical device rows.'
  }
]);

const LIFECYCLE_INTEGRITY_ADVISORY_CHECKS = Object.freeze([
  {
    check_name: 'ingest_only_with_bridge_evidence_advisory',
    description: 'Ingest-only rows that already carry bridge-operational evidence.'
  },
  {
    check_name: 'active_serial_alias_multi_canonical_advisory',
    description: 'Active serial aliases mapped to multiple canonical device_uids.'
  },
  {
    check_name: 'active_mac_alias_multi_canonical_advisory',
    description: 'Active MAC aliases mapped to multiple canonical device_uids.'
  }
]);

const LIFECYCLE_REPAIR_SUPPORTED_ANOMALY = 'canonical_device_missing_active_device_uid_alias';
const LIFECYCLE_REPAIR_SUPPORTED_ANOMALIES = Object.freeze([
  LIFECYCLE_REPAIR_SUPPORTED_ANOMALY
]);

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return parsed;
}

function buildAgentVersionGovernanceProjection(row, effectivePolicy, { staleMinutes } = {}) {
  const policy = (effectivePolicy && typeof effectivePolicy === 'object')
    ? effectivePolicy
    : {
        minimum_supported_version: '0.0.0',
        target_version: null,
        rollout_channel: 'stable',
        policy_source: 'global'
      };

  const versionEvaluation = evaluateAgentVersionSupport({
    reportedVersion: row && row.agent_reported_version,
    reportedAt: row && row.agent_version_reported_at,
    minimumSupportedVersion: policy.minimum_supported_version,
    targetVersion: policy.target_version,
    staleMinutes
  });

  return {
    agent_reported_version: versionEvaluation.reported_version,
    agent_reported_rollout_channel: normalizeRolloutChannel(
      row && row.agent_reported_rollout_channel,
      null
    ),
    agent_version_reported_at: versionEvaluation.reported_at,
    version_support_status: versionEvaluation.support_status,
    version_support_level: versionEvaluation.support_level,
    version_support_reason: versionEvaluation.support_reason,
    version_reported_stale: versionEvaluation.reported_stale,
    version_stale_after_minutes: versionEvaluation.stale_after_minutes,
    minimum_supported_version: versionEvaluation.minimum_supported_version
      || normalizeText(policy.minimum_supported_version)
      || null,
    target_version: versionEvaluation.target_version,
    policy_rollout_channel: normalizeRolloutChannel(policy.rollout_channel, 'stable'),
    version_policy_source: normalizeText(policy.policy_source).toLowerCase() || 'global'
  };
}

function defaultSentStaleSeconds() {
  return parsePositiveInt(process.env.PULL_COMMAND_SENT_STALE_SECONDS, 300);
}

function defaultValidationCommandTtlSeconds() {
  return parsePositiveInt(process.env.DEVICE_VALIDATION_COMMAND_TTL_SECONDS, 900);
}

function defaultValidationSentStaleSeconds() {
  return parsePositiveInt(process.env.DEVICE_VALIDATION_COMMAND_SENT_STALE_SECONDS, 300);
}

function defaultEnrollmentCommandTtlSeconds() {
  return parsePositiveInt(process.env.K80_ENROLLMENT_COMMAND_TTL_SECONDS, 1800);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeVendor(value) {
  return normalizeText(value).toLowerCase() || 'unknown';
}

function normalizeSerial(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeMac(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return '';
  const clean = raw.replace(/[^a-f0-9]/g, '');
  if (clean.length !== 12) {
    return raw;
  }
  return clean.match(/.{1,2}/g).join(':');
}

function buildDeviceUid(candidate) {
  const serial = normalizeSerial(candidate.serial_number);
  const mac = normalizeMac(candidate.mac);
  const ip = normalizeText(candidate.ip);
  const vendor = normalizeVendor(candidate.vendor);
  const direct = normalizeText(candidate.device_uid);

  if (serial) return `${vendor}:sn:${serial}`;
  if (mac) return `${vendor}:mac:${mac}`;
  if (direct) return direct;
  return `${vendor}:ip:${ip}`;
}

function extractStableIdentity(candidate) {
  return {
    vendor: normalizeVendor(candidate.vendor),
    serial_number: normalizeSerial(candidate.serial_number),
    mac: normalizeMac(candidate.mac)
  };
}

function isIpBasedUid(uid, vendor) {
  const normalizedUid = normalizeText(uid).toLowerCase();
  return normalizedUid.startsWith(`${vendor}:ip:`);
}

function isStableUid(uid, vendor) {
  const normalizedUid = normalizeText(uid).toLowerCase();
  return normalizedUid.startsWith(`${vendor}:sn:`) || normalizedUid.startsWith(`${vendor}:mac:`);
}

async function findExistingByStableIdentity(db, { companyId, identity }) {
  const serialUid = identity.serial_number ? `${identity.vendor}:sn:${identity.serial_number}` : '';
  const macUid = identity.mac ? `${identity.vendor}:mac:${identity.mac}` : '';
  const res = await db.query(
    `
    SELECT device_uid, managed_status
    FROM devices
    WHERE company_id = $1
      AND (
        ($2 <> '' AND (
          lower(device_uid) = lower($3)
          OR lower(COALESCE(discovery_metadata->>'serial_number', '')) = lower($2)
          OR lower(COALESCE(metadata->>'serial_number', '')) = lower($2)
        ))
        OR
        ($4 <> '' AND (
          lower(device_uid) = lower($5)
          OR lower(COALESCE(discovery_metadata->>'mac', '')) = lower($4)
          OR lower(COALESCE(metadata->>'mac', '')) = lower($4)
        ))
      )
    ORDER BY
      CASE managed_status
        WHEN 'managed' THEN 0
        WHEN 'candidate' THEN 1
        ELSE 2
      END,
      updated_at DESC
    LIMIT 1
    `,
    [
      companyId,
      identity.serial_number,
      serialUid,
      identity.mac,
      macUid
    ]
  );
  return res.rows[0] || null;
}

async function findDeviceByUid(db, { companyId, deviceUid }) {
  const normalizedDeviceUid = normalizeText(deviceUid);
  if (!normalizedDeviceUid) {
    return null;
  }
  const res = await db.query(
    `
    SELECT
      company_id,
      device_uid,
      managed_status,
      identity_status,
      superseded_by_device_uid,
      discovery_status,
      discovered_by_agent_id,
      manageability_status,
      manageability_reason,
      discovery_metadata
    FROM devices
    WHERE company_id = $1
      AND device_uid = $2
    LIMIT 1
    `,
    [companyId, normalizedDeviceUid]
  );
  return res.rows[0] || null;
}

function deriveVendorFromDeviceUid(deviceUid, fallbackVendor = '') {
  const normalizedDeviceUid = normalizeText(deviceUid);
  if (!normalizedDeviceUid) {
    return normalizeVendor(fallbackVendor);
  }
  const token = normalizedDeviceUid.split(':')[0];
  return normalizeVendor(token || fallbackVendor);
}

async function upsertDeviceIdentityAlias(db, {
  companyId,
  canonicalDeviceUid,
  aliasKind,
  vendor,
  aliasValueNormalized,
  status,
  observedAt,
  metadata
}) {
  const normalizedCompanyId = normalizeText(companyId);
  const normalizedCanonicalDeviceUid = normalizeText(canonicalDeviceUid);
  const normalizedAliasKind = normalizeText(aliasKind).toLowerCase();
  const normalizedAliasValue = normalizeText(aliasValueNormalized);
  if (!normalizedCompanyId || !normalizedCanonicalDeviceUid || !normalizedAliasKind || !normalizedAliasValue) {
    return null;
  }

  const normalizedStatus = normalizeText(status).toLowerCase();
  const safeStatus = normalizedStatus === 'superseded' || normalizedStatus === 'retired'
    ? normalizedStatus
    : 'active';
  const safeVendor = normalizeVendor(vendor);
  const safeObservedAt = normalizeText(observedAt) || null;
  const safeMetadata = isPlainObject(metadata) ? metadata : {};

  const res = await db.query(
    `
    INSERT INTO device_identity_aliases (
      company_id,
      canonical_device_uid,
      alias_kind,
      vendor,
      alias_value_normalized,
      status,
      first_seen_at,
      last_seen_at,
      metadata
    )
    VALUES (
      $1, $2, $3, $4, $5, $6,
      COALESCE($7::timestamptz, now()),
      COALESCE($7::timestamptz, now()),
      $8::jsonb
    )
    ON CONFLICT (company_id, alias_kind, vendor, alias_value_normalized) DO UPDATE
      SET canonical_device_uid = EXCLUDED.canonical_device_uid,
          status = EXCLUDED.status,
          last_seen_at = GREATEST(device_identity_aliases.last_seen_at, EXCLUDED.last_seen_at),
          metadata = device_identity_aliases.metadata || EXCLUDED.metadata,
          updated_at = now()
    RETURNING id, company_id, canonical_device_uid, alias_kind, vendor, alias_value_normalized, status, metadata
    `,
    [
      normalizedCompanyId,
      normalizedCanonicalDeviceUid,
      normalizedAliasKind,
      safeVendor,
      normalizedAliasValue,
      safeStatus,
      safeObservedAt,
      JSON.stringify(safeMetadata)
    ]
  );
  return res.rows[0] || null;
}

async function supersedeProvisionalDeviceUid(db, {
  companyId,
  provisionalDeviceUid,
  canonicalDeviceUid
}) {
  const normalizedCompanyId = normalizeText(companyId);
  const normalizedProvisionalUid = normalizeText(provisionalDeviceUid);
  const normalizedCanonicalUid = normalizeText(canonicalDeviceUid);
  if (!normalizedCompanyId || !normalizedProvisionalUid || !normalizedCanonicalUid) {
    return {
      applied: false,
      reason: 'invalid_input',
      before_row: null,
      after_row: null
    };
  }
  if (normalizedProvisionalUid === normalizedCanonicalUid) {
    return {
      applied: false,
      reason: 'same_uid',
      before_row: null,
      after_row: null
    };
  }

  const beforeRes = await db.query(
    `
    SELECT
      company_id,
      device_uid,
      managed_status,
      identity_status,
      superseded_by_device_uid,
      discovery_status,
      discovered_by_agent_id,
      manageability_status,
      manageability_reason,
      discovery_metadata
    FROM devices
    WHERE company_id = $1
      AND device_uid = $2
    LIMIT 1
    FOR UPDATE
    `,
    [normalizedCompanyId, normalizedProvisionalUid]
  );
  const provisionalRow = beforeRes.rows[0] || null;
  if (!provisionalRow) {
    return {
      applied: false,
      reason: 'provisional_not_found',
      before_row: null,
      after_row: null
    };
  }
  if (normalizeText(provisionalRow.managed_status).toLowerCase() === MANAGED_STATUS.MANAGED) {
    return {
      applied: false,
      reason: 'managed_provisional_requires_operator',
      before_row: provisionalRow,
      after_row: null
    };
  }

  const identityStatus = normalizeText(provisionalRow.identity_status).toLowerCase();
  const alreadySupersededTo = normalizeText(provisionalRow.superseded_by_device_uid);
  if (identityStatus === 'superseded' && alreadySupersededTo === normalizedCanonicalUid) {
    return {
      applied: false,
      reason: 'already_superseded',
      before_row: provisionalRow,
      after_row: provisionalRow
    };
  }
  if (identityStatus === 'superseded' && alreadySupersededTo && alreadySupersededTo !== normalizedCanonicalUid) {
    return {
      applied: false,
      reason: 'superseded_to_other_requires_operator',
      before_row: provisionalRow,
      after_row: null
    };
  }

  const updateRes = await db.query(
    `
    UPDATE devices
    SET identity_status = 'superseded',
        superseded_by_device_uid = $1,
        updated_at = now()
    WHERE company_id = $2
      AND device_uid = $3
    RETURNING
      company_id,
      device_uid,
      managed_status,
      identity_status,
      superseded_by_device_uid,
      discovery_status,
      discovered_by_agent_id,
      manageability_status,
      manageability_reason,
      discovery_metadata
    `,
    [normalizedCanonicalUid, normalizedCompanyId, normalizedProvisionalUid]
  );
  const updatedRow = updateRes.rows[0] || null;
  return {
    applied: !!updatedRow,
    reason: updatedRow ? 'superseded' : 'update_noop',
    before_row: provisionalRow,
    after_row: updatedRow || null
  };
}

async function resolveCanonicalDeviceUid(db, { companyId, discovered, candidateUid }) {
  const candidateRow = await findDeviceByUid(db, { companyId, deviceUid: candidateUid });
  const candidateIdentityStatus = normalizeText(candidateRow && candidateRow.identity_status).toLowerCase();
  const candidateSupersededBy = normalizeText(candidateRow && candidateRow.superseded_by_device_uid);
  if (candidateIdentityStatus === 'superseded' && candidateSupersededBy) {
    return {
      device_uid: candidateSupersededBy,
      identity: extractStableIdentity(discovered),
      matched_existing_uid: candidateUid,
      promoted_to_stable_uid: false,
      superseded_from_uid: candidateUid,
      auto_supersession_allowed: false,
      requires_operator_intervention: false,
      identity_transition: 'superseded_redirect'
    };
  }

  const identity = extractStableIdentity(discovered);
  if (!identity.serial_number && !identity.mac) {
    return {
      device_uid: candidateUid,
      identity,
      matched_existing_uid: null,
      promoted_to_stable_uid: false,
      superseded_from_uid: null,
      auto_supersession_allowed: false,
      requires_operator_intervention: false,
      identity_transition: 'none'
    };
  }

  const existing = await findExistingByStableIdentity(db, { companyId, identity });
  if (!existing) {
    return {
      device_uid: candidateUid,
      identity,
      matched_existing_uid: null,
      promoted_to_stable_uid: false,
      superseded_from_uid: null,
      auto_supersession_allowed: false,
      requires_operator_intervention: false,
      identity_transition: 'none'
    };
  }

  if (existing.device_uid === candidateUid) {
    return {
      device_uid: candidateUid,
      identity,
      matched_existing_uid: existing.device_uid,
      promoted_to_stable_uid: false,
      superseded_from_uid: null,
      auto_supersession_allowed: false,
      requires_operator_intervention: false,
      identity_transition: 'none'
    };
  }

  if (
    existing.managed_status !== MANAGED_STATUS.MANAGED
    && isIpBasedUid(existing.device_uid, identity.vendor)
    && isStableUid(candidateUid, identity.vendor)
  ) {
    return {
      device_uid: candidateUid,
      identity,
      matched_existing_uid: existing.device_uid,
      promoted_to_stable_uid: false,
      superseded_from_uid: existing.device_uid,
      auto_supersession_allowed: true,
      requires_operator_intervention: false,
      identity_transition: 'auto_supersede_provisional'
    };
  }

  return {
    device_uid: existing.device_uid,
    identity,
    matched_existing_uid: existing.device_uid,
    promoted_to_stable_uid: false,
    superseded_from_uid: null,
    auto_supersession_allowed: false,
    requires_operator_intervention: true,
    identity_transition: 'existing_preferred'
  };
}

function resolveDiscoveryStatus(discovered) {
  const state = normalizeText(discovered && discovered.confirmation_state).toLowerCase();
  if (state === 'confirmed') {
    return 'confirmed';
  }
  if (state === 'zk_service_reachable') {
    return 'probable';
  }
  if (state === 'host_reachable') {
    return 'heuristic';
  }
  return 'discovered';
}

function normalizeLifecycleActorType(value, fallback = 'system') {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'system'
    || normalized === 'agent'
    || normalized === 'operator'
    || normalized === 'admin'
    || normalized === 'migration') {
    return normalized;
  }
  return fallback;
}

function normalizeLifecycleCorrelationId(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function parseJsonObject(value) {
  if (isPlainObject(value)) {
    return value;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function toLifecycleCandidateState(row) {
  if (!row || typeof row !== 'object') {
    return {};
  }
  const discoveryMetadata = parseJsonObject(row.discovery_metadata);
  const managedStatus = normalizeText(row.managed_status).toLowerCase();
  const discoveryStatus = normalizeText(row.discovery_status).toLowerCase();
  const manageabilityStatus = normalizeText(row.manageability_status).toLowerCase();
  const manageabilityReason = normalizeText(row.manageability_reason);
  const serialNumber = normalizeText(discoveryMetadata.serial_number);
  const mac = normalizeText(discoveryMetadata.mac);
  const ip = normalizeText(discoveryMetadata.ip);

  return {
    managed_status: managedStatus || null,
    discovery_status: discoveryStatus || null,
    discovered_by_agent_id: row.discovered_by_agent_id || null,
    manageability_status: manageabilityStatus || null,
    manageability_reason: manageabilityReason || null,
    serial_number: serialNumber || null,
    mac: mac || null,
    ip: ip || null
  };
}

function shouldEmitCandidateUpdatedEvent(beforeRow, afterRow) {
  const beforeState = toLifecycleCandidateState(beforeRow);
  const afterState = toLifecycleCandidateState(afterRow);
  return JSON.stringify(beforeState) !== JSON.stringify(afterState);
}

function parseIntegerLike(value) {
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

function normalizeManualMetadataConnection(metadata) {
  const source = parseJsonObject(metadata);
  const connection = parseJsonObject(source.connection);
  const rootAuth = parseIntegerLike(source.auth_password);
  const rootComm = parseIntegerLike(source.communication_key);
  const authPassword = parseIntegerLike(connection.auth_password);
  const communicationKey = parseIntegerLike(connection.communication_key);
  const deviceNumber = parseIntegerLike(connection.device_number);
  const port = parseIntegerLike(connection.port);

  return {
    host: normalizeText(connection.host) || normalizeText(source.ip) || null,
    port: Number.isInteger(port) ? port : null,
    transport: normalizeText(connection.transport).toLowerCase() || normalizeText(source.transport).toLowerCase() || null,
    attlog_sequence: normalizeText(connection.attlog_sequence).toLowerCase() || normalizeText(source.attlog_sequence).toLowerCase() || null,
    device_number: Number.isInteger(deviceNumber) ? deviceNumber : parseIntegerLike(source.device_number),
    auth_password: Number.isInteger(authPassword)
      ? authPassword
      : (Number.isInteger(communicationKey)
          ? communicationKey
          : (Number.isInteger(rootAuth) ? rootAuth : rootComm)),
    communication_key: Number.isInteger(communicationKey)
      ? communicationKey
      : (Number.isInteger(authPassword)
          ? authPassword
          : (Number.isInteger(rootComm) ? rootComm : rootAuth))
  };
}

function evaluateManualConfiguration({ provider, metadata }) {
  const normalizedProvider = normalizeText(provider).toLowerCase();
  const connection = normalizeManualMetadataConnection(metadata);
  const missing = [];

  if (!normalizedProvider) {
    missing.push('provider');
  }
  if (!normalizeText(connection.host)) {
    missing.push('connection.host');
  }
  if (!Number.isInteger(connection.port)) {
    missing.push('connection.port');
  }
  if (!Number.isInteger(connection.auth_password)) {
    missing.push('connection.communication_key');
  }
  if (!Number.isInteger(connection.device_number)) {
    missing.push('connection.device_number');
  }
  if (!connection.transport || (connection.transport !== 'udp' && connection.transport !== 'tcp' && connection.transport !== 'auto')) {
    missing.push('connection.transport');
  }
  if (!connection.attlog_sequence
    || (connection.attlog_sequence !== 'off'
      && connection.attlog_sequence !== 'deviceid_platform'
      && connection.attlog_sequence !== 'deviceid_platform_version'
      && connection.attlog_sequence !== 'zktime_k80')) {
    missing.push('connection.attlog_sequence');
  }

  const ready = missing.length === 0;
  return {
    configuration_status: ready ? 'complete' : 'incomplete',
    missing_required_fields: missing,
    ready_for_validation: ready
  };
}

function normalizeManualValidationStatus(value) {
  const status = normalizeText(value).toLowerCase();
  if (status === MANUAL_VALIDATION_STATUS.QUEUED
    || status === MANUAL_VALIDATION_STATUS.IN_PROGRESS
    || status === MANUAL_VALIDATION_STATUS.FAILED
    || status === MANUAL_VALIDATION_STATUS.SUCCEEDED) {
    return status;
  }
  return MANUAL_VALIDATION_STATUS.NEVER_RUN;
}

function normalizeIsoOrNull(value) {
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

function readManualValidation(metadata) {
  const meta = parseJsonObject(metadata);
  const manual = parseJsonObject(meta.manual_onboarding);
  const validation = parseJsonObject(manual.validation);
  return {
    status: normalizeManualValidationStatus(validation.status),
    last_requested_at: normalizeIsoOrNull(validation.last_requested_at),
    last_started_at: normalizeIsoOrNull(validation.last_started_at),
    last_completed_at: normalizeIsoOrNull(validation.last_completed_at),
    last_success_at: normalizeIsoOrNull(validation.last_success_at),
    last_failure_at: normalizeIsoOrNull(validation.last_failure_at),
    last_reason_code: normalizeText(validation.last_reason_code) || null,
    last_command_id: normalizeText(validation.last_command_id) || null,
    last_agent_id: normalizeText(validation.last_agent_id) || null,
    last_result: parseJsonObject(validation.last_result)
  };
}

function deriveManualOnboardingState({
  managedStatus,
  configurationStatus,
  validationStatus,
  hasActiveManagingAgentBinding
}) {
  const managed = normalizeText(managedStatus).toLowerCase();
  const config = normalizeText(configurationStatus).toLowerCase();
  const validation = normalizeManualValidationStatus(validationStatus);
  if (managed !== MANAGED_STATUS.MANAGED) {
    if (config !== 'complete') {
      return MANUAL_ONBOARDING_STATE.CANDIDATE_UNCONFIGURED;
    }
    if (validation === MANUAL_VALIDATION_STATUS.SUCCEEDED) {
      return MANUAL_ONBOARDING_STATE.VALIDATION_SUCCEEDED;
    }
    if (validation === MANUAL_VALIDATION_STATUS.FAILED) {
      return MANUAL_ONBOARDING_STATE.VALIDATION_FAILED;
    }
    return MANUAL_ONBOARDING_STATE.CANDIDATE_CONFIGURED;
  }
  return hasActiveManagingAgentBinding
    ? MANUAL_ONBOARDING_STATE.MANAGED_PULL_READY
    : MANUAL_ONBOARDING_STATE.MANAGED_UNBOUND;
}

function isAgentOnlineNow(agentRow, onlineWindowMinutes = 10) {
  if (!agentRow || typeof agentRow !== 'object') {
    return false;
  }
  const safeWindowMinutes = Number.isInteger(onlineWindowMinutes) && onlineWindowMinutes > 0
    ? onlineWindowMinutes
    : 10;
  const seenCandidate = agentRow.last_seen_at || agentRow.last_heartbeat_at;
  if (!seenCandidate) {
    return false;
  }
  const seenAt = seenCandidate instanceof Date
    ? seenCandidate
    : new Date(normalizeText(seenCandidate));
  if (Number.isNaN(seenAt.getTime())) {
    return false;
  }
  return (Date.now() - seenAt.getTime()) <= (safeWindowMinutes * 60 * 1000);
}

function deriveOperatorReadinessStatus({
  onboardingState,
  managedStatus,
  managingAgentOnline
}) {
  const state = normalizeText(onboardingState).toLowerCase();
  const managed = normalizeText(managedStatus).toLowerCase();
  const agentOnline = managingAgentOnline === true;

  if (state === MANUAL_ONBOARDING_STATE.CANDIDATE_UNCONFIGURED) {
    return {
      status: 'candidate_incomplete_configuration',
      label: 'Candidate - incomplete configuration',
      reason: 'Add all required connection fields before validation can run.'
    };
  }
  if (state === MANUAL_ONBOARDING_STATE.CANDIDATE_CONFIGURED) {
    return {
      status: 'candidate_ready_for_validation',
      label: 'Candidate - ready for validation',
      reason: 'Configuration is complete. Run validation from the site agent.'
    };
  }
  if (state === MANUAL_ONBOARDING_STATE.VALIDATION_FAILED) {
    return {
      status: 'validation_failed',
      label: 'Validation failed',
      reason: 'Latest validation failed. Review reason/evidence and retry validation.'
    };
  }
  if (state === MANUAL_ONBOARDING_STATE.VALIDATION_SUCCEEDED) {
    return {
      status: 'validation_succeeded',
      label: 'Validation succeeded',
      reason: 'Validation succeeded. Claim device to continue lifecycle.'
    };
  }
  if (state === MANUAL_ONBOARDING_STATE.MANAGED_UNBOUND) {
    return {
      status: 'managed_unbound',
      label: 'Managed - unbound',
      reason: 'Managed device has no active managing-agent binding yet.'
    };
  }
  if (state === MANUAL_ONBOARDING_STATE.MANAGED_PULL_READY) {
    if (!agentOnline) {
      return {
        status: 'managed_blocked_agent_offline',
        label: 'Managed - blocked (agent offline)',
        reason: 'Managing agent is not currently online, so pull is not actionable now.'
      };
    }
    return {
      status: 'managed_pull_ready',
      label: 'Managed - pull ready',
      reason: 'Managed device is bound to an online agent and can queue pull commands.'
    };
  }

  if (managed === MANAGED_STATUS.MANAGED && !agentOnline) {
    return {
      status: 'managed_blocked_agent_offline',
      label: 'Managed - blocked (agent offline)',
      reason: 'Managing agent is not currently online, so pull is not actionable now.'
    };
  }

  return {
    status: 'unknown',
    label: 'Unknown',
    reason: 'Readiness could not be derived from current state.'
  };
}

function toManualOnboardingReadModel(row, options = {}) {
  const metadata = parseJsonObject(row && row.metadata);
  const configuration = evaluateManualConfiguration({
    provider: row && row.provider,
    metadata
  });
  const validation = readManualValidation(metadata);
  const state = deriveManualOnboardingState({
    managedStatus: row && row.managed_status,
    configurationStatus: configuration.configuration_status,
    validationStatus: validation.status,
    hasActiveManagingAgentBinding: options.hasActiveManagingAgentBinding === true
  });

  return {
    configuration_status: configuration.configuration_status,
    missing_required_fields: configuration.missing_required_fields,
    ready_for_validation: configuration.ready_for_validation,
    validation_status: validation.status,
    validation_reason_code: validation.last_reason_code,
    validation_last_requested_at: validation.last_requested_at,
    validation_last_started_at: validation.last_started_at,
    validation_last_completed_at: validation.last_completed_at,
    validation_last_success_at: validation.last_success_at,
    validation_last_failure_at: validation.last_failure_at,
    onboarding_state: state
  };
}

async function getDeviceOnboardingReadiness(db, {
  companyId,
  deviceUid,
  onlineWindowMinutes
}) {
  const safeCompanyId = normalizeText(companyId) || 'DEFAULT';
  const safeDeviceUid = normalizeText(deviceUid);
  if (!safeDeviceUid) {
    return { error: 'invalid_device_uid' };
  }

  const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
    companyId: safeCompanyId,
    deviceUid: safeDeviceUid
  });
  if (canonicalResolution.resolved_by === 'superseded_without_canonical') {
    return {
      error: 'device_uid_superseded_without_canonical',
      value: {
        requested_device_uid: canonicalResolution.requested_device_uid,
        canonical_device_uid: canonicalResolution.canonical_device_uid,
        canonical_resolved_by: canonicalResolution.resolved_by,
        canonical_alias_kind: canonicalResolution.alias_kind || null,
        canonical_alias_status: canonicalResolution.alias_status || null
      }
    };
  }

  const canonicalDeviceUid = normalizeText(canonicalResolution.canonical_device_uid)
    || normalizeText(canonicalResolution.requested_device_uid)
    || safeDeviceUid;

  const deviceRes = await db.query(
    `
    SELECT
      company_id,
      device_uid,
      provider,
      device_name,
      managed_status,
      lifecycle_scope,
      manageability_status,
      manageability_reason,
      metadata,
      discovery_metadata,
      discovered_by_agent_id,
      site_id,
      last_seen_at,
      updated_at
    FROM devices
    WHERE company_id = $1
      AND device_uid = $2
    LIMIT 1
    `,
    [safeCompanyId, canonicalDeviceUid]
  );
  const deviceRow = deviceRes.rows[0] || null;
  if (!deviceRow) {
    return {
      error: 'device_not_found',
      value: {
        requested_device_uid: canonicalResolution.requested_device_uid || safeDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by || 'unresolved',
        canonical_alias_kind: canonicalResolution.alias_kind || null,
        canonical_alias_status: canonicalResolution.alias_status || null
      }
    };
  }

  const activeBinding = await getActiveManagingAgentBinding(db, {
    companyId: safeCompanyId,
    deviceUid: canonicalDeviceUid
  });
  let managingAgent = null;
  if (activeBinding && activeBinding.agent_id) {
    managingAgent = await getAgentById(db, {
      companyId: safeCompanyId,
      agentId: activeBinding.agent_id
    });
  }

  const hasActiveBinding = Boolean(activeBinding);
  const onboarding = toManualOnboardingReadModel(deviceRow, {
    hasActiveManagingAgentBinding: hasActiveBinding
  });
  const validation = readManualValidation(deviceRow.metadata);
  const safeOnlineWindowMinutes = parsePositiveInt(onlineWindowMinutes, 10);
  const managingAgentOnline = hasActiveBinding
    ? isAgentOnlineNow(managingAgent, safeOnlineWindowMinutes)
    : false;
  const readiness = deriveOperatorReadinessStatus({
    onboardingState: onboarding.onboarding_state,
    managedStatus: deviceRow.managed_status,
    managingAgentOnline
  });
  const suggestedAgentId = normalizeText(
    (activeBinding && activeBinding.agent_id)
      || validation.last_agent_id
      || deviceRow.discovered_by_agent_id
  ) || null;
  const validationLastResult = isPlainObject(validation.last_result) && Object.keys(validation.last_result).length > 0
    ? validation.last_result
    : null;
  let site = null;
  if (deviceRow.site_id) {
    const siteRes = await db.query(
      `
      SELECT site_id, site_key, site_name, status
      FROM sites
      WHERE company_id = $1
        AND site_id = $2
      LIMIT 1
      `,
      [safeCompanyId, deviceRow.site_id]
    );
    site = siteRes.rows[0] || null;
  }
  const deviceReportedStateRow = await getDeviceRuntimeReportedState(db, {
    companyId: safeCompanyId,
    deviceUid: canonicalDeviceUid
  });
  const deviceReportedState = toDeviceRuntimeReportedReadModel(deviceReportedStateRow, {
    staleMinutes: defaultDeviceRuntimeReportedStaleMinutes()
  });

  return {
    value: {
      company_id: safeCompanyId,
      requested_device_uid: canonicalResolution.requested_device_uid || safeDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      canonical_resolved_by: canonicalResolution.resolved_by || 'direct',
      canonical_alias_kind: canonicalResolution.alias_kind || null,
      canonical_alias_status: canonicalResolution.alias_status || null,
      provider: normalizeText(deviceRow.provider).toLowerCase() || null,
      device_name: normalizeText(deviceRow.device_name) || null,
      managed_status: normalizeText(deviceRow.managed_status).toLowerCase() || null,
      lifecycle_scope: normalizeText(deviceRow.lifecycle_scope).toLowerCase() || null,
      manageability_status: normalizeText(deviceRow.manageability_status).toLowerCase() || null,
      manageability_reason: normalizeText(deviceRow.manageability_reason) || null,
      site_id: normalizeText(deviceRow.site_id) || null,
      site_key: normalizeText(site && site.site_key) || null,
      site_name: normalizeText(site && site.site_name) || null,
      site_status: normalizeText(site && site.status).toLowerCase() || null,
      last_seen_at: normalizeIsoOrNull(deviceRow.last_seen_at),
      updated_at: normalizeIsoOrNull(deviceRow.updated_at),
      suggested_agent_id: suggestedAgentId,
      ...onboarding,
      validation_last_result: validationLastResult,
      readiness_status: readiness.status,
      readiness_label: readiness.label,
      readiness_reason: readiness.reason,
      reported_state: deviceReportedState,
      active_binding: activeBinding
        ? {
            id: activeBinding.id,
            agent_id: activeBinding.agent_id,
            status: activeBinding.status,
            bound_at: activeBinding.bound_at || null,
            reason: activeBinding.reason || null,
            updated_at: activeBinding.updated_at || null
          }
        : null,
      managing_agent: managingAgent
        ? {
            id: managingAgent.id,
            agent_name: managingAgent.agent_name || null,
            status: managingAgent.status || null,
            last_seen_at: managingAgent.last_seen_at || null,
            last_heartbeat_at: managingAgent.last_heartbeat_at || null,
            is_online_now: managingAgentOnline,
            online_window_minutes: safeOnlineWindowMinutes
          }
        : null
    }
  };
}

function toManualOnboardingLifecycleState(row) {
  if (!row || typeof row !== 'object') {
    return {};
  }
  const metadata = parseJsonObject(row.metadata);
  const connection = normalizeManualMetadataConnection(metadata);
  const identity = parseJsonObject(metadata.identity);

  return {
    managed_status: normalizeText(row.managed_status).toLowerCase() || null,
    lifecycle_scope: normalizeText(row.lifecycle_scope).toLowerCase() || null,
    provider: normalizeText(row.provider).toLowerCase() || null,
    device_name: normalizeText(row.device_name) || null,
    serial_number: normalizeText(identity.serial_number) || normalizeText(metadata.serial_number) || null,
    mac: normalizeText(identity.mac) || normalizeText(metadata.mac) || null,
    connection,
    ...toManualOnboardingReadModel(row)
  };
}

function shouldEmitManualCandidateUpdatedEvent(beforeRow, afterRow) {
  const beforeState = toManualOnboardingLifecycleState(beforeRow);
  const afterState = toManualOnboardingLifecycleState(afterRow);
  return JSON.stringify(beforeState) !== JSON.stringify(afterState);
}

function deriveManualCandidateDeviceUid({ provider, explicitDeviceUid, identity, connection }) {
  const normalizedProvider = normalizeVendor(provider);
  const explicit = normalizeText(explicitDeviceUid);
  const serial = normalizeSerial(identity && identity.serial_number);
  const mac = normalizeMac(identity && identity.mac);
  const host = normalizeText(connection && connection.host);

  if (explicit) return explicit;
  if (serial) return `${normalizedProvider}:sn:${serial}`;
  if (mac) return `${normalizedProvider}:mac:${mac}`;
  if (host) return `${normalizedProvider}:ip:${host}`;
  return '';
}

function buildManualOnboardingMetadata({
  existingMetadata,
  connection,
  identity,
  deviceProfile,
  siteContext,
  operatorNotes,
  actorType,
  actorRef
}) {
  const nextMetadata = {
    ...parseJsonObject(existingMetadata)
  };

  const existingConnection = parseJsonObject(nextMetadata.connection);
  const mergedConnection = {
    ...existingConnection
  };
  if (Object.prototype.hasOwnProperty.call(connection, 'host')) {
    mergedConnection.host = normalizeText(connection.host) || null;
  }
  if (Object.prototype.hasOwnProperty.call(connection, 'port')) {
    mergedConnection.port = parseIntegerLike(connection.port);
  }
  if (Object.prototype.hasOwnProperty.call(connection, 'transport')) {
    mergedConnection.transport = normalizeText(connection.transport).toLowerCase() || null;
  }
  if (Object.prototype.hasOwnProperty.call(connection, 'attlog_sequence')) {
    mergedConnection.attlog_sequence = normalizeText(connection.attlog_sequence).toLowerCase() || null;
  }
  if (Object.prototype.hasOwnProperty.call(connection, 'device_number')) {
    mergedConnection.device_number = parseIntegerLike(connection.device_number);
  }
  if (Object.prototype.hasOwnProperty.call(connection, 'communication_key')
    || Object.prototype.hasOwnProperty.call(connection, 'auth_password')) {
    const authPassword = parseIntegerLike(
      Object.prototype.hasOwnProperty.call(connection, 'communication_key')
        ? connection.communication_key
        : connection.auth_password
    );
    mergedConnection.communication_key = authPassword;
    mergedConnection.auth_password = authPassword;
  }
  nextMetadata.connection = mergedConnection;

  if (normalizeText(mergedConnection.host)) {
    nextMetadata.ip = normalizeText(mergedConnection.host);
  }
  if (Number.isInteger(mergedConnection.port)) {
    nextMetadata.port = mergedConnection.port;
    const protocol = parseJsonObject(nextMetadata.protocol);
    nextMetadata.protocol = {
      ...protocol,
      port: mergedConnection.port
    };
  }
  if (normalizeText(mergedConnection.transport)) {
    nextMetadata.transport = normalizeText(mergedConnection.transport).toLowerCase();
  }
  if (normalizeText(mergedConnection.attlog_sequence)) {
    nextMetadata.attlog_sequence = normalizeText(mergedConnection.attlog_sequence).toLowerCase();
  }
  if (Number.isInteger(mergedConnection.device_number)) {
    nextMetadata.device_number = mergedConnection.device_number;
  }
  if (Number.isInteger(mergedConnection.auth_password)) {
    nextMetadata.auth_password = mergedConnection.auth_password;
    nextMetadata.communication_key = mergedConnection.auth_password;
  }

  const existingIdentity = parseJsonObject(nextMetadata.identity);
  const serial = normalizeSerial(identity && identity.serial_number);
  const mac = normalizeMac(identity && identity.mac);
  const mergedIdentity = {
    ...existingIdentity
  };
  if (serial) {
    mergedIdentity.serial_number = serial;
    nextMetadata.serial_number = serial;
  }
  if (mac) {
    mergedIdentity.mac = mac;
    nextMetadata.mac = mac;
  }
  nextMetadata.identity = mergedIdentity;

  if (isPlainObject(deviceProfile) && Object.keys(deviceProfile).length > 0) {
    nextMetadata.device_profile = {
      ...parseJsonObject(nextMetadata.device_profile),
      ...deviceProfile
    };
  }
  if (isPlainObject(siteContext) && Object.keys(siteContext).length > 0) {
    nextMetadata.site_context = {
      ...parseJsonObject(nextMetadata.site_context),
      ...siteContext
    };
  }
  if (isPlainObject(operatorNotes) && Object.keys(operatorNotes).length > 0) {
    nextMetadata.operator_notes = {
      ...parseJsonObject(nextMetadata.operator_notes),
      ...operatorNotes
    };
  }

  nextMetadata.manual_onboarding = {
    ...parseJsonObject(nextMetadata.manual_onboarding),
    last_configured_at: new Date().toISOString(),
    last_configured_by_actor_type: normalizeLifecycleActorType(actorType || 'operator', 'operator'),
    last_configured_by_ref: normalizeText(actorRef) || null
  };

  return nextMetadata;
}

function buildManualValidationMetadata(existingMetadata, update) {
  const nextMetadata = {
    ...parseJsonObject(existingMetadata)
  };
  const manual = {
    ...parseJsonObject(nextMetadata.manual_onboarding)
  };
  const currentValidation = {
    ...parseJsonObject(manual.validation)
  };
  const patch = isPlainObject(update) ? update : {};

  const status = normalizeManualValidationStatus(
    Object.prototype.hasOwnProperty.call(patch, 'status')
      ? patch.status
      : currentValidation.status
  );

  const merged = {
    ...currentValidation,
    ...patch,
    status
  };

  if (Object.prototype.hasOwnProperty.call(patch, 'last_result')) {
    merged.last_result = isPlainObject(patch.last_result) ? patch.last_result : {};
  } else if (!isPlainObject(merged.last_result)) {
    merged.last_result = {};
  }

  ['last_requested_at', 'last_started_at', 'last_completed_at', 'last_success_at', 'last_failure_at']
    .forEach(field => {
      if (Object.prototype.hasOwnProperty.call(merged, field)) {
        merged[field] = normalizeIsoOrNull(merged[field]);
      }
    });

  merged.last_reason_code = normalizeText(merged.last_reason_code) || null;
  merged.last_command_id = normalizeText(merged.last_command_id) || null;
  merged.last_agent_id = normalizeText(merged.last_agent_id) || null;
  merged.updated_at = new Date().toISOString();

  manual.validation = merged;
  nextMetadata.manual_onboarding = manual;
  return nextMetadata;
}

async function insertDeviceLifecycleEvent(db, {
  companyId,
  deviceUid,
  lifecycleEvent,
  actorType,
  actorRef,
  agentId,
  fromState,
  toState,
  reason,
  correlationId,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeDeviceUid = normalizeText(deviceUid);
  const safeLifecycleEvent = normalizeText(lifecycleEvent);
  if (!safeCompanyId || !safeDeviceUid || !safeLifecycleEvent) {
    return;
  }

  const safeActorType = normalizeLifecycleActorType(actorType, 'system');
  const safeActorRef = normalizeText(actorRef) || null;
  const safeReason = normalizeText(reason) || null;
  const safeCorrelationId = normalizeLifecycleCorrelationId(correlationId);
  const safeMetadata = isPlainObject(metadata) ? metadata : {};
  const safeFromState = isPlainObject(fromState) ? fromState : {};
  const safeToState = isPlainObject(toState) ? toState : {};

  await db.query(
    `
    INSERT INTO device_lifecycle_events (
      company_id,
      device_uid,
      lifecycle_event,
      actor_type,
      actor_ref,
      agent_id,
      from_state,
      to_state,
      reason,
      correlation_id,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb)
    `,
    [
      safeCompanyId,
      safeDeviceUid,
      safeLifecycleEvent,
      safeActorType,
      safeActorRef,
      agentId || null,
      JSON.stringify(safeFromState),
      JSON.stringify(safeToState),
      safeReason,
      safeCorrelationId,
      JSON.stringify(safeMetadata)
    ]
  );
}

async function resolveCanonicalDeviceUidForOperations(db, { companyId, deviceUid }) {
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

async function getActiveManagingAgentBinding(db, { companyId, deviceUid }) {
  const res = await db.query(
    `
    SELECT
      id,
      company_id,
      device_uid,
      agent_id,
      status,
      bound_at,
      unbound_at,
      bound_by_key_id,
      reason,
      metadata,
      created_at,
      updated_at
    FROM device_managing_agent_bindings
    WHERE company_id = $1
      AND device_uid = $2
      AND status = 'active'
    ORDER BY bound_at DESC, updated_at DESC, id DESC
    LIMIT 1
    `,
    [companyId, deviceUid]
  );
  return res.rows[0] || null;
}

async function createProvisioningToken(db, { companyId, createdByKeyId, ttlMinutes, metadata }) {
  const rawToken = randomToken('apt', 32);
  const tokenHash = hashSecret(rawToken);
  const prefix = rawToken.slice(0, 12);
  const ttl = Number.isInteger(ttlMinutes) ? ttlMinutes : 60;
  const safeTtl = Math.min(Math.max(ttl, 5), 1440);
  const payload = isPlainObject(metadata) ? metadata : {};

  const res = await db.query(
    `
    INSERT INTO agent_provisioning_tokens (
      company_id, token_hash, token_prefix, created_by_key_id, expires_at, metadata
    )
    VALUES ($1, $2, $3, $4, now() + ($5::text || ' minutes')::interval, $6::jsonb)
    RETURNING id, company_id, token_prefix, expires_at, created_at
    `,
    [companyId, tokenHash, prefix, createdByKeyId || null, String(safeTtl), JSON.stringify(payload)]
  );

  return {
    ...res.rows[0],
    token: rawToken
  };
}

async function consumeProvisioningToken(db, rawToken) {
  const tokenHash = hashSecret(rawToken);
  const res = await db.query(
    `
    SELECT id, company_id, used_at, revoked_at, expires_at
    FROM agent_provisioning_tokens
    WHERE token_hash = $1
    LIMIT 1
    `,
    [tokenHash]
  );
  const token = res.rows[0];
  if (!token) {
    return { error: 'invalid_token' };
  }
  if (token.revoked_at) {
    return { error: 'revoked_token' };
  }
  if (token.used_at) {
    return { error: 'already_used' };
  }
  if (new Date(token.expires_at).getTime() < Date.now()) {
    return { error: 'expired_token' };
  }
  return { value: token };
}

async function insertAgentRuntimeIdentity(db, {
  companyId,
  agentId,
  credentialHash,
  credentialPrefix,
  issuedFromTokenId,
  metadata
}) {
  const payload = isPlainObject(metadata) ? metadata : {};
  const res = await db.query(
    `
    INSERT INTO agent_runtime_identities (
      company_id,
      agent_id,
      credential_hash,
      credential_prefix,
      status,
      issued_from_token_id,
      metadata
    )
    VALUES ($1, $2, $3, $4, 'active', $5, $6::jsonb)
    RETURNING
      identity_id,
      company_id,
      agent_id,
      status,
      issued_at,
      revoked_at,
      issued_from_token_id,
      replaced_by_identity_id,
      replaced_reason,
      metadata,
      created_at,
      updated_at
    `,
    [
      companyId,
      agentId,
      credentialHash,
      credentialPrefix,
      issuedFromTokenId || null,
      JSON.stringify(payload)
    ]
  );
  return res.rows[0] || null;
}

async function bootstrapAgent(db, { provisioningToken, agentName, metadata }) {
  await db.query('BEGIN');
  try {
    const tokenState = await consumeProvisioningToken(db, provisioningToken);
    if (tokenState.error) {
      await db.query('ROLLBACK');
      return tokenState;
    }

    const tokenRow = tokenState.value;
    const secret = randomToken('agt', 32);
    const secretHash = hashSecret(secret);
    const secretPrefix = secret.slice(0, 12);
    const safeName = normalizeText(agentName) || `agent-${Date.now()}`;
    const safeMetadata = isPlainObject(metadata) ? metadata : {};

    const agentRes = await db.query(
      `
      INSERT INTO agent_nodes (
        company_id, agent_name, auth_secret_hash, auth_secret_prefix, provisioned_from_token_id, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING id, company_id, agent_name, status, credential_version, created_at, registered_at
      `,
      [
        tokenRow.company_id,
        safeName,
        secretHash,
        secretPrefix,
        tokenRow.id,
        JSON.stringify(safeMetadata)
      ]
    );
    const agent = agentRes.rows[0] || null;
    if (!agent) {
      await db.query('ROLLBACK');
      return { error: 'agent_insert_failed' };
    }

    const runtimeIdentity = await insertAgentRuntimeIdentity(db, {
      companyId: tokenRow.company_id,
      agentId: agent.id,
      credentialHash: secretHash,
      credentialPrefix: secretPrefix,
      issuedFromTokenId: tokenRow.id,
      metadata: {
        source: 'agent.bootstrap',
        provisioning_token_id: tokenRow.id
      }
    });

    await db.query(
      `
      UPDATE agent_nodes
      SET active_runtime_identity_id = $1,
          identity_status = 'active',
          runtime_identity_issued_at = $2,
          updated_at = now()
      WHERE id = $3
        AND company_id = $4
      `,
      [
        runtimeIdentity ? runtimeIdentity.identity_id : null,
        runtimeIdentity ? runtimeIdentity.issued_at : null,
        agent.id,
        tokenRow.company_id
      ]
    );

    await db.query(
      `
      UPDATE agent_provisioning_tokens
      SET used_at = now()
      WHERE id = $1
      `,
      [tokenRow.id]
    );

    await db.query('COMMIT');
    return {
      value: {
        ...agent,
        active_runtime_identity_id: runtimeIdentity ? runtimeIdentity.identity_id : null,
        identity_status: 'active',
        runtime_identity_issued_at: runtimeIdentity ? runtimeIdentity.issued_at : null,
        auth_token: secret
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    if (err && err.code === '23505') {
      return { error: 'agent_name_conflict' };
    }
    throw err;
  }
}

function mergeRuntimeCapabilityEntry(map, entry) {
  const safeEntry = isPlainObject(entry) ? entry : {};
  const safeCapabilityKey = normalizeText(
    safeEntry.capabilityKey || safeEntry.capability_key
  ).toLowerCase();
  const safeCapabilityStatus = normalizeText(
    safeEntry.capabilityStatus || safeEntry.capability_status
  ).toLowerCase();
  if (!safeCapabilityKey || !safeCapabilityStatus) {
    return;
  }
  map.set(safeCapabilityKey, {
    capability_key: safeCapabilityKey,
    capability_status: safeCapabilityStatus,
    capability_reason: normalizeText(
      safeEntry.capabilityReason || safeEntry.capability_reason
    ) || null,
    metadata: isPlainObject(safeEntry.metadata) ? safeEntry.metadata : {}
  });
}

function buildRuntimeCapabilityEntriesFromHeartbeatPayload(payload, {
  versionReported
} = {}) {
  const safePayload = isPlainObject(payload) ? payload : {};
  const entriesMap = new Map();
  const reportedEntries = parseCapabilityReportMap(safePayload.capabilities);
  for (const entry of reportedEntries) {
    mergeRuntimeCapabilityEntry(entriesMap, entry);
  }

  if (!entriesMap.has(RUNTIME_CAPABILITY_KEYS.HEARTBEAT_REPORTING)) {
    mergeRuntimeCapabilityEntry(entriesMap, {
      capabilityKey: RUNTIME_CAPABILITY_KEYS.HEARTBEAT_REPORTING,
      capabilityStatus: CAPABILITY_STATUS.SUPPORTED,
      capabilityReason: 'heartbeat_received',
      metadata: {
        source: 'agent.heartbeat'
      }
    });
  }

  if (versionReported && !entriesMap.has(RUNTIME_CAPABILITY_KEYS.VERSION_REPORTING)) {
    mergeRuntimeCapabilityEntry(entriesMap, {
      capabilityKey: RUNTIME_CAPABILITY_KEYS.VERSION_REPORTING,
      capabilityStatus: CAPABILITY_STATUS.SUPPORTED,
      capabilityReason: 'version_reported',
      metadata: {
        source: 'agent.heartbeat'
      }
    });
  }

  return Array.from(entriesMap.values());
}

const DEVICE_CAPABILITY_UNSUPPORTED_REASONS = new Set([
  'runtime_capability_unsupported',
  'device_path_capability_unsupported',
  'command_unsupported',
  'unsupported_vendor',
  'protocol_variant_mismatch'
]);

function shouldPersistUnsupportedDeviceCapability(reasonCode) {
  const normalized = normalizeText(reasonCode).toLowerCase();
  if (!normalized) {
    return false;
  }
  return DEVICE_CAPABILITY_UNSUPPORTED_REASONS.has(normalized);
}

async function updateHeartbeat(db, { agentId, companyId, payload }) {
  const safePayload = isPlainObject(payload) ? payload : {};
  await db.query('BEGIN');
  try {
    await ensureCapabilityReportingSchemaReady(db, {
      runtimePath: '/api/agent/heartbeat'
    });

    const res = await db.query(
      `
      UPDATE agent_nodes
      SET last_seen_at = now(),
          last_heartbeat_at = now(),
          heartbeat_payload = $1::jsonb,
          updated_at = now()
      WHERE id = $2 AND company_id = $3
      RETURNING id, company_id, agent_name, status, site_id, last_seen_at, last_heartbeat_at
      `,
      [JSON.stringify(safePayload), agentId, companyId]
    );
    const row = res.rows[0] || null;
    if (row) {
      const versionReport = extractVersionReportFromHeartbeatPayload(safePayload);
      const hasVersionReport = Boolean(versionReport.reported_version);
      if (versionReport.reported_version) {
        const reportedVersionSourceField = normalizeText(safePayload.agent_version)
          ? 'agent_version'
          : (normalizeText(safePayload.version) ? 'version' : null);
        await upsertAgentRuntimeVersionReportedState(db, {
          companyId: row.company_id,
          agentId: row.id,
          siteId: row.site_id || null,
          reportedVersion: versionReport.reported_version,
          rolloutChannel: versionReport.rollout_channel,
          reportedAt: row.last_heartbeat_at,
          metadata: {
            source: 'agent.heartbeat',
            reported_version_source_field: reportedVersionSourceField
          }
        });
      }
      const runtimeCapabilityEntries = buildRuntimeCapabilityEntriesFromHeartbeatPayload(safePayload, {
        versionReported: hasVersionReport
      });
      for (const entry of runtimeCapabilityEntries) {
        await upsertAgentRuntimeCapabilityReportedState(db, {
          companyId: row.company_id,
          agentId: row.id,
          siteId: row.site_id || null,
          capabilityKey: entry.capability_key,
          capabilityStatus: entry.capability_status,
          capabilityReason: entry.capability_reason,
          reportedAt: row.last_heartbeat_at,
          metadata: {
            source: 'agent.heartbeat',
            ...(isPlainObject(entry.metadata) ? entry.metadata : {})
          }
        });
      }
      await upsertSiteRuntimeReportedStateFromAgent(db, {
        companyId: row.company_id,
        agentId: row.id,
        lastHeartbeatAt: row.last_heartbeat_at,
        runtimeHealthStatus: 'healthy',
        runtimeHealthReason: 'heartbeat_received',
        reportedAt: row.last_heartbeat_at,
        metadata: {
          source: 'agent.heartbeat'
        }
      });
      logBridgeEvent('bridge.agent.heartbeat.persisted', {
        company_id: row.company_id,
        agent_id: row.id,
        last_heartbeat_at: row.last_heartbeat_at
      });
    }
    await db.query('COMMIT');
    return row;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function queueScanSubnetCommand(db, {
  companyId,
  agentId,
  commandPayload,
  createdByKeyId
}) {
  const res = await db.query(
    `
    INSERT INTO agent_commands (
      company_id, agent_id, command_type, command_payload, status, created_by_key_id
    )
    VALUES ($1, $2, $3, $4::jsonb, 'queued', $5)
    RETURNING id, company_id, agent_id, command_type, command_payload, status, created_at
    `,
    [
      companyId,
      agentId,
      COMMAND_TYPES.SCAN_SUBNET,
      JSON.stringify(commandPayload),
      createdByKeyId || null
    ]
  );
  return res.rows[0];
}

async function queueValidateDeviceCandidateCommand(db, {
  companyId,
  agentId,
  deviceUid,
  options,
  createdByKeyId,
  createdByRole,
  correlationId
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  const safeDeviceUid = normalizeText(deviceUid);
  const safeOptions = isPlainObject(options) ? options : {};
  const safeActorType = normalizeLifecycleActorType(createdByRole || 'operator', 'operator');
  const safeCorrelationId = normalizeLifecycleCorrelationId(correlationId);
  if (!safeCompanyId || !safeAgentId || !safeDeviceUid) {
    return { error: 'invalid_request' };
  }

  await db.query('BEGIN');
  try {
    const agent = await getAgentById(db, {
      companyId: safeCompanyId,
      agentId: safeAgentId
    });
    if (!agent) {
      await db.query('ROLLBACK');
      return { error: 'agent_not_found' };
    }
    if (normalizeText(agent.status).toLowerCase() !== 'active') {
      await db.query('ROLLBACK');
      return { error: 'agent_not_active' };
    }

    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId: safeCompanyId,
      deviceUid: safeDeviceUid
    });
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

    const canonicalDeviceUid = normalizeText(canonicalResolution.canonical_device_uid)
      || normalizeText(canonicalResolution.requested_device_uid)
      || safeDeviceUid;

    const deviceRes = await db.query(
      `
      SELECT
        company_id,
        device_uid,
        provider,
        managed_status,
        lifecycle_scope,
        site_id,
        metadata
      FROM devices
      WHERE company_id = $1
        AND device_uid = $2
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, canonicalDeviceUid]
    );
    const deviceRow = deviceRes.rows[0] || null;
    if (!deviceRow) {
      await db.query('ROLLBACK');
      return { error: 'device_not_found' };
    }

    const managedStatus = normalizeText(deviceRow.managed_status).toLowerCase();
    if (managedStatus !== MANAGED_STATUS.CANDIDATE) {
      await db.query('ROLLBACK');
      return {
        error: 'device_not_candidate',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          managed_status: deviceRow.managed_status || null
        }
      };
    }

    const lifecycleScope = normalizeText(deviceRow.lifecycle_scope).toLowerCase() || 'ingest_only';
    if (lifecycleScope !== 'bridge_ops') {
      await db.query('ROLLBACK');
      return {
        error: 'device_not_bridge_scope',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          lifecycle_scope: lifecycleScope
        }
      };
    }

    const provider = normalizeText(deviceRow.provider).toLowerCase();
    if (provider && provider !== 'zkteco') {
      await db.query('ROLLBACK');
      return { error: 'unsupported_vendor' };
    }

    const configuration = evaluateManualConfiguration({
      provider: provider || 'zkteco',
      metadata: deviceRow.metadata
    });
    if (configuration.ready_for_validation !== true) {
      await db.query('ROLLBACK');
      return {
        error: 'device_candidate_unconfigured',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          configuration_status: configuration.configuration_status,
          missing_required_fields: configuration.missing_required_fields,
          ready_for_validation: false
        }
      };
    }
    const executionGate = await evaluateCommandIssuanceGate(db, {
      companyId: safeCompanyId,
      targetAgentId: safeAgentId,
      commandType: COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE,
      deviceUid: canonicalDeviceUid,
      deviceSiteId: deviceRow.site_id || null,
      agentSiteId: agent.site_id || null,
      bindingAgentId: null
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
          configuration_status: configuration.configuration_status,
          missing_required_fields: configuration.missing_required_fields,
          ready_for_validation: configuration.ready_for_validation === true,
          execution_gate: executionGate.details
        }
      };
    }

    await reconcileAgentCommandLifecycle(db, {
      companyId: safeCompanyId,
      agentId: safeAgentId
    });

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
      [safeCompanyId, safeAgentId, COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE, canonicalDeviceUid]
    );
    if (inFlightRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return {
        error: 'validation_command_already_in_flight',
        value: {
          command_id: inFlightRes.rows[0].id,
          status: inFlightRes.rows[0].status
        }
      };
    }

    const connection = normalizeManualMetadataConnection(deviceRow.metadata);
    const timeoutMs = Number.isInteger(safeOptions.timeout_ms)
      ? safeOptions.timeout_ms
      : (parsePositiveInt(process.env.DEVICE_VALIDATION_TIMEOUT_MS, 1600) || 1600);
    const maxPackets = Number.isInteger(safeOptions.max_packets)
      ? safeOptions.max_packets
      : (parsePositiveInt(process.env.DEVICE_VALIDATION_MAX_PACKETS, 1024) || 1024);
    const probeMode = safeOptions.probe_mode === true;
    const ttlSeconds = parsePositiveInt(safeOptions.command_ttl_seconds)
      || defaultValidationCommandTtlSeconds();
    const sentStaleSeconds = parsePositiveInt(safeOptions.sent_stale_seconds)
      || defaultValidationSentStaleSeconds();

    const commandPayload = {
      device_uid: canonicalDeviceUid,
      vendor: provider || 'zkteco',
      connection: {
        host: connection.host,
        port: connection.port,
        transport: connection.transport,
        attlog_sequence: connection.attlog_sequence,
        auth_password: connection.auth_password,
        device_number: connection.device_number
      },
      validation: {
        mode: 'connect_auth_probe',
        timeout_ms: timeoutMs,
        max_packets: maxPackets,
        sent_stale_seconds: sentStaleSeconds,
        probe_mode: probeMode
      },
      runtime_context: {
        site_id: executionGate.details.site_id || null,
        active_site_agent_id: executionGate.details.active_site_agent_id || null,
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

    const commandRes = await db.query(
      `
      INSERT INTO agent_commands (
        company_id,
        agent_id,
        command_type,
        command_payload,
        status,
        created_by_key_id,
        expires_at
      )
      VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, now() + ($6::text || ' seconds')::interval)
      RETURNING id, company_id, agent_id, command_type, command_payload, status, created_at, expires_at
      `,
      [
        safeCompanyId,
        safeAgentId,
        COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE,
        JSON.stringify(commandPayload),
        createdByKeyId || null,
        String(ttlSeconds)
      ]
    );
    const command = commandRes.rows[0];

    const beforeRow = { ...deviceRow };
    const nextMetadata = buildManualValidationMetadata(beforeRow.metadata, {
      status: MANUAL_VALIDATION_STATUS.QUEUED,
      last_requested_at: new Date().toISOString(),
      last_command_id: command.id,
      last_agent_id: safeAgentId,
      last_reason_code: null,
      last_result: {}
    });
    const updateRes = await db.query(
      `
      UPDATE devices
      SET metadata = $1::jsonb,
          updated_at = now()
      WHERE company_id = $2
        AND device_uid = $3
      RETURNING
        company_id,
        device_uid,
        provider,
        device_name,
        managed_status,
        lifecycle_scope,
        metadata
      `,
      [JSON.stringify(nextMetadata), safeCompanyId, canonicalDeviceUid]
    );
    const updatedRow = updateRes.rows[0] || beforeRow;

    if (shouldEmitManualCandidateUpdatedEvent(beforeRow, updatedRow)) {
      await insertDeviceLifecycleEvent(db, {
        companyId: safeCompanyId,
        deviceUid: canonicalDeviceUid,
        lifecycleEvent: 'candidate_updated',
        actorType: safeActorType,
        actorRef: createdByKeyId || null,
        agentId: safeAgentId,
        fromState: toManualOnboardingLifecycleState(beforeRow),
        toState: toManualOnboardingLifecycleState(updatedRow),
        reason: 'validation_queued',
        correlationId: safeCorrelationId,
        metadata: {
          source: 'agent_admin.device_validation',
          command_id: command.id,
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by,
          canonical_alias_kind: canonicalResolution.alias_kind,
          canonical_alias_status: canonicalResolution.alias_status,
          validation_status: MANUAL_VALIDATION_STATUS.QUEUED
        }
      });
    }

    await db.query('COMMIT');
    const onboarding = toManualOnboardingReadModel(updatedRow);
    return {
      value: {
        command,
        company_id: safeCompanyId,
        requested_device_uid: canonicalResolution.requested_device_uid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by,
        canonical_alias_kind: canonicalResolution.alias_kind,
        canonical_alias_status: canonicalResolution.alias_status,
        managed_status: managedStatus,
        lifecycle_scope: lifecycleScope,
        ...onboarding
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function queueK80EnrollmentAttemptExecutionCommand(db, {
  companyId,
  enrollmentAttemptId,
  requestedDeviceUid,
  createdByKeyId,
  createdByRole
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAttemptId = normalizeText(enrollmentAttemptId);
  const safeRequestedDeviceUid = normalizeText(requestedDeviceUid);
  const safeActorType = normalizeLifecycleActorType(createdByRole || 'operator', 'operator');
  if (!safeCompanyId || !safeAttemptId) {
    return { error: 'invalid_request' };
  }

  await db.query('BEGIN');
  try {
    const attemptRes = await db.query(
      `
      SELECT
        id,
        company_id,
        device_uid,
        inventory_scope,
        person_id,
        device_user_id,
        selected_finger,
        preflight_decision_id,
        attempt_status,
        status_reason,
        protocol_session_ref,
        command_ref,
        evidence_ref,
        source_metadata
      FROM device_enrollment_attempts
      WHERE company_id = $1
        AND id = $2::uuid
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, safeAttemptId]
    );
    const attemptRow = attemptRes.rows[0] || null;
    if (!attemptRow) {
      await db.query('ROLLBACK');
      return { error: 'enrollment_attempt_not_found' };
    }

    if (normalizeText(attemptRow.inventory_scope).toLowerCase() !== 'zk_k80') {
      await db.query('ROLLBACK');
      return { error: 'enrollment_attempt_scope_not_supported' };
    }
    if (normalizeText(attemptRow.attempt_status).toLowerCase() !== 'pending') {
      await db.query('ROLLBACK');
      return {
        error: 'enrollment_attempt_not_pending',
        value: {
          enrollment_attempt_id: attemptRow.id,
          attempt_status: attemptRow.attempt_status
        }
      };
    }

    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId: safeCompanyId,
      deviceUid: attemptRow.device_uid
    });
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
    const canonicalDeviceUid = normalizeText(canonicalResolution.canonical_device_uid)
      || normalizeText(canonicalResolution.requested_device_uid)
      || normalizeText(attemptRow.device_uid);
    if (safeRequestedDeviceUid && canonicalDeviceUid !== safeRequestedDeviceUid) {
      await db.query('ROLLBACK');
      return {
        error: 'enrollment_attempt_device_mismatch',
        value: {
          requested_device_uid: safeRequestedDeviceUid,
          canonical_device_uid: canonicalDeviceUid
        }
      };
    }

    const deviceRes = await db.query(
      `
      SELECT
        company_id,
        device_uid,
        provider,
        managed_status,
        lifecycle_scope,
        site_id,
        metadata
      FROM devices
      WHERE company_id = $1
        AND device_uid = $2
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, canonicalDeviceUid]
    );
    const deviceRow = deviceRes.rows[0] || null;
    if (!deviceRow) {
      await db.query('ROLLBACK');
      return { error: 'device_not_found' };
    }

    const activeBinding = await getActiveManagingAgentBinding(db, {
      companyId: safeCompanyId,
      deviceUid: canonicalDeviceUid
    });
    if (!activeBinding || !normalizeText(activeBinding.agent_id)) {
      await db.query('ROLLBACK');
      return {
        error: 'device_managing_agent_binding_missing',
        value: {
          canonical_device_uid: canonicalDeviceUid
        }
      };
    }

    const targetAgentId = normalizeText(activeBinding.agent_id);
    const agent = await getAgentById(db, {
      companyId: safeCompanyId,
      agentId: targetAgentId
    });
    if (!agent) {
      await db.query('ROLLBACK');
      return { error: 'agent_not_found' };
    }
    if (normalizeText(agent.status).toLowerCase() !== 'active') {
      await db.query('ROLLBACK');
      return { error: 'agent_not_active' };
    }

    const executionGate = await evaluateCommandIssuanceGate(db, {
      companyId: safeCompanyId,
      targetAgentId,
      commandType: COMMAND_TYPES.RUN_K80_ENROLLMENT_ATTEMPT,
      deviceUid: canonicalDeviceUid,
      deviceSiteId: deviceRow.site_id || null,
      agentSiteId: agent.site_id || null,
      bindingAgentId: targetAgentId
    });
    if (!executionGate.allowed) {
      await db.query('ROLLBACK');
      return {
        error: executionGate.reason_code,
        value: {
          canonical_device_uid: canonicalDeviceUid,
          execution_gate: executionGate.details
        }
      };
    }

    await reconcileAgentCommandLifecycle(db, {
      companyId: safeCompanyId,
      agentId: targetAgentId
    });

    const inFlightRes = await db.query(
      `
      SELECT id, status
      FROM agent_commands
      WHERE company_id = $1
        AND agent_id = $2
        AND command_type = $3
        AND status IN ('queued', 'sent')
        AND COALESCE(command_payload->>'enrollment_attempt_id', '') = $4
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `,
      [safeCompanyId, targetAgentId, COMMAND_TYPES.RUN_K80_ENROLLMENT_ATTEMPT, safeAttemptId]
    );
    if (inFlightRes.rows.length > 0) {
      await db.query('ROLLBACK');
      return {
        error: 'enrollment_command_already_in_flight',
        value: {
          command_id: inFlightRes.rows[0].id,
          status: inFlightRes.rows[0].status
        }
      };
    }

    const connection = normalizeManualMetadataConnection(deviceRow.metadata);
    if (!normalizeText(connection.host) || !Number.isInteger(connection.port)) {
      await db.query('ROLLBACK');
      return {
        error: 'enrollment_device_connection_missing',
        value: {
          canonical_device_uid: canonicalDeviceUid
        }
      };
    }

    const ttlSeconds = defaultEnrollmentCommandTtlSeconds();
    const commandPayload = {
      enrollment_attempt_id: safeAttemptId,
      device_uid: canonicalDeviceUid,
      vendor: normalizeText(deviceRow.provider).toLowerCase() || 'zkteco',
      connection: {
        host: connection.host,
        port: connection.port,
        transport: connection.transport,
        attlog_sequence: connection.attlog_sequence,
        auth_password: connection.auth_password,
        device_number: connection.device_number
      },
      enrollment: {
        inventory_scope: attemptRow.inventory_scope,
        person_id: attemptRow.person_id,
        device_user_id: Number.isInteger(attemptRow.device_user_id) ? attemptRow.device_user_id : null,
        selected_finger: normalizeText(attemptRow.selected_finger).toUpperCase(),
        protocol_profile: 'k80_enrollment_chain_v1_conservative',
        progress_timeout_ms: parsePositiveInt(process.env.K80_ENROLLMENT_PROGRESS_TIMEOUT_MS, 45000) || 45000
      },
      runtime_context: {
        site_id: executionGate.details.site_id || null,
        active_site_agent_id: executionGate.details.active_site_agent_id || null,
        runtime_health_status: executionGate.details.runtime_health_status || null,
        version_support_status: executionGate.details.version_support_status || null
      }
    };

    const commandRes = await db.query(
      `
      INSERT INTO agent_commands (
        company_id,
        agent_id,
        command_type,
        command_payload,
        status,
        created_by_key_id,
        expires_at
      )
      VALUES ($1, $2, $3, $4::jsonb, 'queued', $5, now() + ($6::text || ' seconds')::interval)
      RETURNING id, company_id, agent_id, command_type, command_payload, status, created_at, expires_at
      `,
      [
        safeCompanyId,
        targetAgentId,
        COMMAND_TYPES.RUN_K80_ENROLLMENT_ATTEMPT,
        JSON.stringify(commandPayload),
        createdByKeyId || null,
        String(ttlSeconds)
      ]
    );
    const command = commandRes.rows[0];

    const nextSourceMetadata = {
      ...(isPlainObject(attemptRow.source_metadata) ? attemptRow.source_metadata : {}),
      protocol_execution_state: 'starting',
      execution_profile: 'k80_enrollment_chain_v1_conservative',
      queued_command_id: command.id,
      queued_agent_id: targetAgentId
    };
    await db.query(
      `
      UPDATE device_enrollment_attempts
      SET attempt_status = 'starting',
          status_reason = 'k80_protocol_execution_queued',
          command_ref = $1,
          source_metadata = $2::jsonb,
          updated_at = now()
      WHERE company_id = $3
        AND id = $4::uuid
      `,
      [
        command.id,
        JSON.stringify(nextSourceMetadata),
        safeCompanyId,
        safeAttemptId
      ]
    );

    await db.query('COMMIT');
    logBridgeEvent('bridge.agent.command.enrollment_attempt.queued', {
      company_id: safeCompanyId,
      agent_id: targetAgentId,
      command_id: command.id,
      enrollment_attempt_id: safeAttemptId,
      canonical_device_uid: canonicalDeviceUid,
      actor_type: safeActorType
    });
    return {
      value: {
        command,
        enrollment_attempt_id: safeAttemptId,
        canonical_device_uid: canonicalDeviceUid,
        agent_id: targetAgentId
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function fetchNextCommandForAgent(db, { companyId, agentId }) {
  await db.query('BEGIN');
  try {
    const polledAt = new Date().toISOString();
    await reconcileAgentCommandLifecycle(db, {
      companyId,
      agentId
    });

    let command = null;
    while (!command) {
      const res = await db.query(
        `
        SELECT id, company_id, agent_id, command_type, command_payload, created_at
        FROM agent_commands
        WHERE company_id = $1
          AND agent_id = $2
          AND status = 'queued'
          AND available_at <= now()
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
        `,
        [companyId, agentId]
      );
      if (res.rows.length === 0) {
        await upsertSiteRuntimeReportedStateFromAgent(db, {
          companyId,
          agentId,
          lastPollAt: polledAt,
          runtimeHealthStatus: 'healthy',
          runtimeHealthReason: 'command_poll_ok',
          reportedAt: polledAt,
          metadata: {
            source: 'agent.commands.next',
            command_available: false
          }
        });
        await db.query('COMMIT');
        logBridgeEvent('bridge.agent.command.poll.empty', {
          company_id: companyId,
          agent_id: agentId
        });
        return null;
      }

      const candidate = res.rows[0];
      const acceptanceGate = await evaluateCommandAcceptanceGate(db, {
        companyId,
        polledAgentId: agentId,
        commandType: candidate.command_type,
        commandPayload: candidate.command_payload
      });
      if (!acceptanceGate.allowed) {
        const payload = isPlainObject(candidate.command_payload) ? candidate.command_payload : {};
        const deviceUid = normalizeText(payload.device_uid);
        await db.query(
          `
          UPDATE agent_commands
          SET status = 'failed',
              failure_reason = $1,
              result_payload = COALESCE(result_payload, '{}'::jsonb) || $2::jsonb
          WHERE id = $3
            AND company_id = $4
            AND agent_id = $5
          `,
          [
            acceptanceGate.reason_code,
            JSON.stringify({
              failure_stage: 'execution_gate',
              execution_gate: acceptanceGate.details || {}
            }),
            candidate.id,
            companyId,
            agentId
          ]
        );
        if (candidate.command_type === COMMAND_TYPES.PULL_DEVICE_EVENTS && deviceUid) {
          await db.query(
            `
            UPDATE agent_device_sync_states
            SET status = 'error',
                consecutive_failures = consecutive_failures + 1,
                failure_reason = $1,
                last_error_at = now(),
                metadata = metadata || $2::jsonb,
                updated_at = now()
            WHERE company_id = $3
              AND agent_id = $4
              AND device_uid = $5
            `,
            [
              acceptanceGate.reason_code,
              JSON.stringify({
                last_command_id: candidate.id,
                last_command_status: COMMAND_STATUS.FAILED,
                last_command_failure_reason: acceptanceGate.reason_code
              }),
              companyId,
              agentId,
              deviceUid
            ]
          );
        }
        if (candidate.command_type === COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE) {
          await markValidationCommandFailure(db, {
            companyId,
            agentId,
            commandId: candidate.id,
            commandPayload: candidate.command_payload,
            failureReason: acceptanceGate.reason_code
          });
        }
        if (candidate.command_type === COMMAND_TYPES.RUN_K80_ENROLLMENT_ATTEMPT) {
          await markEnrollmentCommandFailure(db, {
            companyId,
            agentId,
            commandId: candidate.id,
            commandPayload: candidate.command_payload,
            failureReason: acceptanceGate.reason_code
          });
        }
        logBridgeEvent('bridge.agent.command.poll.blocked', {
          company_id: companyId,
          agent_id: agentId,
          command_id: candidate.id,
          command_type: candidate.command_type,
          failure_reason: acceptanceGate.reason_code
        });
        continue;
      }

      command = candidate;
    }

    await db.query(
      `
      UPDATE agent_commands
      SET status = 'sent', sent_at = now()
      WHERE id = $1
      `,
      [command.id]
    );

    if (command.command_type === COMMAND_TYPES.PULL_DEVICE_EVENTS) {
      const payload = isPlainObject(command.command_payload) ? command.command_payload : {};
      const deviceUid = normalizeText(payload.device_uid);
      if (deviceUid) {
        await db.query(
          `
          UPDATE agent_device_sync_states
          SET status = 'syncing',
              last_sync_started_at = now(),
              failure_reason = NULL,
              last_error_at = NULL,
              metadata = metadata || $1::jsonb,
              updated_at = now()
          WHERE company_id = $2
            AND agent_id = $3
            AND device_uid = $4
          `,
          [
            JSON.stringify({
              last_command_id: command.id,
              last_command_status: COMMAND_STATUS.SENT
            }),
            companyId,
            agentId,
            deviceUid
          ]
        );
      }
    }

    if (command.command_type === COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE) {
      const payload = isPlainObject(command.command_payload) ? command.command_payload : {};
      const deviceUid = normalizeText(payload.device_uid);
      if (deviceUid) {
        const beforeRes = await db.query(
          `
          SELECT metadata, managed_status
          FROM devices
          WHERE company_id = $1
            AND device_uid = $2
          LIMIT 1
          FOR UPDATE
          `,
          [companyId, deviceUid]
        );
        const beforeRow = beforeRes.rows[0] || null;
        if (beforeRow && normalizeText(beforeRow.managed_status).toLowerCase() === MANAGED_STATUS.CANDIDATE) {
          const nextMetadata = buildManualValidationMetadata(beforeRow.metadata, {
            status: MANUAL_VALIDATION_STATUS.IN_PROGRESS,
            last_started_at: new Date().toISOString(),
            last_command_id: command.id,
            last_agent_id: agentId,
            last_reason_code: null
          });
          await db.query(
            `
            UPDATE devices
            SET metadata = $1::jsonb,
                updated_at = now()
            WHERE company_id = $2
              AND device_uid = $3
            `,
            [JSON.stringify(nextMetadata), companyId, deviceUid]
          );
        }
      }
    }

    if (command.command_type === COMMAND_TYPES.RUN_K80_ENROLLMENT_ATTEMPT) {
      const payload = isPlainObject(command.command_payload) ? command.command_payload : {};
      const enrollmentAttemptId = normalizeText(payload.enrollment_attempt_id);
      if (enrollmentAttemptId) {
        const attemptRes = await db.query(
          `
          SELECT source_metadata
          FROM device_enrollment_attempts
          WHERE company_id = $1
            AND id = $2::uuid
          LIMIT 1
          FOR UPDATE
          `,
          [companyId, enrollmentAttemptId]
        );
        const attemptRow = attemptRes.rows[0] || null;
        if (attemptRow) {
          const sourceMetadata = {
            ...(isPlainObject(attemptRow.source_metadata) ? attemptRow.source_metadata : {}),
            protocol_execution_state: 'in_progress',
            in_progress_command_id: command.id,
            in_progress_agent_id: agentId
          };
          await db.query(
            `
            UPDATE device_enrollment_attempts
            SET attempt_status = 'in_progress',
                status_reason = 'k80_protocol_execution_in_progress',
                source_metadata = $1::jsonb,
                updated_at = now()
            WHERE company_id = $2
              AND id = $3::uuid
            `,
            [JSON.stringify(sourceMetadata), companyId, enrollmentAttemptId]
          );
        }
      }
    }

    await upsertSiteRuntimeReportedStateFromAgent(db, {
      companyId,
      agentId,
      lastPollAt: polledAt,
      runtimeHealthStatus: 'healthy',
      runtimeHealthReason: 'command_poll_ok',
      reportedAt: polledAt,
      metadata: {
        source: 'agent.commands.next',
        command_available: true,
        command_id: command.id,
        command_type: command.command_type
      }
    });

    await db.query('COMMIT');
    logBridgeEvent('bridge.agent.command.poll.sent', {
      company_id: companyId,
      agent_id: agentId,
      command_id: command.id,
      command_type: command.command_type
    });
    return command;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function acknowledgeCommand(db, { commandId, companyId, agentId, resultPayload }) {
  const safeResult = isPlainObject(resultPayload) ? resultPayload : {};
  await db.query(
    `
    UPDATE agent_commands
    SET status = 'acknowledged',
        acknowledged_at = now(),
        result_payload = $1::jsonb
    WHERE id = $2 AND company_id = $3 AND agent_id = $4
    `,
    [JSON.stringify(safeResult), commandId, companyId, agentId]
  );
}

async function ingestDeviceValidationResult(db, {
  companyId,
  agentId,
  payload
}) {
  const safePayload = isPlainObject(payload) ? payload : {};
  const commandId = normalizeText(safePayload.command_id);
  const requestedDeviceUid = normalizeText(safePayload.device_uid);
  if (!commandId || !requestedDeviceUid) {
    return { error: 'invalid_request' };
  }

  await db.query('BEGIN');
  try {
    const commandRes = await db.query(
      `
      SELECT id, status, command_payload
      FROM agent_commands
      WHERE id = $1
        AND company_id = $2
        AND agent_id = $3
        AND command_type = $4
      LIMIT 1
      FOR UPDATE
      `,
      [commandId, companyId, agentId, COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE]
    );
    const commandRow = commandRes.rows[0] || null;
    if (!commandRow) {
      await db.query('ROLLBACK');
      return { error: 'validation_command_not_found' };
    }

    const status = normalizeText(commandRow.status).toLowerCase();
    if (status === COMMAND_STATUS.FAILED || status === COMMAND_STATUS.EXPIRED) {
      await db.query('ROLLBACK');
      return {
        error: 'validation_command_not_pending',
        value: {
          command_id: commandId,
          status
        }
      };
    }

    const commandPayload = isPlainObject(commandRow.command_payload) ? commandRow.command_payload : {};
    const commandDeviceUid = normalizeText(commandPayload.device_uid);
    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId,
      deviceUid: requestedDeviceUid
    });
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
    const canonicalDeviceUid = normalizeText(canonicalResolution.canonical_device_uid)
      || normalizeText(canonicalResolution.requested_device_uid)
      || requestedDeviceUid;

    if (commandDeviceUid && canonicalDeviceUid && commandDeviceUid !== canonicalDeviceUid) {
      await db.query('ROLLBACK');
      return {
        error: 'validation_device_uid_mismatch',
        value: {
          command_id: commandId,
          command_device_uid: commandDeviceUid,
          requested_device_uid: requestedDeviceUid,
          canonical_device_uid: canonicalDeviceUid
        }
      };
    }

    const result = isPlainObject(safePayload.result) ? safePayload.result : {};
    const success = result.success === true;
    const reasonCode = normalizeText(result.reason_code)
      || (success ? 'validation_succeeded' : 'validation_failed');
    const completedAt = normalizeIsoOrNull(safePayload.completed_at) || new Date().toISOString();
    const startedAt = normalizeIsoOrNull(safePayload.started_at);
    const resultEvidence = isPlainObject(result.evidence) ? result.evidence : {};

    await db.query(
      `
      UPDATE agent_commands
      SET status = 'acknowledged',
          acknowledged_at = now(),
          result_payload = $1::jsonb
      WHERE id = $2
        AND company_id = $3
        AND agent_id = $4
      `,
      [
        JSON.stringify({
          validation_ok: success,
          reason_code: reasonCode,
          run_id: normalizeText(safePayload.run_id) || null,
          requested_device_uid: requestedDeviceUid,
          canonical_device_uid: canonicalDeviceUid,
          started_at: startedAt,
          completed_at: completedAt,
          evidence: resultEvidence
        }),
        commandId,
        companyId,
        agentId
      ]
    );

    const deviceRes = await db.query(
      `
      SELECT
        company_id,
        device_uid,
        provider,
        device_name,
        managed_status,
        lifecycle_scope,
        site_id,
        metadata
      FROM devices
      WHERE company_id = $1
        AND device_uid = $2
      LIMIT 1
      FOR UPDATE
      `,
      [companyId, canonicalDeviceUid]
    );
    const beforeRow = deviceRes.rows[0] || null;
    let afterRow = beforeRow;
    let lifecycleEventWritten = false;
    if (beforeRow && normalizeText(beforeRow.managed_status).toLowerCase() === MANAGED_STATUS.CANDIDATE) {
      const validationStatus = success
        ? MANUAL_VALIDATION_STATUS.SUCCEEDED
        : MANUAL_VALIDATION_STATUS.FAILED;
      const nextMetadata = buildManualValidationMetadata(beforeRow.metadata, {
        status: validationStatus,
        last_completed_at: completedAt,
        last_command_id: commandId,
        last_agent_id: agentId,
        last_reason_code: reasonCode,
        ...(success ? { last_success_at: completedAt } : { last_failure_at: completedAt }),
        last_result: {
          success,
          reason_code: reasonCode,
          run_id: normalizeText(safePayload.run_id) || null,
          started_at: startedAt,
          completed_at: completedAt,
          evidence: resultEvidence
        }
      });

      const updateRes = await db.query(
        `
        UPDATE devices
        SET metadata = $1::jsonb,
            updated_at = now()
        WHERE company_id = $2
          AND device_uid = $3
        RETURNING
          company_id,
          device_uid,
          provider,
          device_name,
          managed_status,
          lifecycle_scope,
          site_id,
          metadata
        `,
        [JSON.stringify(nextMetadata), companyId, canonicalDeviceUid]
      );
      afterRow = updateRes.rows[0] || beforeRow;

      if (shouldEmitManualCandidateUpdatedEvent(beforeRow, afterRow)) {
        await insertDeviceLifecycleEvent(db, {
          companyId,
          deviceUid: canonicalDeviceUid,
          lifecycleEvent: 'candidate_updated',
          actorType: 'agent',
          actorRef: String(agentId),
          agentId,
          fromState: toManualOnboardingLifecycleState(beforeRow),
          toState: toManualOnboardingLifecycleState(afterRow),
          reason: success ? 'validation_succeeded' : 'validation_failed',
          correlationId: normalizeLifecycleCorrelationId(safePayload.run_id),
          metadata: {
            source: 'agent.validation',
            command_id: commandId,
            requested_device_uid: requestedDeviceUid,
            canonical_device_uid: canonicalDeviceUid,
            canonical_resolved_by: canonicalResolution.resolved_by,
            canonical_alias_kind: canonicalResolution.alias_kind,
            canonical_alias_status: canonicalResolution.alias_status,
            validation_status: validationStatus,
            reason_code: reasonCode
          }
        });
        lifecycleEventWritten = true;
      }
    }

    if (afterRow) {
      await upsertDeviceRuntimeReportedState(db, {
        companyId,
        deviceUid: canonicalDeviceUid,
        siteId: afterRow.site_id || null,
        reportingAgentId: agentId,
        lastValidationStatus: success ? MANUAL_VALIDATION_STATUS.SUCCEEDED : MANUAL_VALIDATION_STATUS.FAILED,
        lastValidationReason: reasonCode,
        lastLocalContactAt: completedAt,
        reportedHealthStatus: success ? 'healthy' : 'blocked',
        reportedHealthReason: success ? 'validation_succeeded' : reasonCode,
        reportedAt: completedAt,
        metadata: {
          source: 'agent.device_validation_result',
          command_id: commandId,
          run_id: normalizeText(safePayload.run_id) || null
        }
      });

      if (success) {
        await upsertDeviceRuntimeCapabilityReportedState(db, {
          companyId,
          deviceUid: canonicalDeviceUid,
          siteId: afterRow.site_id || null,
          reportingAgentId: agentId,
          capabilityKey: DEVICE_PATH_CAPABILITY_KEYS.VALIDATE_DEVICE_CANDIDATE,
          capabilityStatus: CAPABILITY_STATUS.SUPPORTED,
          capabilityReason: 'validation_succeeded',
          reportedAt: completedAt,
          metadata: {
            source: 'agent.device_validation_result',
            command_id: commandId,
            run_id: normalizeText(safePayload.run_id) || null
          }
        });
      } else if (shouldPersistUnsupportedDeviceCapability(reasonCode)) {
        await upsertDeviceRuntimeCapabilityReportedState(db, {
          companyId,
          deviceUid: canonicalDeviceUid,
          siteId: afterRow.site_id || null,
          reportingAgentId: agentId,
          capabilityKey: DEVICE_PATH_CAPABILITY_KEYS.VALIDATE_DEVICE_CANDIDATE,
          capabilityStatus: CAPABILITY_STATUS.UNSUPPORTED,
          capabilityReason: reasonCode,
          reportedAt: completedAt,
          metadata: {
            source: 'agent.device_validation_result',
            command_id: commandId,
            run_id: normalizeText(safePayload.run_id) || null
          }
        });
      }
    }

    await db.query('COMMIT');
    return {
      value: {
        command_id: commandId,
        command_status: COMMAND_STATUS.ACKNOWLEDGED,
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by,
        canonical_alias_kind: canonicalResolution.alias_kind,
        canonical_alias_status: canonicalResolution.alias_status,
        result: {
          success,
          reason_code: reasonCode
        },
        lifecycle_event_written: lifecycleEventWritten,
        ...(afterRow ? toManualOnboardingReadModel(afterRow) : {})
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

function resolveSentStaleSecondsFromPayload(commandPayload, fallback) {
  const payload = isPlainObject(commandPayload) ? commandPayload : {};
  const validation = isPlainObject(payload.validation) ? payload.validation : {};
  const validationValue = validation.sent_stale_seconds;
  const validationParsed = parsePositiveInt(validationValue, null);
  if (validationParsed) {
    return validationParsed;
  }
  const pull = isPlainObject(payload.pull) ? payload.pull : {};
  const value = pull.sent_stale_seconds;
  return parsePositiveInt(value, fallback);
}

function normalizeCommandDeviceUid(commandPayload) {
  const payload = isPlainObject(commandPayload) ? commandPayload : {};
  return normalizeText(payload.device_uid);
}

async function markPullSyncStateCommandFailure(db, {
  companyId,
  agentId,
  commandId,
  commandPayload,
  failureReason
}) {
  const deviceUid = normalizeCommandDeviceUid(commandPayload);
  if (!deviceUid) {
    return;
  }

  await db.query(
    `
    UPDATE agent_device_sync_states
    SET status = 'error',
        consecutive_failures = consecutive_failures + 1,
        failure_reason = $1,
        last_error_at = now(),
        last_sync_completed_at = now(),
        metadata = metadata || $2::jsonb,
        updated_at = now()
    WHERE company_id = $3
      AND agent_id = $4
      AND device_uid = $5
    `,
    [
      failureReason,
      JSON.stringify({
        last_command_id: commandId,
        last_command_status: COMMAND_STATUS.FAILED,
        last_command_failure_reason: failureReason
      }),
      companyId,
      agentId,
      deviceUid
    ]
  );
}

async function markValidationCommandFailure(db, {
  companyId,
  agentId,
  commandId,
  commandPayload,
  failureReason
}) {
  const payload = isPlainObject(commandPayload) ? commandPayload : {};
  const deviceUid = normalizeText(payload.device_uid);
  if (!deviceUid) {
    return;
  }

  const beforeRes = await db.query(
    `
    SELECT
      company_id,
      device_uid,
      provider,
      device_name,
      managed_status,
      lifecycle_scope,
      metadata
    FROM devices
    WHERE company_id = $1
      AND device_uid = $2
    LIMIT 1
    FOR UPDATE
    `,
    [companyId, deviceUid]
  );
  const beforeRow = beforeRes.rows[0] || null;
  if (!beforeRow || normalizeText(beforeRow.managed_status).toLowerCase() !== MANAGED_STATUS.CANDIDATE) {
    return;
  }

  const nowIso = new Date().toISOString();
  const nextMetadata = buildManualValidationMetadata(beforeRow.metadata, {
    status: MANUAL_VALIDATION_STATUS.FAILED,
    last_completed_at: nowIso,
    last_failure_at: nowIso,
    last_reason_code: normalizeText(failureReason) || COMMAND_FAILURE_REASON.SENT_TIMEOUT,
    last_command_id: commandId,
    last_agent_id: agentId,
    last_result: {
      failure_reason: normalizeText(failureReason) || COMMAND_FAILURE_REASON.SENT_TIMEOUT,
      lifecycle_reconciled: true
    }
  });

  const updateRes = await db.query(
    `
    UPDATE devices
    SET metadata = $1::jsonb,
        updated_at = now()
    WHERE company_id = $2
      AND device_uid = $3
    RETURNING
      company_id,
      device_uid,
      provider,
      device_name,
      managed_status,
      lifecycle_scope,
      metadata
    `,
    [JSON.stringify(nextMetadata), companyId, deviceUid]
  );
  const afterRow = updateRes.rows[0] || null;
  if (afterRow && shouldEmitManualCandidateUpdatedEvent(beforeRow, afterRow)) {
    await insertDeviceLifecycleEvent(db, {
      companyId,
      deviceUid,
      lifecycleEvent: 'candidate_updated',
      actorType: 'system',
      actorRef: 'agent_command_lifecycle_reconciler',
      agentId,
      fromState: toManualOnboardingLifecycleState(beforeRow),
      toState: toManualOnboardingLifecycleState(afterRow),
      reason: 'validation_failed',
      correlationId: null,
      metadata: {
        source: 'agent_command_lifecycle_reconciler',
        command_id: commandId,
        validation_status: MANUAL_VALIDATION_STATUS.FAILED,
        failure_reason: normalizeText(failureReason) || COMMAND_FAILURE_REASON.SENT_TIMEOUT
      }
    });
  }
}

async function markEnrollmentCommandFailure(db, {
  companyId,
  agentId,
  commandId,
  commandPayload,
  failureReason
}) {
  const payload = isPlainObject(commandPayload) ? commandPayload : {};
  const enrollmentAttemptId = normalizeText(payload.enrollment_attempt_id);
  if (!enrollmentAttemptId) {
    return;
  }

  const nowIso = new Date().toISOString();
  const reason = normalizeText(failureReason) || COMMAND_FAILURE_REASON.SENT_TIMEOUT;
  const attemptRes = await db.query(
    `
    SELECT source_metadata, evidence_ref, attempt_status
    FROM device_enrollment_attempts
    WHERE company_id = $1
      AND id = $2::uuid
    LIMIT 1
    FOR UPDATE
    `,
    [companyId, enrollmentAttemptId]
  );
  const attempt = attemptRes.rows[0] || null;
  if (!attempt) {
    return;
  }

  const sourceMetadata = {
    ...(isPlainObject(attempt.source_metadata) ? attempt.source_metadata : {}),
    protocol_execution_state: 'failed_before_completion',
    failure_reason: reason,
    failure_command_id: commandId,
    failure_agent_id: agentId
  };
  const evidenceRef = {
    ...(isPlainObject(attempt.evidence_ref) ? attempt.evidence_ref : {}),
    lifecycle_failure_reason: reason
  };
  await db.query(
    `
    UPDATE device_enrollment_attempts
    SET attempt_status = 'partial_or_failed',
        status_reason = $1,
        source_metadata = $2::jsonb,
        evidence_ref = $3::jsonb,
        ended_at = COALESCE(ended_at, $4::timestamptz),
        updated_at = now()
    WHERE company_id = $5
      AND id = $6::uuid
    `,
    [
      `command_${reason}`,
      JSON.stringify(sourceMetadata),
      JSON.stringify(evidenceRef),
      nowIso,
      companyId,
      enrollmentAttemptId
    ]
  );
}

async function reconcileAgentCommandLifecycle(db, {
  companyId,
  agentId,
  nowIso,
  sentStaleSeconds
}) {
  const now = normalizeText(nowIso) || new Date().toISOString();
  const staleSeconds = parsePositiveInt(sentStaleSeconds, defaultSentStaleSeconds());

  const expiredRes = await db.query(
    `
    SELECT id, command_type, command_payload
    FROM agent_commands
    WHERE company_id = $1
      AND agent_id = $2
      AND status = $3
      AND expires_at IS NOT NULL
      AND expires_at <= $4::timestamptz
    ORDER BY created_at ASC
    `,
    [companyId, agentId, COMMAND_STATUS.QUEUED, now]
  );
  const expiredRows = expiredRes.rows || [];
  if (expiredRows.length > 0) {
    await db.query(
      `
      UPDATE agent_commands
      SET status = $1,
          failure_reason = $2,
          result_payload = COALESCE(result_payload, '{}'::jsonb) || $3::jsonb
      WHERE id = ANY($4::uuid[])
      `,
      [
        COMMAND_STATUS.EXPIRED,
        COMMAND_FAILURE_REASON.EXPIRED,
        JSON.stringify({
          lifecycle_reconciled: true,
          lifecycle_transition: 'queued_to_expired',
          reason: COMMAND_FAILURE_REASON.EXPIRED,
          reconciled_at: now
        }),
        expiredRows.map(row => row.id)
      ]
    );
  }

  const sentRes = await db.query(
    `
    SELECT id, command_type, command_payload, sent_at
    FROM agent_commands
    WHERE company_id = $1
      AND agent_id = $2
      AND status = $3
      AND sent_at IS NOT NULL
    ORDER BY sent_at ASC
    `,
    [companyId, agentId, COMMAND_STATUS.SENT]
  );
  const sentRows = sentRes.rows || [];
  const staleRows = sentRows.filter(row => {
    const sentAtMs = new Date(row.sent_at).getTime();
    if (Number.isNaN(sentAtMs)) {
      return false;
    }
    const threshold = resolveSentStaleSecondsFromPayload(row.command_payload, staleSeconds);
    return sentAtMs <= (new Date(now).getTime() - threshold * 1000);
  });

  if (staleRows.length > 0) {
    await db.query(
      `
      UPDATE agent_commands
      SET status = $1,
          failure_reason = $2,
          result_payload = COALESCE(result_payload, '{}'::jsonb) || $3::jsonb
      WHERE id = ANY($4::uuid[])
      `,
      [
        COMMAND_STATUS.FAILED,
        COMMAND_FAILURE_REASON.SENT_TIMEOUT,
        JSON.stringify({
          lifecycle_reconciled: true,
          lifecycle_transition: 'sent_to_failed',
          reason: COMMAND_FAILURE_REASON.SENT_TIMEOUT,
          reconciled_at: now
        }),
        staleRows.map(row => row.id)
      ]
    );
  }

  const transitionedRows = [...expiredRows, ...staleRows];
  for (const row of transitionedRows) {
    const failureReason = staleRows.find(item => item.id === row.id)
      ? COMMAND_FAILURE_REASON.SENT_TIMEOUT
      : COMMAND_FAILURE_REASON.EXPIRED;
    if (row.command_type === COMMAND_TYPES.PULL_DEVICE_EVENTS) {
      await markPullSyncStateCommandFailure(db, {
        companyId,
        agentId,
        commandId: row.id,
        commandPayload: row.command_payload,
        failureReason
      });
    }
    if (row.command_type === COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE) {
      await markValidationCommandFailure(db, {
        companyId,
        agentId,
        commandId: row.id,
        commandPayload: row.command_payload,
        failureReason
      });
    }
    if (row.command_type === COMMAND_TYPES.RUN_K80_ENROLLMENT_ATTEMPT) {
      await markEnrollmentCommandFailure(db, {
        companyId,
        agentId,
        commandId: row.id,
        commandPayload: row.command_payload,
        failureReason
      });
    }
  }

  return {
    now,
    expired_count: expiredRows.length,
    stale_sent_failed_count: staleRows.length,
    total_transitioned: expiredRows.length + staleRows.length
  };
}

async function ingestK80EnrollmentAttemptResult(db, {
  companyId,
  agentId,
  payload
}) {
  const safePayload = isPlainObject(payload) ? payload : {};
  const commandId = normalizeText(safePayload.command_id);
  const enrollmentAttemptId = normalizeText(safePayload.enrollment_attempt_id);
  const requestedDeviceUid = normalizeText(safePayload.device_uid);
  if (!commandId || !enrollmentAttemptId || !requestedDeviceUid) {
    return { error: 'invalid_request' };
  }

  await db.query('BEGIN');
  try {
    const commandRes = await db.query(
      `
      SELECT id, status, command_payload
      FROM agent_commands
      WHERE id = $1
        AND company_id = $2
        AND agent_id = $3
        AND command_type = $4
      LIMIT 1
      FOR UPDATE
      `,
      [commandId, companyId, agentId, COMMAND_TYPES.RUN_K80_ENROLLMENT_ATTEMPT]
    );
    const commandRow = commandRes.rows[0] || null;
    if (!commandRow) {
      await db.query('ROLLBACK');
      return { error: 'enrollment_command_not_found' };
    }
    const status = normalizeText(commandRow.status).toLowerCase();
    if (status === COMMAND_STATUS.FAILED || status === COMMAND_STATUS.EXPIRED) {
      await db.query('ROLLBACK');
      return {
        error: 'enrollment_command_not_pending',
        value: { command_id: commandId, status }
      };
    }

    const commandPayload = isPlainObject(commandRow.command_payload) ? commandRow.command_payload : {};
    const commandAttemptId = normalizeText(commandPayload.enrollment_attempt_id);
    const commandDeviceUid = normalizeText(commandPayload.device_uid);
    if (commandAttemptId && commandAttemptId !== enrollmentAttemptId) {
      await db.query('ROLLBACK');
      return {
        error: 'enrollment_attempt_mismatch',
        value: {
          command_enrollment_attempt_id: commandAttemptId,
          reported_enrollment_attempt_id: enrollmentAttemptId
        }
      };
    }
    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId,
      deviceUid: requestedDeviceUid
    });
    if (canonicalResolution.resolved_by === 'superseded_without_canonical') {
      await db.query('ROLLBACK');
      return {
        error: 'device_uid_superseded_without_canonical',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalResolution.canonical_device_uid
        }
      };
    }
    const canonicalDeviceUid = normalizeText(canonicalResolution.canonical_device_uid)
      || normalizeText(canonicalResolution.requested_device_uid)
      || requestedDeviceUid;
    if (commandDeviceUid && canonicalDeviceUid && commandDeviceUid !== canonicalDeviceUid) {
      await db.query('ROLLBACK');
      return {
        error: 'enrollment_device_uid_mismatch',
        value: {
          command_device_uid: commandDeviceUid,
          requested_device_uid: requestedDeviceUid,
          canonical_device_uid: canonicalDeviceUid
        }
      };
    }

    const attemptRes = await db.query(
      `
      SELECT
        id,
        attempt_status,
        status_reason,
        started_at,
        ended_at,
        protocol_session_ref,
        source_metadata,
        evidence_ref
      FROM device_enrollment_attempts
      WHERE company_id = $1
        AND id = $2::uuid
      LIMIT 1
      FOR UPDATE
      `,
      [companyId, enrollmentAttemptId]
    );
    const attemptRow = attemptRes.rows[0] || null;
    if (!attemptRow) {
      await db.query('ROLLBACK');
      return { error: 'enrollment_attempt_not_found' };
    }

    const result = isPlainObject(safePayload.result) ? safePayload.result : {};
    const evidenceFlags = isPlainObject(result.evidence_flags) ? result.evidence_flags : {};
    const conservativeClassification = classifyEnrollmentAttemptResultConservative({
      requestedStatus: result.attempt_status,
      requestedReason: result.status_reason,
      evidenceFlags
    });
    const saw05df = conservativeClassification.flags.saw_05df;
    const saw05ddAfter05df = conservativeClassification.flags.saw_05dd_after_05df;
    const finalStatus = conservativeClassification.final_status;
    const statusReason = conservativeClassification.status_reason;

    const completedAt = normalizeIsoOrNull(safePayload.completed_at) || new Date().toISOString();
    const startedAt = normalizeIsoOrNull(safePayload.started_at) || attemptRow.started_at || new Date().toISOString();
    const protocolExecutionState = normalizeText(result.protocol_execution_state).toLowerCase()
      || (finalStatus === 'success' ? 'completed_success' : 'completed_non_success');
    const sourceMetadata = {
      ...(isPlainObject(attemptRow.source_metadata) ? attemptRow.source_metadata : {}),
      ...(isPlainObject(result.source_metadata) ? result.source_metadata : {}),
      protocol_execution_state: protocolExecutionState,
      conservative_chain_classification: true
    };
    const evidenceRef = {
      ...(isPlainObject(attemptRow.evidence_ref) ? attemptRow.evidence_ref : {}),
      marker_flags: {
        saw_003e: evidenceFlags.saw_003e === true,
        saw_003d: evidenceFlags.saw_003d === true,
        saw_01f4_progress: evidenceFlags.saw_01f4_progress === true,
        saw_05df: saw05df,
        saw_05dd_after_05df: saw05ddAfter05df
      },
      protocol_refs: isPlainObject(result.evidence_refs) ? result.evidence_refs : {}
    };

    const resultPayload = {
      enrollment_attempt_id: enrollmentAttemptId,
      run_id: normalizeText(safePayload.run_id) || null,
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      attempt_status: finalStatus,
      status_reason: statusReason,
      protocol_execution_state: protocolExecutionState,
      protocol_session_ref: normalizeText(result.protocol_session_ref) || null,
      started_at: startedAt,
      completed_at: completedAt,
      evidence_flags: evidenceRef.marker_flags,
      evidence_refs: evidenceRef.protocol_refs,
      source_metadata: sourceMetadata
    };
    await db.query(
      `
      UPDATE agent_commands
      SET status = 'acknowledged',
          acknowledged_at = now(),
          result_payload = $1::jsonb
      WHERE id = $2
        AND company_id = $3
        AND agent_id = $4
      `,
      [JSON.stringify(resultPayload), commandId, companyId, agentId]
    );

    await db.query(
      `
      UPDATE device_enrollment_attempts
      SET attempt_status = $1,
          status_reason = $2,
          protocol_session_ref = COALESCE($3, protocol_session_ref),
          source_metadata = $4::jsonb,
          evidence_ref = $5::jsonb,
          started_at = COALESCE(started_at, $6::timestamptz),
          ended_at = $7::timestamptz,
          updated_at = now()
      WHERE company_id = $8
        AND id = $9::uuid
      `,
      [
        finalStatus,
        statusReason,
        normalizeText(result.protocol_session_ref) || null,
        JSON.stringify(sourceMetadata),
        JSON.stringify(evidenceRef),
        startedAt,
        completedAt,
        companyId,
        enrollmentAttemptId
      ]
    );

    await db.query('COMMIT');
    return {
      value: {
        command_id: commandId,
        enrollment_attempt_id: enrollmentAttemptId,
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        attempt_status: finalStatus,
        status_reason: statusReason,
        protocol_execution_state: protocolExecutionState
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

function classifyEnrollmentAttemptResultConservative({
  requestedStatus,
  requestedReason,
  evidenceFlags
}) {
  const flags = {
    saw_003e: isPlainObject(evidenceFlags) && evidenceFlags.saw_003e === true,
    saw_003d: isPlainObject(evidenceFlags) && evidenceFlags.saw_003d === true,
    saw_01f4_progress: isPlainObject(evidenceFlags) && evidenceFlags.saw_01f4_progress === true,
    saw_05df: isPlainObject(evidenceFlags) && evidenceFlags.saw_05df === true,
    saw_05dd_after_05df: isPlainObject(evidenceFlags) && evidenceFlags.saw_05dd_after_05df === true
  };
  const successChainObserved = flags.saw_05df && flags.saw_05dd_after_05df;
  let finalStatus = normalizeText(requestedStatus).toLowerCase();
  if (!['success', 'cancelled', 'partial_or_failed'].includes(finalStatus)) {
    finalStatus = 'partial_or_failed';
  }
  if (finalStatus === 'success' && !successChainObserved) {
    finalStatus = 'partial_or_failed';
  }

  let statusReason = normalizeText(requestedReason);
  if (!statusReason) {
    statusReason = finalStatus === 'success'
      ? 'success_chain_observed'
      : (finalStatus === 'cancelled' ? 'cancelled_without_success_chain' : 'partial_or_failed_without_success_chain');
  }
  if (normalizeText(requestedStatus).toLowerCase() === 'success' && !successChainObserved) {
    statusReason = 'success_chain_missing';
  }

  return {
    final_status: finalStatus,
    status_reason: statusReason,
    flags
  };
}

async function listAgentCommands(db, {
  companyId,
  agentId,
  deviceUid,
  status,
  createdFrom,
  createdTo,
  limit,
  offset
}) {
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
  const safeOffset = Number.isInteger(offset) ? Math.max(offset, 0) : 0;
  const params = [companyId];
  const where = ['company_id = $1'];

  if (normalizeText(agentId)) {
    params.push(normalizeText(agentId));
    where.push(`agent_id = $${params.length}`);
  }
  if (normalizeText(deviceUid)) {
    params.push(normalizeText(deviceUid));
    where.push(`COALESCE(command_payload->>'device_uid', '') = $${params.length}`);
  }
  if (normalizeText(status)) {
    params.push(normalizeText(status).toLowerCase());
    where.push(`status = $${params.length}`);
  }
  if (normalizeText(createdFrom)) {
    params.push(normalizeText(createdFrom));
    where.push(`created_at >= $${params.length}::timestamptz`);
  }
  if (normalizeText(createdTo)) {
    params.push(normalizeText(createdTo));
    where.push(`created_at <= $${params.length}::timestamptz`);
  }

  params.push(safeLimit);
  params.push(safeOffset);

  const res = await db.query(
    `
    SELECT
      id,
      company_id,
      agent_id,
      command_type,
      command_payload,
      status,
      available_at,
      expires_at,
      created_at,
      sent_at,
      acknowledged_at,
      failure_reason,
      result_payload
    FROM agent_commands
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
    `,
    params
  );
  return res.rows;
}

async function listAgents(db, {
  companyId,
  status,
  seenSince,
  limit,
  offset
}) {
  const siteRuntimeStaleMinutes = defaultSiteRuntimeReportedStaleMinutes();
  const versionReportedStaleMinutes = defaultAgentVersionReportedStaleMinutes();
  const versionPolicy = await getEffectiveAgentVersionPolicy(db, { companyId });
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
  const safeOffset = Number.isInteger(offset) ? Math.max(offset, 0) : 0;
  const params = [companyId];
  const where = ['a.company_id = $1'];

  if (normalizeText(status)) {
    params.push(normalizeText(status).toLowerCase());
    where.push(`a.status = $${params.length}`);
  }
  if (normalizeText(seenSince)) {
    params.push(normalizeText(seenSince));
    where.push(`COALESCE(a.last_seen_at, a.last_heartbeat_at, 'epoch'::timestamptz) >= $${params.length}::timestamptz`);
  }

  params.push(safeLimit);
  params.push(safeOffset);

  const res = await db.query(
    `
    SELECT
      a.id,
      a.agent_name,
      a.status,
      a.identity_status,
      a.active_runtime_identity_id,
      a.runtime_identity_issued_at,
      a.last_seen_at,
      a.last_heartbeat_at,
      a.created_at,
      a.site_id,
      s.site_key,
      s.site_name,
      s.status AS site_status,
      sal.lease_id AS site_active_lease_id,
      sal.agent_id AS site_active_agent_id,
      sal.leased_at AS site_active_leased_at,
      (sal.agent_id IS NOT NULL AND sal.agent_id = a.id) AS is_site_active_runtime,
      srs.reporting_agent_id AS site_runtime_reporting_agent_id,
      srs.runtime_health_status AS site_runtime_health_status_raw,
      srs.runtime_health_reason AS site_runtime_health_reason_raw,
      srs.reported_at AS site_runtime_reported_at,
      srs.last_heartbeat_at AS site_runtime_last_heartbeat_at,
      srs.last_poll_at AS site_runtime_last_poll_at,
      avrs.reported_version AS agent_reported_version,
      avrs.rollout_channel AS agent_reported_rollout_channel,
      avrs.reported_at AS agent_version_reported_at,
      ari.status AS runtime_identity_status,
      ari.issued_at AS runtime_identity_issued_at_raw,
      ari.revoked_at AS runtime_identity_revoked_at
    FROM agent_nodes a
    LEFT JOIN sites s
      ON s.company_id = a.company_id
     AND s.site_id = a.site_id
    LEFT JOIN site_agent_leases sal
      ON sal.company_id = a.company_id
     AND sal.site_id = a.site_id
     AND sal.status = 'active'
    LEFT JOIN site_runtime_reported_state srs
      ON srs.company_id = a.company_id
     AND srs.site_id = a.site_id
    LEFT JOIN agent_runtime_version_reported_state avrs
      ON avrs.company_id = a.company_id
     AND avrs.agent_id = a.id
    LEFT JOIN agent_runtime_identities ari
      ON ari.identity_id = a.active_runtime_identity_id
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(a.last_seen_at, a.last_heartbeat_at, a.created_at) DESC, a.created_at DESC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
    `,
    params
  );
  return res.rows.map(row => {
    const {
      site_runtime_reporting_agent_id,
      site_runtime_health_status_raw,
      site_runtime_health_reason_raw,
      site_runtime_reported_at,
      site_runtime_last_heartbeat_at,
      site_runtime_last_poll_at,
      agent_reported_version,
      agent_reported_rollout_channel,
      agent_version_reported_at,
      runtime_identity_issued_at_raw,
      ...baseRow
    } = row;
    const reported = toSiteRuntimeReportedReadModel({
      reporting_agent_id: site_runtime_reporting_agent_id,
      runtime_health_status: site_runtime_health_status_raw,
      runtime_health_reason: site_runtime_health_reason_raw,
      reported_at: site_runtime_reported_at,
      last_heartbeat_at: site_runtime_last_heartbeat_at,
      last_poll_at: site_runtime_last_poll_at
    }, {
      staleMinutes: siteRuntimeStaleMinutes
    });
    const versionGovernance = buildAgentVersionGovernanceProjection({
      agent_reported_version,
      agent_reported_rollout_channel,
      agent_version_reported_at
    }, versionPolicy.effective_policy, {
      staleMinutes: versionReportedStaleMinutes
    });
    return {
      ...baseRow,
      runtime_identity_status: normalizeText(row.runtime_identity_status).toLowerCase() || null,
      runtime_identity_issued_at: runtime_identity_issued_at_raw || row.runtime_identity_issued_at || null,
      runtime_identity_revoked_at: row.runtime_identity_revoked_at || null,
      site_runtime_reporting_agent_id: reported.reporting_agent_id,
      site_runtime_health_status: reported.health_status,
      site_runtime_health_reason: reported.health_reason,
      site_runtime_reported_at: reported.reported_at,
      site_runtime_last_heartbeat_at: reported.last_heartbeat_at,
      site_runtime_last_poll_at: reported.last_poll_at,
      site_runtime_reported_stale: reported.reported_stale,
      ...versionGovernance
    };
  });
}

function buildIntegrityCheckRows(countRows, definitions, severity) {
  const countsByName = new Map(
    (Array.isArray(countRows) ? countRows : []).map(row => [
      normalizeText(row.check_name),
      parseCount(row.issue_count)
    ])
  );
  return definitions.map(definition => {
    const checkName = normalizeText(definition.check_name);
    const issueCount = countsByName.has(checkName) ? countsByName.get(checkName) : 0;
    return {
      check_name: checkName,
      severity,
      issue_count: issueCount,
      description: definition.description
    };
  });
}

function sumIntegrityIssues(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((acc, row) => {
    return acc + parseCount(row && row.issue_count);
  }, 0);
}

async function getLifecycleIntegrityReport(db, {
  companyId,
  includeDetails,
  detailLimit
}) {
  const safeCompanyId = normalizeText(companyId) || 'DEFAULT';
  const safeIncludeDetails = includeDetails === true;
  const safeDetailLimit = Math.min(Math.max(parsePositiveInt(detailLimit, 50), 1), 200);

  const requiredMigrationsRes = await db.query(
    `
    SELECT
      required.filename,
      CASE
        WHEN sm.filename IS NULL THEN 'missing'
        ELSE 'applied'
      END AS status
    FROM unnest($1::text[]) AS required(filename)
    LEFT JOIN public.schema_migrations sm
      ON sm.filename = required.filename
    ORDER BY required.filename
    `,
    [LIFECYCLE_REQUIRED_MIGRATIONS]
  );

  const lifecycleSummaryRes = await db.query(
    `
    SELECT
      d.company_id,
      d.lifecycle_scope,
      d.managed_status,
      d.identity_status,
      COUNT(*)::bigint AS row_count
    FROM public.devices d
    WHERE d.company_id = $1
    GROUP BY d.company_id, d.lifecycle_scope, d.managed_status, d.identity_status
    ORDER BY d.lifecycle_scope, d.managed_status, d.identity_status
    `,
    [safeCompanyId]
  );

  const checkCountsRes = await db.query(
    `
    WITH checks AS (
      SELECT
        'superseded_without_canonical'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.identity_status = 'superseded'
        AND d.superseded_by_device_uid IS NULL

      UNION ALL

      SELECT
        'canonical_with_superseded_pointer'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.identity_status <> 'superseded'
        AND d.superseded_by_device_uid IS NOT NULL

      UNION ALL

      SELECT
        'managed_bridge_missing_active_binding'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.lifecycle_scope = 'bridge_ops'
        AND d.managed_status = 'managed'
        AND NOT EXISTS (
          SELECT 1
          FROM public.device_managing_agent_bindings b
          WHERE b.company_id = d.company_id
            AND b.device_uid = d.device_uid
            AND b.status = 'active'
        )

      UNION ALL

      SELECT
        'active_binding_on_non_bridge_or_non_managed_device'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.device_managing_agent_bindings b
      JOIN public.devices d
        ON d.company_id = b.company_id
       AND d.device_uid = b.device_uid
      WHERE b.company_id = $1
        AND b.status = 'active'
        AND (d.lifecycle_scope <> 'bridge_ops' OR d.managed_status <> 'managed')

      UNION ALL

      SELECT
        'canonical_device_missing_active_device_uid_alias'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.identity_status <> 'superseded'
        AND NOT EXISTS (
          SELECT 1
          FROM public.device_identity_aliases a
          WHERE a.company_id = d.company_id
            AND a.canonical_device_uid = d.device_uid
            AND a.alias_kind = 'device_uid'
            AND lower(a.alias_value_normalized) = lower(d.device_uid)
            AND a.status = 'active'
        )

      UNION ALL

      SELECT
        'active_alias_points_to_superseded_canonical'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.device_identity_aliases a
      JOIN public.devices d
        ON d.company_id = a.company_id
       AND d.device_uid = a.canonical_device_uid
      WHERE a.company_id = $1
        AND a.status = 'active'
        AND d.identity_status = 'superseded'

      UNION ALL

      SELECT
        'ingest_only_with_bridge_evidence_advisory'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.lifecycle_scope = 'ingest_only'
        AND (
          d.source = 'agent_discovery'
          OR d.managed_status = 'candidate'
          OR d.discovered_by_agent_id IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM public.agent_device_sync_states s
            WHERE s.company_id = d.company_id
              AND s.device_uid = d.device_uid
          )
          OR EXISTS (
            SELECT 1
            FROM public.agent_device_event_batches b
            WHERE b.company_id = d.company_id
              AND b.device_uid = d.device_uid
          )
        )

      UNION ALL

      SELECT
        'active_serial_alias_multi_canonical_advisory'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM (
        SELECT
          lower(a.alias_value_normalized) AS alias_value,
          COUNT(DISTINCT a.canonical_device_uid) AS canonical_count
        FROM public.device_identity_aliases a
        WHERE a.company_id = $1
          AND a.status = 'active'
          AND a.alias_kind = 'serial_number'
        GROUP BY lower(a.alias_value_normalized)
        HAVING COUNT(DISTINCT a.canonical_device_uid) > 1
      ) t

      UNION ALL

      SELECT
        'active_mac_alias_multi_canonical_advisory'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM (
        SELECT
          lower(a.alias_value_normalized) AS alias_value,
          COUNT(DISTINCT a.canonical_device_uid) AS canonical_count
        FROM public.device_identity_aliases a
        WHERE a.company_id = $1
          AND a.status = 'active'
          AND a.alias_kind = 'mac'
        GROUP BY lower(a.alias_value_normalized)
        HAVING COUNT(DISTINCT a.canonical_device_uid) > 1
      ) t
    )
    SELECT check_name, issue_count
    FROM checks
    ORDER BY check_name
    `,
    [safeCompanyId]
  );

  const strictChecks = buildIntegrityCheckRows(
    checkCountsRes.rows,
    LIFECYCLE_INTEGRITY_STRICT_CHECKS,
    'strict'
  );
  const advisoryChecks = buildIntegrityCheckRows(
    checkCountsRes.rows,
    LIFECYCLE_INTEGRITY_ADVISORY_CHECKS,
    'advisory'
  );

  let details = null;
  if (safeIncludeDetails) {
    const supersededWithoutCanonicalRes = await db.query(
      `
      SELECT
        d.company_id,
        d.device_uid,
        d.identity_status,
        d.superseded_by_device_uid,
        d.updated_at
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.identity_status = 'superseded'
        AND d.superseded_by_device_uid IS NULL
      ORDER BY d.updated_at DESC
      LIMIT $2
      `,
      [safeCompanyId, safeDetailLimit]
    );

    const canonicalWithSupersededPointerRes = await db.query(
      `
      SELECT
        d.company_id,
        d.device_uid,
        d.identity_status,
        d.superseded_by_device_uid,
        d.updated_at
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.identity_status <> 'superseded'
        AND d.superseded_by_device_uid IS NOT NULL
      ORDER BY d.updated_at DESC, d.device_uid ASC
      LIMIT $2
      `,
      [safeCompanyId, safeDetailLimit]
    );

    const managedMissingBindingRes = await db.query(
      `
      SELECT
        d.company_id,
        d.device_uid,
        d.managed_status,
        d.lifecycle_scope,
        d.updated_at
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.lifecycle_scope = 'bridge_ops'
        AND d.managed_status = 'managed'
        AND NOT EXISTS (
          SELECT 1
          FROM public.device_managing_agent_bindings b
          WHERE b.company_id = d.company_id
            AND b.device_uid = d.device_uid
            AND b.status = 'active'
        )
      ORDER BY d.updated_at DESC, d.device_uid ASC
      LIMIT $2
      `,
      [safeCompanyId, safeDetailLimit]
    );

    const activeBindingMismatchRes = await db.query(
      `
      SELECT
        b.company_id,
        b.device_uid,
        b.agent_id,
        b.status AS binding_status,
        d.managed_status,
        d.lifecycle_scope,
        b.updated_at
      FROM public.device_managing_agent_bindings b
      JOIN public.devices d
        ON d.company_id = b.company_id
       AND d.device_uid = b.device_uid
      WHERE b.company_id = $1
        AND b.status = 'active'
        AND (d.lifecycle_scope <> 'bridge_ops' OR d.managed_status <> 'managed')
      ORDER BY b.updated_at DESC, b.device_uid ASC
      LIMIT $2
      `,
      [safeCompanyId, safeDetailLimit]
    );

    const canonicalMissingAliasRes = await db.query(
      `
      SELECT
        d.company_id,
        d.device_uid,
        d.identity_status,
        d.updated_at
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.identity_status <> 'superseded'
        AND NOT EXISTS (
          SELECT 1
          FROM public.device_identity_aliases a
          WHERE a.company_id = d.company_id
            AND a.canonical_device_uid = d.device_uid
            AND a.alias_kind = 'device_uid'
            AND lower(a.alias_value_normalized) = lower(d.device_uid)
            AND a.status = 'active'
        )
      ORDER BY d.updated_at DESC, d.device_uid ASC
      LIMIT $2
      `,
      [safeCompanyId, safeDetailLimit]
    );

    const activeAliasToSupersededRes = await db.query(
      `
      SELECT
        a.company_id,
        a.alias_kind,
        a.vendor,
        a.alias_value_normalized,
        a.status AS alias_status,
        a.canonical_device_uid,
        d.identity_status,
        d.superseded_by_device_uid,
        a.updated_at
      FROM public.device_identity_aliases a
      JOIN public.devices d
        ON d.company_id = a.company_id
       AND d.device_uid = a.canonical_device_uid
      WHERE a.company_id = $1
        AND a.status = 'active'
        AND d.identity_status = 'superseded'
      ORDER BY a.updated_at DESC
      LIMIT $2
      `,
      [safeCompanyId, safeDetailLimit]
    );

    const ingestOnlyWithBridgeEvidenceRes = await db.query(
      `
      SELECT
        d.company_id,
        d.device_uid,
        d.lifecycle_scope,
        d.managed_status,
        d.source,
        d.discovered_by_agent_id,
        d.updated_at
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.lifecycle_scope = 'ingest_only'
        AND (
          d.source = 'agent_discovery'
          OR d.managed_status = 'candidate'
          OR d.discovered_by_agent_id IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM public.agent_device_sync_states s
            WHERE s.company_id = d.company_id
              AND s.device_uid = d.device_uid
          )
          OR EXISTS (
            SELECT 1
            FROM public.agent_device_event_batches b
            WHERE b.company_id = d.company_id
              AND b.device_uid = d.device_uid
          )
        )
      ORDER BY d.updated_at DESC, d.device_uid ASC
      LIMIT $2
      `,
      [safeCompanyId, safeDetailLimit]
    );

    const activeSerialConflictRes = await db.query(
      `
      SELECT
        a.company_id,
        lower(a.alias_value_normalized) AS alias_value_normalized,
        COUNT(DISTINCT a.canonical_device_uid)::bigint AS canonical_count,
        array_agg(DISTINCT a.canonical_device_uid ORDER BY a.canonical_device_uid) AS canonical_device_uids
      FROM public.device_identity_aliases a
      WHERE a.company_id = $1
        AND a.status = 'active'
        AND a.alias_kind = 'serial_number'
      GROUP BY a.company_id, lower(a.alias_value_normalized)
      HAVING COUNT(DISTINCT a.canonical_device_uid) > 1
      ORDER BY canonical_count DESC, alias_value_normalized ASC
      LIMIT $2
      `,
      [safeCompanyId, safeDetailLimit]
    );

    const activeMacConflictRes = await db.query(
      `
      SELECT
        a.company_id,
        lower(a.alias_value_normalized) AS alias_value_normalized,
        COUNT(DISTINCT a.canonical_device_uid)::bigint AS canonical_count,
        array_agg(DISTINCT a.canonical_device_uid ORDER BY a.canonical_device_uid) AS canonical_device_uids
      FROM public.device_identity_aliases a
      WHERE a.company_id = $1
        AND a.status = 'active'
        AND a.alias_kind = 'mac'
      GROUP BY a.company_id, lower(a.alias_value_normalized)
      HAVING COUNT(DISTINCT a.canonical_device_uid) > 1
      ORDER BY canonical_count DESC, alias_value_normalized ASC
      LIMIT $2
      `,
      [safeCompanyId, safeDetailLimit]
    );

    details = {
      detail_limit: safeDetailLimit,
      strict: {
        superseded_without_canonical: supersededWithoutCanonicalRes.rows,
        canonical_with_superseded_pointer: canonicalWithSupersededPointerRes.rows,
        managed_bridge_missing_active_binding: managedMissingBindingRes.rows,
        active_binding_on_non_bridge_or_non_managed_device: activeBindingMismatchRes.rows,
        canonical_device_missing_active_device_uid_alias: canonicalMissingAliasRes.rows,
        active_alias_points_to_superseded_canonical: activeAliasToSupersededRes.rows
      },
      advisory: {
        ingest_only_with_bridge_evidence_advisory: ingestOnlyWithBridgeEvidenceRes.rows,
        active_serial_alias_multi_canonical_advisory: activeSerialConflictRes.rows,
        active_mac_alias_multi_canonical_advisory: activeMacConflictRes.rows
      }
    };
  }

  return {
    company_id: safeCompanyId,
    generated_at: new Date().toISOString(),
    required_migrations: requiredMigrationsRes.rows.map(row => ({
      filename: row.filename,
      status: row.status,
      scope: 'global'
    })),
    lifecycle_summary: lifecycleSummaryRes.rows.map(row => ({
      company_id: row.company_id,
      lifecycle_scope: row.lifecycle_scope,
      managed_status: row.managed_status,
      identity_status: row.identity_status,
      row_count: parseCount(row.row_count)
    })),
    checks: {
      strict: strictChecks,
      advisory: advisoryChecks
    },
    strict_issue_count_total: sumIntegrityIssues(strictChecks),
    advisory_issue_count_total: sumIntegrityIssues(advisoryChecks),
    details
  };
}

async function getLifecycleStrictCheckCounts(db, { companyId }) {
  const safeCompanyId = normalizeText(companyId) || 'DEFAULT';
  const res = await db.query(
    `
    WITH checks AS (
      SELECT
        'superseded_without_canonical'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.identity_status = 'superseded'
        AND d.superseded_by_device_uid IS NULL

      UNION ALL

      SELECT
        'canonical_with_superseded_pointer'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.identity_status <> 'superseded'
        AND d.superseded_by_device_uid IS NOT NULL

      UNION ALL

      SELECT
        'managed_bridge_missing_active_binding'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.lifecycle_scope = 'bridge_ops'
        AND d.managed_status = 'managed'
        AND NOT EXISTS (
          SELECT 1
          FROM public.device_managing_agent_bindings b
          WHERE b.company_id = d.company_id
            AND b.device_uid = d.device_uid
            AND b.status = 'active'
        )

      UNION ALL

      SELECT
        'active_binding_on_non_bridge_or_non_managed_device'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.device_managing_agent_bindings b
      JOIN public.devices d
        ON d.company_id = b.company_id
       AND d.device_uid = b.device_uid
      WHERE b.company_id = $1
        AND b.status = 'active'
        AND (d.lifecycle_scope <> 'bridge_ops' OR d.managed_status <> 'managed')

      UNION ALL

      SELECT
        'canonical_device_missing_active_device_uid_alias'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.devices d
      WHERE d.company_id = $1
        AND d.identity_status <> 'superseded'
        AND NOT EXISTS (
          SELECT 1
          FROM public.device_identity_aliases a
          WHERE a.company_id = d.company_id
            AND a.canonical_device_uid = d.device_uid
            AND a.alias_kind = 'device_uid'
            AND lower(a.alias_value_normalized) = lower(d.device_uid)
            AND a.status = 'active'
        )

      UNION ALL

      SELECT
        'active_alias_points_to_superseded_canonical'::text AS check_name,
        COUNT(*)::bigint AS issue_count
      FROM public.device_identity_aliases a
      JOIN public.devices d
        ON d.company_id = a.company_id
       AND d.device_uid = a.canonical_device_uid
      WHERE a.company_id = $1
        AND a.status = 'active'
        AND d.identity_status = 'superseded'
    )
    SELECT check_name, issue_count
    FROM checks
    ORDER BY check_name
    `,
    [safeCompanyId]
  );
  return res.rows;
}

async function getLifecycleStrictAnomalyDetails(db, { companyId, detailLimit }) {
  const safeCompanyId = normalizeText(companyId) || 'DEFAULT';
  const safeDetailLimit = Math.min(Math.max(parsePositiveInt(detailLimit, 50), 1), 200);

  const supersededWithoutCanonicalRes = await db.query(
    `
    SELECT
      d.company_id,
      d.device_uid,
      d.identity_status,
      d.superseded_by_device_uid,
      d.updated_at
    FROM public.devices d
    WHERE d.company_id = $1
      AND d.identity_status = 'superseded'
      AND d.superseded_by_device_uid IS NULL
    ORDER BY d.updated_at DESC
    LIMIT $2
    `,
    [safeCompanyId, safeDetailLimit]
  );

  const canonicalWithSupersededPointerRes = await db.query(
    `
    SELECT
      d.company_id,
      d.device_uid,
      d.identity_status,
      d.superseded_by_device_uid,
      d.updated_at
    FROM public.devices d
    WHERE d.company_id = $1
      AND d.identity_status <> 'superseded'
      AND d.superseded_by_device_uid IS NOT NULL
    ORDER BY d.updated_at DESC, d.device_uid ASC
    LIMIT $2
    `,
    [safeCompanyId, safeDetailLimit]
  );

  const managedMissingBindingRes = await db.query(
    `
    SELECT
      d.company_id,
      d.device_uid,
      d.managed_status,
      d.lifecycle_scope,
      d.updated_at
    FROM public.devices d
    WHERE d.company_id = $1
      AND d.lifecycle_scope = 'bridge_ops'
      AND d.managed_status = 'managed'
      AND NOT EXISTS (
        SELECT 1
        FROM public.device_managing_agent_bindings b
        WHERE b.company_id = d.company_id
          AND b.device_uid = d.device_uid
          AND b.status = 'active'
      )
    ORDER BY d.updated_at DESC, d.device_uid ASC
    LIMIT $2
    `,
    [safeCompanyId, safeDetailLimit]
  );

  const activeBindingMismatchRes = await db.query(
    `
    SELECT
      b.company_id,
      b.device_uid,
      b.agent_id,
      b.status AS binding_status,
      d.managed_status,
      d.lifecycle_scope,
      b.updated_at
    FROM public.device_managing_agent_bindings b
    JOIN public.devices d
      ON d.company_id = b.company_id
     AND d.device_uid = b.device_uid
    WHERE b.company_id = $1
      AND b.status = 'active'
      AND (d.lifecycle_scope <> 'bridge_ops' OR d.managed_status <> 'managed')
    ORDER BY b.updated_at DESC, b.device_uid ASC
    LIMIT $2
    `,
    [safeCompanyId, safeDetailLimit]
  );

  const canonicalMissingAliasRes = await db.query(
    `
    SELECT
      d.company_id,
      d.device_uid,
      d.identity_status,
      d.updated_at
    FROM public.devices d
    WHERE d.company_id = $1
      AND d.identity_status <> 'superseded'
      AND NOT EXISTS (
        SELECT 1
        FROM public.device_identity_aliases a
        WHERE a.company_id = d.company_id
          AND a.canonical_device_uid = d.device_uid
          AND a.alias_kind = 'device_uid'
          AND lower(a.alias_value_normalized) = lower(d.device_uid)
          AND a.status = 'active'
      )
    ORDER BY d.updated_at DESC, d.device_uid ASC
    LIMIT $2
    `,
    [safeCompanyId, safeDetailLimit]
  );

  const activeAliasToSupersededRes = await db.query(
    `
    SELECT
      a.company_id,
      a.alias_kind,
      a.vendor,
      a.alias_value_normalized,
      a.status AS alias_status,
      a.canonical_device_uid,
      d.identity_status,
      d.superseded_by_device_uid,
      a.updated_at
    FROM public.device_identity_aliases a
    JOIN public.devices d
      ON d.company_id = a.company_id
     AND d.device_uid = a.canonical_device_uid
    WHERE a.company_id = $1
      AND a.status = 'active'
      AND d.identity_status = 'superseded'
    ORDER BY a.updated_at DESC
    LIMIT $2
    `,
    [safeCompanyId, safeDetailLimit]
  );

  return {
    detail_limit: safeDetailLimit,
    strict: {
      superseded_without_canonical: supersededWithoutCanonicalRes.rows,
      canonical_with_superseded_pointer: canonicalWithSupersededPointerRes.rows,
      managed_bridge_missing_active_binding: managedMissingBindingRes.rows,
      active_binding_on_non_bridge_or_non_managed_device: activeBindingMismatchRes.rows,
      canonical_device_missing_active_device_uid_alias: canonicalMissingAliasRes.rows,
      active_alias_points_to_superseded_canonical: activeAliasToSupersededRes.rows
    }
  };
}

function buildLifecycleDryRunProposal(anomalyType, evidence) {
  const safeAnomalyType = normalizeText(anomalyType);
  if (safeAnomalyType === 'canonical_device_missing_active_device_uid_alias') {
    const vendor = deriveVendorFromDeviceUid(evidence && evidence.device_uid, 'unknown');
    return {
      proposed_repair_action: {
        action_type: 'insert_active_device_uid_self_alias',
        target_table: 'device_identity_aliases',
        action_mode: 'dry_run_only',
        candidate_parameters: {
          company_id: evidence.company_id,
          canonical_device_uid: evidence.device_uid,
          alias_kind: 'device_uid',
          vendor,
          alias_value_normalized: evidence.device_uid,
          status: 'active'
        }
      },
      confidence: 'high',
      safety_level: 'safe_auto',
      rationale: 'Canonical device row has no active self-alias and repair target is deterministic.'
    };
  }

  if (safeAnomalyType === 'active_alias_points_to_superseded_canonical') {
    const redirectUid = normalizeText(evidence && evidence.superseded_by_device_uid);
    if (redirectUid) {
      return {
        proposed_repair_action: {
          action_type: 'retarget_alias_to_canonical_redirect',
          target_table: 'device_identity_aliases',
          action_mode: 'dry_run_only',
          candidate_parameters: {
            company_id: evidence.company_id,
            alias_kind: evidence.alias_kind,
            alias_value_normalized: evidence.alias_value_normalized,
            current_canonical_device_uid: evidence.canonical_device_uid,
            next_canonical_device_uid: redirectUid
          }
        },
        confidence: 'high',
        safety_level: 'safe_auto',
        rationale: 'Alias currently points to superseded canonical row with explicit redirect target.'
      };
    }
    return {
      proposed_repair_action: {
        action_type: 'manual_alias_retarget_required',
        target_table: 'device_identity_aliases',
        action_mode: 'dry_run_only',
        candidate_parameters: {
          company_id: evidence.company_id,
          alias_kind: evidence.alias_kind,
          alias_value_normalized: evidence.alias_value_normalized,
          current_canonical_device_uid: evidence.canonical_device_uid
        }
      },
      confidence: 'low',
      safety_level: 'manual_required',
      rationale: 'Superseded canonical has no redirect target; deterministic retarget is not possible.'
    };
  }

  if (safeAnomalyType === 'superseded_without_canonical') {
    return {
      proposed_repair_action: {
        action_type: 'manual_set_superseded_redirect',
        target_table: 'devices',
        action_mode: 'dry_run_only',
        candidate_parameters: {
          company_id: evidence.company_id,
          device_uid: evidence.device_uid,
          superseded_by_device_uid: null
        }
      },
      confidence: 'low',
      safety_level: 'manual_required',
      rationale: 'No canonical redirect is available; operator must pick the canonical target explicitly.'
    };
  }

  if (safeAnomalyType === 'canonical_with_superseded_pointer') {
    return {
      proposed_repair_action: {
        action_type: 'clear_superseded_pointer_on_canonical_row',
        target_table: 'devices',
        action_mode: 'dry_run_only',
        candidate_parameters: {
          company_id: evidence.company_id,
          device_uid: evidence.device_uid,
          superseded_by_device_uid: null,
          current_superseded_by_device_uid: evidence.superseded_by_device_uid
        }
      },
      confidence: 'medium',
      safety_level: 'needs_review',
      rationale: 'Canonical rows should not carry superseded redirect pointers.'
    };
  }

  if (safeAnomalyType === 'managed_bridge_missing_active_binding') {
    return {
      proposed_repair_action: {
        action_type: 'manual_create_active_managing_agent_binding',
        target_table: 'device_managing_agent_bindings',
        action_mode: 'dry_run_only',
        candidate_parameters: {
          company_id: evidence.company_id,
          device_uid: evidence.device_uid,
          required_field: 'agent_id'
        }
      },
      confidence: 'low',
      safety_level: 'manual_required',
      rationale: 'Missing binding requires explicit agent assignment; no deterministic agent can be inferred safely.'
    };
  }

  if (safeAnomalyType === 'active_binding_on_non_bridge_or_non_managed_device') {
    const lifecycleScope = normalizeText(evidence && evidence.lifecycle_scope).toLowerCase();
    const managedStatus = normalizeText(evidence && evidence.managed_status).toLowerCase();
    if (lifecycleScope !== 'bridge_ops' && managedStatus === 'managed') {
      return {
        proposed_repair_action: {
          action_type: 'set_device_lifecycle_scope_bridge_ops',
          target_table: 'devices',
          action_mode: 'dry_run_only',
          candidate_parameters: {
            company_id: evidence.company_id,
            device_uid: evidence.device_uid,
            lifecycle_scope: 'bridge_ops',
            current_lifecycle_scope: evidence.lifecycle_scope
          }
        },
        confidence: 'medium',
        safety_level: 'needs_review',
        rationale: 'Active binding on managed row suggests lifecycle_scope drift.'
      };
    }
    return {
      proposed_repair_action: {
        action_type: 'manual_binding_scope_reconciliation',
        target_table: 'device_managing_agent_bindings',
        action_mode: 'dry_run_only',
        candidate_parameters: {
          company_id: evidence.company_id,
          device_uid: evidence.device_uid,
          agent_id: evidence.agent_id,
          current_binding_status: evidence.binding_status,
          current_managed_status: evidence.managed_status,
          current_lifecycle_scope: evidence.lifecycle_scope
        }
      },
      confidence: 'low',
      safety_level: 'manual_required',
      rationale: 'Binding/device lifecycle mismatch needs explicit operator decision to avoid incorrect automatic demotion.'
    };
  }

  return {
    proposed_repair_action: {
      action_type: 'manual_reconciliation_required',
      target_table: null,
      action_mode: 'dry_run_only',
      candidate_parameters: {}
    },
    confidence: 'low',
    safety_level: 'manual_required',
    rationale: 'No deterministic proposal mapping exists for this anomaly type.'
  };
}

function buildLifecycleDryRunFindings(details) {
  const strictDetails = details && details.strict ? details.strict : {};
  const findings = [];
  for (const definition of LIFECYCLE_INTEGRITY_STRICT_CHECKS) {
    const anomalyType = normalizeText(definition.check_name);
    const rows = Array.isArray(strictDetails[anomalyType]) ? strictDetails[anomalyType] : [];
    for (const evidence of rows) {
      const proposal = buildLifecycleDryRunProposal(anomalyType, evidence || {});
      findings.push({
        anomaly_detected: {
          anomaly_type: anomalyType,
          severity: 'strict',
          description: definition.description,
          evidence: evidence || {}
        },
        proposed_repair_action: proposal.proposed_repair_action,
        confidence: proposal.confidence,
        safety_level: proposal.safety_level,
        rationale: proposal.rationale,
        write_mode: 'dry_run_only'
      });
    }
  }
  return findings;
}

async function getLifecycleReconciliationDryRun(db, {
  companyId,
  detailLimit
}) {
  const safeCompanyId = normalizeText(companyId) || 'DEFAULT';
  const strictCheckRows = await getLifecycleStrictCheckCounts(db, { companyId: safeCompanyId });
  const strictChecks = buildIntegrityCheckRows(
    strictCheckRows,
    LIFECYCLE_INTEGRITY_STRICT_CHECKS,
    'strict'
  );
  const detailPayload = await getLifecycleStrictAnomalyDetails(db, {
    companyId: safeCompanyId,
    detailLimit
  });
  const findings = buildLifecycleDryRunFindings(detailPayload);

  const strictCategories = strictChecks.map(row => {
    const detailRows = detailPayload && detailPayload.strict && Array.isArray(detailPayload.strict[row.check_name])
      ? detailPayload.strict[row.check_name].length
      : 0;
    return {
      anomaly_type: row.check_name,
      issue_count: parseCount(row.issue_count),
      detail_rows_included: detailRows,
      description: row.description
    };
  });

  return {
    company_id: safeCompanyId,
    generated_at: new Date().toISOString(),
    mode: 'dry_run',
    strict_only: true,
    detail_limit: detailPayload.detail_limit,
    strict_categories: strictCategories,
    strict_issue_count_total: sumIntegrityIssues(strictChecks),
    findings_count: findings.length,
    findings,
    notes: [
      'This surface is dry-run only; no database writes are executed.',
      'Only strict lifecycle anomalies are included in this planner output.',
      'Advisory anomalies are intentionally excluded from repair proposals in this slice.'
    ]
  };
}

function buildLifecycleRepairUnsupportedResult(anomalyType) {
  return {
    error: 'lifecycle_repair_unsupported_anomaly_type',
    value: {
      requested_anomaly_type: normalizeText(anomalyType),
      supported_anomaly_types: LIFECYCLE_REPAIR_SUPPORTED_ANOMALIES
    }
  };
}

async function loadCanonicalSelfAliasRepairContext(db, {
  companyId,
  requestedDeviceUid,
  lockRows
}) {
  const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
    companyId,
    deviceUid: requestedDeviceUid
  });
  const canonicalDeviceUid = normalizeText(canonicalResolution.canonical_device_uid);
  if (!canonicalDeviceUid) {
    return {
      error: 'device_not_found',
      value: {
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by,
        canonical_alias_kind: canonicalResolution.alias_kind,
        canonical_alias_status: canonicalResolution.alias_status
      }
    };
  }

  if (canonicalResolution.resolved_by === 'superseded_without_canonical') {
    return {
      error: 'device_uid_superseded_without_canonical',
      value: {
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by,
        canonical_alias_kind: canonicalResolution.alias_kind,
        canonical_alias_status: canonicalResolution.alias_status
      }
    };
  }

  const deviceRes = await db.query(
    `
    SELECT
      company_id,
      device_uid,
      identity_status,
      superseded_by_device_uid,
      provider,
      updated_at
    FROM public.devices
    WHERE company_id = $1
      AND device_uid = $2
    LIMIT 1
    ${lockRows ? 'FOR UPDATE' : ''}
    `,
    [companyId, canonicalDeviceUid]
  );
  const device = deviceRes.rows[0] || null;
  if (!device) {
    return {
      error: 'device_not_found',
      value: {
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by,
        canonical_alias_kind: canonicalResolution.alias_kind,
        canonical_alias_status: canonicalResolution.alias_status
      }
    };
  }

  const identityStatus = normalizeText(device.identity_status).toLowerCase();
  const supersededByDeviceUid = normalizeText(device.superseded_by_device_uid);
  if (identityStatus === 'superseded') {
    return {
      error: supersededByDeviceUid
        ? 'device_uid_superseded_use_canonical'
        : 'device_uid_superseded_without_canonical',
      value: {
        requested_device_uid: requestedDeviceUid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by,
        canonical_alias_kind: canonicalResolution.alias_kind,
        canonical_alias_status: canonicalResolution.alias_status,
        superseded_by_device_uid: supersededByDeviceUid || null
      }
    };
  }

  const aliasRowsRes = await db.query(
    `
    SELECT
      id,
      company_id,
      canonical_device_uid,
      alias_kind,
      vendor,
      alias_value_normalized,
      status,
      metadata,
      first_seen_at,
      last_seen_at,
      created_at,
      updated_at
    FROM public.device_identity_aliases
    WHERE company_id = $1
      AND alias_kind = 'device_uid'
      AND lower(alias_value_normalized) = lower($2)
    ORDER BY
      CASE status
        WHEN 'active' THEN 0
        WHEN 'superseded' THEN 1
        WHEN 'retired' THEN 2
        ELSE 3
      END,
      updated_at DESC,
      created_at DESC,
      id DESC
    ${lockRows ? 'FOR UPDATE' : ''}
    `,
    [companyId, canonicalDeviceUid]
  );

  return {
    value: {
      requested_device_uid: requestedDeviceUid,
      canonical_device_uid: canonicalDeviceUid,
      canonical_resolved_by: canonicalResolution.resolved_by,
      canonical_alias_kind: canonicalResolution.alias_kind,
      canonical_alias_status: canonicalResolution.alias_status,
      device,
      alias_rows: aliasRowsRes.rows
    }
  };
}

function evaluateCanonicalSelfAliasRepairContext({
  companyId,
  anomalyType,
  context
}) {
  const requestedDeviceUid = normalizeText(context && context.requested_device_uid);
  const canonicalDeviceUid = normalizeText(context && context.canonical_device_uid);
  const device = context && context.device ? context.device : {};
  const aliasRows = Array.isArray(context && context.alias_rows) ? context.alias_rows : [];
  const deviceProvider = normalizeText(device.provider);
  const aliasVendor = deriveVendorFromDeviceUid(canonicalDeviceUid, deviceProvider || 'unknown');

  const activeSelfAlias = aliasRows.find(row =>
    normalizeText(row && row.status).toLowerCase() === 'active'
    && normalizeText(row && row.canonical_device_uid) === canonicalDeviceUid
  ) || null;

  const sameCanonicalAlias = aliasRows.find(row =>
    normalizeText(row && row.canonical_device_uid) === canonicalDeviceUid
  ) || null;

  const activeOtherCanonicalAlias = aliasRows.find(row =>
    normalizeText(row && row.status).toLowerCase() === 'active'
    && normalizeText(row && row.canonical_device_uid) !== canonicalDeviceUid
  ) || null;

  let anomalyPresent = true;
  let repairAction = 'insert_active_device_uid_self_alias';
  let blockedReason = null;
  let targetAlias = sameCanonicalAlias;

  if (activeSelfAlias) {
    anomalyPresent = false;
    repairAction = 'none';
    targetAlias = activeSelfAlias;
  } else if (sameCanonicalAlias) {
    repairAction = 'reactivate_device_uid_self_alias';
    targetAlias = sameCanonicalAlias;
  } else if (activeOtherCanonicalAlias) {
    repairAction = 'blocked_conflict';
    blockedReason = 'active_alias_owned_by_other_canonical';
    targetAlias = null;
  }

  const evidence = {
    company_id: companyId,
    device_uid: canonicalDeviceUid,
    identity_status: normalizeText(device.identity_status).toLowerCase() || 'canonical',
    requested_device_uid: requestedDeviceUid,
    canonical_resolved_by: normalizeText(context && context.canonical_resolved_by) || null,
    canonical_alias_kind: normalizeText(context && context.canonical_alias_kind) || null,
    canonical_alias_status: normalizeText(context && context.canonical_alias_status) || null,
    conflict_alias_canonical_device_uid: activeOtherCanonicalAlias
      ? normalizeText(activeOtherCanonicalAlias.canonical_device_uid)
      : null,
    conflict_alias_status: activeOtherCanonicalAlias
      ? normalizeText(activeOtherCanonicalAlias.status).toLowerCase()
      : null
  };

  const proposal = buildLifecycleDryRunProposal(anomalyType, evidence);

  return {
    requested_device_uid: requestedDeviceUid,
    canonical_device_uid: canonicalDeviceUid,
    canonical_resolved_by: normalizeText(context && context.canonical_resolved_by) || null,
    canonical_alias_kind: normalizeText(context && context.canonical_alias_kind) || null,
    canonical_alias_status: normalizeText(context && context.canonical_alias_status) || null,
    alias_vendor: aliasVendor,
    anomaly_present: anomalyPresent,
    repair_action: repairAction,
    blocked_reason: blockedReason,
    target_alias: targetAlias,
    active_self_alias: activeSelfAlias,
    active_other_canonical_alias: activeOtherCanonicalAlias,
    anomaly_detected: {
      anomaly_type: anomalyType,
      severity: 'strict',
      description: 'Canonical devices missing active self device_uid aliases.',
      evidence
    },
    proposed_repair_action: proposal.proposed_repair_action,
    confidence: proposal.confidence,
    safety_level: proposal.safety_level,
    rationale: proposal.rationale
  };
}

async function executeLifecycleReconciliationRepair(db, {
  companyId,
  anomalyType,
  targetDeviceUid,
  apply,
  actorType,
  actorRef,
  reason,
  metadata,
  correlationId
}) {
  const safeCompanyId = normalizeText(companyId) || 'DEFAULT';
  const safeAnomalyType = normalizeText(anomalyType);
  if (safeAnomalyType !== LIFECYCLE_REPAIR_SUPPORTED_ANOMALY) {
    return buildLifecycleRepairUnsupportedResult(safeAnomalyType);
  }

  const requestedDeviceUid = normalizeText(targetDeviceUid);
  if (!requestedDeviceUid) {
    return { error: 'invalid_target_device_uid' };
  }

  const applyRepair = apply === true;
  const safeActorType = normalizeLifecycleActorType(actorType, 'operator');
  const safeActorRef = normalizeText(actorRef) || null;
  const safeReason = normalizeText(reason) || 'lifecycle_reconciliation_repair';
  const safeMetadata = isPlainObject(metadata) ? metadata : {};
  const safeCorrelationId = normalizeLifecycleCorrelationId(correlationId);

  if (!applyRepair) {
    const contextResult = await loadCanonicalSelfAliasRepairContext(db, {
      companyId: safeCompanyId,
      requestedDeviceUid,
      lockRows: false
    });
    if (contextResult.error) {
      return contextResult;
    }
    const evaluation = evaluateCanonicalSelfAliasRepairContext({
      companyId: safeCompanyId,
      anomalyType: safeAnomalyType,
      context: contextResult.value
    });
    return {
      value: {
        company_id: safeCompanyId,
        mode: 'dry_run',
        write_executed: false,
        repair_result: evaluation.anomaly_present ? 'planned' : 'noop_already_correct',
        anomaly_type: safeAnomalyType,
        supported_anomaly_types: LIFECYCLE_REPAIR_SUPPORTED_ANOMALIES,
        ...evaluation
      }
    };
  }

  await db.query('BEGIN');
  try {
    const contextResult = await loadCanonicalSelfAliasRepairContext(db, {
      companyId: safeCompanyId,
      requestedDeviceUid,
      lockRows: true
    });
    if (contextResult.error) {
      await db.query('ROLLBACK');
      return contextResult;
    }

    const evaluation = evaluateCanonicalSelfAliasRepairContext({
      companyId: safeCompanyId,
      anomalyType: safeAnomalyType,
      context: contextResult.value
    });

    if (evaluation.blocked_reason === 'active_alias_owned_by_other_canonical') {
      await db.query('ROLLBACK');
      return {
        error: 'lifecycle_repair_conflict_active_alias_owned_by_other_canonical',
        value: {
          company_id: safeCompanyId,
          anomaly_type: safeAnomalyType,
          supported_anomaly_types: LIFECYCLE_REPAIR_SUPPORTED_ANOMALIES,
          ...evaluation
        }
      };
    }

    if (!evaluation.anomaly_present) {
      await db.query('COMMIT');
      return {
        value: {
          company_id: safeCompanyId,
          mode: 'apply',
          write_executed: false,
          repair_result: 'noop_already_correct',
          anomaly_type: safeAnomalyType,
          supported_anomaly_types: LIFECYCLE_REPAIR_SUPPORTED_ANOMALIES,
          ...evaluation
        }
      };
    }

    let aliasRow = null;
    let lifecycleEventWritten = false;
    let fromAliasStatus = 'missing';

    if (evaluation.repair_action === 'reactivate_device_uid_self_alias' && evaluation.target_alias && evaluation.target_alias.id) {
      fromAliasStatus = normalizeText(evaluation.target_alias.status).toLowerCase() || 'unknown';
      const updateAliasRes = await db.query(
        `
        UPDATE public.device_identity_aliases
        SET status = 'active',
            last_seen_at = GREATEST(last_seen_at, now()),
            updated_at = now(),
            metadata = device_identity_aliases.metadata || $1::jsonb
        WHERE id = $2
          AND company_id = $3
        RETURNING
          id,
          company_id,
          canonical_device_uid,
          alias_kind,
          vendor,
          alias_value_normalized,
          status,
          first_seen_at,
          last_seen_at,
          metadata,
          created_at,
          updated_at
        `,
        [
          JSON.stringify({
            source: 'lifecycle_reconciliation.repair',
            anomaly_type: safeAnomalyType,
            repaired_at: new Date().toISOString(),
            ...safeMetadata
          }),
          evaluation.target_alias.id,
          safeCompanyId
        ]
      );
      aliasRow = updateAliasRes.rows[0] || null;
      if (!aliasRow) {
        await db.query('ROLLBACK');
        return {
          error: 'lifecycle_repair_target_alias_not_found',
          value: {
            company_id: safeCompanyId,
            anomaly_type: safeAnomalyType,
            supported_anomaly_types: LIFECYCLE_REPAIR_SUPPORTED_ANOMALIES,
            ...evaluation
          }
        };
      }
    } else {
      const insertAliasSql = `
        INSERT INTO public.device_identity_aliases (
          company_id,
          canonical_device_uid,
          alias_kind,
          vendor,
          alias_value_normalized,
          status,
          first_seen_at,
          last_seen_at,
          metadata
        )
        VALUES ($1, $2, 'device_uid', $3, $4, 'active', now(), now(), $5::jsonb)
        RETURNING
          id,
          company_id,
          canonical_device_uid,
          alias_kind,
          vendor,
          alias_value_normalized,
          status,
          first_seen_at,
          last_seen_at,
          metadata,
          created_at,
          updated_at
      `;
      try {
        const insertAliasRes = await db.query(
          insertAliasSql,
          [
            safeCompanyId,
            evaluation.canonical_device_uid,
            evaluation.alias_vendor,
            evaluation.canonical_device_uid,
            JSON.stringify({
              source: 'lifecycle_reconciliation.repair',
              anomaly_type: safeAnomalyType,
              repaired_at: new Date().toISOString(),
              ...safeMetadata
            })
          ]
        );
        aliasRow = insertAliasRes.rows[0] || null;
      } catch (err) {
        if (err && err.code === '23505') {
          await db.query('ROLLBACK');
          return {
            error: 'lifecycle_repair_alias_conflict_vendor_key',
            value: {
              company_id: safeCompanyId,
              anomaly_type: safeAnomalyType,
              supported_anomaly_types: LIFECYCLE_REPAIR_SUPPORTED_ANOMALIES,
              ...evaluation
            }
          };
        }
        throw err;
      }
      if (!aliasRow) {
        await db.query('ROLLBACK');
        return {
          error: 'lifecycle_repair_insert_failed',
          value: {
            company_id: safeCompanyId,
            anomaly_type: safeAnomalyType,
            supported_anomaly_types: LIFECYCLE_REPAIR_SUPPORTED_ANOMALIES,
            ...evaluation
          }
        };
      }
    }

    await insertDeviceLifecycleEvent(db, {
      companyId: safeCompanyId,
      deviceUid: evaluation.canonical_device_uid,
      lifecycleEvent: 'identity_alias_added',
      actorType: safeActorType,
      actorRef: safeActorRef,
      agentId: null,
      fromState: {
        alias_kind: 'device_uid',
        alias_value_normalized: evaluation.canonical_device_uid,
        alias_status: fromAliasStatus
      },
      toState: {
        alias_kind: 'device_uid',
        alias_value_normalized: evaluation.canonical_device_uid,
        alias_status: 'active'
      },
      reason: safeReason,
      correlationId: safeCorrelationId,
      metadata: {
        source: 'lifecycle_reconciliation.repair',
        anomaly_type: safeAnomalyType,
        requested_device_uid: evaluation.requested_device_uid,
        canonical_device_uid: evaluation.canonical_device_uid,
        repair_action: evaluation.repair_action,
        alias_id: aliasRow.id,
        ...safeMetadata
      }
    });
    lifecycleEventWritten = true;

    await db.query('COMMIT');
    return {
      value: {
        company_id: safeCompanyId,
        mode: 'apply',
        write_executed: true,
        repair_result: 'repaired',
        anomaly_type: safeAnomalyType,
        supported_anomaly_types: LIFECYCLE_REPAIR_SUPPORTED_ANOMALIES,
        lifecycle_event_written: lifecycleEventWritten,
        repaired_alias: aliasRow,
        ...evaluation
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function ingestDiscoveryReport(db, {
  companyId,
  agentId,
  commandId,
  adapterId,
  subnetTargets,
  reportedAt,
  discoveredDevices,
  summary
}) {
  await db.query('BEGIN');
  try {
    const safeSummary = isPlainObject(summary) ? summary : {};
    const runId = normalizeText(safeSummary.run_id) || null;
    const reportPayload = {
      summary: safeSummary,
      discovered_devices_count: discoveredDevices.length
    };
    const reportRes = await db.query(
      `
      INSERT INTO device_discovery_reports (
        company_id, agent_id, command_id, adapter_id, subnet_targets, report_payload, reported_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz)
      RETURNING id, company_id, agent_id, command_id, adapter_id, reported_at, created_at
      `,
      [
        companyId,
        agentId,
        commandId || null,
        adapterId,
        JSON.stringify(Array.isArray(subnetTargets) ? subnetTargets : []),
        JSON.stringify(reportPayload),
        reportedAt
      ]
    );
    const report = reportRes.rows[0];
    logBridgeEvent('bridge.discovery.report.persisted', {
      company_id: companyId,
      agent_id: agentId,
      command_id: commandId || null,
      run_id: runId,
      report_id: report.id,
      discovered_devices_count: discoveredDevices.length
    });

    for (const discovered of discoveredDevices) {
      const proposedDeviceUid = buildDeviceUid(discovered);
      const canonical = await resolveCanonicalDeviceUid(db, {
        companyId,
        discovered,
        candidateUid: proposedDeviceUid
      });
      const deviceUid = canonical.device_uid;
      const existingRes = await db.query(
        `
        SELECT
          company_id,
          device_uid,
          managed_status,
          discovery_status,
          discovered_by_agent_id,
          manageability_status,
          manageability_reason,
          discovery_metadata
        FROM devices
        WHERE company_id = $1
          AND device_uid = $2
        LIMIT 1
        `,
        [companyId, deviceUid]
      );
      const existingBefore = existingRes.rows[0] || null;
      const discoveryStatus = resolveDiscoveryStatus(discovered);
      const discoveryManageability = mapDiscoveryOutcomeToManageability({
        confirmationState: discovered.confirmation_state,
        failureReason: discovered.failure_reason
      });
      const metadata = {
        adapter_id: adapterId,
        ip: discovered.ip,
        mac: discovered.mac,
        model: discovered.model,
        serial_number: discovered.serial_number,
        discovery_method: discovered.discovery_method,
        confidence: discovered.confidence,
        confidence_class: discovered.confidence_class || null,
        confirmation_state: discovered.confirmation_state || null,
        outcome_class: discovered.outcome_class || null,
        identity_source: discovered.identity_source || null,
        failure_reason: discovered.failure_reason || null,
        protocol: isPlainObject(discovered.protocol) ? discovered.protocol : {},
        observed_at: discovered.observed_at,
        raw: discovered.raw
      };
      const observedAt = normalizeText(discovered.observed_at) || normalizeText(reportedAt) || null;
      const aliasVendor = deriveVendorFromDeviceUid(deviceUid, discovered.vendor || canonical.identity.vendor);

      const upsertRes = await db.query(
        `
        INSERT INTO devices (
          company_id,
          device_uid,
          provider,
          active,
          metadata,
          managed_status,
          discovery_status,
          discovered_by_agent_id,
          source,
          lifecycle_scope,
          last_seen_at,
          discovery_metadata,
          manageability_status,
          manageability_reason,
          manageability_updated_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, true, $4::jsonb, $5, $6, $7, 'agent_discovery', 'bridge_ops', $8::timestamptz, $9::jsonb, $10, $11, now(), now()
        )
        ON CONFLICT (company_id, device_uid) DO UPDATE
          SET provider = COALESCE(devices.provider, EXCLUDED.provider),
              active = true,
              source = COALESCE(devices.source, 'agent_discovery'),
              lifecycle_scope = 'bridge_ops',
              discovered_by_agent_id = EXCLUDED.discovered_by_agent_id,
              last_seen_at = GREATEST(COALESCE(devices.last_seen_at, 'epoch'::timestamptz), EXCLUDED.last_seen_at),
              discovery_status = CASE
                WHEN devices.discovery_status = 'confirmed' THEN 'confirmed'
                WHEN devices.discovery_status = 'probable' AND EXCLUDED.discovery_status = 'heuristic' THEN 'probable'
                ELSE EXCLUDED.discovery_status
              END,
              managed_status = CASE
                WHEN devices.managed_status = $12 THEN devices.managed_status
                ELSE $13
              END,
              manageability_status = CASE
                WHEN devices.manageability_status IN ($14, $15, $16) THEN devices.manageability_status
                ELSE EXCLUDED.manageability_status
              END,
              manageability_reason = CASE
                WHEN devices.manageability_status IN ($14, $15, $16) THEN devices.manageability_reason
                ELSE EXCLUDED.manageability_reason
              END,
              manageability_updated_at = CASE
                WHEN devices.manageability_status IN ($14, $15, $16) THEN devices.manageability_updated_at
                ELSE now()
              END,
              discovery_metadata = devices.discovery_metadata || EXCLUDED.discovery_metadata,
              updated_at = now()
        RETURNING company_id, device_uid, managed_status, discovery_status, last_seen_at,
                  discovered_by_agent_id, discovery_metadata,
                  manageability_status, manageability_reason, lifecycle_scope,
                  (xmax = 0) AS inserted
        `,
        [
          companyId,
          deviceUid,
          discovered.vendor,
          JSON.stringify({ source: 'agent_discovery' }),
          MANAGED_STATUS.CANDIDATE,
          discoveryStatus,
          agentId,
          discovered.observed_at,
          JSON.stringify(metadata),
          discoveryManageability.status,
          discoveryManageability.reason,
          MANAGED_STATUS.MANAGED,
          MANAGED_STATUS.CANDIDATE,
          MANAGEABILITY_STATUS.MANAGEABLE,
          MANAGEABILITY_STATUS.INGESTING,
          MANAGEABILITY_STATUS.BLOCKED
        ]
      );

      const persisted = upsertRes.rows[0] || {};
      const inserted = persisted.inserted === true;
      const canonicalUidAlias = await upsertDeviceIdentityAlias(db, {
        companyId,
        canonicalDeviceUid: deviceUid,
        aliasKind: 'device_uid',
        vendor: aliasVendor,
        aliasValueNormalized: deviceUid,
        status: 'active',
        observedAt,
        metadata: {
          source: 'agent_discovery',
          adapter_id: adapterId,
          report_id: report.id
        }
      });

      let supersessionOutcome = null;
      if (canonical.superseded_from_uid && canonical.auto_supersession_allowed === true) {
        supersessionOutcome = await supersedeProvisionalDeviceUid(db, {
          companyId,
          provisionalDeviceUid: canonical.superseded_from_uid,
          canonicalDeviceUid: deviceUid
        });

        if (supersessionOutcome.applied === true) {
          await upsertDeviceIdentityAlias(db, {
            companyId,
            canonicalDeviceUid: deviceUid,
            aliasKind: 'device_uid',
            vendor: deriveVendorFromDeviceUid(canonical.superseded_from_uid, aliasVendor),
            aliasValueNormalized: canonical.superseded_from_uid,
            status: 'superseded',
            observedAt,
            metadata: {
              source: 'identity_supersession',
              superseded_to: deviceUid,
              report_id: report.id,
              adapter_id: adapterId
            }
          });

          await insertDeviceLifecycleEvent(db, {
            companyId,
            deviceUid: canonical.superseded_from_uid,
            lifecycleEvent: 'identity_superseded',
            actorType: 'agent',
            actorRef: String(agentId),
            agentId,
            fromState: {
              identity_status: supersessionOutcome.before_row
                ? normalizeText(supersessionOutcome.before_row.identity_status).toLowerCase() || 'canonical'
                : 'canonical',
              superseded_by_device_uid: supersessionOutcome.before_row
                ? normalizeText(supersessionOutcome.before_row.superseded_by_device_uid) || null
                : null
            },
            toState: {
              identity_status: supersessionOutcome.after_row
                ? normalizeText(supersessionOutcome.after_row.identity_status).toLowerCase() || 'superseded'
                : 'superseded',
              superseded_by_device_uid: deviceUid
            },
            reason: 'auto_supersede_provisional_identity',
            correlationId: normalizeLifecycleCorrelationId(commandId || runId || report.id),
            metadata: {
              source: 'agent_discovery',
              report_id: report.id,
              adapter_id: adapterId,
              provisional_device_uid: canonical.superseded_from_uid,
              canonical_device_uid: deviceUid
            }
          });

          await insertDeviceLifecycleEvent(db, {
            companyId,
            deviceUid,
            lifecycleEvent: 'identity_alias_added',
            actorType: 'agent',
            actorRef: String(agentId),
            agentId,
            fromState: {},
            toState: {
              alias_kind: 'device_uid',
              alias_value_normalized: canonical.superseded_from_uid,
              alias_status: 'superseded'
            },
            reason: 'alias_finalized_on_supersession',
            correlationId: normalizeLifecycleCorrelationId(commandId || runId || report.id),
            metadata: {
              source: 'agent_discovery',
              report_id: report.id,
              adapter_id: adapterId,
              canonical_device_uid: deviceUid,
              alias_device_uid: canonical.superseded_from_uid
            }
          });
        }
      }

      const correlationId = normalizeLifecycleCorrelationId(commandId || runId || report.id);
      const eventMetadata = {
        source: 'agent_discovery',
        report_id: report.id,
        command_id: commandId || null,
        run_id: runId,
        adapter_id: adapterId,
        proposed_device_uid: proposedDeviceUid,
        matched_existing_uid: canonical.matched_existing_uid,
        promoted_to_stable_uid: false,
        identity_transition: canonical.identity_transition || 'none',
        auto_supersession_allowed: canonical.auto_supersession_allowed === true,
        superseded_from_uid: canonical.superseded_from_uid || null,
        supersession_applied: supersessionOutcome ? supersessionOutcome.applied === true : false,
        supersession_reason: supersessionOutcome ? supersessionOutcome.reason : null,
        observed_ip: discovered.ip || null,
        observed_serial_number: metadata.serial_number || canonical.identity.serial_number || null,
        observed_mac: metadata.mac || canonical.identity.mac || null,
        confirmation_state: metadata.confirmation_state || null,
        outcome_class: metadata.outcome_class || null,
        failure_reason: metadata.failure_reason || null,
        canonical_uid_alias_id: canonicalUidAlias ? canonicalUidAlias.id : null
      };
      if (persisted.managed_status === MANAGED_STATUS.CANDIDATE) {
        if (inserted) {
          await insertDeviceLifecycleEvent(db, {
            companyId,
            deviceUid,
            lifecycleEvent: 'candidate_created',
            actorType: 'agent',
            actorRef: String(agentId),
            agentId,
            fromState: {},
            toState: toLifecycleCandidateState(persisted),
            reason: 'discovery_report_ingested',
            correlationId,
            metadata: eventMetadata
          });
        } else if (existingBefore && shouldEmitCandidateUpdatedEvent(existingBefore, persisted)) {
          await insertDeviceLifecycleEvent(db, {
            companyId,
            deviceUid,
            lifecycleEvent: 'candidate_updated',
            actorType: 'agent',
            actorRef: String(agentId),
            agentId,
            fromState: toLifecycleCandidateState(existingBefore),
            toState: toLifecycleCandidateState(persisted),
            reason: 'discovery_report_ingested',
            correlationId,
            metadata: eventMetadata
          });
        }
      }
      logBridgeEvent('bridge.discovery.device.persisted', {
        company_id: companyId,
        agent_id: agentId,
        command_id: commandId || null,
        run_id: runId,
        report_id: report.id,
        device_uid: persisted.device_uid || deviceUid,
        proposed_device_uid: proposedDeviceUid,
        matched_existing_uid: canonical.matched_existing_uid,
        promoted_to_stable_uid: false,
        identity_transition: canonical.identity_transition || 'none',
        auto_supersession_allowed: canonical.auto_supersession_allowed === true,
        superseded_from_uid: canonical.superseded_from_uid || null,
        supersession_applied: supersessionOutcome ? supersessionOutcome.applied === true : false,
        supersession_reason: supersessionOutcome ? supersessionOutcome.reason : null,
        managed_status: persisted.managed_status || null,
        discovery_status: persisted.discovery_status || null,
        manageability_status: persisted.manageability_status || null,
        manageability_reason: persisted.manageability_reason || null,
        last_seen_at: persisted.last_seen_at || null,
        ip: discovered.ip,
        serial_number: metadata.serial_number || canonical.identity.serial_number || null,
        mac: metadata.mac || canonical.identity.mac || null,
        confirmation_state: metadata.confirmation_state,
        outcome_class: metadata.outcome_class,
        failure_reason: metadata.failure_reason
      });
    }

    if (commandId) {
      await acknowledgeCommand(db, {
        commandId,
        companyId,
        agentId,
        resultPayload: {
          report_id: report.id,
          discovered_devices_count: discoveredDevices.length
        }
      });
    }

    await db.query('COMMIT');
    logBridgeEvent('bridge.discovery.report.committed', {
      company_id: companyId,
      agent_id: agentId,
      command_id: commandId || null,
      run_id: runId,
      report_id: report.id
    });
    return report;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function upsertManualOnboardingCandidate(db, {
  companyId,
  payload,
  actorType,
  actorRef,
  correlationId
}) {
  const normalizedCompanyId = normalizeText(companyId);
  if (!normalizedCompanyId) {
    return { error: 'invalid_company_id' };
  }
  const safePayload = isPlainObject(payload) ? payload : {};
  const normalizedProvider = normalizeVendor(safePayload.provider);
  const requestedDeviceUid = deriveManualCandidateDeviceUid({
    provider: normalizedProvider,
    explicitDeviceUid: safePayload.device_uid || safePayload.canonical_device_uid,
    identity: safePayload.identity,
    connection: safePayload.connection
  });
  if (!requestedDeviceUid) {
    return { error: 'invalid_device_uid' };
  }

  const safeActorType = normalizeLifecycleActorType(actorType || 'operator', 'operator');
  const safeActorRef = normalizeText(actorRef) || null;
  const safeCorrelationId = normalizeLifecycleCorrelationId(correlationId);

  await db.query('BEGIN');
  try {
    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, {
      companyId: normalizedCompanyId,
      deviceUid: requestedDeviceUid
    });
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

    const canonicalDeviceUid = normalizeText(canonicalResolution.canonical_device_uid)
      || normalizeText(canonicalResolution.requested_device_uid)
      || requestedDeviceUid;

    const existingRes = await db.query(
      `
      SELECT
        company_id,
        device_uid,
        provider,
        device_name,
        active,
        metadata,
        managed_status,
        discovery_status,
        discovered_by_agent_id,
        source,
        claimed_at,
        claimed_by_key_id,
        last_seen_at,
        discovery_metadata,
        manageability_status,
        manageability_reason,
        manageability_updated_at,
        manageability_last_proven_at,
        remediation_manual_status,
        remediation_manual_note,
        remediation_manual_owner,
        remediation_manual_updated_at,
        remediation_manual_updated_by_key_id,
        lifecycle_scope,
        identity_status,
        superseded_by_device_uid,
        created_at,
        updated_at
      FROM devices
      WHERE company_id = $1
        AND device_uid = $2
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedCompanyId, canonicalDeviceUid]
    );
    const existingRow = existingRes.rows[0] || null;
    const existingManagedStatus = normalizeText(existingRow && existingRow.managed_status).toLowerCase();
    if (existingRow && existingManagedStatus !== MANAGED_STATUS.CANDIDATE) {
      await db.query('ROLLBACK');
      return {
        error: 'device_not_candidate',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by,
          canonical_alias_kind: canonicalResolution.alias_kind,
          canonical_alias_status: canonicalResolution.alias_status,
          managed_status: existingRow.managed_status || null
        }
      };
    }

    const nextMetadata = buildManualOnboardingMetadata({
      existingMetadata: existingRow ? existingRow.metadata : {},
      connection: isPlainObject(safePayload.connection) ? safePayload.connection : {},
      identity: isPlainObject(safePayload.identity) ? safePayload.identity : {},
      deviceProfile: isPlainObject(safePayload.device_profile) ? safePayload.device_profile : {},
      siteContext: isPlainObject(safePayload.site_context) ? safePayload.site_context : {},
      operatorNotes: isPlainObject(safePayload.operator_notes) ? safePayload.operator_notes : {},
      actorType: safeActorType,
      actorRef: safeActorRef
    });
    const safeDeviceName = normalizeText(safePayload.device_name);

    let persistedRow = null;
    let created = false;
    if (!existingRow) {
      const insertRes = await db.query(
        `
        INSERT INTO devices (
          company_id,
          device_uid,
          provider,
          device_name,
          active,
          metadata,
          managed_status,
          discovery_status,
          source,
          lifecycle_scope,
          identity_status,
          superseded_by_device_uid,
          last_seen_at
        )
        VALUES (
          $1, $2, $3, NULLIF($4, ''), true, $5::jsonb,
          $6, $7, $8, $9, $10, NULL, now()
        )
        RETURNING
          company_id,
          device_uid,
          provider,
          device_name,
          active,
          metadata,
          managed_status,
          discovery_status,
          discovered_by_agent_id,
          source,
          claimed_at,
          claimed_by_key_id,
          last_seen_at,
          discovery_metadata,
          manageability_status,
          manageability_reason,
          manageability_updated_at,
          manageability_last_proven_at,
          remediation_manual_status,
          remediation_manual_note,
          remediation_manual_owner,
          remediation_manual_updated_at,
          remediation_manual_updated_by_key_id,
          lifecycle_scope,
          identity_status,
          superseded_by_device_uid,
          created_at,
          updated_at
        `,
        [
          normalizedCompanyId,
          canonicalDeviceUid,
          normalizedProvider,
          safeDeviceName,
          JSON.stringify(nextMetadata),
          MANAGED_STATUS.CANDIDATE,
          'manual',
          'manual_onboarding',
          'bridge_ops',
          'canonical'
        ]
      );
      persistedRow = insertRes.rows[0] || null;
      created = true;
    } else {
      const updateRes = await db.query(
        `
        UPDATE devices
        SET provider = CASE WHEN $3 <> '' THEN $3 ELSE provider END,
            device_name = CASE WHEN $4 <> '' THEN $4 ELSE device_name END,
            active = true,
            metadata = $5::jsonb,
            managed_status = $6,
            discovery_status = COALESCE(discovery_status, 'manual'),
            source = CASE
              WHEN source IS NULL OR btrim(source) = '' THEN 'manual_onboarding'
              ELSE source
            END,
            lifecycle_scope = 'bridge_ops',
            identity_status = CASE
              WHEN identity_status = 'superseded' THEN identity_status
              ELSE 'canonical'
            END,
            superseded_by_device_uid = CASE
              WHEN identity_status = 'superseded' THEN superseded_by_device_uid
              ELSE NULL
            END,
            last_seen_at = COALESCE(last_seen_at, now()),
            updated_at = now()
        WHERE company_id = $1
          AND device_uid = $2
          AND managed_status = $6
        RETURNING
          company_id,
          device_uid,
          provider,
          device_name,
          active,
          metadata,
          managed_status,
          discovery_status,
          discovered_by_agent_id,
          source,
          claimed_at,
          claimed_by_key_id,
          last_seen_at,
          discovery_metadata,
          manageability_status,
          manageability_reason,
          manageability_updated_at,
          manageability_last_proven_at,
          remediation_manual_status,
          remediation_manual_note,
          remediation_manual_owner,
          remediation_manual_updated_at,
          remediation_manual_updated_by_key_id,
          lifecycle_scope,
          identity_status,
          superseded_by_device_uid,
          created_at,
          updated_at
        `,
        [
          normalizedCompanyId,
          canonicalDeviceUid,
          normalizedProvider,
          safeDeviceName,
          JSON.stringify(nextMetadata),
          MANAGED_STATUS.CANDIDATE
        ]
      );
      persistedRow = updateRes.rows[0] || null;
    }

    if (!persistedRow) {
      await db.query('ROLLBACK');
      return {
        error: 'candidate_persist_failed',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid
        }
      };
    }

    const identity = parseJsonObject(nextMetadata.identity);
    const connection = normalizeManualMetadataConnection(nextMetadata);
    const aliasVendor = deriveVendorFromDeviceUid(canonicalDeviceUid, normalizedProvider);
    const observedAt = new Date().toISOString();

    await upsertDeviceIdentityAlias(db, {
      companyId: normalizedCompanyId,
      canonicalDeviceUid,
      aliasKind: 'device_uid',
      vendor: aliasVendor,
      aliasValueNormalized: canonicalDeviceUid,
      status: 'active',
      observedAt,
      metadata: {
        source: 'agent_admin.manual_onboarding',
        canonical: true
      }
    });

    const identitySerial = normalizeSerial(identity.serial_number || nextMetadata.serial_number);
    if (identitySerial) {
      await upsertDeviceIdentityAlias(db, {
        companyId: normalizedCompanyId,
        canonicalDeviceUid,
        aliasKind: 'serial_number',
        vendor: aliasVendor,
        aliasValueNormalized: identitySerial,
        status: 'active',
        observedAt,
        metadata: {
          source: 'agent_admin.manual_onboarding'
        }
      });
    }

    const identityMac = normalizeMac(identity.mac || nextMetadata.mac);
    if (identityMac) {
      await upsertDeviceIdentityAlias(db, {
        companyId: normalizedCompanyId,
        canonicalDeviceUid,
        aliasKind: 'mac',
        vendor: aliasVendor,
        aliasValueNormalized: identityMac,
        status: 'active',
        observedAt,
        metadata: {
          source: 'agent_admin.manual_onboarding'
        }
      });
    }

    const connectionHost = normalizeText(connection.host);
    if (connectionHost) {
      await upsertDeviceIdentityAlias(db, {
        companyId: normalizedCompanyId,
        canonicalDeviceUid,
        aliasKind: 'ip',
        vendor: aliasVendor,
        aliasValueNormalized: connectionHost,
        status: 'active',
        observedAt,
        metadata: {
          source: 'agent_admin.manual_onboarding'
        }
      });
    }

    const onboardingReadModel = toManualOnboardingReadModel(persistedRow);
    const eventMetadata = {
      source: 'agent_admin.manual_onboarding',
      requested_device_uid: canonicalResolution.requested_device_uid,
      canonical_device_uid: canonicalDeviceUid,
      canonical_resolved_by: canonicalResolution.resolved_by,
      canonical_alias_kind: canonicalResolution.alias_kind,
      canonical_alias_status: canonicalResolution.alias_status,
      configuration_status: onboardingReadModel.configuration_status,
      missing_required_fields: onboardingReadModel.missing_required_fields,
      ready_for_validation: onboardingReadModel.ready_for_validation,
      validation_status: onboardingReadModel.validation_status,
      onboarding_state: onboardingReadModel.onboarding_state
    };

    if (created) {
      await insertDeviceLifecycleEvent(db, {
        companyId: normalizedCompanyId,
        deviceUid: canonicalDeviceUid,
        lifecycleEvent: 'candidate_created',
        actorType: safeActorType,
        actorRef: safeActorRef,
        agentId: null,
        fromState: {},
        toState: toManualOnboardingLifecycleState(persistedRow),
        reason: 'manual_onboarding_registered',
        correlationId: safeCorrelationId,
        metadata: eventMetadata
      });
    } else if (existingRow && shouldEmitManualCandidateUpdatedEvent(existingRow, persistedRow)) {
      await insertDeviceLifecycleEvent(db, {
        companyId: normalizedCompanyId,
        deviceUid: canonicalDeviceUid,
        lifecycleEvent: 'candidate_updated',
        actorType: safeActorType,
        actorRef: safeActorRef,
        agentId: null,
        fromState: toManualOnboardingLifecycleState(existingRow),
        toState: toManualOnboardingLifecycleState(persistedRow),
        reason: 'manual_onboarding_updated',
        correlationId: safeCorrelationId,
        metadata: eventMetadata
      });
    }

    await db.query('COMMIT');
    return {
      value: {
        company_id: normalizedCompanyId,
        device_uid: canonicalDeviceUid,
        provider: persistedRow.provider || normalizedProvider,
        managed_status: persistedRow.managed_status || MANAGED_STATUS.CANDIDATE,
        lifecycle_scope: persistedRow.lifecycle_scope || 'bridge_ops',
        configuration_status: onboardingReadModel.configuration_status,
        missing_required_fields: onboardingReadModel.missing_required_fields,
        ready_for_validation: onboardingReadModel.ready_for_validation,
        validation_status: onboardingReadModel.validation_status,
        validation_reason_code: onboardingReadModel.validation_reason_code,
        validation_last_requested_at: onboardingReadModel.validation_last_requested_at,
        validation_last_started_at: onboardingReadModel.validation_last_started_at,
        validation_last_completed_at: onboardingReadModel.validation_last_completed_at,
        validation_last_success_at: onboardingReadModel.validation_last_success_at,
        validation_last_failure_at: onboardingReadModel.validation_last_failure_at,
        onboarding_state: onboardingReadModel.onboarding_state,
        created,
        canonical_resolved_by: canonicalResolution.resolved_by,
        canonical_alias_kind: canonicalResolution.alias_kind,
        canonical_alias_status: canonicalResolution.alias_status
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function listCandidateDevices(db, { companyId, limit, offset }) {
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
  const safeOffset = Number.isInteger(offset) ? Math.max(offset, 0) : 0;
  const res = await db.query(
    `
    SELECT
      d.company_id,
      d.device_uid,
      d.provider,
      d.device_name,
      d.managed_status,
      d.discovery_status,
      d.source,
      d.discovered_by_agent_id,
      d.last_seen_at,
      d.discovery_metadata,
      d.manageability_status,
      d.manageability_reason,
      d.manageability_updated_at,
      d.manageability_last_proven_at,
      d.remediation_manual_status,
      d.remediation_manual_note,
      d.remediation_manual_owner,
      d.remediation_manual_updated_at,
      d.remediation_manual_updated_by_key_id,
      d.site_id,
      s.site_key,
      s.site_name,
      s.status AS site_status,
      d.created_at,
      d.updated_at
    FROM devices d
    LEFT JOIN sites s
      ON s.company_id = d.company_id
     AND s.site_id = d.site_id
    WHERE d.company_id = $1
      AND d.managed_status = $2
    ORDER BY d.updated_at DESC, d.device_uid ASC
    LIMIT $3
    OFFSET $4
    `,
    [companyId, MANAGED_STATUS.CANDIDATE, safeLimit, safeOffset]
  );
  return res.rows;
}

async function claimCandidateDevice(db, { companyId, deviceUid, claimedByKeyId, claimedByRole, updates }) {
  const safeName = normalizeText(updates && updates.device_name);
  const safeProvider = normalizeText(updates && updates.provider).toLowerCase();
  const metadata = isPlainObject(updates && updates.metadata) ? updates.metadata : null;
  const safeActorType = normalizeLifecycleActorType(claimedByRole || 'operator', 'operator');

  await db.query('BEGIN');
  try {
    const beforeRes = await db.query(
      `
      SELECT
        company_id,
        device_uid,
        managed_status,
        discovery_status,
        discovered_by_agent_id,
        manageability_status,
        manageability_reason,
        discovery_metadata
      FROM devices
      WHERE company_id = $1
        AND device_uid = $2
        AND managed_status = $3
      LIMIT 1
      FOR UPDATE
      `,
      [companyId, deviceUid, MANAGED_STATUS.CANDIDATE]
    );
    const beforeRow = beforeRes.rows[0] || null;
    if (!beforeRow) {
      await db.query('ROLLBACK');
      return null;
    }

    const res = await db.query(
      `
      UPDATE devices
      SET managed_status = $1,
          claimed_at = now(),
          claimed_by_key_id = $2,
          source = COALESCE(source, 'agent_discovery'),
          lifecycle_scope = 'bridge_ops',
          provider = CASE WHEN $3 <> '' THEN $3 ELSE provider END,
          device_name = CASE WHEN $4 <> '' THEN $4 ELSE device_name END,
          metadata = CASE WHEN $5::jsonb IS NOT NULL THEN COALESCE(metadata, '{}'::jsonb) || $5::jsonb ELSE metadata END,
          updated_at = now()
      WHERE company_id = $6
        AND device_uid = $7
        AND managed_status = $8
      RETURNING company_id, device_uid, provider, device_name, active, metadata,
                managed_status, discovery_status, discovered_by_agent_id, source,
                claimed_at, claimed_by_key_id, last_seen_at, discovery_metadata,
                manageability_status, manageability_reason, manageability_updated_at, manageability_last_proven_at,
                remediation_manual_status, remediation_manual_note, remediation_manual_owner,
                remediation_manual_updated_at, remediation_manual_updated_by_key_id,
                lifecycle_scope,
                created_at, updated_at
      `,
      [
        MANAGED_STATUS.MANAGED,
        claimedByKeyId || null,
        safeProvider,
        safeName,
        metadata ? JSON.stringify(metadata) : null,
        companyId,
        deviceUid,
        MANAGED_STATUS.CANDIDATE
      ]
    );
    const row = res.rows[0] || null;
    if (!row) {
      await db.query('ROLLBACK');
      return null;
    }

    await insertDeviceLifecycleEvent(db, {
      companyId,
      deviceUid: row.device_uid,
      lifecycleEvent: 'candidate_claimed',
      actorType: safeActorType === 'admin' ? 'admin' : 'operator',
      actorRef: claimedByKeyId || null,
      agentId: null,
      fromState: toLifecycleCandidateState(beforeRow),
      toState: {
        ...toLifecycleCandidateState(row),
        managed_status: MANAGED_STATUS.MANAGED
      },
      reason: 'manual_claim',
      correlationId: null,
      metadata: {
        source: 'agent_admin.claim',
        claimed_by_key_id: claimedByKeyId || null,
        applied_provider: safeProvider || null,
        applied_device_name: safeName || null,
        metadata_patch_applied: metadata !== null
      }
    });

    await db.query('COMMIT');
    logBridgeEvent('bridge.discovery.device.claimed', {
      company_id: row.company_id,
      device_uid: row.device_uid,
      claimed_by_key_id: row.claimed_by_key_id,
      claimed_at: row.claimed_at
    });
    return row;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function setManagingAgentBinding(db, {
  companyId,
  deviceUid,
  agentId,
  boundByKeyId,
  boundByRole,
  reason,
  metadata
}) {
  const normalizedAgentId = normalizeText(agentId);
  if (!normalizedAgentId) {
    return { error: 'invalid_agent_id' };
  }

  const safeReason = normalizeText(reason) || null;
  const safeMetadata = isPlainObject(metadata) ? metadata : {};
  const safeActorType = normalizeLifecycleActorType(boundByRole || 'operator', 'operator');

  await db.query('BEGIN');
  try {
    const canonicalResolution = await resolveCanonicalDeviceUidForOperations(db, { companyId, deviceUid });
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
    const deviceRes = await db.query(
      `
      SELECT
        company_id,
        device_uid,
        managed_status,
        discovery_status,
        discovered_by_agent_id,
        manageability_status,
        manageability_reason,
        discovery_metadata
      FROM devices
      WHERE company_id = $1
        AND device_uid = $2
      LIMIT 1
      FOR UPDATE
      `,
      [companyId, canonicalDeviceUid]
    );
    const deviceRow = deviceRes.rows[0] || null;
    if (!deviceRow) {
      await db.query('ROLLBACK');
      return {
        error: 'device_not_found',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by,
          canonical_alias_kind: canonicalResolution.alias_kind,
          canonical_alias_status: canonicalResolution.alias_status
        }
      };
    }
    if (normalizeText(deviceRow.managed_status).toLowerCase() !== MANAGED_STATUS.MANAGED) {
      await db.query('ROLLBACK');
      return {
        error: 'device_not_managed',
        value: {
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          managed_status: deviceRow.managed_status || null
        }
      };
    }

    const agentRes = await db.query(
      `
      SELECT id, company_id, status
      FROM agent_nodes
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      `,
      [companyId, normalizedAgentId]
    );
    const agentRow = agentRes.rows[0] || null;
    if (!agentRow) {
      await db.query('ROLLBACK');
      return { error: 'agent_not_found' };
    }
    if (normalizeText(agentRow.status).toLowerCase() !== 'active') {
      await db.query('ROLLBACK');
      return { error: 'agent_not_active' };
    }

    const activeBindingRes = await db.query(
      `
      SELECT
        id,
        company_id,
        device_uid,
        agent_id,
        status,
        bound_at,
        unbound_at,
        bound_by_key_id,
        reason,
        metadata,
        created_at,
        updated_at
      FROM device_managing_agent_bindings
      WHERE company_id = $1
        AND device_uid = $2
        AND status = 'active'
      ORDER BY bound_at DESC, updated_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [companyId, canonicalDeviceUid]
    );
    const activeBinding = activeBindingRes.rows[0] || null;

    let bindingAction = 'noop';
    let previousAgentId = null;
    let bindingRow = activeBinding;

    if (!activeBinding) {
      const insertRes = await db.query(
        `
        INSERT INTO device_managing_agent_bindings (
          company_id,
          device_uid,
          agent_id,
          status,
          bound_at,
          unbound_at,
          bound_by_key_id,
          reason,
          metadata
        )
        VALUES ($1, $2, $3, 'active', now(), NULL, $4, $5, $6::jsonb)
        RETURNING *
        `,
        [
          companyId,
          canonicalDeviceUid,
          normalizedAgentId,
          boundByKeyId || null,
          safeReason,
          JSON.stringify({
            source: 'agent_admin.managing_agent_binding',
            ...safeMetadata
          })
        ]
      );
      bindingRow = insertRes.rows[0] || null;
      bindingAction = 'bound';

      await insertDeviceLifecycleEvent(db, {
        companyId,
        deviceUid: canonicalDeviceUid,
        lifecycleEvent: 'managing_agent_bound',
        actorType: safeActorType === 'admin' ? 'admin' : 'operator',
        actorRef: boundByKeyId || null,
        agentId: normalizedAgentId,
        fromState: {
          managing_agent_id: null
        },
        toState: {
          managing_agent_id: normalizedAgentId,
          binding_status: 'active'
        },
        reason: safeReason || 'manual_bind',
        correlationId: null,
        metadata: {
          source: 'agent_admin.managing_agent_binding',
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by,
          canonical_alias_kind: canonicalResolution.alias_kind,
          canonical_alias_status: canonicalResolution.alias_status,
          binding_action: bindingAction
        }
      });
    } else if (String(activeBinding.agent_id) === String(normalizedAgentId)) {
      bindingAction = 'noop';
    } else {
      previousAgentId = activeBinding.agent_id;
      await db.query(
        `
        UPDATE device_managing_agent_bindings
        SET status = 'superseded',
            unbound_at = now(),
            updated_at = now(),
            reason = COALESCE($1, reason)
        WHERE id = $2
        `,
        [safeReason, activeBinding.id]
      );

      const insertRes = await db.query(
        `
        INSERT INTO device_managing_agent_bindings (
          company_id,
          device_uid,
          agent_id,
          status,
          bound_at,
          unbound_at,
          bound_by_key_id,
          reason,
          metadata
        )
        VALUES ($1, $2, $3, 'active', now(), NULL, $4, $5, $6::jsonb)
        RETURNING *
        `,
        [
          companyId,
          canonicalDeviceUid,
          normalizedAgentId,
          boundByKeyId || null,
          safeReason,
          JSON.stringify({
            source: 'agent_admin.managing_agent_binding',
            rebound_from_agent_id: previousAgentId,
            ...safeMetadata
          })
        ]
      );
      bindingRow = insertRes.rows[0] || null;
      bindingAction = 'rebound';

      await insertDeviceLifecycleEvent(db, {
        companyId,
        deviceUid: canonicalDeviceUid,
        lifecycleEvent: 'managing_agent_rebound',
        actorType: safeActorType === 'admin' ? 'admin' : 'operator',
        actorRef: boundByKeyId || null,
        agentId: normalizedAgentId,
        fromState: {
          managing_agent_id: previousAgentId,
          binding_status: 'active'
        },
        toState: {
          managing_agent_id: normalizedAgentId,
          binding_status: 'active'
        },
        reason: safeReason || 'manual_rebind',
        correlationId: null,
        metadata: {
          source: 'agent_admin.managing_agent_binding',
          requested_device_uid: canonicalResolution.requested_device_uid,
          canonical_device_uid: canonicalDeviceUid,
          canonical_resolved_by: canonicalResolution.resolved_by,
          canonical_alias_kind: canonicalResolution.alias_kind,
          canonical_alias_status: canonicalResolution.alias_status,
          previous_agent_id: previousAgentId,
          binding_action: bindingAction
        }
      });
    }

    await db.query('COMMIT');
    return {
      value: {
        company_id: companyId,
        requested_device_uid: canonicalResolution.requested_device_uid,
        canonical_device_uid: canonicalDeviceUid,
        canonical_resolved_by: canonicalResolution.resolved_by,
        canonical_alias_kind: canonicalResolution.alias_kind,
        canonical_alias_status: canonicalResolution.alias_status,
        binding_action: bindingAction,
        previous_agent_id: previousAgentId,
        binding: bindingRow
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function setManualDeviceRemediation(db, {
  companyId,
  deviceUid,
  manualStatus,
  manualNote,
  manualOwner,
  updatedByKeyId
}) {
  const normalizedDeviceUid = normalizeText(deviceUid);
  if (!normalizedDeviceUid) {
    return { error: 'invalid_device_uid' };
  }

  const statusRaw = normalizeText(manualStatus).toLowerCase();
  const clearManualState = statusRaw === '' || statusRaw === 'clear' || statusRaw === 'none';
  if (!clearManualState && statusRaw !== MANUAL_REMEDIATION_STATUS.NEEDS_FIELD_ACTION) {
    return { error: 'invalid_manual_status' };
  }

  const statusValue = clearManualState ? null : MANUAL_REMEDIATION_STATUS.NEEDS_FIELD_ACTION;
  const noteValue = normalizeText(manualNote);
  const ownerValue = normalizeText(manualOwner);
  const res = await db.query(
    `
    UPDATE devices
    SET remediation_manual_status = $1,
        remediation_manual_note = CASE WHEN $1::text IS NULL THEN NULL ELSE NULLIF($2, '') END,
        remediation_manual_owner = CASE WHEN $1::text IS NULL THEN NULL ELSE NULLIF($3, '') END,
        remediation_manual_updated_at = now(),
        remediation_manual_updated_by_key_id = $4,
        updated_at = now()
    WHERE company_id = $5
      AND device_uid = $6
    RETURNING company_id, device_uid, provider, device_name, active, metadata,
              managed_status, discovery_status, discovered_by_agent_id, source,
              claimed_at, claimed_by_key_id, last_seen_at, discovery_metadata,
              manageability_status, manageability_reason, manageability_updated_at, manageability_last_proven_at,
              remediation_manual_status, remediation_manual_note, remediation_manual_owner,
              remediation_manual_updated_at, remediation_manual_updated_by_key_id,
              created_at, updated_at
    `,
    [
      statusValue,
      noteValue,
      ownerValue,
      updatedByKeyId || null,
      companyId,
      normalizedDeviceUid
    ]
  );
  const row = res.rows[0] || null;
  if (!row) {
    return { error: 'device_not_found' };
  }
  logBridgeEvent('bridge.device.remediation.manual.updated', {
    company_id: row.company_id,
    device_uid: row.device_uid,
    remediation_manual_status: row.remediation_manual_status,
    remediation_manual_owner: row.remediation_manual_owner || null
  });
  return { value: row };
}

async function getAgentRuntimeIdentity(db, {
  companyId,
  agentId,
  historyLimit
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  if (!safeCompanyId || !safeAgentId) {
    return { error: 'invalid_request' };
  }

  const safeHistoryLimit = Number.isInteger(historyLimit)
    ? Math.min(Math.max(historyLimit, 1), 20)
    : 10;

  const agentRes = await db.query(
    `
    SELECT
      id,
      company_id,
      agent_name,
      status,
      credential_version,
      identity_status,
      active_runtime_identity_id,
      runtime_identity_issued_at,
      registered_at,
      created_at,
      updated_at
    FROM agent_nodes
    WHERE company_id = $1
      AND id = $2
    LIMIT 1
    `,
    [safeCompanyId, safeAgentId]
  );
  const agent = agentRes.rows[0] || null;
  if (!agent) {
    return { error: 'agent_not_found' };
  }

  const identitiesRes = await db.query(
    `
    SELECT
      identity_id,
      company_id,
      agent_id,
      status,
      issued_at,
      revoked_at,
      issued_from_token_id,
      replaced_by_identity_id,
      replaced_reason,
      credential_prefix,
      metadata,
      created_at,
      updated_at
    FROM agent_runtime_identities
    WHERE company_id = $1
      AND agent_id = $2
    ORDER BY issued_at DESC, created_at DESC, identity_id DESC
    LIMIT $3
    `,
    [safeCompanyId, safeAgentId, safeHistoryLimit]
  );

  const identities = identitiesRes.rows.map(row => ({
    identity_id: row.identity_id,
    company_id: row.company_id,
    agent_id: row.agent_id,
    status: row.status,
    issued_at: row.issued_at,
    revoked_at: row.revoked_at,
    issued_from_token_id: row.issued_from_token_id,
    replaced_by_identity_id: row.replaced_by_identity_id,
    replaced_reason: row.replaced_reason,
    credential_prefix: row.credential_prefix,
    metadata: isPlainObject(row.metadata) ? row.metadata : {},
    created_at: row.created_at,
    updated_at: row.updated_at
  }));

  const activeIdentityId = normalizeText(agent.active_runtime_identity_id);
  const activeIdentity = identities.find(row => String(row.identity_id) === activeIdentityId) || null;

  return {
    value: {
      company_id: agent.company_id,
      agent_id: agent.id,
      agent_name: agent.agent_name,
      agent_status: agent.status,
      credential_version: agent.credential_version,
      identity_status: normalizeText(agent.identity_status).toLowerCase() || 'bootstrap_only',
      active_runtime_identity_id: activeIdentityId || null,
      runtime_identity_issued_at: agent.runtime_identity_issued_at || null,
      active_runtime_identity: activeIdentity,
      runtime_identity_history: identities
    }
  };
}

async function reissueAgentRuntimeIdentity(db, {
  companyId,
  agentId,
  actorType,
  actorRef,
  reason,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  if (!safeCompanyId || !safeAgentId) {
    return { error: 'invalid_request' };
  }

  const safeActorType = normalizeLifecycleActorType(actorType, 'admin');
  const safeReason = normalizeText(reason) || null;
  const safeMetadata = isPlainObject(metadata) ? metadata : {};

  await db.query('BEGIN');
  try {
    const agentRes = await db.query(
      `
      SELECT
        id,
        company_id,
        agent_name,
        status,
        credential_version,
        provisioned_from_token_id,
        active_runtime_identity_id
      FROM agent_nodes
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, safeAgentId]
    );
    const agent = agentRes.rows[0] || null;
    if (!agent) {
      await db.query('ROLLBACK');
      return { error: 'agent_not_found' };
    }

    const normalizedAgentStatus = normalizeText(agent.status).toLowerCase();
    if (normalizedAgentStatus === 'revoked') {
      await db.query('ROLLBACK');
      return { error: 'agent_revoked' };
    }

    const previousActiveRes = await db.query(
      `
      SELECT
        identity_id,
        status
      FROM agent_runtime_identities
      WHERE company_id = $1
        AND agent_id = $2
        AND status = 'active'
      ORDER BY issued_at DESC, created_at DESC, identity_id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, safeAgentId]
    );
    const previousActive = previousActiveRes.rows[0] || null;

    if (previousActive) {
      await db.query(
        `
        UPDATE agent_runtime_identities
        SET status = 'replaced',
            revoked_at = now(),
            replaced_reason = COALESCE($1, replaced_reason),
            updated_at = now()
        WHERE identity_id = $2
          AND company_id = $3
        `,
        [
          safeReason || 'runtime_identity_reissued',
          previousActive.identity_id,
          safeCompanyId
        ]
      );
    }

    const secret = randomToken('agt', 32);
    const secretHash = hashSecret(secret);
    const secretPrefix = secret.slice(0, 12);

    const createdIdentity = await insertAgentRuntimeIdentity(db, {
      companyId: safeCompanyId,
      agentId: safeAgentId,
      credentialHash: secretHash,
      credentialPrefix: secretPrefix,
      issuedFromTokenId: null,
      metadata: {
        source: 'agent_admin.runtime_identity.reissue',
        actor_type: safeActorType,
        actor_ref: actorRef || null,
        previous_active_identity_id: previousActive ? previousActive.identity_id : null,
        reason: safeReason,
        ...safeMetadata
      }
    });

    if (previousActive) {
      await db.query(
        `
        UPDATE agent_runtime_identities
        SET replaced_by_identity_id = $1,
            updated_at = now()
        WHERE identity_id = $2
          AND company_id = $3
        `,
        [createdIdentity.identity_id, previousActive.identity_id, safeCompanyId]
      );
    }

    const updatedAgentRes = await db.query(
      `
      UPDATE agent_nodes
      SET auth_secret_hash = $1,
          auth_secret_prefix = $2,
          credential_version = COALESCE(credential_version, 0) + 1,
          active_runtime_identity_id = $3,
          identity_status = 'active',
          runtime_identity_issued_at = $4,
          updated_at = now()
      WHERE company_id = $5
        AND id = $6
      RETURNING
        id,
        company_id,
        agent_name,
        status,
        credential_version,
        active_runtime_identity_id,
        identity_status,
        runtime_identity_issued_at
      `,
      [
        secretHash,
        secretPrefix,
        createdIdentity.identity_id,
        createdIdentity.issued_at,
        safeCompanyId,
        safeAgentId
      ]
    );

    const updatedAgent = updatedAgentRes.rows[0] || null;
    await db.query('COMMIT');
    return {
      value: {
        company_id: safeCompanyId,
        agent_id: safeAgentId,
        agent_name: updatedAgent ? updatedAgent.agent_name : null,
        agent_status: updatedAgent ? updatedAgent.status : null,
        credential_version: updatedAgent ? updatedAgent.credential_version : null,
        identity_status: updatedAgent ? updatedAgent.identity_status : 'active',
        active_runtime_identity_id: createdIdentity.identity_id,
        previous_runtime_identity_id: previousActive ? previousActive.identity_id : null,
        runtime_identity_issued_at: createdIdentity.issued_at,
        auth_token: secret
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function revokeAgentRuntimeIdentity(db, {
  companyId,
  agentId,
  actorType,
  actorRef,
  reason,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  if (!safeCompanyId || !safeAgentId) {
    return { error: 'invalid_request' };
  }

  const safeActorType = normalizeLifecycleActorType(actorType, 'admin');
  const safeReason = normalizeText(reason) || 'runtime_identity_revoked';
  const safeMetadata = isPlainObject(metadata) ? metadata : {};

  await db.query('BEGIN');
  try {
    const agentRes = await db.query(
      `
      SELECT
        id,
        company_id,
        agent_name,
        status,
        credential_version,
        active_runtime_identity_id,
        identity_status
      FROM agent_nodes
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, safeAgentId]
    );
    const agent = agentRes.rows[0] || null;
    if (!agent) {
      await db.query('ROLLBACK');
      return { error: 'agent_not_found' };
    }

    const activeIdentityRes = await db.query(
      `
      SELECT
        identity_id,
        status,
        issued_at
      FROM agent_runtime_identities
      WHERE company_id = $1
        AND agent_id = $2
        AND status = 'active'
      ORDER BY issued_at DESC, created_at DESC, identity_id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [safeCompanyId, safeAgentId]
    );
    const activeIdentity = activeIdentityRes.rows[0] || null;
    if (!activeIdentity) {
      await db.query('ROLLBACK');
      return { error: 'runtime_identity_not_active' };
    }

    await db.query(
      `
      UPDATE agent_runtime_identities
      SET status = 'revoked',
          revoked_at = now(),
          replaced_reason = COALESCE($1, replaced_reason),
          metadata = metadata || $2::jsonb,
          updated_at = now()
      WHERE identity_id = $3
        AND company_id = $4
      `,
      [
        safeReason,
        JSON.stringify({
          source: 'agent_admin.runtime_identity.revoke',
          actor_type: safeActorType,
          actor_ref: actorRef || null,
          ...safeMetadata
        }),
        activeIdentity.identity_id,
        safeCompanyId
      ]
    );

    const updatedAgentRes = await db.query(
      `
      UPDATE agent_nodes
      SET status = 'revoked',
          active_runtime_identity_id = NULL,
          identity_status = 'revoked',
          runtime_identity_issued_at = NULL,
          updated_at = now()
      WHERE company_id = $1
        AND id = $2
      RETURNING
        id,
        company_id,
        agent_name,
        status,
        credential_version,
        identity_status
      `,
      [safeCompanyId, safeAgentId]
    );

    const updatedAgent = updatedAgentRes.rows[0] || null;
    await db.query('COMMIT');
    return {
      value: {
        company_id: safeCompanyId,
        agent_id: safeAgentId,
        agent_name: updatedAgent ? updatedAgent.agent_name : null,
        agent_status: updatedAgent ? updatedAgent.status : 'revoked',
        credential_version: updatedAgent ? updatedAgent.credential_version : null,
        identity_status: updatedAgent ? updatedAgent.identity_status : 'revoked',
        revoked_runtime_identity_id: activeIdentity.identity_id,
        revoked_at: new Date().toISOString(),
        reason: safeReason
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function getAgentVersionPolicy(db, { companyId }) {
  return getEffectiveAgentVersionPolicy(db, { companyId });
}

async function setCompanyVersionPolicy(db, {
  companyId,
  minimumSupportedVersion,
  targetVersion,
  rolloutChannel,
  metadata,
  updatedByKeyId
}) {
  const safeCompanyId = normalizeText(companyId) || 'DEFAULT';
  await db.query('BEGIN');
  try {
    const updatedOverride = await upsertCompanyAgentVersionPolicy(db, {
      companyId: safeCompanyId,
      minimumSupportedVersion,
      targetVersion,
      rolloutChannel,
      metadata,
      updatedByKeyId
    });
    const policy = await getEffectiveAgentVersionPolicy(db, {
      companyId: safeCompanyId
    });
    await db.query('COMMIT');
    return {
      value: {
        company_id: safeCompanyId,
        global_policy: policy.global_policy,
        company_policy_override: policy.company_policy_override,
        effective_policy: policy.effective_policy,
        updated_override: updatedOverride
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function getAgentById(db, { companyId, agentId }) {
  const siteRuntimeStaleMinutes = defaultSiteRuntimeReportedStaleMinutes();
  const versionReportedStaleMinutes = defaultAgentVersionReportedStaleMinutes();
  const versionPolicy = await getEffectiveAgentVersionPolicy(db, { companyId });
  const res = await db.query(
    `
    SELECT
      a.id,
      a.company_id,
      a.agent_name,
      a.status,
      a.identity_status,
      a.active_runtime_identity_id,
      a.runtime_identity_issued_at,
      a.last_seen_at,
      a.last_heartbeat_at,
      a.created_at,
      a.site_id,
      s.site_key,
      s.site_name,
      s.status AS site_status,
      sal.lease_id AS site_active_lease_id,
      sal.agent_id AS site_active_agent_id,
      sal.leased_at AS site_active_leased_at,
      (sal.agent_id IS NOT NULL AND sal.agent_id = a.id) AS is_site_active_runtime,
      srs.reporting_agent_id AS site_runtime_reporting_agent_id,
      srs.runtime_health_status AS site_runtime_health_status_raw,
      srs.runtime_health_reason AS site_runtime_health_reason_raw,
      srs.reported_at AS site_runtime_reported_at,
      srs.last_heartbeat_at AS site_runtime_last_heartbeat_at,
      srs.last_poll_at AS site_runtime_last_poll_at,
      avrs.reported_version AS agent_reported_version,
      avrs.rollout_channel AS agent_reported_rollout_channel,
      avrs.reported_at AS agent_version_reported_at,
      ari.status AS runtime_identity_status,
      ari.issued_at AS runtime_identity_issued_at_raw,
      ari.revoked_at AS runtime_identity_revoked_at
    FROM agent_nodes a
    LEFT JOIN sites s
      ON s.company_id = a.company_id
     AND s.site_id = a.site_id
    LEFT JOIN site_agent_leases sal
      ON sal.company_id = a.company_id
     AND sal.site_id = a.site_id
     AND sal.status = 'active'
    LEFT JOIN site_runtime_reported_state srs
      ON srs.company_id = a.company_id
     AND srs.site_id = a.site_id
    LEFT JOIN agent_runtime_version_reported_state avrs
      ON avrs.company_id = a.company_id
     AND avrs.agent_id = a.id
    LEFT JOIN agent_runtime_identities ari
      ON ari.identity_id = a.active_runtime_identity_id
    WHERE a.company_id = $1
      AND a.id = $2
    LIMIT 1
    `,
    [companyId, agentId]
  );
  const row = res.rows[0] || null;
  if (!row) {
    return null;
  }
  const {
    site_runtime_reporting_agent_id,
    site_runtime_health_status_raw,
    site_runtime_health_reason_raw,
    site_runtime_reported_at,
    site_runtime_last_heartbeat_at,
    site_runtime_last_poll_at,
    agent_reported_version,
    agent_reported_rollout_channel,
    agent_version_reported_at,
    runtime_identity_issued_at_raw,
    ...baseRow
  } = row;
  const reported = toSiteRuntimeReportedReadModel({
    reporting_agent_id: site_runtime_reporting_agent_id,
    runtime_health_status: site_runtime_health_status_raw,
    runtime_health_reason: site_runtime_health_reason_raw,
    reported_at: site_runtime_reported_at,
    last_heartbeat_at: site_runtime_last_heartbeat_at,
    last_poll_at: site_runtime_last_poll_at
  }, {
    staleMinutes: siteRuntimeStaleMinutes
  });
  const versionGovernance = buildAgentVersionGovernanceProjection({
    agent_reported_version,
    agent_reported_rollout_channel,
    agent_version_reported_at
  }, versionPolicy.effective_policy, {
    staleMinutes: versionReportedStaleMinutes
  });
  return {
    ...baseRow,
    runtime_identity_status: normalizeText(row.runtime_identity_status).toLowerCase() || null,
    runtime_identity_issued_at: runtime_identity_issued_at_raw || row.runtime_identity_issued_at || null,
    runtime_identity_revoked_at: row.runtime_identity_revoked_at || null,
    site_runtime_reporting_agent_id: reported.reporting_agent_id,
    site_runtime_health_status: reported.health_status,
    site_runtime_health_reason: reported.health_reason,
    site_runtime_reported_at: reported.reported_at,
    site_runtime_last_heartbeat_at: reported.last_heartbeat_at,
    site_runtime_last_poll_at: reported.last_poll_at,
    site_runtime_reported_stale: reported.reported_stale,
    ...versionGovernance
  };
}

module.exports = {
  createProvisioningToken,
  bootstrapAgent,
  updateHeartbeat,
  queueScanSubnetCommand,
  queueValidateDeviceCandidateCommand,
  queueK80EnrollmentAttemptExecutionCommand,
  fetchNextCommandForAgent,
  ingestDeviceValidationResult,
  ingestK80EnrollmentAttemptResult,
  ingestDiscoveryReport,
  listAgents,
  listAgentCommands,
  getLifecycleIntegrityReport,
  getLifecycleReconciliationDryRun,
  executeLifecycleReconciliationRepair,
  reconcileAgentCommandLifecycle,
  listCandidateDevices,
  getDeviceOnboardingReadiness,
  upsertManualOnboardingCandidate,
  claimCandidateDevice,
  setManagingAgentBinding,
  setManualDeviceRemediation,
  getAgentById,
  getAgentVersionPolicy,
  setCompanyVersionPolicy,
  getAgentRuntimeIdentity,
  reissueAgentRuntimeIdentity,
  revokeAgentRuntimeIdentity,
  getActiveManagingAgentBinding,
  resolveCanonicalDeviceUidForOperations,
  __test: {
    buildDeviceUid,
    extractStableIdentity,
    resolveDiscoveryStatus,
    isIpBasedUid,
    isStableUid,
    resolveCanonicalDeviceUid,
    resolveCanonicalDeviceUidForOperations,
    classifyEnrollmentAttemptResultConservative,
    evaluateManualConfiguration,
    toManualOnboardingReadModel,
    deriveManualOnboardingState,
    deriveOperatorReadinessStatus,
    isAgentOnlineNow
  }
};
