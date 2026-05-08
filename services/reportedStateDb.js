const { normalizeText } = require('./agentAuth');
const {
  CAPABILITY_STATUS,
  normalizeCapabilityKey,
  normalizeStoredCapabilityStatus
} = require('../contracts/capabilityContract');

const REPORTED_HEALTH_STATUSES = new Set(['healthy', 'degraded', 'blocked', 'offline', 'unknown']);
const VALIDATION_STATUSES = new Set(['never_run', 'queued', 'in_progress', 'failed', 'succeeded']);
const PULL_STATUSES = new Set([
  'queued',
  'sent',
  'acknowledged',
  'failed',
  'expired',
  'accepted',
  'partial',
  'rejected',
  'idle',
  'error',
  'unknown'
]);

const CAPABILITY_UNKNOWN_REASON_MISSING = 'reported_state_missing';
const CAPABILITY_UNKNOWN_REASON_STALE = 'reported_state_stale';
const RUNTIME_SCHEMA_NOT_READY_CODE = 'RUNTIME_SCHEMA_NOT_READY';
const CAPABILITY_REPORTING_REQUIRED_MIGRATION = '20260328_capability_reporting_feature_gates_foundation.sql';

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseJsonObject(value) {
  if (isPlainObject(value)) {
    return value;
  }
  if (!value || typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function buildRuntimeSchemaNotReadyError({
  runtimePath,
  missingRelations,
  schemaMigrationsTracked,
  requiredMigration,
  migrationRecorded
}) {
  const safeMissingRelations = Array.isArray(missingRelations)
    ? missingRelations.filter(Boolean)
    : [];
  const safeRuntimePath = normalizeText(runtimePath) || null;
  const safeRequiredMigration = normalizeText(requiredMigration) || null;
  const message = safeRuntimePath
    ? `runtime_schema_not_ready:${safeRuntimePath}`
    : 'runtime_schema_not_ready';
  const err = new Error(message);
  err.code = RUNTIME_SCHEMA_NOT_READY_CODE;
  err.status = 503;
  err.details = {
    kind: 'runtime_schema_not_ready',
    runtime_path: safeRuntimePath,
    missing_relations: safeMissingRelations,
    schema_migrations_tracked: schemaMigrationsTracked === true,
    required_migration: safeRequiredMigration,
    migration_recorded: typeof migrationRecorded === 'boolean' ? migrationRecorded : null
  };
  return err;
}

function normalizeIsoOrNull(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }
    return value.toISOString();
  }
  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    if (Number.isNaN(fromNumber.getTime())) {
      return null;
    }
    return fromNumber.toISOString();
  }
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

function defaultSiteRuntimeReportedStaleMinutes() {
  return parsePositiveInt(process.env.SITE_RUNTIME_REPORTED_STALE_MINUTES, 10);
}

function defaultDeviceRuntimeReportedStaleMinutes() {
  return parsePositiveInt(process.env.DEVICE_RUNTIME_REPORTED_STALE_MINUTES, 15);
}

function defaultRuntimeCapabilityReportedStaleMinutes() {
  return parsePositiveInt(process.env.RUNTIME_CAPABILITY_REPORTED_STALE_MINUTES, 20);
}

function defaultDeviceCapabilityReportedStaleMinutes() {
  return parsePositiveInt(process.env.DEVICE_CAPABILITY_REPORTED_STALE_MINUTES, 30);
}

async function getCapabilityReportingSchemaReadiness(db) {
  const regRes = await db.query(
    `
    SELECT
      to_regclass('public.agent_runtime_capability_reported_state') AS agent_runtime_capability_table,
      to_regclass('public.device_runtime_capability_reported_state') AS device_runtime_capability_table,
      to_regclass('public.schema_migrations') AS schema_migrations_table
    `
  );
  const regRow = regRes.rows[0] || {};
  const missingRelations = [];
  if (!regRow.agent_runtime_capability_table) {
    missingRelations.push('public.agent_runtime_capability_reported_state');
  }
  if (!regRow.device_runtime_capability_table) {
    missingRelations.push('public.device_runtime_capability_reported_state');
  }

  let migrationRecorded = null;
  if (regRow.schema_migrations_table) {
    const migrationRes = await db.query(
      `
      SELECT 1
      FROM public.schema_migrations
      WHERE filename = $1
      LIMIT 1
      `,
      [CAPABILITY_REPORTING_REQUIRED_MIGRATION]
    );
    migrationRecorded = migrationRes.rows.length > 0;
  }

  return {
    ready: missingRelations.length === 0,
    missing_relations: missingRelations,
    schema_migrations_tracked: Boolean(regRow.schema_migrations_table),
    required_migration: CAPABILITY_REPORTING_REQUIRED_MIGRATION,
    migration_recorded: migrationRecorded
  };
}

async function ensureCapabilityReportingSchemaReady(db, { runtimePath } = {}) {
  const readiness = await getCapabilityReportingSchemaReadiness(db);
  if (readiness.ready) {
    return readiness;
  }
  throw buildRuntimeSchemaNotReadyError({
    runtimePath,
    missingRelations: readiness.missing_relations,
    schemaMigrationsTracked: readiness.schema_migrations_tracked,
    requiredMigration: readiness.required_migration,
    migrationRecorded: readiness.migration_recorded
  });
}

function normalizeReportedHealthStatus(value, fallback = 'unknown') {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!REPORTED_HEALTH_STATUSES.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function normalizeValidationStatus(value, fallback = null) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!VALIDATION_STATUSES.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function normalizePullStatus(value, fallback = null) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (!PULL_STATUSES.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function normalizeCapabilityReason(value, fallback = null) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return fallback;
  }
  return normalized;
}

function isReportedStateStale(reportedAt, staleMinutes) {
  const normalizedReportedAt = normalizeIsoOrNull(reportedAt);
  if (!normalizedReportedAt) {
    return true;
  }
  const windowMinutes = parsePositiveInt(staleMinutes, 10);
  const staleBefore = Date.now() - (windowMinutes * 60 * 1000);
  return new Date(normalizedReportedAt).getTime() < staleBefore;
}

async function getActiveLeasedSiteForAgent(db, { companyId, agentId }) {
  const res = await db.query(
    `
    SELECT site_id
    FROM site_agent_leases
    WHERE company_id = $1
      AND agent_id = $2
      AND status = 'active'
    ORDER BY leased_at DESC, created_at DESC
    LIMIT 1
    `,
    [companyId, agentId]
  );
  return res.rows[0] || null;
}

async function getSiteRuntimeReportedState(db, { companyId, siteId }) {
  const safeSiteId = normalizeText(siteId);
  if (!safeSiteId) {
    return null;
  }
  const res = await db.query(
    `
    SELECT
      company_id,
      site_id,
      reporting_agent_id,
      last_heartbeat_at,
      last_poll_at,
      runtime_health_status,
      runtime_health_reason,
      reported_at,
      metadata,
      created_at,
      updated_at
    FROM site_runtime_reported_state
    WHERE company_id = $1
      AND site_id = $2
    LIMIT 1
    `,
    [companyId, safeSiteId]
  );
  return res.rows[0] || null;
}

async function upsertSiteRuntimeReportedState(db, {
  companyId,
  siteId,
  reportingAgentId,
  lastHeartbeatAt,
  lastPollAt,
  runtimeHealthStatus,
  runtimeHealthReason,
  reportedAt,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeSiteId = normalizeText(siteId);
  if (!safeCompanyId || !safeSiteId) {
    return null;
  }
  const existing = await getSiteRuntimeReportedState(db, {
    companyId: safeCompanyId,
    siteId: safeSiteId
  });

  const nextReportedAt = normalizeIsoOrNull(reportedAt)
    || normalizeIsoOrNull(existing && existing.reported_at)
    || new Date().toISOString();
  const nextLastHeartbeatAt = normalizeIsoOrNull(lastHeartbeatAt)
    || normalizeIsoOrNull(existing && existing.last_heartbeat_at);
  const nextLastPollAt = normalizeIsoOrNull(lastPollAt)
    || normalizeIsoOrNull(existing && existing.last_poll_at);
  const nextStatus = normalizeReportedHealthStatus(
    runtimeHealthStatus,
    normalizeReportedHealthStatus(existing && existing.runtime_health_status, 'unknown')
  );
  const nextReason = normalizeText(runtimeHealthReason)
    || normalizeText(existing && existing.runtime_health_reason)
    || null;
  const nextReportingAgentId = normalizeText(reportingAgentId)
    || normalizeText(existing && existing.reporting_agent_id)
    || null;
  const nextMetadata = {
    ...parseJsonObject(existing && existing.metadata),
    ...(isPlainObject(metadata) ? metadata : {})
  };

  const res = await db.query(
    `
    INSERT INTO site_runtime_reported_state (
      company_id,
      site_id,
      reporting_agent_id,
      last_heartbeat_at,
      last_poll_at,
      runtime_health_status,
      runtime_health_reason,
      reported_at,
      metadata
    )
    VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8::timestamptz, $9::jsonb)
    ON CONFLICT (company_id, site_id) DO UPDATE
      SET reporting_agent_id = EXCLUDED.reporting_agent_id,
          last_heartbeat_at = EXCLUDED.last_heartbeat_at,
          last_poll_at = EXCLUDED.last_poll_at,
          runtime_health_status = EXCLUDED.runtime_health_status,
          runtime_health_reason = EXCLUDED.runtime_health_reason,
          reported_at = EXCLUDED.reported_at,
          metadata = EXCLUDED.metadata,
          updated_at = now()
    RETURNING
      company_id,
      site_id,
      reporting_agent_id,
      last_heartbeat_at,
      last_poll_at,
      runtime_health_status,
      runtime_health_reason,
      reported_at,
      metadata,
      created_at,
      updated_at
    `,
    [
      safeCompanyId,
      safeSiteId,
      nextReportingAgentId,
      nextLastHeartbeatAt,
      nextLastPollAt,
      nextStatus,
      nextReason,
      nextReportedAt,
      JSON.stringify(nextMetadata)
    ]
  );
  return res.rows[0] || null;
}

async function upsertSiteRuntimeReportedStateFromAgent(db, {
  companyId,
  agentId,
  lastHeartbeatAt,
  lastPollAt,
  runtimeHealthStatus,
  runtimeHealthReason,
  reportedAt,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  if (!safeCompanyId || !safeAgentId) {
    return null;
  }
  const activeLease = await getActiveLeasedSiteForAgent(db, {
    companyId: safeCompanyId,
    agentId: safeAgentId
  });
  if (!activeLease || !normalizeText(activeLease.site_id)) {
    return null;
  }
  return upsertSiteRuntimeReportedState(db, {
    companyId: safeCompanyId,
    siteId: activeLease.site_id,
    reportingAgentId: safeAgentId,
    lastHeartbeatAt,
    lastPollAt,
    runtimeHealthStatus,
    runtimeHealthReason,
    reportedAt,
    metadata
  });
}

async function getDeviceRuntimeReportedState(db, { companyId, deviceUid }) {
  const safeDeviceUid = normalizeText(deviceUid);
  if (!safeDeviceUid) {
    return null;
  }
  const res = await db.query(
    `
    SELECT
      company_id,
      device_uid,
      site_id,
      reporting_agent_id,
      last_validation_status,
      last_validation_reason,
      last_pull_status,
      last_pull_reason,
      last_successful_pull_at,
      last_local_contact_at,
      reported_health_status,
      reported_health_reason,
      reported_at,
      metadata,
      created_at,
      updated_at
    FROM device_runtime_reported_state
    WHERE company_id = $1
      AND device_uid = $2
    LIMIT 1
    `,
    [companyId, safeDeviceUid]
  );
  return res.rows[0] || null;
}

async function upsertDeviceRuntimeReportedState(db, {
  companyId,
  deviceUid,
  siteId,
  reportingAgentId,
  lastValidationStatus,
  lastValidationReason,
  lastPullStatus,
  lastPullReason,
  lastSuccessfulPullAt,
  lastLocalContactAt,
  reportedHealthStatus,
  reportedHealthReason,
  reportedAt,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeDeviceUid = normalizeText(deviceUid);
  if (!safeCompanyId || !safeDeviceUid) {
    return null;
  }

  const existing = await getDeviceRuntimeReportedState(db, {
    companyId: safeCompanyId,
    deviceUid: safeDeviceUid
  });

  const nextSiteId = normalizeText(siteId)
    || normalizeText(existing && existing.site_id)
    || null;
  const nextReportingAgentId = normalizeText(reportingAgentId)
    || normalizeText(existing && existing.reporting_agent_id)
    || null;
  const nextValidationStatus = normalizeValidationStatus(
    lastValidationStatus,
    normalizeValidationStatus(existing && existing.last_validation_status, null)
  );
  const nextValidationReason = normalizeText(lastValidationReason)
    || normalizeText(existing && existing.last_validation_reason)
    || null;
  const nextPullStatus = normalizePullStatus(
    lastPullStatus,
    normalizePullStatus(existing && existing.last_pull_status, null)
  );
  const nextPullReason = normalizeText(lastPullReason)
    || normalizeText(existing && existing.last_pull_reason)
    || null;
  const nextLastSuccessfulPullAt = normalizeIsoOrNull(lastSuccessfulPullAt)
    || normalizeIsoOrNull(existing && existing.last_successful_pull_at);
  const nextLastLocalContactAt = normalizeIsoOrNull(lastLocalContactAt)
    || normalizeIsoOrNull(existing && existing.last_local_contact_at);
  const nextReportedHealthStatus = normalizeReportedHealthStatus(
    reportedHealthStatus,
    normalizeReportedHealthStatus(existing && existing.reported_health_status, 'unknown')
  );
  const nextReportedHealthReason = normalizeText(reportedHealthReason)
    || normalizeText(existing && existing.reported_health_reason)
    || null;
  const nextReportedAt = normalizeIsoOrNull(reportedAt)
    || normalizeIsoOrNull(existing && existing.reported_at)
    || new Date().toISOString();
  const nextMetadata = {
    ...parseJsonObject(existing && existing.metadata),
    ...(isPlainObject(metadata) ? metadata : {})
  };

  const res = await db.query(
    `
    INSERT INTO device_runtime_reported_state (
      company_id,
      device_uid,
      site_id,
      reporting_agent_id,
      last_validation_status,
      last_validation_reason,
      last_pull_status,
      last_pull_reason,
      last_successful_pull_at,
      last_local_contact_at,
      reported_health_status,
      reported_health_reason,
      reported_at,
      metadata
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9::timestamptz, $10::timestamptz, $11, $12, $13::timestamptz, $14::jsonb
    )
    ON CONFLICT (company_id, device_uid) DO UPDATE
      SET site_id = EXCLUDED.site_id,
          reporting_agent_id = EXCLUDED.reporting_agent_id,
          last_validation_status = EXCLUDED.last_validation_status,
          last_validation_reason = EXCLUDED.last_validation_reason,
          last_pull_status = EXCLUDED.last_pull_status,
          last_pull_reason = EXCLUDED.last_pull_reason,
          last_successful_pull_at = EXCLUDED.last_successful_pull_at,
          last_local_contact_at = EXCLUDED.last_local_contact_at,
          reported_health_status = EXCLUDED.reported_health_status,
          reported_health_reason = EXCLUDED.reported_health_reason,
          reported_at = EXCLUDED.reported_at,
          metadata = EXCLUDED.metadata,
          updated_at = now()
    RETURNING
      company_id,
      device_uid,
      site_id,
      reporting_agent_id,
      last_validation_status,
      last_validation_reason,
      last_pull_status,
      last_pull_reason,
      last_successful_pull_at,
      last_local_contact_at,
      reported_health_status,
      reported_health_reason,
      reported_at,
      metadata,
      created_at,
      updated_at
    `,
    [
      safeCompanyId,
      safeDeviceUid,
      nextSiteId,
      nextReportingAgentId,
      nextValidationStatus,
      nextValidationReason,
      nextPullStatus,
      nextPullReason,
      nextLastSuccessfulPullAt,
      nextLastLocalContactAt,
      nextReportedHealthStatus,
      nextReportedHealthReason,
      nextReportedAt,
      JSON.stringify(nextMetadata)
    ]
  );
  return res.rows[0] || null;
}

async function getAgentRuntimeCapabilityReportedState(db, {
  companyId,
  agentId,
  capabilityKey
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  const safeCapabilityKey = normalizeCapabilityKey(capabilityKey);
  if (!safeCompanyId || !safeAgentId || !safeCapabilityKey) {
    return null;
  }

  const res = await db.query(
    `
    SELECT
      company_id,
      agent_id,
      site_id,
      capability_key,
      capability_status,
      capability_reason,
      reported_at,
      metadata,
      created_at,
      updated_at
    FROM agent_runtime_capability_reported_state
    WHERE company_id = $1
      AND agent_id = $2
      AND capability_key = $3
    LIMIT 1
    `,
    [safeCompanyId, safeAgentId, safeCapabilityKey]
  );
  return res.rows[0] || null;
}

async function upsertAgentRuntimeCapabilityReportedState(db, {
  companyId,
  agentId,
  siteId,
  capabilityKey,
  capabilityStatus,
  capabilityReason,
  reportedAt,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeAgentId = normalizeText(agentId);
  const safeCapabilityKey = normalizeCapabilityKey(capabilityKey);
  if (!safeCompanyId || !safeAgentId || !safeCapabilityKey) {
    return null;
  }

  const existing = await getAgentRuntimeCapabilityReportedState(db, {
    companyId: safeCompanyId,
    agentId: safeAgentId,
    capabilityKey: safeCapabilityKey
  });

  const nextSiteId = normalizeText(siteId)
    || normalizeText(existing && existing.site_id)
    || null;
  const nextCapabilityStatus = normalizeStoredCapabilityStatus(
    capabilityStatus,
    normalizeStoredCapabilityStatus(existing && existing.capability_status, null)
  );
  if (!nextCapabilityStatus) {
    return existing || null;
  }
  const nextCapabilityReason = normalizeCapabilityReason(
    capabilityReason,
    normalizeCapabilityReason(existing && existing.capability_reason, null)
  );
  const nextReportedAt = normalizeIsoOrNull(reportedAt)
    || normalizeIsoOrNull(existing && existing.reported_at)
    || new Date().toISOString();
  const nextMetadata = {
    ...parseJsonObject(existing && existing.metadata),
    ...(isPlainObject(metadata) ? metadata : {})
  };

  const res = await db.query(
    `
    INSERT INTO agent_runtime_capability_reported_state (
      company_id,
      agent_id,
      site_id,
      capability_key,
      capability_status,
      capability_reason,
      reported_at,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
    ON CONFLICT (company_id, agent_id, capability_key) DO UPDATE
      SET site_id = COALESCE(EXCLUDED.site_id, agent_runtime_capability_reported_state.site_id),
          capability_status = EXCLUDED.capability_status,
          capability_reason = EXCLUDED.capability_reason,
          reported_at = GREATEST(agent_runtime_capability_reported_state.reported_at, EXCLUDED.reported_at),
          metadata = agent_runtime_capability_reported_state.metadata || EXCLUDED.metadata,
          updated_at = now()
    RETURNING
      company_id,
      agent_id,
      site_id,
      capability_key,
      capability_status,
      capability_reason,
      reported_at,
      metadata,
      created_at,
      updated_at
    `,
    [
      safeCompanyId,
      safeAgentId,
      nextSiteId,
      safeCapabilityKey,
      nextCapabilityStatus,
      nextCapabilityReason,
      nextReportedAt,
      JSON.stringify(nextMetadata)
    ]
  );

  return res.rows[0] || null;
}

async function getDeviceRuntimeCapabilityReportedState(db, {
  companyId,
  deviceUid,
  capabilityKey
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeDeviceUid = normalizeText(deviceUid);
  const safeCapabilityKey = normalizeCapabilityKey(capabilityKey);
  if (!safeCompanyId || !safeDeviceUid || !safeCapabilityKey) {
    return null;
  }

  const res = await db.query(
    `
    SELECT
      company_id,
      device_uid,
      site_id,
      reporting_agent_id,
      capability_key,
      capability_status,
      capability_reason,
      reported_at,
      metadata,
      created_at,
      updated_at
    FROM device_runtime_capability_reported_state
    WHERE company_id = $1
      AND device_uid = $2
      AND capability_key = $3
    LIMIT 1
    `,
    [safeCompanyId, safeDeviceUid, safeCapabilityKey]
  );
  return res.rows[0] || null;
}

async function upsertDeviceRuntimeCapabilityReportedState(db, {
  companyId,
  deviceUid,
  siteId,
  reportingAgentId,
  capabilityKey,
  capabilityStatus,
  capabilityReason,
  reportedAt,
  metadata
}) {
  const safeCompanyId = normalizeText(companyId);
  const safeDeviceUid = normalizeText(deviceUid);
  const safeCapabilityKey = normalizeCapabilityKey(capabilityKey);
  if (!safeCompanyId || !safeDeviceUid || !safeCapabilityKey) {
    return null;
  }

  const existing = await getDeviceRuntimeCapabilityReportedState(db, {
    companyId: safeCompanyId,
    deviceUid: safeDeviceUid,
    capabilityKey: safeCapabilityKey
  });

  const nextSiteId = normalizeText(siteId)
    || normalizeText(existing && existing.site_id)
    || null;
  const nextReportingAgentId = normalizeText(reportingAgentId)
    || normalizeText(existing && existing.reporting_agent_id)
    || null;
  const nextCapabilityStatus = normalizeStoredCapabilityStatus(
    capabilityStatus,
    normalizeStoredCapabilityStatus(existing && existing.capability_status, null)
  );
  if (!nextCapabilityStatus) {
    return existing || null;
  }
  const nextCapabilityReason = normalizeCapabilityReason(
    capabilityReason,
    normalizeCapabilityReason(existing && existing.capability_reason, null)
  );
  const nextReportedAt = normalizeIsoOrNull(reportedAt)
    || normalizeIsoOrNull(existing && existing.reported_at)
    || new Date().toISOString();
  const nextMetadata = {
    ...parseJsonObject(existing && existing.metadata),
    ...(isPlainObject(metadata) ? metadata : {})
  };

  const res = await db.query(
    `
    INSERT INTO device_runtime_capability_reported_state (
      company_id,
      device_uid,
      site_id,
      reporting_agent_id,
      capability_key,
      capability_status,
      capability_reason,
      reported_at,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)
    ON CONFLICT (company_id, device_uid, capability_key) DO UPDATE
      SET site_id = COALESCE(EXCLUDED.site_id, device_runtime_capability_reported_state.site_id),
          reporting_agent_id = COALESCE(EXCLUDED.reporting_agent_id, device_runtime_capability_reported_state.reporting_agent_id),
          capability_status = EXCLUDED.capability_status,
          capability_reason = EXCLUDED.capability_reason,
          reported_at = GREATEST(device_runtime_capability_reported_state.reported_at, EXCLUDED.reported_at),
          metadata = device_runtime_capability_reported_state.metadata || EXCLUDED.metadata,
          updated_at = now()
    RETURNING
      company_id,
      device_uid,
      site_id,
      reporting_agent_id,
      capability_key,
      capability_status,
      capability_reason,
      reported_at,
      metadata,
      created_at,
      updated_at
    `,
    [
      safeCompanyId,
      safeDeviceUid,
      nextSiteId,
      nextReportingAgentId,
      safeCapabilityKey,
      nextCapabilityStatus,
      nextCapabilityReason,
      nextReportedAt,
      JSON.stringify(nextMetadata)
    ]
  );

  return res.rows[0] || null;
}

function toCapabilityReportedReadModel(row, { staleMinutes } = {}) {
  const safeWindow = parsePositiveInt(staleMinutes, defaultRuntimeCapabilityReportedStaleMinutes());
  const stale = isReportedStateStale(row && row.reported_at, safeWindow);
  if (!row) {
    return {
      capability_key: null,
      status: CAPABILITY_STATUS.UNKNOWN,
      reason: CAPABILITY_UNKNOWN_REASON_MISSING,
      reported_at: null,
      reported_stale: true,
      stale_after_minutes: safeWindow,
      metadata: {}
    };
  }

  return {
    capability_key: normalizeCapabilityKey(row.capability_key) || null,
    status: stale
      ? CAPABILITY_STATUS.UNKNOWN
      : normalizeStoredCapabilityStatus(row.capability_status, CAPABILITY_STATUS.UNKNOWN),
    reason: stale
      ? CAPABILITY_UNKNOWN_REASON_STALE
      : normalizeCapabilityReason(row.capability_reason, null),
    reported_at: normalizeIsoOrNull(row.reported_at),
    reported_stale: stale,
    stale_after_minutes: safeWindow,
    metadata: parseJsonObject(row.metadata)
  };
}

function toSiteRuntimeReportedReadModel(row, { staleMinutes } = {}) {
  const safeWindow = parsePositiveInt(staleMinutes, defaultSiteRuntimeReportedStaleMinutes());
  const hasEvidence = Boolean(
    row
    && (
      normalizeText(row.reporting_agent_id)
      || normalizeIsoOrNull(row.reported_at)
      || normalizeIsoOrNull(row.last_heartbeat_at)
      || normalizeIsoOrNull(row.last_poll_at)
    )
  );
  if (!row || !hasEvidence) {
    return {
      reporting_agent_id: null,
      health_status: 'unknown',
      health_reason: 'reported_state_missing',
      reported_at: null,
      last_heartbeat_at: null,
      last_poll_at: null,
      reported_stale: true,
      stale_after_minutes: safeWindow
    };
  }
  const stale = isReportedStateStale(row && row.reported_at, safeWindow);
  return {
    reporting_agent_id: normalizeText(row.reporting_agent_id) || null,
    health_status: stale
      ? 'unknown'
      : normalizeReportedHealthStatus(row.runtime_health_status, 'unknown'),
    health_reason: stale
      ? 'reported_state_stale'
      : (normalizeText(row.runtime_health_reason) || null),
    reported_at: normalizeIsoOrNull(row.reported_at),
    last_heartbeat_at: normalizeIsoOrNull(row.last_heartbeat_at),
    last_poll_at: normalizeIsoOrNull(row.last_poll_at),
    reported_stale: stale,
    stale_after_minutes: safeWindow
  };
}

function toDeviceRuntimeReportedReadModel(row, { staleMinutes } = {}) {
  const safeWindow = parsePositiveInt(staleMinutes, defaultDeviceRuntimeReportedStaleMinutes());
  const stale = isReportedStateStale(row && row.reported_at, safeWindow);
  if (!row) {
    return {
      reporting_agent_id: null,
      status: 'unknown',
      reason: 'reported_state_missing',
      reported_at: null,
      reported_stale: true,
      stale_after_minutes: safeWindow,
      last_validation_status: null,
      last_validation_reason: null,
      last_pull_status: null,
      last_pull_reason: null,
      last_successful_pull_at: null,
      last_local_contact_at: null
    };
  }
  return {
    reporting_agent_id: normalizeText(row.reporting_agent_id) || null,
    status: stale
      ? 'unknown'
      : normalizeReportedHealthStatus(row.reported_health_status, 'unknown'),
    reason: stale
      ? 'reported_state_stale'
      : (normalizeText(row.reported_health_reason) || null),
    reported_at: normalizeIsoOrNull(row.reported_at),
    reported_stale: stale,
    stale_after_minutes: safeWindow,
    last_validation_status: normalizeValidationStatus(row.last_validation_status, null),
    last_validation_reason: normalizeText(row.last_validation_reason) || null,
    last_pull_status: normalizePullStatus(row.last_pull_status, null),
    last_pull_reason: normalizeText(row.last_pull_reason) || null,
    last_successful_pull_at: normalizeIsoOrNull(row.last_successful_pull_at),
    last_local_contact_at: normalizeIsoOrNull(row.last_local_contact_at)
  };
}

module.exports = {
  RUNTIME_SCHEMA_NOT_READY_CODE,
  CAPABILITY_REPORTING_REQUIRED_MIGRATION,
  defaultSiteRuntimeReportedStaleMinutes,
  defaultDeviceRuntimeReportedStaleMinutes,
  defaultRuntimeCapabilityReportedStaleMinutes,
  defaultDeviceCapabilityReportedStaleMinutes,
  buildRuntimeSchemaNotReadyError,
  getCapabilityReportingSchemaReadiness,
  ensureCapabilityReportingSchemaReady,
  normalizeReportedHealthStatus,
  normalizeValidationStatus,
  normalizePullStatus,
  normalizeCapabilityReason,
  isReportedStateStale,
  getActiveLeasedSiteForAgent,
  getSiteRuntimeReportedState,
  upsertSiteRuntimeReportedState,
  upsertSiteRuntimeReportedStateFromAgent,
  getDeviceRuntimeReportedState,
  upsertDeviceRuntimeReportedState,
  getAgentRuntimeCapabilityReportedState,
  upsertAgentRuntimeCapabilityReportedState,
  getDeviceRuntimeCapabilityReportedState,
  upsertDeviceRuntimeCapabilityReportedState,
  toCapabilityReportedReadModel,
  toSiteRuntimeReportedReadModel,
  toDeviceRuntimeReportedReadModel
};
