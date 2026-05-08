const { normalizeText } = require('./agentAuth');

const DIRECTION_HISTORICAL_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  ERROR: 'error'
});

const DIRECTION_HISTORICAL_STOP_REASON = Object.freeze({
  HISTORY_EXHAUSTED: 'history_exhausted',
  NO_PROGRESS_LIMIT: 'no_progress_limit',
  RETRY_LIMIT: 'retry_limit',
  OPERATOR_STOP: 'operator_stop',
  SOURCE_UNAVAILABLE: 'source_unavailable',
  VALIDATION_FAILED: 'validation_failed'
});

const VALID_STATUS = new Set(Object.values(DIRECTION_HISTORICAL_STATUS));
const VALID_STOP_REASON = new Set(Object.values(DIRECTION_HISTORICAL_STOP_REASON));

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
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

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function normalizeStatus(value, fallback = DIRECTION_HISTORICAL_STATUS.IDLE) {
  const status = normalizeText(value).toLowerCase();
  return VALID_STATUS.has(status) ? status : fallback;
}

function normalizeStopReason(value) {
  const reason = normalizeText(value).toLowerCase();
  return VALID_STOP_REASON.has(reason) ? reason : null;
}

function parseMetadata(value) {
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

function normalizeLaneState(value) {
  const source = isPlainObject(value) ? value : {};
  return {
    status: normalizeStatus(source.status),
    session_id: normalizeText(source.session_id) || null,
    window_before_utc_exclusive: normalizeIsoUtc(source.window_before_utc_exclusive),
    window_before_anchor_key: normalizeText(source.window_before_anchor_key) || null,
    last_processed_utc: normalizeIsoUtc(source.last_processed_utc),
    last_artifact_fingerprint: normalizeText(source.last_artifact_fingerprint) || null,
    last_artifact_count: parseNonNegativeInt(source.last_artifact_count, 0),
    no_progress_windows: parseNonNegativeInt(source.no_progress_windows, 0),
    history_exhausted: source.history_exhausted === true,
    exhausted_at: normalizeIsoUtc(source.exhausted_at),
    retry_count: parseNonNegativeInt(source.retry_count, 0),
    last_error_code: normalizeText(source.last_error_code) || null,
    last_error_at: normalizeIsoUtc(source.last_error_at),
    stop_reason: normalizeStopReason(source.stop_reason),
    updated_at: normalizeIsoUtc(source.updated_at)
  };
}

function ensureScope(scope = {}) {
  const companyId = normalizeText(scope.companyId);
  const agentId = normalizeText(scope.agentId);
  const deviceUid = normalizeText(scope.deviceUid);
  if (!companyId || !agentId || !deviceUid) {
    throw new Error('invalid_scope');
  }
  return { companyId, agentId, deviceUid };
}

function deriveVendorFromDeviceUid(deviceUid, fallback = 'zkteco') {
  const normalized = normalizeText(deviceUid);
  if (!normalized) {
    return fallback;
  }
  const token = normalizeText(normalized.split(':')[0]).toLowerCase();
  return token || fallback;
}

async function ensureSyncStateRow(db, scope) {
  const vendor = deriveVendorFromDeviceUid(scope.deviceUid);
  await db.query(
    `
    INSERT INTO agent_device_sync_states (
      company_id,
      agent_id,
      device_uid,
      vendor,
      sync_mode,
      status,
      metadata
    )
    VALUES ($1, $2::uuid, $3, $4, 'pull', 'idle', '{}'::jsonb)
    ON CONFLICT (company_id, agent_id, device_uid) DO NOTHING
    `,
    [scope.companyId, scope.agentId, scope.deviceUid, vendor]
  );
}

async function lockLaneContext(db, scope) {
  const res = await db.query(
    `
    SELECT metadata
    FROM agent_device_sync_states
    WHERE company_id = $1
      AND agent_id = $2::uuid
      AND device_uid = $3
    LIMIT 1
    FOR UPDATE
    `,
    [scope.companyId, scope.agentId, scope.deviceUid]
  );
  if (res.rows.length === 0) {
    throw new Error('sync_state_not_found');
  }
  const metadata = parseMetadata(res.rows[0].metadata);
  const laneState = normalizeLaneState(metadata.direction_historical);
  return { metadata, laneState };
}

async function writeLaneState(db, scope, metadata, laneState) {
  const nextMetadata = {
    ...metadata,
    direction_historical: normalizeLaneState(laneState)
  };
  await db.query(
    `
    UPDATE agent_device_sync_states
    SET metadata = $4::jsonb,
        updated_at = now()
    WHERE company_id = $1
      AND agent_id = $2::uuid
      AND device_uid = $3
    `,
    [scope.companyId, scope.agentId, scope.deviceUid, JSON.stringify(nextMetadata)]
  );
  return nextMetadata.direction_historical;
}

async function mutateLaneState(db, scopeInput, mutateFn) {
  const scope = ensureScope(scopeInput);
  await db.query('BEGIN');
  try {
    await ensureSyncStateRow(db, scope);
    const { metadata, laneState } = await lockLaneContext(db, scope);
    const nextLaneState = mutateFn(laneState);
    const persisted = await writeLaneState(db, scope, metadata, {
      ...nextLaneState,
      updated_at: new Date().toISOString()
    });
    await db.query('COMMIT');
    return persisted;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function getHistoricalDirectionLaneState(db, scopeInput) {
  const scope = ensureScope(scopeInput);
  const res = await db.query(
    `
    SELECT metadata
    FROM agent_device_sync_states
    WHERE company_id = $1
      AND agent_id = $2::uuid
      AND device_uid = $3
    LIMIT 1
    `,
    [scope.companyId, scope.agentId, scope.deviceUid]
  );
  if (res.rows.length === 0) {
    return normalizeLaneState(null);
  }
  const metadata = parseMetadata(res.rows[0].metadata);
  return normalizeLaneState(metadata.direction_historical);
}

async function startHistoricalDirectionLaneSession(db, scopeInput, payload = {}) {
  const sessionId = normalizeText(payload.session_id);
  if (!sessionId) {
    throw new Error('invalid_session_id');
  }
  const nowIso = new Date().toISOString();
  const windowBeforeUtcExclusive = normalizeIsoUtc(payload.window_before_utc_exclusive);
  const windowBeforeAnchorKey = normalizeText(payload.window_before_anchor_key) || null;

  return mutateLaneState(db, scopeInput, laneState => ({
    ...laneState,
    status: DIRECTION_HISTORICAL_STATUS.RUNNING,
    session_id: sessionId,
    window_before_utc_exclusive: windowBeforeUtcExclusive,
    window_before_anchor_key: windowBeforeAnchorKey,
    last_processed_utc: null,
    last_artifact_fingerprint: null,
    last_artifact_count: 0,
    no_progress_windows: 0,
    history_exhausted: false,
    exhausted_at: null,
    retry_count: 0,
    last_error_code: null,
    last_error_at: null,
    stop_reason: null,
    updated_at: nowIso
  }));
}

async function updateHistoricalDirectionLaneCheckpoint(db, scopeInput, payload = {}) {
  return mutateLaneState(db, scopeInput, laneState => ({
    ...laneState,
    last_processed_utc: normalizeIsoUtc(payload.last_processed_utc) || laneState.last_processed_utc,
    window_before_utc_exclusive:
      normalizeIsoUtc(payload.window_before_utc_exclusive) || laneState.window_before_utc_exclusive,
    window_before_anchor_key:
      normalizeText(payload.window_before_anchor_key) || laneState.window_before_anchor_key,
    last_artifact_fingerprint:
      normalizeText(payload.last_artifact_fingerprint) || laneState.last_artifact_fingerprint,
    last_artifact_count: Number.isInteger(payload.last_artifact_count) && payload.last_artifact_count >= 0
      ? payload.last_artifact_count
      : laneState.last_artifact_count
  }));
}

async function incrementHistoricalDirectionLaneRetry(db, scopeInput, payload = {}) {
  const errorCode = normalizeText(payload.last_error_code) || null;
  return mutateLaneState(db, scopeInput, laneState => ({
    ...laneState,
    retry_count: parseNonNegativeInt(laneState.retry_count, 0) + 1,
    last_error_code: errorCode,
    last_error_at: errorCode ? new Date().toISOString() : laneState.last_error_at
  }));
}

async function incrementHistoricalDirectionLaneNoProgress(db, scopeInput) {
  return mutateLaneState(db, scopeInput, laneState => ({
    ...laneState,
    no_progress_windows: parseNonNegativeInt(laneState.no_progress_windows, 0) + 1
  }));
}

async function pauseHistoricalDirectionLane(db, scopeInput, payload = {}) {
  const stopReason = normalizeStopReason(payload.stop_reason);
  return mutateLaneState(db, scopeInput, laneState => ({
    ...laneState,
    status: DIRECTION_HISTORICAL_STATUS.PAUSED,
    stop_reason: stopReason
  }));
}

async function stopHistoricalDirectionLane(db, scopeInput, payload = {}) {
  const stopReason = normalizeStopReason(payload.stop_reason);
  const historyExhausted = payload.history_exhausted === true || stopReason === DIRECTION_HISTORICAL_STOP_REASON.HISTORY_EXHAUSTED;
  const exhaustedAt = historyExhausted ? new Date().toISOString() : null;
  return mutateLaneState(db, scopeInput, laneState => ({
    ...laneState,
    status: DIRECTION_HISTORICAL_STATUS.STOPPED,
    stop_reason: stopReason,
    history_exhausted: historyExhausted,
    exhausted_at: exhaustedAt
  }));
}

async function markHistoricalDirectionLaneError(db, scopeInput, payload = {}) {
  const errorCode = normalizeText(payload.last_error_code) || 'unknown_error';
  const stopReason = normalizeStopReason(payload.stop_reason);
  return mutateLaneState(db, scopeInput, laneState => ({
    ...laneState,
    status: DIRECTION_HISTORICAL_STATUS.ERROR,
    stop_reason: stopReason,
    retry_count: parseNonNegativeInt(laneState.retry_count, 0) + 1,
    last_error_code: errorCode,
    last_error_at: new Date().toISOString()
  }));
}

module.exports = {
  DIRECTION_HISTORICAL_STATUS,
  DIRECTION_HISTORICAL_STOP_REASON,
  getHistoricalDirectionLaneState,
  startHistoricalDirectionLaneSession,
  updateHistoricalDirectionLaneCheckpoint,
  incrementHistoricalDirectionLaneRetry,
  incrementHistoricalDirectionLaneNoProgress,
  pauseHistoricalDirectionLane,
  stopHistoricalDirectionLane,
  markHistoricalDirectionLaneError
};
