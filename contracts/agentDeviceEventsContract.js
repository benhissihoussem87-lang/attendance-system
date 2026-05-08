const crypto = require('crypto');

const INGEST_METHODS = new Set([
  'agent_pull',
  'agent_realtime',
  'agent_push'
]);

const DIRECTION_SET = new Set(['IN', 'OUT']);

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

function isPrivateIPv4(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
}

function validateTimezone(timezone) {
  const value = normalizeText(timezone);
  if (!value) {
    return { ok: true, value: null };
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: `invalid timezone '${value}'` };
  }
}

function validatePullDeviceEventsCommandPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }
  const deviceUid = normalizeText(payload.device_uid);
  if (!deviceUid) {
    return { ok: false, error: 'device_uid is required' };
  }

  const options = isPlainObject(payload.options) ? payload.options : {};
  const host = normalizeText(options.host);
  if (host && !isPrivateIPv4(host)) {
    return { ok: false, error: 'options.host must be RFC1918 private IPv4' };
  }
  const port = Number.isInteger(options.port) ? options.port : 4370;
  if (port < 1 || port > 65535) {
    return { ok: false, error: 'options.port must be between 1 and 65535' };
  }
  const authPassword = Number.isInteger(options.auth_password) ? options.auth_password : null;
  if (authPassword !== null && (authPassword < 0 || authPassword > 99999999)) {
    return { ok: false, error: 'options.auth_password must be between 0 and 99999999' };
  }
  const lookbackMinutes = Number.isInteger(options.lookback_minutes) ? options.lookback_minutes : 1440;
  if (lookbackMinutes < 1 || lookbackMinutes > 10080) {
    return { ok: false, error: 'options.lookback_minutes must be between 1 and 10080' };
  }
  const safetyWindowMinutes = Number.isInteger(options.safety_window_minutes)
    ? options.safety_window_minutes
    : 5;
  if (safetyWindowMinutes < 0 || safetyWindowMinutes > 120) {
    return { ok: false, error: 'options.safety_window_minutes must be between 0 and 120' };
  }
  const maxEvents = Number.isInteger(options.max_events) ? options.max_events : 500;
  if (maxEvents < 1 || maxEvents > 5000) {
    return { ok: false, error: 'options.max_events must be between 1 and 5000' };
  }
  const commandTtlSeconds = Number.isInteger(options.command_ttl_seconds)
    ? options.command_ttl_seconds
    : 1800;
  if (commandTtlSeconds < 1 || commandTtlSeconds > 86400) {
    return { ok: false, error: 'options.command_ttl_seconds must be between 1 and 86400' };
  }
  const sentStaleSeconds = Number.isInteger(options.sent_stale_seconds)
    ? options.sent_stale_seconds
    : 300;
  if (sentStaleSeconds < 1 || sentStaleSeconds > 86400) {
    return { ok: false, error: 'options.sent_stale_seconds must be between 1 and 86400' };
  }

  const sinceUtc = normalizeText(options.since_utc) || null;
  if (sinceUtc && !isValidIsoDate(sinceUtc)) {
    return { ok: false, error: 'options.since_utc must be ISO datetime' };
  }
  const historyModeRaw = normalizeText(options.history_mode).toLowerCase();
  const historyMode = historyModeRaw || null;
  if (historyMode && historyMode !== 'normal' && historyMode !== 'history_drain') {
    return { ok: false, error: 'options.history_mode must be normal or history_drain' };
  }
  const historyBeforeUtc = normalizeText(options.history_before_utc) || null;
  if (historyBeforeUtc && !isValidIsoDate(historyBeforeUtc)) {
    return { ok: false, error: 'options.history_before_utc must be ISO datetime' };
  }
  const historyBeforeDedupKey = normalizeText(options.history_before_dedup_key).toLowerCase() || null;
  if (historyBeforeDedupKey && !/^[0-9a-f]{16,128}$/.test(historyBeforeDedupKey)) {
    return { ok: false, error: 'options.history_before_dedup_key must be 16-128 lowercase hex chars' };
  }
  if (historyBeforeDedupKey && !historyBeforeUtc) {
    return { ok: false, error: 'options.history_before_dedup_key requires options.history_before_utc' };
  }
  if ((historyBeforeUtc || historyBeforeDedupKey) && historyMode !== 'history_drain') {
    return { ok: false, error: 'history boundary options require options.history_mode=history_drain' };
  }

  const tz = validateTimezone(options.device_timezone);
  if (!tz.ok) {
    return tz;
  }
  const connectOnlyProbe = options.connect_only_probe === true;
  const connectOnlyProbeHoldMs = Number.isInteger(options.connect_only_probe_hold_ms)
    ? options.connect_only_probe_hold_ms
    : null;
  if (connectOnlyProbeHoldMs !== null && (connectOnlyProbeHoldMs < 0 || connectOnlyProbeHoldMs > 60000)) {
    return { ok: false, error: 'options.connect_only_probe_hold_ms must be between 0 and 60000' };
  }

  return {
    ok: true,
    value: {
      device_uid: deviceUid,
      options: {
        ...(host ? { host } : {}),
        port,
        ...(authPassword !== null ? { auth_password: authPassword } : {}),
        lookback_minutes: lookbackMinutes,
        safety_window_minutes: safetyWindowMinutes,
        max_events: maxEvents,
        command_ttl_seconds: commandTtlSeconds,
        sent_stale_seconds: sentStaleSeconds,
        ...(sinceUtc ? { since_utc: sinceUtc } : {}),
        ...(historyMode ? { history_mode: historyMode } : {}),
        ...(historyBeforeUtc ? { history_before_utc: historyBeforeUtc } : {}),
        ...(historyBeforeDedupKey ? { history_before_dedup_key: historyBeforeDedupKey } : {}),
        ...(tz.value ? { device_timezone: tz.value } : {}),
        ...(connectOnlyProbe ? { connect_only_probe: true } : {}),
        ...(connectOnlyProbeHoldMs !== null ? { connect_only_probe_hold_ms: connectOnlyProbeHoldMs } : {}),
        mode: 'pull',
        enable_realtime: options.enable_realtime === true
      }
    }
  };
}

function normalizeDirection(value) {
  const raw = normalizeText(value).toUpperCase();
  if (!raw) return '';
  if (raw === 'I') return 'IN';
  if (raw === 'O') return 'OUT';
  return raw;
}

function buildDedupKey({
  vendor,
  deviceUid,
  devicePersonId,
  eventTimeUtc,
  direction,
  verifyState,
  verifyMethod
}) {
  const input = [
    normalizeText(vendor).toLowerCase(),
    normalizeText(deviceUid),
    normalizeText(devicePersonId),
    normalizeText(eventTimeUtc),
    normalizeDirection(direction),
    normalizeText(verifyState),
    normalizeText(verifyMethod).toLowerCase()
  ].join('|');
  return crypto.createHash('sha256').update(input).digest('hex');
}

function validateAgentDeviceEvent(event, defaults) {
  if (!isPlainObject(event)) {
    return { ok: false, error: 'event must be an object' };
  }

  const devicePersonId = normalizeText(event.device_person_id);
  if (!devicePersonId) {
    return { ok: false, error: 'event.device_person_id is required' };
  }

  const eventTimeLocal = normalizeText(event.event_time_local);
  if (!eventTimeLocal) {
    return { ok: false, error: 'event.event_time_local is required' };
  }

  const eventTimeUtc = normalizeText(event.event_time_utc);
  if (!eventTimeUtc || !isValidIsoDate(eventTimeUtc)) {
    return { ok: false, error: 'event.event_time_utc must be valid ISO datetime' };
  }

  const direction = normalizeDirection(event.direction || event.event_type);
  if (!DIRECTION_SET.has(direction)) {
    return { ok: false, error: 'event.direction must be IN or OUT' };
  }

  const eventTimezone = normalizeText(event.device_timezone || defaults.device_timezone);
  if (eventTimezone) {
    const tz = validateTimezone(eventTimezone);
    if (!tz.ok) {
      return { ok: false, error: `event ${tz.error}` };
    }
  }

  const raw = isPlainObject(event.raw) ? event.raw : {};
  const verifyStateRaw = event.verify_state;
  const verifyState = (verifyStateRaw === null || verifyStateRaw === undefined)
    ? null
    : String(verifyStateRaw);
  const verifyMethod = normalizeText(event.verify_method) || null;

  const dedupKey = normalizeText(event.dedup_key) || buildDedupKey({
    vendor: defaults.vendor,
    deviceUid: defaults.device_uid,
    devicePersonId,
    eventTimeUtc,
    direction,
    verifyState,
    verifyMethod
  });

  return {
    ok: true,
    value: {
      device_uid: defaults.device_uid,
      vendor: defaults.vendor,
      ingest_method: defaults.ingest_method,
      device_person_id: devicePersonId,
      event_time_local: eventTimeLocal,
      event_time_utc: new Date(eventTimeUtc).toISOString(),
      device_timezone: eventTimezone || null,
      direction,
      event_type: normalizeText(event.event_type) || direction,
      verify_state: verifyState,
      verify_method: verifyMethod,
      dedup_key: dedupKey,
      raw
    }
  };
}

function validateAgentEventBatchPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const deviceUid = normalizeText(payload.device_uid);
  if (!deviceUid) {
    return { ok: false, error: 'device_uid is required' };
  }
  const vendor = normalizeText(payload.vendor).toLowerCase() || 'zkteco';
  if (vendor !== 'zkteco') {
    return { ok: false, error: 'vendor must be zkteco for this slice' };
  }
  const ingestMethod = normalizeText(payload.ingest_method).toLowerCase() || 'agent_pull';
  if (!INGEST_METHODS.has(ingestMethod)) {
    return { ok: false, error: `invalid ingest_method '${ingestMethod}'` };
  }
  const commandId = normalizeText(payload.command_id) || null;
  const deliveryId = normalizeText(payload.delivery_id) || null;
  if (deliveryId && deliveryId.length > 128) {
    return { ok: false, error: 'delivery_id max length is 128' };
  }
  const deliveryAttemptRaw = payload.delivery_attempt;
  const deliveryAttempt = Number.isInteger(deliveryAttemptRaw)
    ? deliveryAttemptRaw
    : null;
  if (deliveryAttempt !== null && (deliveryAttempt < 1 || deliveryAttempt > 100000)) {
    return { ok: false, error: 'delivery_attempt must be between 1 and 100000' };
  }
  if (ingestMethod === 'agent_pull' && !commandId) {
    return { ok: false, error: 'command_id is required for ingest_method agent_pull' };
  }
  const events = Array.isArray(payload.events) ? payload.events : null;
  if (!events) {
    return { ok: false, error: 'events must be an array' };
  }
  if (events.length > 5000) {
    return { ok: false, error: 'events max length is 5000' };
  }

  const pullCompletedAt = normalizeText(payload.pull_completed_at) || new Date().toISOString();
  if (!isValidIsoDate(pullCompletedAt)) {
    return { ok: false, error: 'pull_completed_at must be valid ISO datetime' };
  }
  const pullStartedAt = normalizeText(payload.pull_started_at);
  if (pullStartedAt && !isValidIsoDate(pullStartedAt)) {
    return { ok: false, error: 'pull_started_at must be valid ISO datetime' };
  }

  const batchTimezone = normalizeText(payload.device_timezone);
  if (batchTimezone) {
    const tz = validateTimezone(batchTimezone);
    if (!tz.ok) {
      return { ok: false, error: tz.error };
    }
  }

  const normalizedEvents = [];
  for (const event of events) {
    const validated = validateAgentDeviceEvent(event, {
      device_uid: deviceUid,
      vendor,
      ingest_method: ingestMethod,
      device_timezone: batchTimezone
    });
    if (!validated.ok) {
      return validated;
    }
    normalizedEvents.push(validated.value);
  }

  const cursor = isPlainObject(payload.cursor) ? payload.cursor : {};
  const requestedSinceUtc = normalizeText(cursor.requested_since_utc) || null;
  const latestEventTimeUtc = normalizeText(cursor.latest_event_time_utc) || null;
  if (requestedSinceUtc && !isValidIsoDate(requestedSinceUtc)) {
    return { ok: false, error: 'cursor.requested_since_utc must be ISO datetime' };
  }
  if (latestEventTimeUtc && !isValidIsoDate(latestEventTimeUtc)) {
    return { ok: false, error: 'cursor.latest_event_time_utc must be ISO datetime' };
  }

  return {
    ok: true,
    value: {
      command_id: commandId,
      ...(deliveryId ? { delivery_id: deliveryId } : {}),
      ...(deliveryAttempt !== null ? { delivery_attempt: deliveryAttempt } : {}),
      run_id: normalizeText(payload.run_id) || null,
      device_uid: deviceUid,
      vendor,
      ingest_method: ingestMethod,
      device_timezone: batchTimezone || null,
      pull_started_at: pullStartedAt || null,
      pull_completed_at: new Date(pullCompletedAt).toISOString(),
      cursor: {
        requested_since_utc: requestedSinceUtc ? new Date(requestedSinceUtc).toISOString() : null,
        latest_event_time_utc: latestEventTimeUtc ? new Date(latestEventTimeUtc).toISOString() : null,
        has_more: cursor.has_more === true
      },
      summary: isPlainObject(payload.summary) ? payload.summary : {},
      events: normalizedEvents
    }
  };
}

module.exports = {
  INGEST_METHODS,
  validatePullDeviceEventsCommandPayload,
  validateAgentEventBatchPayload,
  buildDedupKey
};
