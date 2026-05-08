const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const { buildDedupKey } = require('../../../contracts/agentDeviceEventsContract');
const { runK80EnrollmentAttemptV2 } = require('./zktecoEnrollmentV2Orchestrator');
const {
  decodeZkTimestamp: decodeZkTimestampFromParser,
  parseBinaryAttendancePayload
} = require('../parsers/zktecoAttendanceParser');

const PORT_DEFAULT = 4370;
const USHRT_MAX = 0xffff;

const COMMANDS = {
  OPTIONS_RRQ: 11,
  ATTLOG_RRQ: 13,
  ZKTIME_PREMODE_000C: 0x000c,
  ZKTIME_PREMODE_0045: 0x0045,
  ZKTIME_PREMODE_2710: 0x2710,
  ZKTIME_STARTUP_NEGOTIATION: 0x01f5,
  ZKTIME_PREMODE_044C: 0x044c,
  ZKTIME_ENROLL_PHASE_BOUNDARY: 0x003e,
  ZKTIME_ENROLL_SELECTION: 0x003d,
  ZKTIME_RT_SUBSCRIBE: 0x01f4,
  ZKTIME_STATUS_PROBE: 0x0bb6,
  ZKTIME_PRE_SIZE_QUERY: 0x03eb,
  ZKTIME_SIZE_QUERY: 0x0032,
  ZKTIME_PULL_REQUEST: 0x05df,
  ZKTIME_ENROLL_RESULT_CONTINUE: 0x0058,
  ZKTIME_PULL_CONTINUE_REQUEST: 0x05e0,
  ZKTIME_PULL_CONTINUE_MARKER: 0x05dc,
  ZKTIME_PULL_RESPONSE: 0x05dd,
  ZKTIME_PULL_INTERMEDIATE: 0x137d,
  ZKTIME_CLEANUP: 0x03ea,
  CONNECT: 1000,
  EXIT: 1001,
  GET_VERSION: 1100,
  AUTH: 1102,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502
};

const ACK = {
  OK: 2000,
  ERROR: 2001,
  DATA: 2002,
  UNAUTH: 2005
};

const PRE_PARSE_TRUNCATION_STAGE = {
  DURING_COLLECTION: 'TRUNCATION_DURING_COLLECTION',
  DURING_ASSEMBLY: 'TRUNCATION_DURING_ASSEMBLY',
  DURING_PARSER_HANDOFF: 'TRUNCATION_DURING_PARSER_HANDOFF',
  EXPECTED_LENGTH_MISINTERPRETATION: 'EXPECTED_LENGTH_MISINTERPRETATION',
  STILL_UNCLEAR: 'STILL_UNCLEAR'
};

const TRANSPORT = {
  UDP: 'udp',
  TCP: 'tcp',
  AUTO: 'auto'
};

const ATTLOG_SEQUENCE = {
  OFF: 'off',
  DEVICEID_PLATFORM: 'deviceid_platform',
  DEVICEID_PLATFORM_VERSION: 'deviceid_platform_version',
  ZKTIME_K80: 'zktime_k80'
};

const FAILURE_REASON = {
  SOCKET_CONNECT_FAILED: 'socket_connect_failed',
  CONNECT_PACKET_SENT_NO_REPLY: 'connect_packet_sent_no_reply',
  ACK_PARSE_FAILED: 'ack_parse_failed',
  AUTH_STAGE_FAILED: 'auth_stage_failed',
  ATTLOG_STAGE_FAILED: 'attlog_stage_failed',
  PROTOCOL_VARIANT_MISMATCH: 'protocol_variant_mismatch'
};

const LEGACY_FAILURE_FALLBACK = {
  [FAILURE_REASON.SOCKET_CONNECT_FAILED]: 'socket_error',
  [FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY]: 'connect_timeout',
  [FAILURE_REASON.ACK_PARSE_FAILED]: 'protocol_error',
  [FAILURE_REASON.AUTH_STAGE_FAILED]: 'auth_failed',
  [FAILURE_REASON.ATTLOG_STAGE_FAILED]: 'attlog_timeout',
  [FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH]: 'protocol_error'
};

const TCP_WRAPPER_MAGIC = Buffer.from([0x50, 0x50, 0x82, 0x7d]);
const TCP_FRAME_MAX = 1024 * 1024;
const K80_STARTUP_NEGOTIATION_PAYLOAD_HEX = '7e4f533d3f2c457874656e64466d743d3f2c7e457874656e64466d743d3f2c457874656e644f504c6f673d3f2c7e457874656e644f504c6f673d3f2c7e506c6174666f726d3d3f2c7e5a4b465056657273696f6e3d3f2c576f726b436f64653d3f2c7e5353523d3f2c7e50494e3257696474683d3f2c7e55736572457874466d743d3f2c4275696c6456657273696f6e3d3f2c41747450686f746f466f7253444b3d3f2c7e49734f6e6c7952464d616368696e653d3f2c43616d6572614f70656e3d3f2c436f6d7061744f6c644669726d776172653d3f2c4973537570706f727450756c6c3d3f2c4c616e67756167653d3f2c7e53657269616c4e756d6265723d3f2c4661636546756e4f6e3d3f2c7e4465766963654e616d653d3f';

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function envFlagEnabled(name, fallback = false) {
  const raw = normalizeText(process.env[name]).toLowerCase();
  if (!raw) {
    return fallback;
  }
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function parseAllowlist(raw) {
  return String(raw || '')
    .split(',')
    .map(item => normalizeText(item))
    .filter(Boolean);
}

const K80_EXPERIMENTAL_PROTOCOL_FAMILIES = Object.freeze({
  ATTLOG_07D0_FOLLOWUP: 'attlog_07d0_followup',
  DYNAMIC_05E0_PAYLOAD: 'dynamic_05e0_payload',
  PULL_REQUEST_07D0_CONTINUE: 'pull_request_07d0_continue',
  LEDGER_REFRESH: 'ledger_refresh',
  FREE_DATA_STEP: 'free_data_step',
  SESSION_CONTEXT_HOLD: 'session_context_hold',
  RT_SUBSCRIBE_STEP: 'rt_subscribe_step',
  STARTUP_NEGOTIATION: 'startup_negotiation',
  PREMODE_044C: 'premode_044c',
  PREATTLOG_MODE_ENTRY: 'preattlog_mode_entry',
  PREMODE_2710_SPECIAL_HANDLING: 'premode_2710_special_handling',
  PRE_ATTLOG_ENABLE_BOUNDARY: 'pre_attlog_enable_boundary',
  PRE_SIZE_SELECTOR_AB: 'pre_size_selector_ab',
  MULTIPAGE_ATTLOG: 'multipage_attlog',
  APP_PARITY_RESTART: 'app_parity_restart',
  PRE_RETRIEVAL_SUBFAMILY: 'pre_retrieval_subfamily'
});

// Isolation boundary for experimental K80 protocol families.
// Baseline-supported and conditional production paths must not depend on this gate.
function resolveK80ExperimentalProtocolFamilyGate({ familyKey, deviceUid }) {
  const profileEnabled = envFlagEnabled('K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED', false);
  const scopeAllowlist = parseAllowlist(process.env.K80_EXPERIMENTAL_PROTOCOL_FAMILIES_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = scopeAllowlist.length === 0 || scopeAllowlist.includes(normalizeText(deviceUid));
  const familyAllowlist = parseAllowlist(process.env.K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ALLOWLIST);
  const familyAllowed = familyAllowlist.length === 0 || familyAllowlist.includes(normalizeText(familyKey));
  return {
    enabled: profileEnabled && scopeAllowed && familyAllowed,
    profile_enabled: profileEnabled,
    scope_allowlist_applied: scopeAllowlist.length > 0,
    scope_allowed: scopeAllowed,
    family_allowlist_applied: familyAllowlist.length > 0,
    family_allowed: familyAllowed
  };
}

function parsePositiveInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseNonNegativeInt(value, fallback = null) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function truncateHex(value, maxChars = 256) {
  const hex = normalizeText(value).toLowerCase();
  if (!hex) {
    return '';
  }
  if (hex.length <= maxChars) {
    return hex;
  }
  return `${hex.slice(0, maxChars)}...`;
}

function decodeUnexpectedPullPayload(command, payload) {
  if (!Buffer.isBuffer(payload) || payload.length === 0) {
    return null;
  }
  const words = [];
  const fullWords = Math.floor(payload.length / 4);
  for (let i = 0; i < Math.min(fullWords, 4); i += 1) {
    words.push(payload.readUInt32LE(i * 4));
  }
  return {
    payload_bytes: payload.length,
    payload_hex: truncateHex(bufferToHex(payload), 512),
    payload_u32le_words: words,
    payload_trailing_bytes_hex: payload.length % 4 === 0
      ? null
      : payload.slice(fullWords * 4).toString('hex'),
    classification: Number(command) === ACK.OK
      ? 'ack_ok_unexpected_at_pull_request'
      : 'unexpected_command_at_pull_request'
  };
}

function buildK8007d0FollowupRequestPayload() {
  const raw = normalizeText(process.env.K80_ATTLOG_07D0_FOLLOWUP_PAYLOAD_HEX);
  if (!raw) {
    return Buffer.alloc(0);
  }
  const normalized = raw.replace(/\s+/g, '').toLowerCase();
  if (!normalized || normalized.length % 2 !== 0 || /[^0-9a-f]/i.test(normalized)) {
    return Buffer.alloc(0);
  }
  return Buffer.from(normalized, 'hex');
}

function resolveK8007d0FollowupPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.ATTLOG_07D0_FOLLOWUP,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_ATTLOG_07D0_FOLLOWUP_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_ATTLOG_07D0_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length === 0 || allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled,
    sequence_ok: sequenceOk,
    transport_ok: transportOk,
    flag_enabled: flagEnabled,
    allowlist_applied: allowlist.length > 0,
    scope_allowed: scopeAllowed,
    experimental_profile_enabled: experimentalGate.profile_enabled,
    experimental_scope_allowed: experimentalGate.scope_allowed,
    experimental_family_allowed: experimentalGate.family_allowed,
    request_payload: buildK8007d0FollowupRequestPayload()
  };
}

function resolveK80Dynamic05e0PayloadPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.DYNAMIC_05E0_PAYLOAD,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_DYNAMIC_05E0_PAYLOAD_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_DYNAMIC_05E0_PAYLOAD_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled,
    flag_enabled: flagEnabled,
    allowlist_applied: allowlist.length > 0,
    scope_allowed: scopeAllowed,
    experimental_profile_enabled: experimentalGate.profile_enabled,
    experimental_scope_allowed: experimentalGate.scope_allowed,
    experimental_family_allowed: experimentalGate.family_allowed
  };
}

function resolveK80PullRequest07d0ContinuePolicy({
  attlogSequence,
  transport,
  deviceUid,
  dynamic05e0Enabled
}) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.PULL_REQUEST_07D0_CONTINUE,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_PULL_REQUEST_07D0_CONTINUE_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_PULL_REQUEST_07D0_CONTINUE_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk
      && transportOk
      && flagEnabled
      && scopeAllowed
      && dynamic05e0Enabled === true
      && experimentalGate.enabled,
    flag_enabled: flagEnabled,
    allowlist_applied: allowlist.length > 0,
    scope_allowed: scopeAllowed,
    experimental_profile_enabled: experimentalGate.profile_enabled,
    experimental_scope_allowed: experimentalGate.scope_allowed,
    experimental_family_allowed: experimentalGate.family_allowed
  };
}

function deriveK8005e0FollowupPayloadFromPullAck(ackPayload) {
  if (!Buffer.isBuffer(ackPayload) || ackPayload.length < 4) {
    return null;
  }
  const firstWord = ackPayload.readUInt32LE(0);
  const shiftedWord = (firstWord >>> 8) >>> 0;
  if (!Number.isInteger(shiftedWord) || shiftedWord <= 0) {
    return null;
  }
  const payload = Buffer.alloc(8, 0);
  payload.writeUInt32LE(shiftedWord, 4);
  return {
    payload,
    source_payload_hex: bufferToHex(ackPayload),
    source_first_word_u32le: firstWord,
    derived_word_u32le: shiftedWord
  };
}

function resolveK80LedgerRefreshPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.LEDGER_REFRESH,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_LEDGER_REFRESH_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_LEDGER_REFRESH_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const maxCyclesRaw = Number.parseInt(normalizeText(process.env.K80_LEDGER_REFRESH_MAX_CYCLES), 10);
  const maxCycles = Number.isInteger(maxCyclesRaw) && maxCyclesRaw > 1
    ? Math.min(maxCyclesRaw, 8)
    : 1;
  const intervalRaw = Number.parseInt(normalizeText(process.env.K80_LEDGER_REFRESH_INTERVAL_MS), 10);
  const intervalMs = Number.isInteger(intervalRaw) && intervalRaw >= 0
    ? Math.min(intervalRaw, 30000)
    : 0;
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled,
    sequence_ok: sequenceOk,
    transport_ok: transportOk,
    flag_enabled: flagEnabled,
    allowlist_applied: true,
    scope_allowed: scopeAllowed,
    experimental_profile_enabled: experimentalGate.profile_enabled,
    experimental_scope_allowed: experimentalGate.scope_allowed,
    experimental_family_allowed: experimentalGate.family_allowed,
    max_cycles: maxCycles,
    interval_ms: intervalMs
  };
}

function resolveK80Rt01f4IngestPolicy({ vendor, deviceUid, attlogSequence }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const flagEnabled = envFlagEnabled('K80_RT_01F4_INGEST_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const maxEventsRaw = Number.parseInt(normalizeText(process.env.K80_RT_01F4_INGEST_MAX_EVENTS_PER_PULL), 10);
  const maxEvents = Number.isInteger(maxEventsRaw) && maxEventsRaw > 0
    ? Math.min(maxEventsRaw, 200)
    : 20;
  const requirePersonParse = envFlagEnabled('K80_RT_01F4_REQUIRE_PERSON_PARSE', true);
  return {
    enabled: vendorOk && sequenceOk && flagEnabled && scopeAllowed,
    max_events: maxEvents,
    require_person_parse: requirePersonParse
  };
}

function resolveK80PreNormalizationDumpPolicy({ deviceUid }) {
  const flagEnabled = envFlagEnabled('K80_PRENORMALIZATION_DUMP_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_PRENORMALIZATION_DUMP_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const rawMaxRows = parsePositiveInt(process.env.K80_PRENORMALIZATION_DUMP_MAX_ROWS, 500);
  const maxRows = Math.max(1, Math.min(rawMaxRows || 500, 1000));
  return {
    enabled: flagEnabled && scopeAllowed,
    max_rows: maxRows
  };
}

function resolveK80RelaxRequestedSincePolicy({ vendor, attlogSequence, transport, deviceUid }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_RELAX_REQUESTED_SINCE_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_RELAX_REQUESTED_SINCE_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const rawMinutes = parsePositiveInt(process.env.K80_RELAX_REQUESTED_SINCE_BACKFILL_MINUTES, 180);
  const backfillMinutes = Math.max(15, Math.min(rawMinutes || 180, 1440));
  return {
    enabled: vendorOk && sequenceOk && transportOk && flagEnabled && scopeAllowed,
    backfill_minutes: backfillMinutes
  };
}

function resolveK80NormalizationReasonDiagnosticsPolicy({ vendor, attlogSequence, deviceUid }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const flagEnabled = envFlagEnabled('K80_NORMALIZATION_REASON_DIAGNOSTICS_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_NORMALIZATION_REASON_DIAGNOSTICS_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const rawMaxRows = parsePositiveInt(process.env.K80_NORMALIZATION_REASON_DIAGNOSTICS_MAX_ROWS, 100);
  const maxRows = Math.max(1, Math.min(rawMaxRows || 100, 500));
  return {
    enabled: vendorOk && sequenceOk && flagEnabled && scopeAllowed,
    max_rows: maxRows
  };
}

function resolveK80NewestFirstEmitPolicy({ vendor, attlogSequence, deviceUid }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const flagEnabled = envFlagEnabled('K80_NEWEST_FIRST_EMIT_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_NEWEST_FIRST_EMIT_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: vendorOk && sequenceOk && flagEnabled && scopeAllowed
  };
}

function resolveK80HistoryDrainModePolicy({ vendor, attlogSequence, deviceUid }) {
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const flagEnabled = envFlagEnabled('K80_HISTORY_DRAIN_MODE_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_HISTORY_DRAIN_MODE_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const allowlistApplied = allowlist.length > 0;
  return {
    enabled: vendorOk && sequenceOk && flagEnabled && scopeAllowed,
    flag_enabled: flagEnabled,
    allowlist_applied: allowlistApplied,
    scope_allowed: scopeAllowed
  };
}

function resolveK80RtSubscriberPolicy() {
  const enabled = envFlagEnabled('K80_RT_SUBSCRIBER_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST);
  const host = normalizeText(process.env.K80_RT_SUBSCRIBER_HOST);
  const port = parsePositiveInt(process.env.K80_RT_SUBSCRIBER_PORT, PORT_DEFAULT) || PORT_DEFAULT;
  const authPasswordRaw = parseNonNegativeInt(process.env.K80_RT_SUBSCRIBER_AUTH_PASSWORD, null);
  const authPassword = Number.isInteger(authPasswordRaw) && authPasswordRaw <= 99999999
    ? authPasswordRaw
    : null;
  const sessionWindowMs = Math.max(
    5000,
    Math.min(parsePositiveInt(process.env.K80_RT_SUBSCRIBER_SESSION_WINDOW_MS, 120000) || 120000, 300000)
  );
  const reconnectDelayMs = Math.max(
    1000,
    Math.min(parsePositiveInt(process.env.K80_RT_SUBSCRIBER_RECONNECT_DELAY_MS, 3000) || 3000, 60000)
  );
  const flushIntervalMs = Math.max(
    1000,
    Math.min(parsePositiveInt(process.env.K80_RT_SUBSCRIBER_FLUSH_INTERVAL_MS, 5000) || 5000, 60000)
  );
  const maxEventsPerFlush = Math.max(
    1,
    Math.min(parsePositiveInt(process.env.K80_RT_SUBSCRIBER_MAX_EVENTS_PER_FLUSH, 20) || 20, 500)
  );
  return {
    enabled,
    allowlist,
    host,
    port,
    auth_password: authPassword,
    session_window_ms: sessionWindowMs,
    reconnect_delay_ms: reconnectDelayMs,
    flush_interval_ms: flushIntervalMs,
    max_events_per_flush: maxEventsPerFlush
  };
}

function resolveK80RtSubscriberConnection({ policy, connection }) {
  const safeConnection = connection && typeof connection === 'object' ? connection : {};
  const connectionHost = normalizeText(safeConnection.host);
  const connectionPort = parsePositiveInt(safeConnection.port, null);
  const connectionAuthPassword = parseNonNegativeInt(safeConnection.auth_password, null);
  const connectionDeviceNumber = parseNonNegativeInt(safeConnection.device_number, null);
  const connectionTransport = normalizeTransportMode(safeConnection.transport, TRANSPORT.UDP);

  const usingEnvHost = Boolean(policy && normalizeText(policy.host));
  const host = usingEnvHost ? normalizeText(policy.host) : connectionHost;
  const port = usingEnvHost ? policy.port : (connectionPort || policy.port || PORT_DEFAULT);
  const authPassword = Number.isInteger(policy && policy.auth_password)
    ? policy.auth_password
    : connectionAuthPassword;
  const deviceNumber = Number.isInteger(connectionDeviceNumber) ? connectionDeviceNumber : 1;

  return {
    host,
    port,
    auth_password: authPassword,
    device_number: deviceNumber,
    transport: usingEnvHost ? null : connectionTransport,
    source: usingEnvHost ? 'env' : 'connection'
  };
}

function resolveK80FreeDataPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.FREE_DATA_STEP,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_FREE_DATA_STEP_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_FREE_DATA_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled
  };
}

function resolveK80SessionContextHoldPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.SESSION_CONTEXT_HOLD,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_SESSION_CONTEXT_HOLD_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_SESSION_CONTEXT_HOLD_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const windowMsRaw = parsePositiveInt(process.env.K80_SESSION_CONTEXT_HOLD_WINDOW_MS, 45000);
  const pollMsRaw = parsePositiveInt(process.env.K80_SESSION_CONTEXT_HOLD_POLL_MS, 500);
  const windowMs = Math.max(1000, Math.min(windowMsRaw, 60000));
  const pollMs = Math.max(100, Math.min(pollMsRaw, 2000));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled,
    window_ms: windowMs,
    poll_ms: pollMs
  };
}

function resolveK80RtSubscribePolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.RT_SUBSCRIBE_STEP,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_RT_SUBSCRIBE_STEP_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_RT_SUBSCRIBE_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled
  };
}

function resolveK80StartupNegotiationPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.STARTUP_NEGOTIATION,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_STARTUP_NEGOTIATION_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_STARTUP_NEGOTIATION_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled
  };
}

function resolveK80Premode044cPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.PREMODE_044C,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_PREMODE_044C_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_PREMODE_044C_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled
  };
}

function resolveK80PreAttlogModeEntryPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.PREATTLOG_MODE_ENTRY,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_PREATTLOG_MODE_ENTRY_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_PREATTLOG_MODE_ENTRY_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled
  };
}

function resolveK80Premode2710SpecialHandlingPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.PREMODE_2710_SPECIAL_HANDLING,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_PREMODE_2710_SPECIAL_HANDLING_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_PREMODE_2710_SPECIAL_HANDLING_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled
  };
}

function resolveK80PreAttlogEnableBoundaryPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.PRE_ATTLOG_ENABLE_BOUNDARY,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_PRE_ATTLOG_ENABLE_BOUNDARY_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_PRE_ATTLOG_ENABLE_BOUNDARY_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled
  };
}

function resolveK80PreSizeSelectorAbPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.PRE_SIZE_SELECTOR_AB,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_PRE_SIZE_SELECTOR_AB_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_PRE_SIZE_SELECTOR_AB_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const selectorBRaw = normalizeText(process.env.K80_PRE_SIZE_SELECTOR_B_PAYLOAD_HEX)
    .replace(/\s+/g, '')
    .toLowerCase();
  const selectorBPayloadHex = /^[0-9a-f]+$/.test(selectorBRaw) && selectorBRaw.length % 2 === 0
    ? selectorBRaw
    : '2c010000';
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled,
    selector_b_payload_hex: selectorBPayloadHex
  };
}

function resolveK80MultipageAttlogPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.MULTIPAGE_ATTLOG,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_MULTIPAGE_ATTLOG_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_MULTIPAGE_ATTLOG_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const maxPagesRaw = parsePositiveInt(process.env.K80_MULTIPAGE_ATTLOG_MAX_PAGES, 1);
  const maxPages = Math.max(1, Math.min(maxPagesRaw || 1, 12));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled,
    max_pages: maxPages
  };
}

function resolveK80AppParityRestartPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.APP_PARITY_RESTART,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_APP_PARITY_RESTART_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_APP_PARITY_RESTART_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled
  };
}

function resolveK80PreRetrievalSubfamilyPolicy({ attlogSequence, transport, deviceUid }) {
  const experimentalGate = resolveK80ExperimentalProtocolFamilyGate({
    familyKey: K80_EXPERIMENTAL_PROTOCOL_FAMILIES.PRE_RETRIEVAL_SUBFAMILY,
    deviceUid
  });
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const transportOk = normalizeTransportMode(transport, TRANSPORT.UDP) === TRANSPORT.TCP;
  const flagEnabled = envFlagEnabled('K80_PRE_RETRIEVAL_SUBFAMILY_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_PRE_RETRIEVAL_SUBFAMILY_DEVICE_UID_ALLOWLIST);
  const scopeAllowed = allowlist.length > 0 && allowlist.includes(normalizeText(deviceUid));
  const maxPollsRaw = parsePositiveInt(process.env.K80_PRE_RETRIEVAL_SUBFAMILY_MAX_0032_POLLS, 4);
  const maxPolls = Math.max(1, Math.min(maxPollsRaw || 4, 12));
  const pollIntervalRaw = parseNonNegativeInt(process.env.K80_PRE_RETRIEVAL_SUBFAMILY_POLL_INTERVAL_MS, 150);
  const pollIntervalMs = Math.max(0, Math.min(pollIntervalRaw || 150, 2000));
  return {
    enabled: sequenceOk && transportOk && flagEnabled && scopeAllowed && experimentalGate.enabled,
    max_0032_polls: maxPolls,
    poll_interval_ms: pollIntervalMs
  };
}

function shouldEnterK8007d0FollowupBranch({
  responseOk,
  stepId,
  expectedResponseCommand,
  responseCommand,
  policyEnabled
}) {
  return responseOk === true
    && stepId === 'pull_request'
    && expectedResponseCommand === COMMANDS.ZKTIME_PULL_RESPONSE
    && responseCommand === ACK.OK
    && policyEnabled === true;
}

function summarizeK8007d0Continuation({
  followupResponse,
  followupFrames
}) {
  const commandsObserved = [];
  const payloadChunks = [];
  const continuationFrameSizes = [];
  let reached05dc = false;
  let reached05dd = false;
  let parseFailures = 0;
  let timeout = false;
  let fatalError = null;
  let expectedBytesHint = null;
  let expectedBytesHintSource = null;
  let observedPayloadBytes = 0;
  let observed05ddPayloadBytes = 0;
  let payloadHexTruncated = false;
  const payloadChunksMeta = [];
  const rawPayloadChunkByIndex = new Map();

  if (followupFrames && Array.isArray(followupFrames.rawPayloadChunks)) {
    for (const chunk of followupFrames.rawPayloadChunks) {
      if (!chunk || !Number.isInteger(chunk.frame_index) || !Buffer.isBuffer(chunk.payload)) {
        continue;
      }
      rawPayloadChunkByIndex.set(chunk.frame_index, chunk.payload);
    }
  }

  if (followupResponse && followupResponse.response && Number.isInteger(followupResponse.response.command)) {
    const cmd = followupResponse.response.command;
    commandsObserved.push(cmd);
    continuationFrameSizes.push({
      source: 'followup_response',
      command: cmd,
      command_hex: commandToHex(cmd),
      payload_bytes: Buffer.isBuffer(followupResponse.response.payload)
        ? followupResponse.response.payload.length
        : 0
    });
    observedPayloadBytes += Buffer.isBuffer(followupResponse.response.payload)
      ? followupResponse.response.payload.length
      : 0;
    if (cmd === COMMANDS.ZKTIME_PULL_CONTINUE_MARKER) {
      reached05dc = true;
      if (Buffer.isBuffer(followupResponse.response.payload) && followupResponse.response.payload.length >= 4) {
        expectedBytesHint = followupResponse.response.payload.readUInt32LE(0);
        expectedBytesHintSource = '05dc_followup_response_payload_u32le';
      }
    }
    if (cmd === COMMANDS.ZKTIME_PULL_RESPONSE) {
      reached05dd = true;
      if (Buffer.isBuffer(followupResponse.response.payload) && followupResponse.response.payload.length > 0) {
        observed05ddPayloadBytes += followupResponse.response.payload.length;
        payloadChunks.push(followupResponse.response.payload);
        payloadChunksMeta.push({
          source: 'followup_response',
          frame_index: -1,
          command: cmd,
          command_hex: commandToHex(cmd),
          payload_bytes: followupResponse.response.payload.length
        });
      }
    }
  }

  if (followupFrames && Array.isArray(followupFrames.frames)) {
    timeout = followupFrames.timeoutHit === true;
    fatalError = followupFrames.fatalError || null;
    for (const frame of followupFrames.frames) {
      if (!frame || frame.parse_ok !== true) {
        parseFailures += 1;
        continue;
      }
      if (Number.isInteger(frame.command)) {
        commandsObserved.push(frame.command);
        observedPayloadBytes += Number.isInteger(frame.payload_bytes) ? frame.payload_bytes : 0;
        continuationFrameSizes.push({
          source: 'followup_frame',
          command: frame.command,
          command_hex: commandToHex(frame.command),
          payload_bytes: Number.isInteger(frame.payload_bytes) ? frame.payload_bytes : 0
        });
      }
      if (frame.command === COMMANDS.ZKTIME_PULL_CONTINUE_MARKER) {
        reached05dc = true;
        if (!Number.isInteger(expectedBytesHint)) {
          const payloadHex = normalizeText(frame.payload_hex);
          if (payloadHex && payloadHex.length >= 8 && !/[^0-9a-f]/i.test(payloadHex.slice(0, 8))) {
            expectedBytesHint = Number.parseInt(payloadHex.slice(0, 8), 16);
            expectedBytesHintSource = '05dc_followup_frame_payload_prefix_u32le_hex';
          }
        }
      }
      if (frame.command === COMMANDS.ZKTIME_PULL_RESPONSE) {
        reached05dd = true;
        observed05ddPayloadBytes += Number.isInteger(frame.payload_bytes) ? frame.payload_bytes : 0;
        const rawChunk = rawPayloadChunkByIndex.get(Number.isInteger(frame.index) ? frame.index : -1);
        if (Buffer.isBuffer(rawChunk) && rawChunk.length > 0) {
          payloadChunks.push(rawChunk);
          payloadChunksMeta.push({
            source: 'followup_frame_raw',
            frame_index: Number.isInteger(frame.index) ? frame.index : null,
            command: frame.command,
            command_hex: commandToHex(frame.command),
            payload_bytes: Number.isInteger(frame.payload_bytes) ? frame.payload_bytes : rawChunk.length,
            payload_raw_bytes: rawChunk.length
          });
          continue;
        }
        if (normalizeText(frame.payload_hex) && Number.isInteger(frame.payload_bytes) && frame.payload_bytes > 0) {
          const rawPayloadHex = normalizeText(frame.payload_hex);
          if (/\.\.\.\(\+\d+b\)$/i.test(rawPayloadHex)) {
            payloadHexTruncated = true;
          }
          const hex = rawPayloadHex.replace(/\.\.\.\(\+\d+b\)$/i, '');
          if (hex && hex.length % 2 === 0 && !/[^0-9a-f]/i.test(hex)) {
            payloadChunks.push(Buffer.from(hex, 'hex'));
            payloadChunksMeta.push({
              source: 'followup_frame',
              frame_index: Number.isInteger(frame.index) ? frame.index : null,
              command: frame.command,
              command_hex: commandToHex(frame.command),
              payload_bytes: Number.isInteger(frame.payload_bytes) ? frame.payload_bytes : 0,
              payload_hex_bytes: Math.floor(hex.length / 2),
              payload_hex_truncated: /\.\.\.\(\+\d+b\)$/i.test(rawPayloadHex)
            });
          }
        }
      }
    }
  }

  const payload = payloadChunks.length > 0 ? Buffer.concat(payloadChunks) : Buffer.alloc(0);
  const payloadPrefixHex = payload.length > 0
    ? payload.subarray(0, Math.min(payload.length, 32)).toString('hex')
    : null;
  const payloadSuffixHex = payload.length > 0
    ? payload.subarray(Math.max(0, payload.length - 32)).toString('hex')
    : null;
  const success = reached05dd && payload.length > 0;
  const branchOutcome = success
    ? 'success_with_05dd_data'
    : (timeout
      ? 'failed_timeout'
      : ((fatalError || parseFailures > 0) ? 'failed_parse' : 'failed_no_05dd'));

  return {
    success,
    reached05dc,
    reached05dd,
    payload,
    commands_observed: commandsObserved,
    timeout,
    fatal_error: fatalError,
    parse_failures: parseFailures,
    branch_outcome: branchOutcome,
    expected_bytes_hint: Number.isInteger(expectedBytesHint) ? expectedBytesHint : null,
    expected_bytes_hint_source: expectedBytesHintSource,
    observed_payload_bytes: observedPayloadBytes,
    observed_05dd_payload_bytes: observed05ddPayloadBytes,
    collected_payload_bytes: payload.length,
    collected_payload_chunks: payloadChunks.length,
    collected_payload_chunk_sizes: payloadChunksMeta,
    payload_hex_truncated_detected: payloadHexTruncated,
    payload_prefix_hex: payloadPrefixHex,
    payload_suffix_hex: payloadSuffixHex,
    likely_truncated: Number.isInteger(expectedBytesHint) ? payload.length < expectedBytesHint : null,
    continuation_frames_count: Array.isArray(followupFrames && followupFrames.frames)
      ? followupFrames.frames.length
      : 0,
    continuation_frame_sizes: continuationFrameSizes
  };
}

function classifyK8007d0PreParseStage({
  expectedBytes,
  observedBytes,
  observed05ddBytes,
  assembledBytes,
  parserInputBytes,
  payloadHexTruncated
}) {
  if (Number.isInteger(expectedBytes) && expectedBytes > 0 && Number.isInteger(observedBytes) && observedBytes < expectedBytes) {
    return PRE_PARSE_TRUNCATION_STAGE.DURING_COLLECTION;
  }
  if (Number.isInteger(observed05ddBytes)
    && observed05ddBytes > 0
    && Number.isInteger(assembledBytes)
    && assembledBytes < observed05ddBytes) {
    return PRE_PARSE_TRUNCATION_STAGE.DURING_ASSEMBLY;
  }
  if (payloadHexTruncated === true
    && (!Number.isInteger(observed05ddBytes)
      || !Number.isInteger(assembledBytes)
      || assembledBytes < observed05ddBytes)) {
    return PRE_PARSE_TRUNCATION_STAGE.DURING_ASSEMBLY;
  }
  if (Number.isInteger(assembledBytes)
    && Number.isInteger(parserInputBytes)
    && assembledBytes !== parserInputBytes) {
    return PRE_PARSE_TRUNCATION_STAGE.DURING_PARSER_HANDOFF;
  }
  if (Number.isInteger(expectedBytes)
    && expectedBytes > 0
    && Number.isInteger(observed05ddBytes)
    && observed05ddBytes > expectedBytes) {
    return PRE_PARSE_TRUNCATION_STAGE.EXPECTED_LENGTH_MISINTERPRETATION;
  }
  if (Number.isInteger(expectedBytes)
    && expectedBytes > 0
    && Number.isInteger(observedBytes)
    && observedBytes > expectedBytes
    && !Number.isInteger(observed05ddBytes)) {
    return PRE_PARSE_TRUNCATION_STAGE.EXPECTED_LENGTH_MISINTERPRETATION;
  }
  return PRE_PARSE_TRUNCATION_STAGE.STILL_UNCLEAR;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function valueTypeLabel(value) {
  return value === null ? 'null' : typeof value;
}

function compactValueOrNull(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

function buildEnrollmentTransitSnapshot(payload, prefix) {
  const payloadPlain = isPlainObject(payload);
  const enrollmentExists = payloadPlain && Object.prototype.hasOwnProperty.call(payload, 'enrollment');
  const enrollmentValue = enrollmentExists ? payload.enrollment : undefined;
  const enrollmentPlain = isPlainObject(enrollmentValue);
  const deviceUserIdValue = enrollmentPlain ? enrollmentValue.device_user_id : undefined;
  const selectedFingerValue = enrollmentPlain ? enrollmentValue.selected_finger : undefined;

  return {
    [`${prefix}_payload_plain`]: payloadPlain,
    [`${prefix}_enrollment_exists`]: enrollmentExists,
    [`${prefix}_enrollment_plain`]: enrollmentPlain,
    [`${prefix}_device_user_id_type`]: valueTypeLabel(deviceUserIdValue),
    [`${prefix}_device_user_id_value`]: compactValueOrNull(deviceUserIdValue),
    [`${prefix}_selected_finger_type`]: valueTypeLabel(selectedFingerValue),
    [`${prefix}_selected_finger_value`]: compactValueOrNull(selectedFingerValue)
  };
}

function normalizeDirection(value) {
  const raw = normalizeText(value).toUpperCase();
  if (!raw) return '';
  if (raw === 'I') return 'IN';
  if (raw === 'O') return 'OUT';
  return raw;
}

function normalizeTransportMode(value, fallback = TRANSPORT.UDP) {
  const raw = normalizeText(value).toLowerCase();
  if (raw === TRANSPORT.UDP || raw === TRANSPORT.TCP || raw === TRANSPORT.AUTO) {
    return raw;
  }
  return fallback;
}

function normalizeAttlogSequenceMode(value, fallback = ATTLOG_SEQUENCE.OFF) {
  const raw = normalizeText(value).toLowerCase();
  if (raw === ATTLOG_SEQUENCE.OFF
    || raw === ATTLOG_SEQUENCE.DEVICEID_PLATFORM
    || raw === ATTLOG_SEQUENCE.DEVICEID_PLATFORM_VERSION
    || raw === ATTLOG_SEQUENCE.ZKTIME_K80) {
    return raw;
  }
  return fallback;
}

function normalizeFailureReasonForOutput(reason, probeMode) {
  const normalized = normalizeText(reason);
  if (!normalized) {
    return normalized;
  }
  if (probeMode) {
    return normalized;
  }
  return LEGACY_FAILURE_FALLBACK[normalized] || normalized;
}

function mapSocketErrorCode(err) {
  if (!err || !err.code) {
    return FAILURE_REASON.SOCKET_CONNECT_FAILED;
  }
  const code = String(err.code).toUpperCase();
  if (code === 'ETIMEDOUT') {
    return FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY;
  }
  return FAILURE_REASON.SOCKET_CONNECT_FAILED;
}

function checksumPacket(packet) {
  let checksum = 0;
  let index = 0;
  let remaining = packet.length;
  while (remaining > 1) {
    checksum += packet[index] + (packet[index + 1] << 8);
    if (checksum > USHRT_MAX) {
      checksum -= USHRT_MAX;
    }
    index += 2;
    remaining -= 2;
  }
  if (remaining === 1) {
    checksum += packet[index];
  }
  while (checksum > USHRT_MAX) {
    checksum -= USHRT_MAX;
  }
  return (~checksum) & USHRT_MAX;
}

function buildPacket({ command, sessionId, replyId, payload }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
  const packet = Buffer.alloc(8 + body.length);
  packet.writeUInt16LE(command & 0xffff, 0);
  packet.writeUInt16LE(0, 2);
  packet.writeUInt16LE(sessionId & 0xffff, 4);
  packet.writeUInt16LE(replyId & 0xffff, 6);
  if (body.length > 0) {
    body.copy(packet, 8);
  }
  const checksum = checksumPacket(packet);
  packet.writeUInt16LE(checksum, 2);
  return packet;
}

function parsePacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) {
    return null;
  }
  return {
    command: buffer.readUInt16LE(0),
    checksum: buffer.readUInt16LE(2),
    session_id: buffer.readUInt16LE(4),
    reply_id: buffer.readUInt16LE(6),
    payload: buffer.subarray(8)
  };
}

function parseOptionValue(payload) {
  if (!Buffer.isBuffer(payload) || payload.length === 0) {
    return '';
  }
  const text = payload.toString('latin1').split('\x00')[0];
  if (!text) {
    return '';
  }
  const eqIndex = text.indexOf('=');
  if (eqIndex < 0) {
    return normalizeText(text);
  }
  return normalizeText(text.slice(eqIndex + 1).replace(/^=+/, ''));
}

function isLikelyTextPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length === 0) {
    return false;
  }
  let printableCount = 0;
  for (const byte of payload) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) {
      printableCount += 1;
    }
  }
  return (printableCount / payload.length) >= 0.85;
}

function compactAsciiPrefix(payload, maxBytes = 192) {
  if (!Buffer.isBuffer(payload) || payload.length === 0) {
    return '';
  }
  const slice = payload.subarray(0, Math.min(payload.length, maxBytes));
  return slice
    .toString('latin1')
    .replace(/[^\x20-\x7e]+/g, ' ')
    .trim()
    .slice(0, 180);
}

function looksLikeSchemaPayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length === 0) {
    return false;
  }
  const prefix = compactAsciiPrefix(payload, 320).toLowerCase();
  if (!prefix) {
    return false;
  }

  const markers = ['user=', 'uid=', 'pin=', 'name='];
  const hits = markers.reduce((count, marker) => {
    return count + (prefix.includes(marker) ? 1 : 0);
  }, 0);

  return (prefix.startsWith('user=') && hits >= 3) || hits === 4;
}

function bufferToHex(buffer, maxBytes = 512) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return '';
  }
  const bounded = maxBytes > 0 ? Math.min(buffer.length, maxBytes) : buffer.length;
  const view = buffer.subarray(0, bounded);
  const suffix = bounded < buffer.length ? `...(+${buffer.length - bounded}b)` : '';
  return `${view.toString('hex')}${suffix}`;
}

function commandToHex(command) {
  if (!Number.isInteger(command)) {
    return null;
  }
  return `0x${(command & 0xffff).toString(16).padStart(4, '0')}`;
}

function extractRawErrorCode(error) {
  if (!error) {
    return null;
  }
  if (typeof error === 'string') {
    return normalizeText(error) || error;
  }
  if (Number.isInteger(error.code) || typeof error.code === 'string') {
    return String(error.code);
  }
  return null;
}

function extractRawErrorMessage(error) {
  if (!error) {
    return null;
  }
  if (typeof error === 'string') {
    return normalizeText(error) || error;
  }
  if (typeof error.message === 'string') {
    return normalizeText(error.message) || error.message;
  }
  return null;
}

function ensureFailureDiagnosticsShape(diagnostics, {
  fallbackStage = null,
  fallbackReason = null,
  failureStep = null,
  error = null
} = {}) {
  const output = isPlainObject(diagnostics) ? diagnostics : {};
  const protocol = isPlainObject(output.protocol) ? output.protocol : {};
  output.protocol = protocol;

  if (!normalizeText(output.failure_stage) && normalizeText(fallbackStage)) {
    output.failure_stage = fallbackStage;
  }
  if (!normalizeText(output.failure_reason) && normalizeText(fallbackReason)) {
    output.failure_reason = fallbackReason;
  }
  if (!normalizeText(output.failure_step)) {
    const derivedStep = normalizeText(failureStep) || normalizeText(protocol.zktime_sequence_failure_step);
    output.failure_step = derivedStep || null;
  }

  const rawCode = extractRawErrorCode(error);
  const rawMessage = extractRawErrorMessage(error);
  if (!Object.prototype.hasOwnProperty.call(output, 'raw_error_code')) {
    output.raw_error_code = rawCode;
  } else if (!normalizeText(output.raw_error_code) && normalizeText(rawCode)) {
    output.raw_error_code = rawCode;
  }
  if (!Object.prototype.hasOwnProperty.call(output, 'raw_error_message')) {
    output.raw_error_message = rawMessage;
  } else if (!normalizeText(output.raw_error_message) && normalizeText(rawMessage)) {
    output.raw_error_message = rawMessage;
  }

  if (!Object.prototype.hasOwnProperty.call(output, 'last_command_sent')) {
    output.last_command_sent = null;
  }
  if (!Object.prototype.hasOwnProperty.call(output, 'last_command_hex')) {
    output.last_command_hex = null;
  }
  if (!Object.prototype.hasOwnProperty.call(output, 'last_response_command')) {
    output.last_response_command = null;
  }
  if (!Object.prototype.hasOwnProperty.call(output, 'last_response_command_hex')) {
    output.last_response_command_hex = null;
  }
  if (!Object.prototype.hasOwnProperty.call(output, 'last_session_id')) {
    output.last_session_id = null;
  }
  if (!Object.prototype.hasOwnProperty.call(output, 'last_reply_id')) {
    output.last_reply_id = null;
  }

  return output;
}

function describeInnerPacket(innerPacket) {
  const parsed = parsePacket(innerPacket);
  if (!parsed) {
    return null;
  }
  return {
    command: parsed.command,
    checksum: parsed.checksum,
    session_id: parsed.session_id,
    reply_id: parsed.reply_id,
    payload_bytes: parsed.payload.length
  };
}

function normalizeTcpLengthMode(value) {
  const raw = normalizeText(value).toLowerCase();
  return raw === 'total' ? 'total' : 'payload';
}

function buildTcpWrappedPacket(innerPacket, options = {}) {
  const inner = Buffer.isBuffer(innerPacket) ? innerPacket : Buffer.alloc(0);
  const lengthMode = normalizeTcpLengthMode(options.length_mode);
  const lengthValue = lengthMode === 'total' ? inner.length + 8 : inner.length;
  const wrapper = Buffer.alloc(8);
  TCP_WRAPPER_MAGIC.copy(wrapper, 0);
  wrapper.writeUInt32LE(lengthValue >>> 0, 4);
  if (Number.isInteger(options.deviceNumber)) {
    // Device number is tracked in diagnostics for variant analysis; packet format remains stable.
  }
  return {
    frame: Buffer.concat([wrapper, inner]),
    wrapper: {
      magic_hex: TCP_WRAPPER_MAGIC.toString('hex'),
      header_bytes: 8,
      length_encoding: 'u32le',
      length_mode: lengthMode,
      length_value: lengthValue,
      payload_bytes: inner.length,
      total_bytes: 8 + inner.length
    }
  };
}

function readTcpFrameCandidate(buffer, meta) {
  if (meta.totalBytes > buffer.length) {
    return null;
  }
  if (meta.payloadBytes < 8) {
    return {
      ok: false,
      consumed: meta.totalBytes,
      error: FAILURE_REASON.ACK_PARSE_FAILED
    };
  }
  const payload = buffer.subarray(meta.payloadOffset, meta.payloadOffset + meta.payloadBytes);
  return {
    ok: true,
    consumed: meta.totalBytes,
    payload,
    wrapper: {
      header_bytes: meta.headerBytes,
      length_encoding: meta.lengthEncoding,
      length_mode: meta.lengthMode,
      payload_bytes: meta.payloadBytes,
      total_bytes: meta.totalBytes,
      magic_hex: TCP_WRAPPER_MAGIC.toString('hex')
    }
  };
}

function extractTcpWrappedFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }
  if (!buffer.subarray(0, 4).equals(TCP_WRAPPER_MAGIC)) {
    if (buffer.length >= 8) {
      return {
        ok: false,
        consumed: buffer.length,
        error: FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH
      };
    }
    return null;
  }

  const candidates = [];
  if (buffer.length >= 8) {
    const len32le = buffer.readUInt32LE(4);
    const len32be = buffer.readUInt32BE(4);
    const values32 = [
      { value: len32le, encoding: 'u32le' },
      { value: len32be, encoding: 'u32be' }
    ];
    for (const entry of values32) {
      if (entry.value > 0 && entry.value <= TCP_FRAME_MAX) {
        candidates.push({
          headerBytes: 8,
          payloadOffset: 8,
          payloadBytes: entry.value,
          totalBytes: 8 + entry.value,
          lengthEncoding: entry.encoding,
          lengthMode: 'payload'
        });
      }
      if (entry.value >= 8 && entry.value <= TCP_FRAME_MAX) {
        candidates.push({
          headerBytes: 8,
          payloadOffset: 8,
          payloadBytes: entry.value - 8,
          totalBytes: entry.value,
          lengthEncoding: entry.encoding,
          lengthMode: 'total'
        });
      }
    }
  }

  if (buffer.length >= 6) {
    const len16le = buffer.readUInt16LE(4);
    const len16be = buffer.readUInt16BE(4);
    const values16 = [
      { value: len16le, encoding: 'u16le' },
      { value: len16be, encoding: 'u16be' }
    ];
    for (const entry of values16) {
      if (entry.value > 0 && entry.value <= TCP_FRAME_MAX) {
        candidates.push({
          headerBytes: 6,
          payloadOffset: 6,
          payloadBytes: entry.value,
          totalBytes: 6 + entry.value,
          lengthEncoding: entry.encoding,
          lengthMode: 'payload'
        });
      }
      if (entry.value >= 6 && entry.value <= TCP_FRAME_MAX) {
        candidates.push({
          headerBytes: 6,
          payloadOffset: 6,
          payloadBytes: entry.value - 6,
          totalBytes: entry.value,
          lengthEncoding: entry.encoding,
          lengthMode: 'total'
        });
      }
    }
  }

  const completeCandidates = candidates
    .map(meta => readTcpFrameCandidate(buffer, meta))
    .filter(Boolean)
    .filter(candidate => candidate.ok === true);
  if (completeCandidates.length > 0) {
    const packetValidated = completeCandidates.find(candidate => parsePacket(candidate.payload));
    return packetValidated || completeCandidates[0];
  }

  const hasIncompleteCandidate = candidates.some(meta => meta.totalBytes > buffer.length);
  if (hasIncompleteCandidate) {
    return null;
  }

  return {
    ok: false,
    consumed: Math.min(buffer.length, 8),
    error: FAILURE_REASON.ACK_PARSE_FAILED
  };
}

function createTcpChannel({ host, port, timeoutMs }) {
  const socket = new net.Socket();
  socket.setNoDelay(true);

  let closed = false;
  let accumulator = Buffer.alloc(0);
  const frameQueue = [];
  const waiters = [];

  function pushError(err) {
    const error = err instanceof Error ? err : new Error(String(err || 'tcp_channel_error'));
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function pushFrame(frame) {
    if (waiters.length > 0) {
      const waiter = waiters.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    frameQueue.push(frame);
  }

  socket.on('data', chunk => {
    accumulator = Buffer.concat([accumulator, chunk]);
    while (true) {
      const extracted = extractTcpWrappedFrame(accumulator);
      if (!extracted) {
        break;
      }
      accumulator = accumulator.subarray(extracted.consumed);
      if (!extracted.ok) {
        pushError(Object.assign(new Error(extracted.error), { code: extracted.error }));
        try {
          socket.destroy();
        } catch (err) {
          // no-op
        }
        return;
      }
      pushFrame(extracted);
    }
  });

  socket.on('error', err => {
    if (closed) {
      return;
    }
    pushError(err);
  });

  socket.on('close', () => {
    closed = true;
    if (waiters.length > 0) {
      pushError(Object.assign(new Error('socket_closed'), { code: 'SOCKET_CLOSED' }));
    }
  });

  function connect() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(Object.assign(new Error('connect_timeout'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('error', onError);
      };

      const onConnect = () => {
        cleanup();
        resolve();
      };

      const onError = err => {
        cleanup();
        reject(err);
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.connect(port, host);
    });
  }

  function send(frameBuffer) {
    const outbound = Buffer.isBuffer(frameBuffer) ? frameBuffer : Buffer.alloc(0);
    return new Promise((resolve, reject) => {
      socket.write(outbound, err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  function receiveFrame(receiveTimeoutMs) {
    if (frameQueue.length > 0) {
      return Promise.resolve(frameQueue.shift());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) {
            waiters.splice(idx, 1);
          }
          reject(Object.assign(new Error('reply_timeout'), { code: 'REPLY_TIMEOUT' }));
        }, receiveTimeoutMs)
      };
      waiters.push(waiter);
    });
  }

  function close() {
    closed = true;
    try {
      socket.destroy();
    } catch (err) {
      // no-op
    }
  }

  return {
    connect,
    send,
    receiveFrame,
    close
  };
}

function parseLocalDateTime(value) {
  const match = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0)
  };
}

function getTimeZoneOffset(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const values = {};
  parts.forEach(part => {
    values[part.type] = part.value;
  });
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return (asUtc - date.getTime()) / 60000;
}

function zonedTimeToUtc(components, timeZone) {
  const utcDate = new Date(Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second,
    0
  ));
  const offsetMinutes = getTimeZoneOffset(utcDate, timeZone);
  return new Date(utcDate.getTime() - offsetMinutes * 60000);
}

function localDateTimeToUtcIso(localDateTime, timeZone) {
  const parsed = parseLocalDateTime(localDateTime);
  if (!parsed) {
    return null;
  }
  const utcDate = zonedTimeToUtc(parsed, timeZone);
  if (Number.isNaN(utcDate.getTime())) {
    return null;
  }
  return utcDate.toISOString();
}

function decodeZkTimestamp(encoded) {
  const decoded = decodeZkTimestampFromParser(encoded);
  if (!decoded) {
    return null;
  }
  return {
    year: decoded.year,
    month: decoded.month,
    day: decoded.day,
    hour: decoded.hour,
    minute: decoded.minute,
    second: decoded.second
  };
}

function defaultStatusMap() {
  return {
    '0': 'IN',
    '1': 'OUT',
    '2': 'IN',
    '3': 'OUT',
    '4': 'IN',
    '5': 'OUT'
  };
}

function parseStatusMap(options) {
  const parsed = { ...defaultStatusMap() };
  if (!options || !options.checktype_map || typeof options.checktype_map !== 'object') {
    return parsed;
  }
  for (const [key, value] of Object.entries(options.checktype_map)) {
    const normalized = normalizeDirection(value);
    if (normalized === 'IN' || normalized === 'OUT') {
      parsed[String(key)] = normalized;
    }
  }
  return parsed;
}

function directionFromStatus(status, statusMap) {
  if (status === null || status === undefined) {
    return null;
  }
  const key = String(status);
  return statusMap[key] || null;
}

function parseTextAttendanceBuffer(buffer, statusMap) {
  const text = buffer.toString('latin1');
  const lines = text.split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean);
  const events = [];
  for (const line of lines) {
    const match = line.match(
      /^([A-Za-z0-9_\-./]+)[,;\t ]+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)(?:[,;\t ]+(\d+))?(?:[,;\t ]+(\d+))?/i
    );
    if (!match) {
      continue;
    }
    const person = normalizeText(match[1]);
    const localTime = normalizeText(match[2]).replace('T', ' ');
    const statusRaw = normalizeText(match[3]);
    const verifyRaw = normalizeText(match[4]);
    const direction = directionFromStatus(statusRaw, statusMap) || 'IN';
    if (!person || !localTime) {
      continue;
    }
    events.push({
      person,
      event_time_local: localTime.length === 16 ? `${localTime}:00` : localTime,
      direction,
      verify_state: statusRaw || null,
      verify_method: verifyRaw || null,
      parser: 'text'
    });
  }
  return events;
}

function parseBinaryAttendanceWithDiagnostics(buffer, statusMap) {
  return parseBinaryAttendancePayload(buffer, {
    statusMap,
    maxHeaderBytes: 32,
    maxMalformedSamples: 12
  });
}

function parseBinaryAttendanceBuffer(buffer, statusMap) {
  return parseBinaryAttendanceWithDiagnostics(buffer, statusMap).events;
}

function normalizeK80RtStateCode(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) {
    return '';
  }
  return numeric.toString(16).padStart(2, '0').toUpperCase();
}

function mapK80RtStateLabelProvisional(code) {
  switch (code) {
    case '00':
      return 'entree';
    case '01':
      return 'sortie';
    case '04':
      return 'prol_entree';
    case '05':
      return 'prol_sortie';
    default:
      return '';
  }
}

function buildK80RtCorrelationKey(person, eventTimeLocal) {
  const personKey = normalizeText(person);
  const timeKey = normalizeText(eventTimeLocal);
  if (!personKey || !timeKey) {
    return '';
  }
  return `${personKey}|${timeKey}`;
}

function collectK80RtCandidateFrames(protocol) {
  const frames = [];
  if (!isPlainObject(protocol)) {
    return frames;
  }
  const seen = new Set();

  const pushFrame = (frame, source = null) => {
    if (!isPlainObject(frame)) {
      return;
    }
    if (!frame.parse_ok) {
      return;
    }
    if (Number(frame.command) !== 0x01f4) {
      return;
    }
    const payloadHex = normalizeText(frame.payload_hex).toLowerCase();
    if (!payloadHex || payloadHex.length % 2 !== 0) {
      return;
    }
    const replyId = Number.isInteger(frame.reply_id) ? frame.reply_id : null;
    const sessionId = Number.isInteger(frame.session_id) ? frame.session_id : null;
    const signature = `${payloadHex}|${replyId === null ? '' : replyId}|${sessionId === null ? '' : sessionId}`;
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    frames.push({
      payloadHex,
      command: Number(frame.command),
      commandHex: normalizeText(frame.command_hex) || commandToHex(Number(frame.command)),
      sourceIndex: Number.isInteger(frame.index) ? frame.index : null,
      source: normalizeText(source) || normalizeText(frame.source) || null
    });
  };

  const pending = Array.isArray(protocol.zktime_pre_pull_pending_frames)
    ? protocol.zktime_pre_pull_pending_frames
    : [];
  for (const frame of pending) {
    pushFrame(frame, 'pre_pull_pending');
  }

  const steps = Array.isArray(protocol.zktime_sequence_steps) ? protocol.zktime_sequence_steps : [];
  for (const step of steps) {
    if (!isPlainObject(step)) {
      continue;
    }
    if (Number(step.response_command) === 0x01f4) {
      const payloadHex = normalizeText(step.payload_hex).toLowerCase();
      if (payloadHex && payloadHex.length % 2 === 0) {
        pushFrame({
          parse_ok: true,
          command: 0x01f4,
          command_hex: normalizeText(step.response_command_hex) || commandToHex(0x01f4),
          payload_hex: payloadHex,
          payload_bytes: Math.floor(payloadHex.length / 2),
          index: null
        }, 'sequence_step_response');
      }
    }
    const followup = Array.isArray(step.followup_frames) ? step.followup_frames : [];
    for (const frame of followup) {
      pushFrame(frame, 'sequence_followup');
    }
  }
  const sessionFrames = Array.isArray(protocol.zktime_session_rt01f4_frames)
    ? protocol.zktime_session_rt01f4_frames
    : [];
  for (const frame of sessionFrames) {
    pushFrame(frame, 'session_tap');
  }
  return frames;
}

function decodeK80RtObservationFromFramePayload(payloadHex) {
  const payload = Buffer.from(payloadHex, 'hex');
  if (payload.length < 32) {
    return null;
  }

  // Provisional evidence-based K80 interpretation from capture: state byte observed at offset 25.
  const stateCode = normalizeK80RtStateCode(payload.readUInt8(25));
  if (!stateCode) {
    return null;
  }

  // Provisional correlation basis: packed ZK timestamp observed at u32le offset 28 in 0x01f4 payload.
  const timestampRaw = payload.readUInt32LE(28);
  const decodedTs = decodeZkTimestampFromParser(timestampRaw);
  if (!decodedTs) {
    return null;
  }
  const eventTimeLocal = `${String(decodedTs.year).padStart(4, '0')}-${String(decodedTs.month).padStart(2, '0')}-${String(decodedTs.day).padStart(2, '0')} `
    + `${String(decodedTs.hour).padStart(2, '0')}:${String(decodedTs.minute).padStart(2, '0')}:${String(decodedTs.second).padStart(2, '0')}`;

  return {
    stateCode,
    stateLabelProvisional: mapK80RtStateLabelProvisional(stateCode) || null,
    eventTimeLocal,
    basis: 'k80_01f4_payload_u32le_ts_offset28'
  };
}

function decodeK80RtPersonFromFramePayload(payloadHex) {
  const payload = Buffer.from(payloadHex, 'hex');
  if (payload.length === 0) {
    return '';
  }
  const nulIdx = payload.indexOf(0x00);
  if (nulIdx > 0 && nulIdx <= 8) {
    const token = payload.subarray(0, nulIdx).toString('ascii').trim();
    if (/^[0-9]+$/.test(token)) {
      const normalized = token.replace(/^0+/, '');
      return normalized || '0';
    }
  }
  const b0 = payload.readUInt8(0);
  if (b0 >= 0x30 && b0 <= 0x39) {
    return String.fromCharCode(b0);
  }
  return '';
}

function buildK80RtProvisionalEventsFromProtocol({
  protocolDiagnostics,
  vendor,
  deviceUid,
  attlogSequence,
  ingestMethod,
  deviceTimezone
}) {
  const policy = resolveK80Rt01f4IngestPolicy({
    vendor,
    deviceUid,
    attlogSequence
  });
  const stats = {
    realtime_provisional_candidate_frames_count: 0,
    realtime_provisional_events_received: 0,
    realtime_provisional_events_inserted: 0,
    realtime_provisional_events_skipped_no_person: 0
  };
  if (!policy.enabled) {
    return {
      enabled: false,
      events: [],
      stats
    };
  }

  const timezone = normalizeText(deviceTimezone) || 'Africa/Tunis';
  const candidates = collectK80RtCandidateFrames(protocolDiagnostics);
  stats.realtime_provisional_candidate_frames_count = candidates.length;
  const events = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || !normalizeText(candidate.payloadHex)) {
      continue;
    }
    const decoded = decodeK80RtObservationFromFramePayload(candidate.payloadHex);
    if (!decoded || !normalizeText(decoded.eventTimeLocal)) {
      continue;
    }
    const direction = mapK80RtStateCodeToDirection(decoded.stateCode);
    if (!direction) {
      continue;
    }
    stats.realtime_provisional_events_received += 1;
    const person = decodeK80RtPersonFromFramePayload(candidate.payloadHex);
    if (!person && policy.require_person_parse) {
      stats.realtime_provisional_events_skipped_no_person += 1;
      continue;
    }
    const eventTimeUtc = localDateTimeToUtcIso(decoded.eventTimeLocal, timezone);
    if (!eventTimeUtc) {
      continue;
    }
    const personId = normalizeText(person) || 'unknown';
    const dedupKey = buildDedupKey({
      vendor,
      deviceUid,
      devicePersonId: personId,
      eventTimeUtc,
      direction,
      verifyState: '',
      verifyMethod: ''
    });
    const eventKey = `${personId}|${eventTimeUtc}|${direction}`;
    if (seen.has(eventKey)) {
      continue;
    }
    seen.add(eventKey);
    events.push({
      device_uid: deviceUid,
      vendor,
      ingest_method: ingestMethod,
      device_person_id: personId,
      event_time_local: decoded.eventTimeLocal,
      event_time_utc: eventTimeUtc,
      device_timezone: timezone,
      direction,
      event_type: direction,
      verify_state: null,
      verify_method: null,
      dedup_key: dedupKey,
      raw: {
        parser: 'k80_01f4_provisional',
        k80_rt_state_code: decoded.stateCode,
        k80_rt_state_label_provisional: decoded.stateLabelProvisional || null,
        k80_rt_basis: decoded.basis,
        k80_rt_person_parse_required: policy.require_person_parse,
        k80_rt_person_parse_ok: !!person,
        k80_rt_person_parse_value: person || null
      }
    });
    if (events.length >= policy.max_events) {
      break;
    }
  }

  stats.realtime_provisional_events_inserted = events.length;
  return {
    enabled: true,
    events,
    stats
  };
}

function buildK80RtStateMapFromRuntimeDiagnostics({
  protocolDiagnostics,
  rawEvents,
  matchWindowMs
}) {
  const candidates = collectK80RtCandidateFrames(protocolDiagnostics)
    .map(frame => {
      const decoded = decodeK80RtObservationFromFramePayload(frame.payloadHex);
      if (!decoded) {
        return null;
      }
      return {
        ...decoded,
        command: frame.command,
        commandHex: frame.commandHex,
        sourceIndex: frame.sourceIndex
      };
    })
    .filter(Boolean);

  if (candidates.length === 0) {
    return {
      stateMap: {},
      confidenceByKey: {},
      basisByKey: {},
      stats: {
        source_candidates_total: 0,
        source_candidates_decoded: 0,
        matched: 0,
        ambiguous: 0
      }
    };
  }

  const events = Array.isArray(rawEvents) ? rawEvents : [];
  const stateMap = {};
  const confidenceByKey = {};
  const basisByKey = {};
  let ambiguousCount = 0;

  for (const event of events) {
    const eventLocal = normalizeText(event && event.event_time_local);
    const person = normalizeText(event && event.person);
    const key = buildK80RtCorrelationKey(person, eventLocal);
    if (!key || !eventLocal) {
      continue;
    }
    const eventMs = new Date(`${eventLocal.replace(' ', 'T')}Z`).getTime();
    if (!Number.isFinite(eventMs)) {
      continue;
    }

    const matches = candidates
      .map(candidate => {
        const candidateMs = new Date(`${candidate.eventTimeLocal.replace(' ', 'T')}Z`).getTime();
        if (!Number.isFinite(candidateMs)) {
          return null;
        }
        const delta = Math.abs(candidateMs - eventMs);
        if (delta > matchWindowMs) {
          return null;
        }
        return { candidate, delta };
      })
      .filter(Boolean)
      .sort((a, b) => a.delta - b.delta);

    if (matches.length === 0) {
      continue;
    }

    const best = matches[0];
    const hasTie = matches.length > 1 && matches[1].delta === best.delta;
    if (hasTie) {
      ambiguousCount += 1;
      continue;
    }

    stateMap[key] = best.candidate.stateCode;
    confidenceByKey[key] = best.delta === 0 ? 'provisional_high' : 'provisional_medium';
    basisByKey[key] = best.candidate.basis;
  }

  return {
    stateMap,
    confidenceByKey,
    basisByKey,
    stats: {
      source_candidates_total: collectK80RtCandidateFrames(protocolDiagnostics).length,
      source_candidates_decoded: candidates.length,
      matched: Object.keys(stateMap).length,
      ambiguous: ambiguousCount
    }
  };
}

function resolveK80RtEnrichmentContext({
  vendor,
  deviceUid,
  attlogSequence,
  pullMeta,
  protocolDiagnostics,
  rawEvents
}) {
  if (!envFlagEnabled('K80_DIRECTION_ENRICHMENT_ENABLED', false)) {
    return null;
  }
  if (normalizeText(vendor).toLowerCase() !== 'zkteco') {
    return null;
  }
  if (normalizeText(attlogSequence).toLowerCase() !== ATTLOG_SEQUENCE.ZKTIME_K80) {
    return null;
  }

  const allowlist = parseAllowlist(process.env.K80_DIRECTION_ENRICHMENT_DEVICE_UID_ALLOWLIST);
  if (allowlist.length > 0 && !allowlist.includes(normalizeText(deviceUid))) {
    return null;
  }

  const meta = isPlainObject(pullMeta) ? pullMeta : {};
  const matchWindowMs = parsePositiveInt(
    process.env.K80_DIRECTION_ENRICHMENT_MATCH_WINDOW_MS,
    1500
  );

  // Preferred Slice 2 source: runtime K80 protocol diagnostics (0x01f4) correlation.
  const runtime = buildK80RtStateMapFromRuntimeDiagnostics({
    protocolDiagnostics,
    rawEvents,
    matchWindowMs
  });
  if (Object.keys(runtime.stateMap).length > 0) {
    return {
      stateMap: runtime.stateMap,
      confidenceByKey: runtime.confidenceByKey,
      basisByKey: runtime.basisByKey,
      source: 'k80_01f4_runtime_diag_frame_correlation_provisional',
      confidence: 'provisional_mixed',
      matchWindowMs,
      stats: runtime.stats
    };
  }

  const mapRaw = isPlainObject(meta.k80_rt_state_map) ? meta.k80_rt_state_map : null;
  if (!mapRaw) {
    return null;
  }

  const normalizedMap = {};
  for (const [key, value] of Object.entries(mapRaw)) {
    const normalizedKey = normalizeText(key);
    const stateCode = normalizeK80RtStateCode(value);
    if (!normalizedKey || !stateCode) {
      continue;
    }
    normalizedMap[normalizedKey] = stateCode;
  }
  if (Object.keys(normalizedMap).length === 0) {
    return null;
  }

  const source = normalizeText(meta.k80_rt_correlation_source) || 'k80_01f4_correlation_provisional';
  const confidence = normalizeText(meta.k80_rt_correlation_confidence) || 'provisional';
  return {
    stateMap: normalizedMap,
    confidenceByKey: {},
    basisByKey: {},
    source,
    confidence,
    matchWindowMs,
    stats: {
      source_candidates_total: 0,
      source_candidates_decoded: 0,
      matched: Object.keys(normalizedMap).length,
      ambiguous: 0
    }
  };
}

function mapK80RtStateCodeToDirection(stateCode) {
  switch (normalizeK80RtStateCode(stateCode)) {
    case '00':
    case '04':
      return 'IN';
    case '01':
    case '05':
      return 'OUT';
    default:
      return null;
  }
}

function resolveK80AuthoritativeDirectionPolicy({
  vendor,
  deviceUid,
  attlogSequence
}) {
  const flagEnabled = envFlagEnabled('K80_DIRECTION_AUTHORITATIVE_ENABLED', false);
  const allowlist = parseAllowlist(process.env.K80_DIRECTION_AUTHORITATIVE_DEVICE_UID_ALLOWLIST);
  const vendorOk = normalizeText(vendor).toLowerCase() === 'zkteco';
  const sequenceOk = normalizeText(attlogSequence).toLowerCase() === ATTLOG_SEQUENCE.ZKTIME_K80;
  const allowlistRequired = allowlist.length > 0;
  const allowlisted = allowlistRequired && allowlist.includes(normalizeText(deviceUid));
  return {
    enabled: flagEnabled && vendorOk && sequenceOk && allowlisted,
    flag_enabled: flagEnabled,
    vendor_ok: vendorOk,
    sequence_ok: sequenceOk,
    allowlist_required: allowlistRequired,
    allowlisted
  };
}

function dedupeParsedEvents(events) {
  const out = [];
  const seen = new Set();
  for (const event of events) {
    const key = [
      event.person,
      event.event_time_local,
      event.direction,
      event.verify_state || '',
      event.parser || ''
    ].join('|');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(event);
  }
  return out;
}

function receiveUdpResponse(socket, timeoutMs, expectedIp) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    const onMessage = (msg, rinfo) => {
      if (expectedIp && rinfo && rinfo.address !== expectedIp) {
        return;
      }
      cleanup();
      resolve(msg);
    };
    const onError = err => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };

    socket.on('message', onMessage);
    socket.on('error', onError);
  });
}

function makeCommKey(password, sessionId, ticks = 50) {
  const key = Number(password) >>> 0;
  let k = 0;
  for (let i = 0; i < 32; i += 1) {
    if (key & (1 << i)) {
      k = ((k << 1) | 1) >>> 0;
    } else {
      k = (k << 1) >>> 0;
    }
  }
  k = (k + (sessionId & 0xffff)) >>> 0;
  const packed = Buffer.alloc(4);
  packed.writeUInt32LE(k >>> 0, 0);
  const xored = Buffer.from([
    packed[0] ^ 'Z'.charCodeAt(0),
    packed[1] ^ 'K'.charCodeAt(0),
    packed[2] ^ 'S'.charCodeAt(0),
    packed[3] ^ 'O'.charCodeAt(0)
  ]);
  const swapped = Buffer.from([xored[2], xored[3], xored[0], xored[1]]);
  const b = ticks & 0xff;
  return Buffer.from([
    swapped[0] ^ b,
    swapped[1] ^ b,
    b,
    swapped[3] ^ b
  ]);
}

async function sendUdpCommand({
  socket,
  ip,
  port,
  timeoutMs,
  command,
  sessionId,
  replyId,
  payload,
  noReplyError = FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY
}) {
  const packet = buildPacket({ command, sessionId, replyId, payload });
  try {
    await new Promise((resolve, reject) => {
      socket.send(packet, port, ip, err => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    return { ok: false, error: mapSocketErrorCode(err) };
  }

  let response;
  try {
    response = await receiveUdpResponse(socket, timeoutMs, ip);
  } catch (err) {
    return { ok: false, error: mapSocketErrorCode(err) };
  }

  if (!response) {
    return { ok: false, error: noReplyError };
  }

  const parsed = parsePacket(response);
  if (!parsed) {
    return { ok: false, error: FAILURE_REASON.ACK_PARSE_FAILED };
  }

  return {
    ok: true,
    response: parsed
  };
}

async function sendTcpCommand({
  channel,
  timeoutMs,
  command,
  sessionId,
  replyId,
  payload,
  noReplyError = FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY,
  deviceNumber = null,
  tcpProfile = null,
  trace = null,
  onFrameReceived = null
}) {
  const innerPacket = buildPacket({ command, sessionId, replyId, payload });
  const wrappedPacket = buildTcpWrappedPacket(innerPacket, {
    length_mode: tcpProfile && tcpProfile.length_mode,
    deviceNumber
  });
  if (trace && typeof trace === 'object') {
    trace.tx = {
      frame_hex: bufferToHex(wrappedPacket.frame),
      frame_bytes: wrappedPacket.frame.length,
      wrapper: wrappedPacket.wrapper,
      inner: describeInnerPacket(innerPacket),
      inner_packet_hex: bufferToHex(innerPacket)
    };
  }

  try {
    await channel.send(wrappedPacket.frame);
  } catch (err) {
    if (trace && typeof trace === 'object') {
      trace.error = mapSocketErrorCode(err);
    }
    return { ok: false, error: mapSocketErrorCode(err) };
  }

  let wrappedFrame;
  try {
    wrappedFrame = await channel.receiveFrame(timeoutMs);
    if (typeof onFrameReceived === 'function') {
      try {
        onFrameReceived(wrappedFrame, {
          stage: trace && trace.stage ? trace.stage : null,
          step: trace && trace.step ? trace.step : null,
          source: 'send_tcp_command'
        });
      } catch (err) {
        // tap diagnostics must remain non-blocking
      }
    }
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    if (code === 'REPLY_TIMEOUT') {
      if (trace && typeof trace === 'object') {
        trace.error = noReplyError;
      }
      return { ok: false, error: noReplyError };
    }
    if (code === FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH) {
      if (trace && typeof trace === 'object') {
        trace.error = FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH;
      }
      return { ok: false, error: FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH };
    }
    if (code === FAILURE_REASON.ACK_PARSE_FAILED) {
      if (trace && typeof trace === 'object') {
        trace.error = FAILURE_REASON.ACK_PARSE_FAILED;
      }
      return { ok: false, error: FAILURE_REASON.ACK_PARSE_FAILED };
    }
    if (trace && typeof trace === 'object') {
      trace.error = mapSocketErrorCode(err);
    }
    return { ok: false, error: mapSocketErrorCode(err) };
  }

  const parsed = parsePacket(wrappedFrame.payload);
  if (!parsed) {
    if (trace && typeof trace === 'object') {
      trace.error = FAILURE_REASON.ACK_PARSE_FAILED;
    }
    return { ok: false, error: FAILURE_REASON.ACK_PARSE_FAILED };
  }
  if (trace && typeof trace === 'object') {
    trace.response = {
      command: parsed.command,
      session_id: parsed.session_id,
      reply_id: parsed.reply_id,
      payload_bytes: parsed.payload.length,
      wrapper: wrappedFrame.wrapper,
      inner_packet_hex: bufferToHex(wrappedFrame.payload),
      payload_hex: bufferToHex(parsed.payload)
    };
  }

  return {
    ok: true,
    response: parsed,
    wrapper: wrappedFrame.wrapper
  };
}

function nextReplyId(replyId) {
  const next = (replyId + 1) & 0xffff;
  return next >= USHRT_MAX ? (next - USHRT_MAX) : next;
}

function mapSelectedFingerToK80Index(selectedFinger) {
  const normalized = normalizeText(selectedFinger).toUpperCase().replace(/[\s_]+/g, '-');
  const map = {
    'LEFT-THUMB': 0,
    'LEFT-INDEX': 1,
    'LEFT-MIDDLE': 2,
    'LEFT-RING': 3,
    'LEFT-LITTLE': 4,
    'RIGHT-THUMB': 5,
    'RIGHT-INDEX': 6,
    'RIGHT-MIDDLE': 7,
    'RIGHT-RING': 8,
    'RIGHT-LITTLE': 9
  };
  if (Object.prototype.hasOwnProperty.call(map, normalized)) {
    return map[normalized];
  }
  return 0;
}

function resolveK80Enrollment003dPayloadPolicy() {
  const guardedEnabled = envFlagEnabled('K80_ENROLL_003D_26B_GUARDED_ENABLED', false);
  const offset00DefaultRaw = parseNonNegativeInt(process.env.K80_ENROLL_003D_OFFSET00_DEFAULT, 0);
  const offset00Default = Number.isInteger(offset00DefaultRaw)
    ? Math.max(0, Math.min(offset00DefaultRaw, 0xff))
    : 0;
  return {
    guarded_26b_enabled: guardedEnabled === true,
    offset_00_default: offset00Default
  };
}

function resolveK80EnrollmentPostProgress05dfPolicy() {
  const guardedEnabled = envFlagEnabled('K80_ENROLL_POST_PROGRESS_05DF_GUARDED_ENABLED', false);
  return {
    guarded_enabled: guardedEnabled === true,
    guarded_payload_template: Buffer.from('0109000500000000000000', 'hex'),
    guarded_payload_version: 'guarded_non_empty_template_v1'
  };
}

function resolveK80EnrollmentPostProgressContinuationPolicy() {
  const guardedEnabled = envFlagEnabled('K80_ENROLL_POST_PROGRESS_CONTINUATION_GUARDED_ENABLED', false);
  const dynamic0058Enabled = envFlagEnabled('K80_ENROLL_CONTINUATION_0058_DYNAMIC_GUARDED_ENABLED', false);
  return {
    guarded_enabled: guardedEnabled === true,
    dynamic_0058_from_first_05dd_enabled: dynamic0058Enabled === true,
    continuation_command: COMMANDS.ZKTIME_ENROLL_RESULT_CONTINUE,
    continuation_payload_template: Buffer.from('080000', 'hex'),
    progression_ack_command: ACK.OK,
    guarded_payload_version: 'guarded_post_progress_continuation_v1'
  };
}

function resolveK80EnrollmentPre003ePrimingPolicy() {
  const guardedEnabled = envFlagEnabled('K80_ENROLL_PRE_003E_PRIMING_GUARDED_ENABLED', false);
  const parityGuardedEnabled = envFlagEnabled('K80_ENROLL_PRE_003E_PRIMING_PARITY_GUARDED_ENABLED', false);
  return {
    guarded_enabled: guardedEnabled === true,
    parity_guarded_enabled: parityGuardedEnabled === true
  };
}

function resolveK80EnrollmentPost2710ClosurePolicy() {
  const guardedEnabled = envFlagEnabled('K80_ENROLL_POST_2710_CLOSURE_GUARDED_ENABLED', false);
  return {
    guarded_enabled: guardedEnabled === true,
    mode: guardedEnabled === true
      ? 'guarded_post_2710_closure_v1'
      : 'legacy_no_closure'
  };
}

function resolveK80EnrollmentClosePairPolicy() {
  const guardedEnabled = envFlagEnabled('K80_ENROLL_CLOSE_PAIR_GUARDED_ENABLED', false);
  return {
    guarded_enabled: guardedEnabled === true,
    mode: guardedEnabled === true
      ? 'guarded_close_pair_v1'
      : 'disabled_or_ineligible'
  };
}

function resolveK80EnrollmentEarlyMarkerDebugPolicy() {
  const enabled = envFlagEnabled('K80_ENROLL_EARLY_MARKER_DEBUG_ENABLED', false);
  return {
    enabled: enabled === true,
    mode: enabled === true
      ? 'early_marker_txrx_trace_v1'
      : 'disabled_or_ineligible'
  };
}

function resolveK80EnrollmentPromptBoundaryLineagePolicy() {
  const guardedEnabled = envFlagEnabled('K80_ENROLL_PROMPT_BOUNDARY_LINEAGE_GUARDED_ENABLED', false);
  return {
    guarded_enabled: guardedEnabled === true,
    mode: guardedEnabled === true
      ? 'guarded_prompt_boundary_lineage_v1'
      : 'disabled_or_ineligible'
  };
}

function resolveK80EnrollmentPromptBoundarySessionHandoffPolicy() {
  const guardedEnabled = envFlagEnabled('K80_ENROLL_PROMPT_BOUNDARY_SESSION_HANDOFF_GUARDED_ENABLED', false);
  return {
    guarded_enabled: guardedEnabled === true,
    mode: guardedEnabled === true
      ? 'guarded_prompt_boundary_session_handoff_v1'
      : 'disabled_or_ineligible'
  };
}

function resolveK80EnrollmentV2Policy({ commandPayload, connection }) {
  const safePayload = isPlainObject(commandPayload) ? commandPayload : {};
  const safeConnection = isPlainObject(connection) ? connection : {};
  const guardedEnabled = envFlagEnabled('K80_ENROLL_V2_LADDER_ENABLED', false);
  const attlogSequence = normalizeAttlogSequenceMode(
    safeConnection.attlog_sequence,
    ATTLOG_SEQUENCE.OFF
  );
  const protocolProfile = normalizeText(safeConnection.protocol_profile).toLowerCase();
  const deviceModel = normalizeText(
    safeConnection.device_model
    || safeConnection.model
    || safePayload.device_model
  ).toLowerCase();
  const isK80Scope = (
    attlogSequence === ATTLOG_SEQUENCE.ZKTIME_K80
    || protocolProfile.includes('k80')
    || deviceModel.includes('k80')
  );
  return {
    guarded_enabled: guardedEnabled === true,
    is_k80_scope: isK80Scope,
    enabled: guardedEnabled === true && isK80Scope === true,
    mode: guardedEnabled === true
      ? (isK80Scope === true ? 'k80_enrollment_v2_ladder_enabled' : 'k80_enrollment_v2_ladder_k80_scope_miss')
      : 'disabled_or_ineligible'
  };
}

function isK80Post2710ExpectedResponseCommand(command) {
  return Number.isInteger(command) && (
    command === ACK.OK
    || command === COMMANDS.PREPARE_DATA
    || command === ACK.DATA
  );
}

function buildK80EnrollmentPre003ePrimingSteps({ policy }) {
  const safePolicy = policy && typeof policy === 'object'
    ? policy
    : resolveK80EnrollmentPre003ePrimingPolicy();
  if (safePolicy.parity_guarded_enabled === true) {
    return {
      mode: 'guarded_official_pre003e_parity_v2',
      steps: [
        {
          step_id: 'premode_000c_sdkbuild',
          command: COMMANDS.ZKTIME_PREMODE_000C,
          payload: Buffer.from('53444b4275696c643d3100', 'hex')
        },
        {
          step_id: 'startup_negotiation_01f5',
          command: COMMANDS.ZKTIME_STARTUP_NEGOTIATION,
          payload: Buffer.from(K80_STARTUP_NEGOTIATION_PAYLOAD_HEX, 'hex')
        },
        {
          step_id: 'options_rrq_zkfaceversion_pre044c',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('ZKFaceVersion\x00', 'ascii')
        },
        {
          step_id: 'premode_044c',
          command: COMMANDS.ZKTIME_PREMODE_044C,
          payload: Buffer.alloc(0)
        },
        {
          step_id: 'premode_0045',
          command: COMMANDS.ZKTIME_PREMODE_0045,
          payload: Buffer.from('20a0', 'hex')
        },
        {
          step_id: 'premode_2710',
          command: COMMANDS.ZKTIME_PREMODE_2710,
          payload: Buffer.alloc(0)
        },
        {
          step_id: 'options_rrq_mask_detection_funon',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('MaskDetectionFunOn\x00', 'ascii')
        },
        {
          step_id: 'options_rrq_irtemp_detection_funon',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('IRTempDetectionFunOn\x00', 'ascii')
        },
        {
          step_id: 'options_rrq_deviceid',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('DeviceID\x00', 'ascii')
        },
        {
          step_id: 'options_rrq_is_support_p2p',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('IsSupportP2P\x00', 'ascii')
        },
        {
          step_id: 'options_rrq_is_support_sfz',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('IsSupportSFZ\x00', 'ascii')
        },
        {
          step_id: 'options_rrq_sfz_funon',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('SFZFunOn\x00', 'ascii')
        },
        {
          step_id: 'options_rrq_visilight_fun',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('VisilightFun\x00', 'ascii')
        },
        {
          step_id: 'options_rrq_mask_detection_funon_repeat',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('MaskDetectionFunOn\x00', 'ascii')
        },
        {
          step_id: 'options_rrq_irtemp_detection_funon_repeat',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('IRTempDetectionFunOn\x00', 'ascii')
        },
        {
          step_id: 'rt_subscribe_ffff0000',
          command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
          payload: Buffer.from('ffff0000', 'hex')
        },
        {
          step_id: 'rt_subscribe_ff7f0000',
          command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
          payload: Buffer.from('ff7f0000', 'hex')
        }
      ]
    };
  }
  if (safePolicy.guarded_enabled !== true) {
    return {
      mode: 'disabled_or_ineligible',
      steps: []
    };
  }
  return {
    mode: 'guarded_official_pre003e_subset_v1',
    steps: [
      {
        step_id: 'premode_000c_sdkbuild',
        command: COMMANDS.ZKTIME_PREMODE_000C,
        payload: Buffer.from('53444b4275696c643d3100', 'hex')
      },
      {
        step_id: 'startup_negotiation_01f5',
        command: COMMANDS.ZKTIME_STARTUP_NEGOTIATION,
        payload: Buffer.from(K80_STARTUP_NEGOTIATION_PAYLOAD_HEX, 'hex')
      },
      {
        step_id: 'premode_044c',
        command: COMMANDS.ZKTIME_PREMODE_044C,
        payload: Buffer.alloc(0)
      },
      {
        step_id: 'premode_0045',
        command: COMMANDS.ZKTIME_PREMODE_0045,
        payload: Buffer.from('2080', 'hex')
      },
      {
        step_id: 'premode_2710',
        command: COMMANDS.ZKTIME_PREMODE_2710,
        payload: Buffer.alloc(0)
      },
      {
        step_id: 'options_rrq_zkfaceversion',
        command: COMMANDS.OPTIONS_RRQ,
        payload: Buffer.from('ZKFaceVersion\x00', 'ascii')
      },
      {
        step_id: 'options_rrq_deviceid',
        command: COMMANDS.OPTIONS_RRQ,
        payload: Buffer.from('DeviceID\x00', 'ascii')
      },
      {
        step_id: 'rt_subscribe_ffff0000',
        command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
        payload: Buffer.from('ffff0000', 'hex')
      },
      {
        step_id: 'rt_subscribe_ff7f0000',
        command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
        payload: Buffer.from('ff7f0000', 'hex')
      }
    ]
  };
}

function buildPostProgress05dfProbePlan({
  policy,
  enrollControlSessionIdFrom003dTx,
  enrollControlReplyIdFrom003dTx
}) {
  const safePolicy = policy && typeof policy === 'object'
    ? policy
    : resolveK80EnrollmentPostProgress05dfPolicy();
  if (
    safePolicy.guarded_enabled === true
    && Number.isInteger(enrollControlSessionIdFrom003dTx)
    && Number.isInteger(enrollControlReplyIdFrom003dTx)
  ) {
    const payload = Buffer.isBuffer(safePolicy.guarded_payload_template)
      ? Buffer.from(safePolicy.guarded_payload_template)
      : Buffer.from('0109000500000000000000', 'hex');
    return {
      mode: 'guarded_enroll_probe_v1',
      context_source: 'selection_tx_control_lineage',
      payload,
      session_id_sent: enrollControlSessionIdFrom003dTx,
      reply_id_sent: nextReplyId(enrollControlReplyIdFrom003dTx),
      session_source: 'selection_tx_session_id',
      reply_source: 'selection_tx_reply_id'
    };
  }
  return {
    mode: 'legacy_empty_probe',
    context_source: 'legacy_live_state',
    payload: Buffer.alloc(0),
    session_id_sent: null,
    reply_id_sent: null,
    session_source: 'legacy_live_state',
    reply_source: 'legacy_live_state'
  };
}

function buildPostProgressContinuationPlan({
  policy,
  enrollControlSessionIdFrom003dTx,
  first05ddReplyId,
  first05ddPayload,
  selectionOffset24From003dPayload,
  selectedFinger
}) {
  const safePolicy = policy && typeof policy === 'object'
    ? policy
    : resolveK80EnrollmentPostProgressContinuationPolicy();
  if (
    safePolicy.guarded_enabled === true
    && Number.isInteger(enrollControlSessionIdFrom003dTx)
    && Number.isInteger(first05ddReplyId)
  ) {
    const payloadTemplate = Buffer.isBuffer(safePolicy.continuation_payload_template)
      ? Buffer.from(safePolicy.continuation_payload_template)
      : Buffer.from('080000', 'hex');
    const payload = Buffer.from(payloadTemplate);
    let continuation0058Mode = 'legacy_static_template';
    let continuation0058Word0Source = 'not_parsed';
    let continuation0058Word0Value = null;
    let continuation0058Byte0Derived = Number.isInteger(payload[0]) ? payload[0] : null;
    const continuation0058Byte1Emitted = 0x00;
    let continuation0058Byte2Emitted = Number.isInteger(payload[2]) ? payload[2] : null;
    let continuation0058Byte2Source = 'legacy_template_byte2';

    if (safePolicy.dynamic_0058_from_first_05dd_enabled === true) {
      continuation0058Mode = 'dynamic_from_first_05dd_word0_guarded_v1';
      if (Buffer.isBuffer(first05ddPayload) && first05ddPayload.length >= 4) {
        continuation0058Word0Source = 'first_post_05df_05dd_word0_u32le';
        continuation0058Word0Value = first05ddPayload.readUInt32LE(0);
        if (continuation0058Word0Value > 0 && continuation0058Word0Value % 72 === 0) {
          continuation0058Byte0Derived = continuation0058Word0Value / 72;
        }
      }

      if (Number.isInteger(selectionOffset24From003dPayload)) {
        continuation0058Byte2Emitted = selectionOffset24From003dPayload & 0xff;
        continuation0058Byte2Source = 'selection_offset24_from_003d_payload';
      } else {
        continuation0058Byte2Emitted = mapSelectedFingerToK80Index(selectedFinger) & 0xff;
        continuation0058Byte2Source = 'selected_finger_mapping_fallback';
      }

      if (Number.isInteger(continuation0058Byte0Derived)) {
        payload.writeUInt8(continuation0058Byte0Derived & 0xff, 0);
      }
      payload.writeUInt8(continuation0058Byte1Emitted, 1);
      if (Number.isInteger(continuation0058Byte2Emitted)) {
        payload.writeUInt8(continuation0058Byte2Emitted & 0xff, 2);
      }
    }
    return {
      mode: 'guarded_post_progress_continuation_v1',
      session_id_sent: enrollControlSessionIdFrom003dTx,
      reply_id_sent: nextReplyId(first05ddReplyId),
      payload,
      context_source: 'selection_tx_control_lineage',
      session_source: 'selection_tx_session_id',
      reply_source: 'first_05dd_reply_id',
      continuation_0058_mode: continuation0058Mode,
      continuation_0058_word0_source: continuation0058Word0Source,
      continuation_0058_word0_value: Number.isInteger(continuation0058Word0Value)
        ? continuation0058Word0Value
        : null,
      continuation_0058_byte0_derived: Number.isInteger(continuation0058Byte0Derived)
        ? continuation0058Byte0Derived
        : null,
      continuation_0058_byte1_emitted: continuation0058Byte1Emitted,
      continuation_0058_byte2_emitted: Number.isInteger(continuation0058Byte2Emitted)
        ? continuation0058Byte2Emitted
        : null,
      continuation_0058_byte2_source: continuation0058Byte2Source,
      continuation_0058_payload_hex: bufferToHex(payload, 16),
      unresolved_0058_byte2_semantics_guarded: true
    };
  }
  return {
    mode: 'disabled_or_ineligible',
    session_id_sent: null,
    reply_id_sent: null,
    payload: Buffer.alloc(0),
    context_source: 'disabled_or_ineligible',
    session_source: 'disabled_or_ineligible',
    reply_source: 'disabled_or_ineligible',
    continuation_0058_mode: 'disabled_or_ineligible',
    continuation_0058_word0_source: 'disabled_or_ineligible',
    continuation_0058_word0_value: null,
    continuation_0058_byte0_derived: null,
    continuation_0058_byte1_emitted: null,
    continuation_0058_byte2_emitted: null,
    continuation_0058_byte2_source: 'disabled_or_ineligible',
    continuation_0058_payload_hex: null,
    unresolved_0058_byte2_semantics_guarded: true
  };
}

function buildConservativeEnrollmentSelectionPayload({
  deviceUserId,
  selectedFinger,
  payloadPolicy
}) {
  const safeDeviceUserId = Number.isInteger(deviceUserId) && deviceUserId >= 0 ? deviceUserId : 0;
  const fingerIndex = mapSelectedFingerToK80Index(selectedFinger);
  const guardedPolicy = payloadPolicy && typeof payloadPolicy === 'object'
    ? payloadPolicy
    : { guarded_26b_enabled: false, offset_00_default: 0 };

  if (guardedPolicy.guarded_26b_enabled === true) {
    const payload = Buffer.alloc(26, 0);
    const emittedOffset00 = Number.isInteger(guardedPolicy.offset_00_default)
      ? Math.max(0, Math.min(guardedPolicy.offset_00_default, 0xff))
      : 0;
    const emittedOffset01 = safeDeviceUserId & 0xff;
    const emittedOffset24 = fingerIndex & 0xff;
    payload.writeUInt8(emittedOffset00, 0);
    payload.writeUInt8(emittedOffset01, 1);
    payload.writeUInt8(emittedOffset24, 24);
    payload.writeUInt8(0x01, 25);
    return {
      payload,
      finger_index: fingerIndex,
      payload_basis: 'guarded_26b_v1_scaffold_offset00_unresolved',
      payload_version: 'guarded_26b_v1',
      payload_len: payload.length,
      selection_offset_00_emitted: emittedOffset00,
      selection_offset_01_emitted: emittedOffset01,
      selection_offset_24_emitted: emittedOffset24,
      unresolved_003d_offset_00: true
    };
  }

  const payload = Buffer.alloc(8, 0);
  payload.writeUInt32LE(safeDeviceUserId >>> 0, 0);
  payload.writeUInt16LE(fingerIndex, 4);
  payload.writeUInt16LE(0, 6);
  return {
    payload,
    finger_index: fingerIndex,
    payload_basis: 'conservative_placeholder_unresolved_003d_layout_v1',
    payload_version: 'legacy_8b_v1',
    payload_len: payload.length,
    selection_offset_00_emitted: payload.readUInt8(0),
    selection_offset_01_emitted: payload.readUInt8(1),
    selection_offset_24_emitted: null,
    unresolved_003d_offset_00: true
  };
}

async function fetchAttendanceBufferUdp({
  host,
  port,
  timeoutMs,
  authPassword,
  maxPackets,
  probeMode
}) {
  const socket = dgram.createSocket('udp4');
  let sessionId = 0;
  let replyId = USHRT_MAX - 1;
  const diagnostics = {
    protocol: {
      host,
      port,
      transport: TRANSPORT.UDP,
      connect_ack: null,
      auth_required: false,
      auth_attempted: false,
      auth_succeeded: false,
      attlog_ack: null,
      data_bytes: 0,
      data_packets: 0,
      parse_failures: 0
    },
    failure_reason: null,
    failure_stage: null
  };

  try {
    const connect = await sendUdpCommand({
      socket,
      ip: host,
      port,
      timeoutMs,
      command: COMMANDS.CONNECT,
      sessionId,
      replyId,
      payload: Buffer.alloc(0),
      noReplyError: FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY
    });
    if (!connect.ok || !connect.response) {
      diagnostics.failure_reason = connect.error || FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY;
      diagnostics.failure_stage = 'connect';
      return { ok: false, diagnostics };
    }

    diagnostics.protocol.connect_ack = connect.response.command;
    sessionId = connect.response.session_id;
    replyId = connect.response.reply_id;
    if (connect.response.command === ACK.UNAUTH) {
      diagnostics.protocol.auth_required = true;
    }
    if (connect.response.command !== ACK.OK && connect.response.command !== ACK.UNAUTH) {
      diagnostics.failure_reason = FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH;
      diagnostics.failure_stage = 'connect';
      return { ok: false, diagnostics };
    }

    if (connect.response.command === ACK.UNAUTH) {
      if (!Number.isInteger(authPassword)) {
        diagnostics.failure_reason = probeMode ? FAILURE_REASON.AUTH_STAGE_FAILED : 'auth_required';
        diagnostics.failure_stage = 'auth';
        return { ok: false, diagnostics };
      }
      diagnostics.protocol.auth_attempted = true;
      const auth = await sendUdpCommand({
        socket,
        ip: host,
        port,
        timeoutMs,
        command: COMMANDS.AUTH,
        sessionId,
        replyId,
        payload: makeCommKey(authPassword, sessionId),
        noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED
      });
      if (!auth.ok || !auth.response || auth.response.command !== ACK.OK) {
        diagnostics.failure_reason = auth.error === FAILURE_REASON.ACK_PARSE_FAILED
          ? FAILURE_REASON.ACK_PARSE_FAILED
          : FAILURE_REASON.AUTH_STAGE_FAILED;
        diagnostics.failure_stage = 'auth';
        return { ok: false, diagnostics };
      }
      diagnostics.protocol.auth_succeeded = true;
      replyId = auth.response.reply_id;
    }

    const attLogReply = await sendUdpCommand({
      socket,
      ip: host,
      port,
      timeoutMs,
      command: COMMANDS.ATTLOG_RRQ,
      sessionId,
      replyId,
      payload: Buffer.alloc(0),
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED
    });
    if (!attLogReply.ok || !attLogReply.response) {
      diagnostics.failure_reason = attLogReply.error === FAILURE_REASON.ACK_PARSE_FAILED
        ? FAILURE_REASON.ACK_PARSE_FAILED
        : FAILURE_REASON.ATTLOG_STAGE_FAILED;
      diagnostics.failure_stage = 'attlog';
      return { ok: false, diagnostics };
    }
    diagnostics.protocol.attlog_ack = attLogReply.response.command;
    replyId = attLogReply.response.reply_id;

    if (attLogReply.response.command === ACK.ERROR) {
      diagnostics.failure_reason = FAILURE_REASON.ATTLOG_STAGE_FAILED;
      diagnostics.failure_stage = 'attlog';
      return { ok: false, diagnostics };
    }

    let dataBuffer = Buffer.alloc(0);
    if (attLogReply.response.command === COMMANDS.PREPARE_DATA || attLogReply.response.command === ACK.DATA) {
      const expectedBytes = attLogReply.response.payload.length >= 4
        ? attLogReply.response.payload.readUInt32LE(0)
        : 0;
      const chunks = [];
      let packets = 0;
      let bytes = 0;
      while (packets < maxPackets && (expectedBytes <= 0 || bytes < expectedBytes)) {
        const dataReply = await receiveUdpResponse(socket, timeoutMs, host);
        if (!dataReply) {
          break;
        }
        const parsed = parsePacket(dataReply);
        if (!parsed) {
          diagnostics.protocol.parse_failures += 1;
          continue;
        }
        packets += 1;
        if (parsed.command === COMMANDS.DATA || parsed.command === ACK.DATA || parsed.command === ACK.OK) {
          if (parsed.payload.length > 0) {
            chunks.push(parsed.payload);
            bytes += parsed.payload.length;
          }
        }
        if (expectedBytes > 0 && bytes >= expectedBytes) {
          break;
        }
      }
      diagnostics.protocol.data_packets = packets;
      diagnostics.protocol.data_bytes = bytes;
      dataBuffer = Buffer.concat(chunks);

      try {
        replyId = nextReplyId(replyId);
        await sendUdpCommand({
          socket,
          ip: host,
          port,
          timeoutMs: Math.min(timeoutMs, 500),
          command: COMMANDS.FREE_DATA,
          sessionId,
          replyId,
          payload: Buffer.alloc(0)
        });
      } catch (err) {
        // no-op
      }
    } else if (attLogReply.response.command === ACK.OK && attLogReply.response.payload.length > 0) {
      dataBuffer = attLogReply.response.payload;
      diagnostics.protocol.data_bytes = attLogReply.response.payload.length;
      diagnostics.protocol.data_packets = 1;
    } else {
      diagnostics.failure_reason = FAILURE_REASON.ATTLOG_STAGE_FAILED;
      diagnostics.failure_stage = 'attlog';
      return { ok: false, diagnostics };
    }

    if (dataBuffer.length === 0) {
      diagnostics.failure_reason = probeMode ? FAILURE_REASON.ATTLOG_STAGE_FAILED : 'empty_data';
      diagnostics.failure_stage = 'data';
      return { ok: false, diagnostics };
    }

    return {
      ok: true,
      data: dataBuffer,
      diagnostics
    };
  } catch (err) {
    return {
      ok: false,
      diagnostics: {
        ...diagnostics,
        failure_reason: mapSocketErrorCode(err),
        failure_stage: diagnostics.failure_stage || 'socket'
      }
    };
  } finally {
    try {
      replyId = nextReplyId(replyId);
      await sendUdpCommand({
        socket,
        ip: host,
        port,
        timeoutMs: Math.min(timeoutMs, 500),
        command: COMMANDS.EXIT,
        sessionId,
        replyId,
        payload: Buffer.alloc(0)
      });
    } catch (err) {
      // ignore disconnect failures
    }
    socket.close();
  }
}

async function fetchAttendanceBufferTcp({
  host,
  port,
  timeoutMs,
  authPassword,
  maxPackets,
  deviceNumber,
  probeMode,
  attlogSequence,
  deviceUid,
  statusMap,
  vendor,
  ingestMethod,
  deviceTimezone,
  requestedSinceUtc,
  maxEvents,
  connectOnlyProbe,
  connectOnlyProbeHoldMs
}) {
  let sessionId = 0;
  let replyId = 0;
  const diagnostics = {
    protocol: {
      host,
      port,
      transport: TRANSPORT.TCP,
      wrapper_magic_hex: TCP_WRAPPER_MAGIC.toString('hex'),
      wrapper_profile: null,
      connect_profile_selected: null,
      connect_attempts: [],
      connect_frame_hex: null,
      connect_frame_wrapper: null,
      connect_frame_inner: null,
      preflight_enabled: false,
      preflight_profile: ATTLOG_SEQUENCE.OFF,
      preflight_steps: [],
      preflight_device_id: null,
      preflight_platform: null,
      preflight_version: null,
      preflight_device_status: null,
      zktime_sequence_enabled: false,
      zktime_sequence_steps: [],
      zktime_sequence_failure_step: null,
      zktime_sequence_data_received: false,
      zktime_sequence_data_payload_bytes: 0,
      zktime_sequence_data_payload_hex: null,
      zktime_pre_pull_pending_frames: [],
      zktime_pre_pull_pending_timeout: false,
      zktime_pre_pull_pending_fatal_error: null,
      zktime_pre_pull_state_adjusted: false,
      zktime_pre_pull_state_before: null,
      zktime_pre_pull_state_after: null,
      zktime_pre_pull_session_mismatch: null,
      zktime_pull_07d0_branch_enabled: false,
      zktime_pull_07d0_branch_entered: false,
      zktime_pull_request_07d0_continue_enabled: false,
      zktime_pull_request_07d0_continue_guard_entered: false,
      zktime_pull_request_07d0_continue_attempted: false,
      zktime_pull_request_07d0_continue_reached_non_empty_05dd: false,
      zktime_pull_request_actual_response_command: null,
      zktime_pull_request_actual_response_command_hex: null,
      zktime_pull_request_07d0_continue_blocker_classification: 'pull_request_07d0_guard_not_entered',
      zktime_dynamic_05e0_payload_enabled: false,
      zktime_dynamic_05e0_payload_entered: false,
      zktime_dynamic_05e0_payload_source_payload_hex: null,
      zktime_dynamic_05e0_payload_source_first_word_u32le: null,
      zktime_dynamic_05e0_payload_derived_word_u32le: null,
      zktime_dynamic_05e0_payload_sent_hex: null,
      zktime_dynamic_05e0_payload_app_parity_family_reached: false,
      zktime_dynamic_05e0_blocker_classification: 'insufficient_evidence',
      zktime_pull_07d0_followup_sent: false,
      zktime_pull_07d0_followup_request_hex: null,
      zktime_pull_07d0_followup_payload_hex: null,
      zktime_pull_07d0_followup_response_commands: [],
      zktime_pull_07d0_reached_05dc: false,
      zktime_pull_07d0_reached_05dd: false,
      zktime_pull_07d0_branch_outcome: null,
      zktime_pull_07d0_fallback_failure: false,
      zktime_pull_07d0_expected_bytes_hint: null,
      zktime_pull_07d0_expected_bytes_hint_source: null,
      zktime_pull_07d0_observed_payload_bytes: 0,
      zktime_pull_07d0_observed_05dd_payload_bytes: 0,
      zktime_pull_07d0_collected_payload_bytes: 0,
      zktime_pull_07d0_collected_payload_chunks: 0,
      zktime_pull_07d0_collected_payload_chunk_sizes: [],
      zktime_pull_07d0_payload_hex_truncated_detected: false,
      zktime_pull_07d0_payload_prefix_hex: null,
      zktime_pull_07d0_payload_suffix_hex: null,
      zktime_pull_07d0_likely_truncated: null,
      zktime_pull_07d0_continuation_frames_count: 0,
      zktime_pull_07d0_continuation_frame_sizes: [],
      zktime_pull_07d0_preparse_truncation_stage: null,
      zktime_pull_path: null,
      zktime_pull_direct_05dd_payload_bytes: 0,
      zktime_pull_direct_05dd_payload_prefix_hex: null,
      zktime_pull_direct_05dd_payload_suffix_hex: null,
      zktime_pull_parser_input_bytes: 0,
      zktime_pull_parser_input_prefix_hex: null,
      zktime_pull_parser_input_suffix_hex: null,
      connect_ack: null,
      auth_required: false,
      auth_attempted: false,
      auth_succeeded: false,
      attlog_ack: null,
      attlog_response_hex: null,
      attlog_response_payload_hex: null,
      attlog_prepare_data_received: false,
      attlog_expected_bytes: null,
      data_mode: null,
      data_first_packet_hex: null,
      data_first_payload_hex: null,
      data_bytes: 0,
      data_packets: 0,
      parse_failures: 0,
      data_inner_packet_parse_failures: 0,
      data_parse_failure_layer: null,
      data_framing_error: null,
      data_followup_timeout: false,
      device_number: Number.isInteger(deviceNumber) ? deviceNumber : null,
      zktime_ledger_refresh_enabled: false,
      zktime_ledger_refresh_executed: false,
      zktime_ledger_refresh_max_cycles: 1,
      zktime_ledger_refresh_interval_ms: 0,
      zktime_ledger_refresh_selected_cycle_index: 1,
      zktime_ledger_refresh_improved_over_cycle1: false,
      zktime_ledger_refresh_cycles_summary: [],
      zktime_free_data_enabled: false,
      zktime_free_data_executed: false,
      zktime_free_data_ok: null,
      zktime_free_data_response_command: null,
      zktime_session_context_hold_enabled: false,
      zktime_session_context_hold_executed: false,
      zktime_session_context_hold_window_ms: 0,
      zktime_session_context_hold_poll_ms: 0,
      zktime_session_context_hold_elapsed_ms: 0,
      zktime_session_context_hold_frames_seen: 0,
      zktime_session_context_hold_rt01f4_seen: false,
      zktime_session_context_hold_rt01f4_frames_count: 0,
      zktime_session_context_hold_rt01f4_first_event_local: null,
      zktime_session_context_hold_rt01f4_last_event_local: null,
      zktime_session_context_hold_error: null,
      zktime_session_context_hold_attlog_payload_bytes: 0,
      zktime_session_context_hold_attlog_parser_candidates: 0,
      zktime_session_context_hold_attlog_normalized_events_count: 0,
      zktime_session_context_hold_attlog_first_event_local: null,
      zktime_session_context_hold_attlog_last_event_local: null,
      zktime_rt_subscribe_enabled: false,
      zktime_rt_subscribe_executed: false,
      zktime_rt_subscribe_ok: null,
      zktime_rt_subscribe_response_command: null,
      zktime_startup_negotiation_enabled: false,
      zktime_startup_negotiation_executed: false,
      zktime_startup_negotiation_ok: null,
      zktime_startup_negotiation_response_command: null,
      zktime_premode_044c_enabled: false,
      zktime_premode_044c_executed: false,
      zktime_premode_044c_ok: null,
      zktime_premode_044c_response_command: null,
      zktime_premode_000c_enabled: false,
      zktime_premode_000c_executed: false,
      zktime_premode_000c_ok: null,
      zktime_premode_000c_response_command: null,
      zktime_premode_0045_enabled: false,
      zktime_premode_0045_executed: false,
      zktime_premode_0045_ok: null,
      zktime_premode_0045_response_command: null,
      zktime_premode_2710_enabled: false,
      zktime_premode_2710_executed: false,
      zktime_premode_2710_ok: null,
      zktime_premode_2710_response_command: null,
      zktime_premode_2710_special_handling_enabled: false,
      zktime_premode_2710_special_handling_entered: false,
      zktime_premode_2710_special_handling_trigger_command: null,
      zktime_premode_2710_special_handling_drained_frames: 0,
      zktime_premode_2710_special_handling_drained_bytes: 0,
      zktime_premode_2710_special_handling_free_data_sent: false,
      zktime_premode_2710_special_handling_free_data_ok: null,
      zktime_premode_2710_special_handling_ok: null,
      zktime_multipage_attlog_enabled: false,
      zktime_multipage_attlog_entered: false,
      zktime_multipage_attlog_pages_collected: 0,
      zktime_multipage_attlog_total_concatenated_bytes: 0,
      zktime_multipage_attlog_stop_reason: null,
      zktime_multipage_attlog_final_parser_input_source: 'single_page',
      zktime_app_parity_family_enabled: false,
      zktime_app_parity_family_entered: false,
      zktime_app_parity_family_restart_ok: null,
      zktime_app_parity_family_variant: 'baseline_k80_inline',
      zktime_app_parity_family_payload_bytes: 0,
      zktime_app_parity_family_merged_candidates: 0,
      zktime_app_parity_family_merged_min_event_time_utc: null,
      zktime_app_parity_family_merged_max_event_time_utc: null,
      zktime_app_parity_family_normalized_count: 0,
      zktime_app_parity_family_any_merged_after_stale_cutoff: false,
      zktime_app_parity_family_blocker_classification: 'insufficient_evidence',
      zktime_pre_retrieval_subfamily_enabled: false,
      zktime_pre_retrieval_subfamily_entered: false,
      zktime_pre_retrieval_subfamily_03eb_2c010000_ok: null,
      zktime_pre_retrieval_subfamily_0032_polls_executed: 0,
      zktime_pre_retrieval_subfamily_03ea_ok: null,
      zktime_pre_retrieval_subfamily_variant: 'baseline_k80_inline',
      zktime_pre_retrieval_subfamily_payload_bytes: 0,
      zktime_pre_retrieval_subfamily_merged_candidates: 0,
      zktime_pre_retrieval_subfamily_merged_min_event_time_utc: null,
      zktime_pre_retrieval_subfamily_merged_max_event_time_utc: null,
      zktime_pre_retrieval_subfamily_normalized_count: 0,
      zktime_pre_retrieval_subfamily_any_merged_after_stale_cutoff: false,
      zktime_pre_retrieval_subfamily_blocker_classification: 'insufficient_evidence',
      pre_attlog_enable_boundary_enabled: false,
      pre_attlog_enable_boundary_entered: false,
      pre_attlog_enable_boundary_sent: false,
      pre_attlog_enable_boundary_response_command: null,
      pre_attlog_enable_boundary_ok: null,
      selector_ab_enabled: false,
      selector_ab_entered: false,
      selector_a_payload_hex: null,
      selector_b_payload_hex: null,
      selector_a_attlog_payload_bytes: 0,
      selector_b_attlog_payload_bytes: 0,
      selector_a_parser_merged_candidates: 0,
      selector_b_parser_merged_candidates: 0,
      selector_a_events_count: 0,
      selector_b_events_count: 0,
      selector_a_earliest_event_time_utc: null,
      selector_a_latest_event_time_utc: null,
      selector_b_earliest_event_time_utc: null,
      selector_b_latest_event_time_utc: null,
      selector_ab_selected_variant: null,
      selector_ab_selection_reason: null,
      final_attlog_payload_bytes: 0,
      final_parser_merged_candidates: 0,
      final_events_count: 0,
      earliest_event_time_utc: null,
      latest_event_time_utc: null,
      final_path_variant: 'baseline_inline',
      zktime_connect_only_probe_enabled: false,
      zktime_connect_only_probe_executed: false,
      zktime_connect_only_probe_ok: null,
      zktime_connect_only_probe_elapsed_ms: 0,
      zktime_connect_only_probe_hold_ms: 0,
      zktime_connect_only_probe_cleanup_ok: null,
      zktime_connect_only_probe_error: null,
      zktime_connect_only_probe_attlog_skipped: false,
      zktime_connect_only_probe_rt01f4_seen: false,
      zktime_connect_only_probe_rt01f4_frames_count: 0,
      zktime_connect_only_probe_rt01f4_first_event_local: null,
      zktime_connect_only_probe_rt01f4_last_event_local: null,
      zktime_session_rt01f4_frames_count: 0,
      zktime_session_rt01f4_frames_sample: [],
      zktime_session_rt01f4_frames: [],
      pull_lifecycle_stage: null,
      pull_lifecycle_step: null
    },
    failure_reason: null,
    failure_stage: null,
    failure_step: null,
    raw_error_code: null,
    raw_error_message: null,
    last_command_sent: null,
    last_command_hex: null,
    last_response_command: null,
    last_response_command_hex: null,
    last_session_id: null,
    last_reply_id: null
  };

  let channel = createTcpChannel({ host, port, timeoutMs });
  const resolvedAttlogSequence = normalizeAttlogSequenceMode(
    attlogSequence,
    probeMode ? ATTLOG_SEQUENCE.DEVICEID_PLATFORM : ATTLOG_SEQUENCE.OFF
  );
  const k80FollowupPolicy = resolveK8007d0FollowupPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80LedgerRefreshPolicy = resolveK80LedgerRefreshPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80FreeDataPolicy = resolveK80FreeDataPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80SessionContextHoldPolicy = resolveK80SessionContextHoldPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80RtSubscribePolicy = resolveK80RtSubscribePolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80StartupNegotiationPolicy = resolveK80StartupNegotiationPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80Premode044cPolicy = resolveK80Premode044cPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80PreAttlogModeEntryPolicy = resolveK80PreAttlogModeEntryPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80Premode2710SpecialHandlingPolicy = resolveK80Premode2710SpecialHandlingPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80PreAttlogEnableBoundaryPolicy = resolveK80PreAttlogEnableBoundaryPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80PreSizeSelectorAbPolicy = resolveK80PreSizeSelectorAbPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80MultipageAttlogPolicy = resolveK80MultipageAttlogPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80AppParityRestartPolicy = resolveK80AppParityRestartPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80PreRetrievalSubfamilyPolicy = resolveK80PreRetrievalSubfamilyPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80Dynamic05e0PayloadPolicy = resolveK80Dynamic05e0PayloadPolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid
  });
  const k80PullRequest07d0ContinuePolicy = resolveK80PullRequest07d0ContinuePolicy({
    attlogSequence: resolvedAttlogSequence,
    transport: TRANSPORT.TCP,
    deviceUid,
    dynamic05e0Enabled: k80Dynamic05e0PayloadPolicy.enabled
  });
  const k80RtIngestPolicy = resolveK80Rt01f4IngestPolicy({
    vendor,
    deviceUid,
    attlogSequence: resolvedAttlogSequence
  });
  const connectOnlyProbeEnabled = connectOnlyProbe === true;
  const connectOnlyProbeHoldWindowMs = connectOnlyProbeEnabled
    ? Math.max(0, Math.min(parsePositiveInt(connectOnlyProbeHoldMs, 0) || 0, 60000))
    : 0;
  const k80RtSessionTapEnabled = k80RtIngestPolicy.enabled
    || k80SessionContextHoldPolicy.enabled
    || connectOnlyProbeEnabled;
  const k80RtSessionFrameLimit = Math.max(32, Math.min(maxPackets + 64, 4096));
  const k80RtSessionSampleLimit = 8;

  function tapK80SessionRt01f4Frame(frame, traceMeta = null) {
    if (!k80RtSessionTapEnabled) {
      return;
    }
    if (!frame || !Buffer.isBuffer(frame.payload) || frame.payload.length === 0) {
      return;
    }
    const parsed = parsePacket(frame.payload);
    if (!parsed || Number(parsed.command) !== 0x01f4) {
      return;
    }
    const payloadHex = bufferToHex(parsed.payload).toLowerCase();
    if (!payloadHex || payloadHex.length % 2 !== 0) {
      return;
    }
    diagnostics.protocol.zktime_session_rt01f4_frames_count += 1;
    const frameEntry = {
      parse_ok: true,
      command: parsed.command,
      command_hex: commandToHex(parsed.command),
      session_id: Number.isInteger(parsed.session_id) ? parsed.session_id : null,
      reply_id: Number.isInteger(parsed.reply_id) ? parsed.reply_id : null,
      payload_bytes: parsed.payload.length,
      payload_hex: payloadHex,
      source: normalizeText(traceMeta && traceMeta.source) || null,
      source_step: normalizeText(traceMeta && traceMeta.step) || null
    };
    if (diagnostics.protocol.zktime_session_rt01f4_frames.length < k80RtSessionFrameLimit) {
      diagnostics.protocol.zktime_session_rt01f4_frames.push(frameEntry);
    }
    if (diagnostics.protocol.zktime_session_rt01f4_frames_sample.length < k80RtSessionSampleLimit) {
      const decoded = decodeK80RtObservationFromFramePayload(payloadHex);
      diagnostics.protocol.zktime_session_rt01f4_frames_sample.push({
        command_hex: frameEntry.command_hex,
        payload_bytes: frameEntry.payload_bytes,
        payload_prefix_hex: payloadHex.slice(0, 64),
        source: frameEntry.source,
        source_step: frameEntry.source_step,
        state_code: decoded ? decoded.stateCode : null,
        event_time_local: decoded ? decoded.eventTimeLocal : null
      });
    }
  }

  function setLifecycleStage(stage, step = null) {
    diagnostics.protocol.pull_lifecycle_stage = normalizeText(stage) || null;
    diagnostics.protocol.pull_lifecycle_step = normalizeText(step) || null;
  }

  function recordRawError(error) {
    const rawCode = extractRawErrorCode(error);
    const rawMessage = extractRawErrorMessage(error);
    if (normalizeText(rawCode)) {
      diagnostics.raw_error_code = rawCode;
    }
    if (normalizeText(rawMessage)) {
      diagnostics.raw_error_message = rawMessage;
    }
  }

  function failWithContext({
    failureStage,
    failureReason,
    failureStep = null,
    lifecycleStage = null,
    error = null
  }) {
    if (normalizeText(lifecycleStage) || normalizeText(failureStage)) {
      setLifecycleStage(lifecycleStage || failureStage, failureStep);
    }
    if (normalizeText(failureReason)) {
      diagnostics.failure_reason = failureReason;
    }
    if (normalizeText(failureStage)) {
      diagnostics.failure_stage = failureStage;
    }
    if (normalizeText(failureStep)) {
      diagnostics.failure_step = failureStep;
    } else if (!normalizeText(diagnostics.failure_step)) {
      diagnostics.failure_step = normalizeText(diagnostics.protocol.zktime_sequence_failure_step) || null;
    }
    if (error) {
      recordRawError(error);
    }
    diagnostics.last_session_id = Number.isInteger(sessionId) ? sessionId : diagnostics.last_session_id;
    diagnostics.last_reply_id = Number.isInteger(replyId) ? replyId : diagnostics.last_reply_id;
    return {
      ok: false,
      diagnostics: ensureFailureDiagnosticsShape(diagnostics, {
        fallbackStage: failureStage,
        fallbackReason: failureReason,
        failureStep,
        error
      })
    };
  }

  async function receiveFrameWithSessionTap(receiveTimeoutMs, source) {
    const frame = await channel.receiveFrame(receiveTimeoutMs);
    tapK80SessionRt01f4Frame(frame, { source });
    return frame;
  }

  async function sendTcpCommandWithSessionTap(args) {
    diagnostics.last_command_sent = Number.isInteger(args.command) ? args.command : null;
    diagnostics.last_command_hex = commandToHex(args.command);
    diagnostics.last_session_id = Number.isInteger(args.sessionId)
      ? args.sessionId
      : diagnostics.last_session_id;
    diagnostics.last_reply_id = Number.isInteger(args.replyId)
      ? args.replyId
      : diagnostics.last_reply_id;

    const result = await sendTcpCommand({
      ...args,
      onFrameReceived: tapK80SessionRt01f4Frame
    });

    if (!result.ok) {
      recordRawError(result.error || (args.trace ? args.trace.error : null));
      return result;
    }

    if (result.response) {
      diagnostics.last_response_command = Number.isInteger(result.response.command)
        ? result.response.command
        : null;
      diagnostics.last_response_command_hex = commandToHex(result.response.command);
      diagnostics.last_session_id = Number.isInteger(result.response.session_id)
        ? result.response.session_id
        : diagnostics.last_session_id;
      diagnostics.last_reply_id = Number.isInteger(result.response.reply_id)
        ? result.response.reply_id
        : diagnostics.last_reply_id;
    }

    return result;
  }

  diagnostics.protocol.zktime_pull_07d0_branch_enabled = k80FollowupPolicy.enabled;
  diagnostics.protocol.k80_pull_07d0_policy_flag_enabled = k80FollowupPolicy.flag_enabled === true;
  diagnostics.protocol.k80_pull_07d0_policy_allowlist_applied = k80FollowupPolicy.allowlist_applied === true;
  diagnostics.protocol.k80_pull_07d0_policy_scope_allowed = k80FollowupPolicy.scope_allowed === true;
  diagnostics.protocol.zktime_pull_request_07d0_continue_enabled =
    k80PullRequest07d0ContinuePolicy.enabled;
  diagnostics.protocol.k80_pull_request_07d0_continue_policy_flag_enabled =
    k80PullRequest07d0ContinuePolicy.flag_enabled === true;
  diagnostics.protocol.k80_pull_request_07d0_continue_policy_allowlist_applied =
    k80PullRequest07d0ContinuePolicy.allowlist_applied === true;
  diagnostics.protocol.k80_pull_request_07d0_continue_policy_scope_allowed =
    k80PullRequest07d0ContinuePolicy.scope_allowed === true;
  diagnostics.protocol.zktime_dynamic_05e0_payload_enabled = k80Dynamic05e0PayloadPolicy.enabled;
  diagnostics.protocol.k80_dynamic_05e0_policy_flag_enabled = k80Dynamic05e0PayloadPolicy.flag_enabled === true;
  diagnostics.protocol.k80_dynamic_05e0_policy_allowlist_applied =
    k80Dynamic05e0PayloadPolicy.allowlist_applied === true;
  diagnostics.protocol.k80_dynamic_05e0_policy_scope_allowed = k80Dynamic05e0PayloadPolicy.scope_allowed === true;
  diagnostics.protocol.zktime_ledger_refresh_enabled = k80LedgerRefreshPolicy.enabled;
  diagnostics.protocol.zktime_ledger_refresh_max_cycles = k80LedgerRefreshPolicy.max_cycles;
  diagnostics.protocol.zktime_ledger_refresh_interval_ms = k80LedgerRefreshPolicy.interval_ms;
  diagnostics.protocol.zktime_free_data_enabled = k80FreeDataPolicy.enabled;
  diagnostics.protocol.zktime_session_context_hold_enabled = k80SessionContextHoldPolicy.enabled;
  diagnostics.protocol.zktime_session_context_hold_window_ms = k80SessionContextHoldPolicy.window_ms;
  diagnostics.protocol.zktime_session_context_hold_poll_ms = k80SessionContextHoldPolicy.poll_ms;
  diagnostics.protocol.zktime_rt_subscribe_enabled = k80RtSubscribePolicy.enabled;
  diagnostics.protocol.zktime_startup_negotiation_enabled = k80StartupNegotiationPolicy.enabled;
  diagnostics.protocol.zktime_premode_044c_enabled = k80Premode044cPolicy.enabled;
  diagnostics.protocol.zktime_premode_000c_enabled = k80PreAttlogModeEntryPolicy.enabled;
  diagnostics.protocol.zktime_premode_0045_enabled = k80PreAttlogModeEntryPolicy.enabled;
  diagnostics.protocol.zktime_premode_2710_enabled = k80PreAttlogModeEntryPolicy.enabled;
  diagnostics.protocol.zktime_premode_2710_special_handling_enabled =
    k80Premode2710SpecialHandlingPolicy.enabled;
  diagnostics.protocol.pre_attlog_enable_boundary_enabled = k80PreAttlogEnableBoundaryPolicy.enabled;
  diagnostics.protocol.selector_ab_enabled = k80PreSizeSelectorAbPolicy.enabled;
  diagnostics.protocol.selector_a_payload_hex = '10270000';
  diagnostics.protocol.selector_b_payload_hex = k80PreSizeSelectorAbPolicy.selector_b_payload_hex;
  diagnostics.protocol.zktime_multipage_attlog_enabled = k80MultipageAttlogPolicy.enabled;
  diagnostics.protocol.zktime_app_parity_family_enabled = k80AppParityRestartPolicy.enabled;
  diagnostics.protocol.zktime_pre_retrieval_subfamily_enabled = k80PreRetrievalSubfamilyPolicy.enabled;
  diagnostics.protocol.zktime_connect_only_probe_enabled = connectOnlyProbeEnabled;
  diagnostics.protocol.zktime_connect_only_probe_hold_ms = connectOnlyProbeHoldWindowMs;

  const diagnosticsStatusMap = isPlainObject(statusMap) ? statusMap : {};
  const diagnosticsVendor = normalizeText(vendor).toLowerCase() || 'zkteco';
  const diagnosticsIngestMethod = normalizeText(ingestMethod) || 'agent_pull';
  const diagnosticsDeviceTimezone = normalizeText(deviceTimezone) || 'Africa/Tunis';
  const diagnosticsRequestedSinceUtc = normalizeText(requestedSinceUtc) || null;
  const diagnosticsMaxEvents = Number.isInteger(maxEvents) ? maxEvents : 500;
  let premode2710DrainedPayload = Buffer.alloc(0);

  function summarizeCyclePayload(payload) {
    if (!Buffer.isBuffer(payload) || payload.length === 0) {
      return {
        payload_bytes: 0,
        parser_candidates: 0,
        normalized_events_count: 0,
        first_event_local: null,
        last_event_local: null,
        normalized_event_keys: []
      };
    }
    const textEvents = parseTextAttendanceBuffer(payload, diagnosticsStatusMap);
    const binaryParse = parseBinaryAttendanceWithDiagnostics(payload, diagnosticsStatusMap);
    const binaryEvents = Array.isArray(binaryParse.events) ? binaryParse.events : [];
    const merged = dedupeParsedEvents([...textEvents, ...binaryEvents]);
    const normalized = normalizePulledEvents({
      rawEvents: merged,
      deviceUid,
      vendor: diagnosticsVendor,
      ingestMethod: diagnosticsIngestMethod,
      deviceTimezone: diagnosticsDeviceTimezone,
      requestedSinceUtc: diagnosticsRequestedSinceUtc,
      maxEvents: diagnosticsMaxEvents,
      k80RtEnrichment: null,
      attlogSequence: resolvedAttlogSequence,
      historyMode: null,
      historyBeforeUtc: null,
      historyBeforeDedupKey: null
    });
    const normalizedEvents = Array.isArray(normalized.events) ? normalized.events : [];
    const normalizedEventKeys = normalizedEvents.map(event => [
      normalizeText(String(event.device_person_id ?? '')),
      normalizeText(String(event.event_time_local ?? '')),
      normalizeText(String(event.direction ?? ''))
    ].join('|'));
    return {
      payload_bytes: payload.length,
      parser_candidates: merged.length,
      normalized_events_count: normalizedEvents.length,
      first_event_local: normalizedEvents.length > 0 ? normalizedEvents[0].event_time_local : null,
      last_event_local: normalizedEvents.length > 0
        ? normalizedEvents[normalizedEvents.length - 1].event_time_local
        : null,
      normalized_event_keys: normalizedEventKeys,
      normalized_events: normalizedEvents,
      earliest_event_time_utc: normalizedEvents.length > 0 ? normalizedEvents[0].event_time_utc : null,
      latest_event_time_utc: normalizedEvents.length > 0
        ? normalizedEvents[normalizedEvents.length - 1].event_time_utc
        : null
    };
  }

  try {
    setLifecycleStage('connect');
    try {
      await channel.connect();
    } catch (err) {
      return failWithContext({
        failureStage: 'socket_connect',
        failureReason: mapSocketErrorCode(err),
        failureStep: 'connect',
        lifecycleStage: 'connect',
        error: err
      });
    }

    const connectProfiles = [
      {
        id: 'tcp_u32le_payload_reply_0000_official',
        reply_id: 0,
        tcp_profile: { length_mode: 'payload' }
      },
      {
        id: 'tcp_u32le_total_reply_0000',
        reply_id: 0,
        tcp_profile: { length_mode: 'total' }
      },
      {
        id: 'tcp_u32le_payload_reply_ffff_legacy',
        reply_id: USHRT_MAX,
        tcp_profile: { length_mode: 'payload' }
      }
    ];

    let connect = null;
    let connectError = FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY;
    for (const profile of connectProfiles) {
      const trace = { profile_id: profile.id };
      const attempt = await sendTcpCommandWithSessionTap({
        channel,
        timeoutMs,
        command: COMMANDS.CONNECT,
        sessionId,
        replyId: profile.reply_id,
        payload: Buffer.alloc(0),
        noReplyError: FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY,
        deviceNumber,
        tcpProfile: profile.tcp_profile,
        trace
      });
      const attemptDiag = {
        profile_id: profile.id,
        tx: trace.tx || null,
        response: trace.response || null,
        error: trace.error || (attempt.ok ? null : (attempt.error || FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY))
      };
      diagnostics.protocol.connect_attempts.push(attemptDiag);
      if (!diagnostics.protocol.connect_frame_hex && attemptDiag.tx) {
        diagnostics.protocol.connect_frame_hex = attemptDiag.tx.frame_hex || null;
        diagnostics.protocol.connect_frame_wrapper = attemptDiag.tx.wrapper || null;
        diagnostics.protocol.connect_frame_inner = attemptDiag.tx.inner || null;
      }
      if (attempt.ok && attempt.response) {
        connect = attempt;
        diagnostics.protocol.connect_profile_selected = profile.id;
        break;
      }
      connectError = attempt.error || connectError;
    }

    if (!connect || !connect.ok || !connect.response) {
      return failWithContext({
        failureStage: 'connect',
        failureReason: connectError,
        failureStep: 'connect',
        lifecycleStage: 'connect',
        error: connect && connect.error ? connect.error : connectError
      });
    }

    diagnostics.protocol.wrapper_profile = connect.wrapper || diagnostics.protocol.wrapper_profile;
    diagnostics.protocol.connect_ack = connect.response.command;
    sessionId = connect.response.session_id;
    replyId = connect.response.reply_id;
    if (connect.response.command === ACK.UNAUTH) {
      diagnostics.protocol.auth_required = true;
    }
    if (connect.response.command !== ACK.OK && connect.response.command !== ACK.UNAUTH) {
      return failWithContext({
        failureStage: 'connect',
        failureReason: FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH,
        failureStep: 'connect',
        lifecycleStage: 'connect'
      });
    }

    if (connect.response.command === ACK.UNAUTH) {
      setLifecycleStage('auth');
      if (!Number.isInteger(authPassword)) {
        return failWithContext({
          failureStage: 'auth',
          failureReason: probeMode ? FAILURE_REASON.AUTH_STAGE_FAILED : 'auth_required',
          failureStep: 'auth',
          lifecycleStage: 'auth'
        });
      }
      diagnostics.protocol.auth_attempted = true;
      const auth = await sendTcpCommandWithSessionTap({
        channel,
        timeoutMs,
        command: COMMANDS.AUTH,
        sessionId,
        replyId,
        payload: makeCommKey(authPassword, sessionId),
        noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED,
        deviceNumber
      });
      if (!auth.ok || !auth.response || auth.response.command !== ACK.OK) {
        return failWithContext({
          failureStage: 'auth',
          failureReason: auth.error === FAILURE_REASON.ACK_PARSE_FAILED
            ? FAILURE_REASON.ACK_PARSE_FAILED
            : FAILURE_REASON.AUTH_STAGE_FAILED,
          failureStep: 'auth',
          lifecycleStage: 'auth',
          error: auth.error
        });
      }
      diagnostics.protocol.wrapper_profile = auth.wrapper || diagnostics.protocol.wrapper_profile;
      diagnostics.protocol.auth_succeeded = true;
      replyId = auth.response.reply_id;
    }

    async function runAppParityRestartBeforeAttlog() {
      diagnostics.protocol.zktime_app_parity_family_entered = true;
      diagnostics.protocol.zktime_app_parity_family_variant = 'app_reconnect_before_attlog';
      const preferredProfileId = normalizeText(diagnostics.protocol.connect_profile_selected);
      const preferredProfile = connectProfiles.find(profile => normalizeText(profile.id) === preferredProfileId)
        || connectProfiles[0];
      const trialChannel = createTcpChannel({ host, port, timeoutMs });
      let trialSessionId = 0;
      let trialReplyId = preferredProfile && Number.isInteger(preferredProfile.reply_id)
        ? preferredProfile.reply_id
        : 0;

      const sendTrial = async ({
        command,
        payload = Buffer.alloc(0),
        expectedResponseCommand = null,
        noReplyError = FAILURE_REASON.ATTLOG_STAGE_FAILED,
        tcpProfile = null
      }) => {
        const result = await sendTcpCommand({
          channel: trialChannel,
          timeoutMs,
          command,
          sessionId: trialSessionId,
          replyId: trialReplyId,
          payload,
          noReplyError,
          deviceNumber,
          tcpProfile,
          onFrameReceived: tapK80SessionRt01f4Frame
        });
        if (!result.ok || !result.response) {
          return { ok: false, error: result.error || noReplyError };
        }
        trialSessionId = result.response.session_id;
        trialReplyId = result.response.reply_id;
        if (Number.isInteger(expectedResponseCommand)
          && result.response.command !== expectedResponseCommand) {
          return { ok: false, error: 'unexpected_response_command' };
        }
        return { ok: true, response: result.response };
      };

      try {
        await trialChannel.connect();
        const connectResult = await sendTrial({
          command: COMMANDS.CONNECT,
          payload: Buffer.alloc(0),
          expectedResponseCommand: null,
          noReplyError: FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY,
          tcpProfile: preferredProfile ? preferredProfile.tcp_profile : null
        });
        if (!connectResult.ok || !connectResult.response) {
          trialChannel.close();
          return { ok: false, reason: 'family_failed' };
        }
        const connectCommand = connectResult.response.command;
        if (connectCommand === ACK.UNAUTH) {
          if (!Number.isInteger(authPassword)) {
            trialChannel.close();
            return { ok: false, reason: 'family_failed' };
          }
          const authResult = await sendTrial({
            command: COMMANDS.AUTH,
            payload: makeCommKey(authPassword, trialSessionId),
            expectedResponseCommand: ACK.OK,
            noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED
          });
          if (!authResult.ok) {
            trialChannel.close();
            return { ok: false, reason: 'family_failed' };
          }
        } else if (connectCommand !== ACK.OK) {
          trialChannel.close();
          return { ok: false, reason: 'family_failed' };
        } else if (Number.isInteger(authPassword)) {
          await sendTrial({
            command: COMMANDS.AUTH,
            payload: makeCommKey(authPassword, trialSessionId),
            expectedResponseCommand: ACK.OK,
            noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED
          });
        }

        const deviceIdResult = await sendTrial({
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('DeviceID\x00', 'ascii'),
          expectedResponseCommand: ACK.OK
        });
        if (!deviceIdResult.ok) {
          trialChannel.close();
          return { ok: false, reason: 'family_failed' };
        }
        const statusProbeResult = await sendTrial({
          command: COMMANDS.ZKTIME_STATUS_PROBE,
          payload: Buffer.alloc(0),
          expectedResponseCommand: ACK.OK
        });
        if (!statusProbeResult.ok) {
          trialChannel.close();
          return { ok: false, reason: 'family_failed' };
        }

        try {
          channel.close();
        } catch (err) {
          // ignore close failure
        }
        channel = trialChannel;
        sessionId = trialSessionId;
        replyId = trialReplyId;
        diagnostics.protocol.zktime_app_parity_family_restart_ok = true;
        return { ok: true };
      } catch (err) {
        trialChannel.close();
        return { ok: false, reason: 'family_failed' };
      }
    }

    async function runPreRetrievalSubfamilyBlock() {
      diagnostics.protocol.zktime_pre_retrieval_subfamily_entered = true;
      diagnostics.protocol.zktime_pre_retrieval_subfamily_variant = 'pre_retrieval_subfamily_before_attlog';

      const preRetrievalPreSize = await runZkTimeK80Step({
        stepId: 'pre_retrieval_pre_size_query',
        command: COMMANDS.ZKTIME_PRE_SIZE_QUERY,
        payload: Buffer.from('2c010000', 'hex'),
        expectedResponseCommand: ACK.OK,
        required: false
      });
      const preSizeOk = preRetrievalPreSize.ok === true;
      diagnostics.protocol.zktime_pre_retrieval_subfamily_03eb_2c010000_ok = preSizeOk;

      let pollsExecuted = 0;
      if (preSizeOk) {
        for (let pollIndex = 0; pollIndex < k80PreRetrievalSubfamilyPolicy.max_0032_polls; pollIndex += 1) {
          const pollStep = await runZkTimeK80Step({
            stepId: `pre_retrieval_size_query_poll_${pollIndex + 1}`,
            command: COMMANDS.ZKTIME_SIZE_QUERY,
            payload: Buffer.alloc(0),
            expectedResponseCommand: ACK.OK,
            required: false
          });
          if (!pollStep.ok) {
            break;
          }
          pollsExecuted += 1;
          if (k80PreRetrievalSubfamilyPolicy.poll_interval_ms > 0
            && pollIndex < (k80PreRetrievalSubfamilyPolicy.max_0032_polls - 1)) {
            await new Promise(resolve => setTimeout(resolve, k80PreRetrievalSubfamilyPolicy.poll_interval_ms));
          }
        }
      }
      diagnostics.protocol.zktime_pre_retrieval_subfamily_0032_polls_executed = pollsExecuted;

      const preRetrievalBoundary = await runZkTimeK80Step({
        stepId: 'pre_retrieval_boundary_03ea',
        command: COMMANDS.ZKTIME_CLEANUP,
        payload: Buffer.alloc(0),
        expectedResponseCommand: ACK.OK,
        required: false
      });
      diagnostics.protocol.zktime_pre_retrieval_subfamily_03ea_ok = preRetrievalBoundary.ok === true;
    }

    async function runAttlogPreflightStep({ stepId, command, payload, valueField }) {
      setLifecycleStage('pre_sequence', stepId);
      const trace = { stage: 'preflight', step: stepId };
      const response = await sendTcpCommandWithSessionTap({
        channel,
        timeoutMs,
        command,
        sessionId,
        replyId,
        payload: Buffer.isBuffer(payload) ? payload : Buffer.alloc(0),
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
        deviceNumber,
        trace
      });

      const ackCode = response && response.response ? response.response.command : null;
      const ackOk = ackCode === ACK.OK;
      const parsedValue = response && response.response
        ? parseOptionValue(response.response.payload)
        : '';

      diagnostics.protocol.preflight_steps.push({
        step: stepId,
        command,
        request_payload_hex: bufferToHex(payload || Buffer.alloc(0)),
        ok: response.ok === true && ackOk,
        ack_code: Number.isInteger(ackCode) ? ackCode : null,
        error: trace.error || (response.ok ? null : (response.error || FAILURE_REASON.ATTLOG_STAGE_FAILED)),
        response_hex: trace.response ? trace.response.inner_packet_hex : null,
        response_payload_hex: trace.response ? trace.response.payload_hex : null,
        value: parsedValue || null
      });

      if (response && response.response) {
        replyId = response.response.reply_id;
      }
      if (valueField && parsedValue) {
        diagnostics.protocol[valueField] = parsedValue;
      }
    }

    async function collectK80PullFollowupFrames() {
      const followupFrames = [];
      const chunks = [];
      const rawPayloadChunks = [];
      const maxFollowupFrames = Math.max(1, Math.min(maxPackets, 16));
      const followupTimeoutMs = Math.min(Math.max(timeoutMs, 600), 2500);
      let expectedBytes = null;
      let timeoutHit = false;
      let fatalError = null;
      let collectedBytes = 0;

      for (let index = 0; index < maxFollowupFrames; index += 1) {
        let frame;
        try {
          frame = await receiveFrameWithSessionTap(followupTimeoutMs, 'k80_pull_followup');
        } catch (err) {
          const code = err && err.code ? String(err.code) : '';
          if (code === 'REPLY_TIMEOUT') {
            timeoutHit = true;
            break;
          }
          fatalError = code || FAILURE_REASON.ATTLOG_STAGE_FAILED;
          break;
        }

        const parsed = parsePacket(frame.payload);
        const frameDiagnostic = {
          index,
          parse_ok: parsed !== null,
          inner_hex: bufferToHex(frame.payload),
          wrapper_payload_bytes: frame && frame.wrapper && Number.isInteger(frame.wrapper.payload_bytes)
            ? frame.wrapper.payload_bytes
            : null,
          wrapper_total_bytes: frame && frame.wrapper && Number.isInteger(frame.wrapper.total_bytes)
            ? frame.wrapper.total_bytes
            : null
        };

        if (!parsed) {
          frameDiagnostic.error = FAILURE_REASON.ACK_PARSE_FAILED;
          followupFrames.push(frameDiagnostic);
          continue;
        }

        frameDiagnostic.command = parsed.command;
        frameDiagnostic.command_hex = commandToHex(parsed.command);
        frameDiagnostic.checksum = parsed.checksum;
        frameDiagnostic.session_id = parsed.session_id;
        frameDiagnostic.reply_id = parsed.reply_id;
        frameDiagnostic.payload_bytes = parsed.payload.length;
        frameDiagnostic.payload_hex = bufferToHex(parsed.payload);
        frameDiagnostic.is_prepare_or_data_marker = parsed.command === COMMANDS.PREPARE_DATA
          || parsed.command === COMMANDS.DATA
          || parsed.command === ACK.DATA
          || parsed.command === COMMANDS.ZKTIME_PULL_RESPONSE;

        if (parsed.command === COMMANDS.PREPARE_DATA || parsed.command === ACK.DATA) {
          if (parsed.payload.length >= 4) {
            expectedBytes = parsed.payload.readUInt32LE(0);
            frameDiagnostic.prepare_expected_bytes = expectedBytes;
          }
        }

        if (parsed.payload.length > 0 && (
          parsed.command === COMMANDS.ZKTIME_PULL_RESPONSE
          || parsed.command === COMMANDS.DATA
          || parsed.command === ACK.DATA
          || parsed.command === ACK.OK
        )) {
          chunks.push(parsed.payload);
          collectedBytes += parsed.payload.length;
        }

        if (parsed.command === COMMANDS.ZKTIME_PULL_RESPONSE && parsed.payload.length > 0) {
          rawPayloadChunks.push({
            frame_index: index,
            command: parsed.command,
            payload: parsed.payload
          });
        }

        followupFrames.push(frameDiagnostic);

        if (Number.isInteger(expectedBytes) && expectedBytes > 0 && collectedBytes >= expectedBytes) {
          break;
        }
      }

      return {
        frames: followupFrames,
        data: Buffer.concat(chunks),
        rawPayloadChunks,
        expectedBytes,
        timeoutHit,
        fatalError
      };
    }

    async function collectK80PrePullPendingFrames() {
      const frames = [];
      const rawPayloadChunks = [];
      const maxFrames = Math.max(1, Math.min(maxPackets, 4));
      const waitMs = Math.min(Math.max(timeoutMs, 120), 600);
      let timeoutHit = false;
      let fatalError = null;

      for (let index = 0; index < maxFrames; index += 1) {
        let frame;
        try {
          frame = await receiveFrameWithSessionTap(waitMs, 'k80_pre_pull_pending');
        } catch (err) {
          const code = err && err.code ? String(err.code) : '';
          if (code === 'REPLY_TIMEOUT') {
            timeoutHit = true;
            break;
          }
          fatalError = code || FAILURE_REASON.ATTLOG_STAGE_FAILED;
          break;
        }

        const parsed = parsePacket(frame.payload);
        const frameDiagnostic = {
          index,
          parse_ok: parsed !== null,
          inner_hex: bufferToHex(frame.payload),
          wrapper_payload_bytes: frame && frame.wrapper && Number.isInteger(frame.wrapper.payload_bytes)
            ? frame.wrapper.payload_bytes
            : null,
          wrapper_total_bytes: frame && frame.wrapper && Number.isInteger(frame.wrapper.total_bytes)
            ? frame.wrapper.total_bytes
            : null
        };
        if (parsed) {
          frameDiagnostic.command = parsed.command;
          frameDiagnostic.command_hex = commandToHex(parsed.command);
          frameDiagnostic.checksum = parsed.checksum;
          frameDiagnostic.session_id = parsed.session_id;
          frameDiagnostic.reply_id = parsed.reply_id;
          frameDiagnostic.payload_bytes = parsed.payload.length;
          frameDiagnostic.payload_hex = bufferToHex(parsed.payload);
          if (Buffer.isBuffer(parsed.payload) && parsed.payload.length > 0) {
            rawPayloadChunks.push({
              frame_index: index,
              payload: parsed.payload
            });
          }
        } else {
          frameDiagnostic.error = FAILURE_REASON.ACK_PARSE_FAILED;
        }
        frames.push(frameDiagnostic);
      }

      return {
        frames,
        rawPayloadChunks,
        timeoutHit,
        fatalError
      };
    }

    async function runZkTimeK80Step({
      stepId,
      command,
      payload,
      expectedResponseCommand = null,
      valueField = null,
      required = true
    }) {
      setLifecycleStage('sequence_step', stepId);
      const requestPayload = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
      const replyIdBefore = replyId;
      const requestReplyId = nextReplyId(replyIdBefore);
      const trace = { stage: 'zktime_k80', step: stepId };
      const response = await sendTcpCommandWithSessionTap({
        channel,
        timeoutMs,
        command,
        sessionId,
        replyId: requestReplyId,
        payload: requestPayload,
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
        deviceNumber,
        trace
      });

      const responseCommand = response && response.response ? response.response.command : null;
      const responsePayload = response && response.response ? response.response.payload : Buffer.alloc(0);
      let stepPayload = responsePayload;
      const parsedTextValue = parseOptionValue(responsePayload);
      const isPullRequestStep = stepId === 'pull_request';
      const isPrepareOrDataMarker = Number.isInteger(responseCommand) && (
        responseCommand === COMMANDS.PREPARE_DATA
        || responseCommand === COMMANDS.DATA
        || responseCommand === ACK.DATA
        || responseCommand === COMMANDS.ZKTIME_PULL_RESPONSE
      );
      const isK80PullIntermediate = stepId === 'pull_request'
        && responseCommand === COMMANDS.ZKTIME_PULL_INTERMEDIATE;
      const responseWrapperPayloadBytes = trace.response && trace.response.wrapper
        && Number.isInteger(trace.response.wrapper.payload_bytes)
        ? trace.response.wrapper.payload_bytes
        : null;
      const responseWrapperTotalBytes = trace.response && trace.response.wrapper
        && Number.isInteger(trace.response.wrapper.total_bytes)
        ? trace.response.wrapper.total_bytes
        : null;
      if (isPullRequestStep) {
        diagnostics.protocol.zktime_pull_request_actual_response_command = Number.isInteger(responseCommand)
          ? responseCommand
          : null;
        diagnostics.protocol.zktime_pull_request_actual_response_command_hex = commandToHex(responseCommand);
      }

      let commandExpectationMet = Number.isInteger(expectedResponseCommand)
        ? responseCommand === expectedResponseCommand
        : true;
      let stepError = trace.error
        || (response.ok ? null : (response.error || FAILURE_REASON.ATTLOG_STAGE_FAILED));
      let followupDiagnostics = null;

      if (response.ok && isPullRequestStep && responseCommand === COMMANDS.ZKTIME_PULL_RESPONSE && stepPayload.length === 0) {
        commandExpectationMet = false;
        stepError = 'pull_response_empty_payload';
      }

      const shouldHandlePremode2710DataState = response.ok === true
        && stepId === 'premode_2710'
        && k80Premode2710SpecialHandlingPolicy.enabled
        && (responseCommand === COMMANDS.PREPARE_DATA
          || responseCommand === COMMANDS.DATA
          || responseCommand === ACK.DATA);
      if (shouldHandlePremode2710DataState) {
        diagnostics.protocol.zktime_premode_2710_special_handling_entered = true;
        diagnostics.protocol.zktime_premode_2710_special_handling_trigger_command = responseCommand;

        const drained = await collectK80PrePullPendingFrames();
        const drainedFrames = Array.isArray(drained.frames) ? drained.frames : [];
        const drainedRawPayloadBuffers = Array.isArray(drained.rawPayloadChunks)
          ? drained.rawPayloadChunks
            .map(item => (item && Buffer.isBuffer(item.payload) ? item.payload : null))
            .filter(Boolean)
          : [];
        const drainedBytes = drainedFrames.reduce((sum, frame) => {
          if (frame && frame.parse_ok === true && Number.isInteger(frame.payload_bytes)) {
            return sum + frame.payload_bytes;
          }
          return sum;
        }, 0);
        premode2710DrainedPayload = drainedRawPayloadBuffers.length > 0
          ? Buffer.concat(drainedRawPayloadBuffers)
          : Buffer.alloc(0);
        diagnostics.protocol.zktime_premode_2710_special_handling_drained_frames = drainedFrames.length;
        diagnostics.protocol.zktime_premode_2710_special_handling_drained_bytes = drainedBytes;

        const lastParsedDrainFrame = drainedFrames
          .slice()
          .reverse()
          .find(frame => frame.parse_ok === true && Number.isInteger(frame.reply_id));
        if (lastParsedDrainFrame
          && Number.isInteger(lastParsedDrainFrame.session_id)
          && lastParsedDrainFrame.session_id === sessionId) {
          replyId = lastParsedDrainFrame.reply_id;
        }

        const freeDataTrace = { stage: 'zktime_k80', step: 'premode_2710_free_data' };
        const freeDataReplyId = nextReplyId(replyId);
        const freeDataResponse = await sendTcpCommandWithSessionTap({
          channel,
          timeoutMs,
          command: COMMANDS.FREE_DATA,
          sessionId,
          replyId: freeDataReplyId,
          payload: Buffer.alloc(0),
          noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
          deviceNumber,
          trace: freeDataTrace
        });
        diagnostics.protocol.zktime_premode_2710_special_handling_free_data_sent = true;
        const freeDataOk = freeDataResponse.ok === true
          && freeDataResponse.response
          && freeDataResponse.response.command === ACK.OK;
        diagnostics.protocol.zktime_premode_2710_special_handling_free_data_ok = freeDataOk;
        diagnostics.protocol.zktime_premode_2710_special_handling_ok =
          freeDataOk && (drained.fatalError ? false : true);

        if (freeDataResponse && freeDataResponse.response && Number.isInteger(freeDataResponse.response.reply_id)) {
          replyId = freeDataResponse.response.reply_id;
        }
      }

      if (response.ok && isK80PullIntermediate) {
        const followup = await collectK80PullFollowupFrames();
        const followupContainsPullResponse = followup.frames.some(
          frame => frame.parse_ok && frame.command === COMMANDS.ZKTIME_PULL_RESPONSE
        );
        const followupPullResponsePayloadBytes = followup.frames
          .filter(frame => frame.parse_ok && frame.command === COMMANDS.ZKTIME_PULL_RESPONSE)
          .reduce((sum, frame) => sum + (Number.isInteger(frame.payload_bytes) ? frame.payload_bytes : 0), 0);
        const lastFollowupReplyId = followup.frames
          .slice()
          .reverse()
          .find(frame => Number.isInteger(frame.reply_id));
        followupDiagnostics = {
          attempted: true,
          timeout: followup.timeoutHit,
          fatal_error: followup.fatalError || null,
          frames_available: followup.frames.length > 0,
          frames: followup.frames,
          expected_bytes: Number.isInteger(followup.expectedBytes) ? followup.expectedBytes : null,
          data_bytes: followup.data.length,
          data_hex: followup.data.length > 0 ? bufferToHex(followup.data) : null,
          contains_pull_response: followupContainsPullResponse,
          pull_response_payload_bytes: followupPullResponsePayloadBytes,
          last_reply_id: lastFollowupReplyId ? lastFollowupReplyId.reply_id : null
        };
        if (followup.fatalError) {
          stepError = followup.fatalError;
          commandExpectationMet = false;
        } else if (followup.timeoutHit) {
          stepError = 'k80_pull_intermediate_0x137d_followup_timeout';
          commandExpectationMet = false;
        } else {
          stepError = 'k80_pull_intermediate_0x137d';
          commandExpectationMet = false;
        }
      }

      const canEnterK8007d0Followup = shouldEnterK8007d0FollowupBranch({
        responseOk: response.ok,
        stepId,
        expectedResponseCommand,
        responseCommand,
        policyEnabled: k80FollowupPolicy.enabled || k80PullRequest07d0ContinuePolicy.enabled
      });
      if (canEnterK8007d0Followup) {
        if (k80PullRequest07d0ContinuePolicy.enabled) {
          diagnostics.protocol.zktime_pull_request_07d0_continue_guard_entered = true;
          diagnostics.protocol.zktime_pull_request_07d0_continue_blocker_classification =
            'pull_request_07d0_continue_attempted';
        }
        setLifecycleStage('followup', stepId);
        diagnostics.protocol.zktime_pull_07d0_branch_entered = true;
        const followupReplyIdBefore = response && response.response
          ? response.response.reply_id
          : requestReplyId;
        const followupRequestReplyId = nextReplyId(followupReplyIdBefore);
        const followupTrace = {
          stage: 'zktime_k80',
          step: 'pull_request_07d0_followup'
        };
        let followupRequestPayload = Buffer.isBuffer(k80FollowupPolicy.request_payload)
          ? k80FollowupPolicy.request_payload
          : Buffer.alloc(0);
        if (k80Dynamic05e0PayloadPolicy.enabled) {
          diagnostics.protocol.zktime_dynamic_05e0_payload_entered = true;
          const derived = deriveK8005e0FollowupPayloadFromPullAck(responsePayload);
          if (derived && Buffer.isBuffer(derived.payload) && derived.payload.length > 0) {
            followupRequestPayload = derived.payload;
            diagnostics.protocol.zktime_dynamic_05e0_payload_source_payload_hex =
              derived.source_payload_hex;
            diagnostics.protocol.zktime_dynamic_05e0_payload_source_first_word_u32le =
              derived.source_first_word_u32le;
            diagnostics.protocol.zktime_dynamic_05e0_payload_derived_word_u32le =
              derived.derived_word_u32le;
          }
        }
        const followupResponse = await sendTcpCommandWithSessionTap({
          channel,
          timeoutMs,
          command: COMMANDS.ZKTIME_PULL_CONTINUE_REQUEST,
          sessionId,
          replyId: followupRequestReplyId,
          payload: followupRequestPayload,
          noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
          deviceNumber,
          trace: followupTrace
        });
        diagnostics.protocol.zktime_pull_07d0_followup_sent = true;
        if (k80PullRequest07d0ContinuePolicy.enabled) {
          diagnostics.protocol.zktime_pull_request_07d0_continue_attempted = true;
        }
        diagnostics.protocol.zktime_pull_07d0_followup_request_hex = followupTrace && followupTrace.tx
          ? followupTrace.tx.frame_hex
          : null;
        diagnostics.protocol.zktime_pull_07d0_followup_payload_hex = bufferToHex(followupRequestPayload);
        diagnostics.protocol.zktime_dynamic_05e0_payload_sent_hex = bufferToHex(followupRequestPayload);
        diagnostics.protocol.zktime_dynamic_05e0_payload_app_parity_family_reached =
          diagnostics.protocol.zktime_dynamic_05e0_payload_sent_hex === '000000006c0b0000';

        const followup = await collectK80PullFollowupFrames();
        const branchSummary = summarizeK8007d0Continuation({
          followupResponse,
          followupFrames: followup
        });
        diagnostics.protocol.zktime_pull_07d0_followup_response_commands = branchSummary.commands_observed;
        diagnostics.protocol.zktime_pull_07d0_reached_05dc = branchSummary.reached05dc;
        diagnostics.protocol.zktime_pull_07d0_reached_05dd = branchSummary.reached05dd;
        diagnostics.protocol.zktime_pull_07d0_branch_outcome = branchSummary.branch_outcome;
        diagnostics.protocol.zktime_pull_07d0_expected_bytes_hint = branchSummary.expected_bytes_hint;
        diagnostics.protocol.zktime_pull_07d0_expected_bytes_hint_source = branchSummary.expected_bytes_hint_source;
        diagnostics.protocol.zktime_pull_07d0_observed_payload_bytes = branchSummary.observed_payload_bytes;
        diagnostics.protocol.zktime_pull_07d0_observed_05dd_payload_bytes = branchSummary.observed_05dd_payload_bytes;
        diagnostics.protocol.zktime_pull_07d0_collected_payload_bytes = branchSummary.collected_payload_bytes;
        diagnostics.protocol.zktime_pull_07d0_collected_payload_chunks = branchSummary.collected_payload_chunks;
        diagnostics.protocol.zktime_pull_07d0_collected_payload_chunk_sizes = branchSummary.collected_payload_chunk_sizes;
        diagnostics.protocol.zktime_pull_07d0_payload_hex_truncated_detected = branchSummary.payload_hex_truncated_detected;
        diagnostics.protocol.zktime_pull_07d0_payload_prefix_hex = branchSummary.payload_prefix_hex;
        diagnostics.protocol.zktime_pull_07d0_payload_suffix_hex = branchSummary.payload_suffix_hex;
        diagnostics.protocol.zktime_pull_07d0_likely_truncated = branchSummary.likely_truncated;
        diagnostics.protocol.zktime_pull_07d0_continuation_frames_count = branchSummary.continuation_frames_count;
        diagnostics.protocol.zktime_pull_07d0_continuation_frame_sizes = branchSummary.continuation_frame_sizes;

        const followupResponseCommand = followupResponse && followupResponse.response
          ? followupResponse.response.command
          : null;
        const followupResponsePayload = followupResponse && followupResponse.response
          ? followupResponse.response.payload
          : Buffer.alloc(0);
        const followupFramesWithAck = [];
        if (Number.isInteger(followupResponseCommand)) {
          followupFramesWithAck.push({
            index: -1,
            parse_ok: true,
            command: followupResponseCommand,
            command_hex: commandToHex(followupResponseCommand),
            payload_bytes: Buffer.isBuffer(followupResponsePayload) ? followupResponsePayload.length : 0,
            payload_hex: Buffer.isBuffer(followupResponsePayload) ? bufferToHex(followupResponsePayload) : null
          });
        }
        if (Array.isArray(followup.frames)) {
          followupFramesWithAck.push(...followup.frames);
        }
        followupDiagnostics = {
          attempted: true,
          timeout: followup.timeoutHit === true,
          fatal_error: followup.fatalError || (followupResponse.error || null),
          frames_available: followupFramesWithAck.length > 0,
          frames: followupFramesWithAck,
          expected_bytes: Number.isInteger(followup.expectedBytes) ? followup.expectedBytes : null,
          data_bytes: branchSummary.payload.length,
          data_hex: branchSummary.payload.length > 0 ? bufferToHex(branchSummary.payload) : null,
          contains_pull_response: branchSummary.reached05dd,
          pull_response_payload_bytes: branchSummary.payload.length,
          last_reply_id: (() => {
            const lastFollowupFrame = Array.isArray(followup.frames)
              ? followup.frames.slice().reverse().find(frame => Number.isInteger(frame.reply_id))
              : null;
            if (lastFollowupFrame && Number.isInteger(lastFollowupFrame.reply_id)) {
              return lastFollowupFrame.reply_id;
            }
            if (followupResponse && followupResponse.response && Number.isInteger(followupResponse.response.reply_id)) {
              return followupResponse.response.reply_id;
            }
            return null;
          })(),
          k80_07d0_branch_outcome: branchSummary.branch_outcome,
          k80_07d0_branch_reached_05dc: branchSummary.reached05dc,
          k80_07d0_branch_reached_05dd: branchSummary.reached05dd,
          k80_07d0_branch_response_commands: branchSummary.commands_observed
        };

        if (branchSummary.success) {
          let finalPullPayload = branchSummary.payload;
          let multipageStopReason = 'disabled_or_single_page';
          let multipagePagesCollected = 1;
          if (k80MultipageAttlogPolicy.enabled) {
            diagnostics.protocol.zktime_multipage_attlog_entered = true;
            const pagePayloads = [branchSummary.payload];
            let loopReplyId = followupDiagnostics && Number.isInteger(followupDiagnostics.last_reply_id)
              ? followupDiagnostics.last_reply_id
              : (followupResponse && followupResponse.response && Number.isInteger(followupResponse.response.reply_id)
                ? followupResponse.response.reply_id
                : null);
            let loopStopped = false;
            for (let pageIndex = 2; pageIndex <= k80MultipageAttlogPolicy.max_pages; pageIndex += 1) {
              const pageRequestReplyId = nextReplyId(loopReplyId);
              const pageTrace = {
                stage: 'zktime_k80',
                step: `pull_request_07d0_followup_page_${pageIndex}`
              };
              const pageResponse = await sendTcpCommandWithSessionTap({
                channel,
                timeoutMs,
                command: COMMANDS.ZKTIME_PULL_CONTINUE_REQUEST,
                sessionId,
                replyId: pageRequestReplyId,
                payload: followupRequestPayload,
                noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
                deviceNumber,
                trace: pageTrace
              });
              const pageFollowup = await collectK80PullFollowupFrames();
              const pageSummary = summarizeK8007d0Continuation({
                followupResponse: pageResponse,
                followupFrames: pageFollowup
              });
              const pageLastReply = Array.isArray(pageFollowup.frames)
                ? pageFollowup.frames.slice().reverse().find(frame => Number.isInteger(frame.reply_id))
                : null;
              if (pageLastReply && Number.isInteger(pageLastReply.reply_id)) {
                loopReplyId = pageLastReply.reply_id;
              } else if (pageResponse && pageResponse.response && Number.isInteger(pageResponse.response.reply_id)) {
                loopReplyId = pageResponse.response.reply_id;
              } else {
                loopReplyId = pageRequestReplyId;
              }
              if (pageSummary.fatal_error) {
                multipageStopReason = 'fatal_error';
                loopStopped = true;
                break;
              }
              if (pageSummary.timeout) {
                multipageStopReason = 'timeout';
                loopStopped = true;
                break;
              }
              if (!pageSummary.reached05dd || pageSummary.payload.length === 0) {
                multipageStopReason = 'continuation_complete';
                loopStopped = true;
                break;
              }
              pagePayloads.push(pageSummary.payload);
              multipagePagesCollected = pagePayloads.length;
            }
            if (!loopStopped && multipagePagesCollected >= k80MultipageAttlogPolicy.max_pages) {
              multipageStopReason = 'max_pages_reached';
            }
            const concatenatedPayload = pagePayloads.length > 0 ? Buffer.concat(pagePayloads) : Buffer.alloc(0);
            diagnostics.protocol.zktime_multipage_attlog_pages_collected = pagePayloads.length;
            diagnostics.protocol.zktime_multipage_attlog_total_concatenated_bytes = concatenatedPayload.length;
            diagnostics.protocol.zktime_multipage_attlog_stop_reason = multipageStopReason;
            if (pagePayloads.length > 1 && concatenatedPayload.length > branchSummary.payload.length) {
              finalPullPayload = concatenatedPayload;
              diagnostics.protocol.zktime_multipage_attlog_final_parser_input_source = 'multipage';
            } else {
              diagnostics.protocol.zktime_multipage_attlog_final_parser_input_source = 'single_page';
            }
          } else {
            diagnostics.protocol.zktime_multipage_attlog_pages_collected = 1;
            diagnostics.protocol.zktime_multipage_attlog_total_concatenated_bytes = branchSummary.payload.length;
            diagnostics.protocol.zktime_multipage_attlog_stop_reason = multipageStopReason;
            diagnostics.protocol.zktime_multipage_attlog_final_parser_input_source = 'single_page';
          }
          commandExpectationMet = true;
          stepError = null;
          stepPayload = finalPullPayload;
          diagnostics.protocol.zktime_pull_path = 'alternate_07d0_followup';
          if (k80PullRequest07d0ContinuePolicy.enabled) {
            diagnostics.protocol.zktime_pull_request_07d0_continue_reached_non_empty_05dd = true;
            diagnostics.protocol.zktime_pull_request_07d0_continue_blocker_classification =
              'pull_request_07d0_continue_reached_05dd';
          }
        } else {
          commandExpectationMet = false;
          diagnostics.protocol.zktime_pull_07d0_fallback_failure = true;
          if (k80PullRequest07d0ContinuePolicy.enabled) {
            diagnostics.protocol.zktime_pull_request_07d0_continue_blocker_classification =
              'pull_request_07d0_continue_still_failed';
          }
          diagnostics.protocol.zktime_multipage_attlog_stop_reason = diagnostics.protocol.zktime_multipage_attlog_enabled
            ? 'initial_followup_failed'
            : diagnostics.protocol.zktime_multipage_attlog_stop_reason;
        }
      }

      if (isPullRequestStep && response.ok && responseCommand === COMMANDS.ZKTIME_PULL_RESPONSE && commandExpectationMet) {
        diagnostics.protocol.zktime_pull_path = diagnostics.protocol.zktime_pull_path || 'direct_05dd';
        diagnostics.protocol.zktime_pull_direct_05dd_payload_bytes = responsePayload.length;
        diagnostics.protocol.zktime_pull_direct_05dd_payload_prefix_hex = responsePayload.length > 0
          ? responsePayload.subarray(0, Math.min(responsePayload.length, 32)).toString('hex')
          : null;
        diagnostics.protocol.zktime_pull_direct_05dd_payload_suffix_hex = responsePayload.length > 0
          ? responsePayload.subarray(Math.max(0, responsePayload.length - 32)).toString('hex')
          : null;
      }

      const ok = response.ok === true && commandExpectationMet;
      const unexpectedPullResponseDetail = isPullRequestStep
        && response.ok === true
        && Number.isInteger(expectedResponseCommand)
        && responseCommand !== expectedResponseCommand
        ? {
          step: stepId,
          expected_response_command: expectedResponseCommand,
          expected_response_command_hex: commandToHex(expectedResponseCommand),
          actual_response_command: Number.isInteger(responseCommand) ? responseCommand : null,
          actual_response_command_hex: commandToHex(responseCommand),
          pre_pull_pending_frames_count: Array.isArray(diagnostics.protocol.zktime_pre_pull_pending_frames)
            ? diagnostics.protocol.zktime_pre_pull_pending_frames.length
            : 0,
          followup_frames_count: followupDiagnostics && Array.isArray(followupDiagnostics.frames)
            ? followupDiagnostics.frames.length
            : 0,
          ...(decodeUnexpectedPullPayload(responseCommand, stepPayload) || {})
        }
        : null;
      const payloadLikelyText = stepPayload.length > 0 ? isLikelyTextPayload(stepPayload) : null;

      const stepDiagnostics = {
        step: stepId,
        command_id: command,
        command_hex: commandToHex(command),
        expected_response_command: Number.isInteger(expectedResponseCommand)
          ? expectedResponseCommand
          : null,
        expected_response_command_hex: commandToHex(expectedResponseCommand),
        state_before_session_id: sessionId,
        state_before_reply_id: replyIdBefore,
        session_id_used: trace.tx && trace.tx.inner ? trace.tx.inner.session_id : sessionId,
        reply_id_before: replyIdBefore,
        reply_id_used: trace.tx && trace.tx.inner ? trace.tx.inner.reply_id : requestReplyId,
        request_hex: trace.tx ? trace.tx.frame_hex : null,
        request_inner_hex: trace.tx ? trace.tx.inner_packet_hex : null,
        request_payload_hex: bufferToHex(requestPayload),
        checksum_used: trace.tx && trace.tx.inner ? trace.tx.inner.checksum : null,
        response_command: Number.isInteger(responseCommand) ? responseCommand : null,
        response_command_hex: commandToHex(responseCommand),
        response_hex: trace.response ? trace.response.inner_packet_hex : null,
        payload_hex: trace.response ? trace.response.payload_hex : null,
        payload_bytes: stepPayload.length,
        parsed_text_value: parsedTextValue || null,
        payload_likely_text: payloadLikelyText,
        large_binary_payload_received: stepPayload.length >= 128 && payloadLikelyText === false,
        response_is_prepare_or_data_marker: isPrepareOrDataMarker,
        response_is_k80_pull_intermediate: isK80PullIntermediate,
        response_wrapper_payload_bytes: responseWrapperPayloadBytes,
        response_wrapper_total_bytes: responseWrapperTotalBytes,
        response_wrapper_indicates_payload: Number.isInteger(responseWrapperPayloadBytes)
          ? responseWrapperPayloadBytes > 8
          : null,
        pull_direct_response_expected: isPullRequestStep ? COMMANDS.ZKTIME_PULL_RESPONSE : null,
        pull_direct_response_expected_hex: isPullRequestStep ? commandToHex(COMMANDS.ZKTIME_PULL_RESPONSE) : null,
        pull_direct_response_matched: isPullRequestStep
          ? responseCommand === COMMANDS.ZKTIME_PULL_RESPONSE
          : null,
        pull_direct_response_payload_bytes: isPullRequestStep && responseCommand === COMMANDS.ZKTIME_PULL_RESPONSE
          ? responsePayload.length
          : null,
        pull_unexpected_response_detail: unexpectedPullResponseDetail,
        followup_attempted: followupDiagnostics ? followupDiagnostics.attempted : false,
        followup_frames_available: followupDiagnostics ? followupDiagnostics.frames_available : false,
        followup_timeout: followupDiagnostics ? followupDiagnostics.timeout : false,
        followup_expected_bytes: followupDiagnostics ? followupDiagnostics.expected_bytes : null,
        followup_data_bytes: followupDiagnostics ? followupDiagnostics.data_bytes : 0,
        followup_data_hex: followupDiagnostics ? followupDiagnostics.data_hex : null,
        followup_contains_pull_response: followupDiagnostics ? followupDiagnostics.contains_pull_response : false,
        followup_pull_response_payload_bytes: followupDiagnostics
          ? followupDiagnostics.pull_response_payload_bytes
          : 0,
        k80_07d0_branch_outcome: followupDiagnostics
          ? (followupDiagnostics.k80_07d0_branch_outcome || null)
          : null,
        k80_07d0_branch_reached_05dc: followupDiagnostics
          ? followupDiagnostics.k80_07d0_branch_reached_05dc === true
          : false,
        k80_07d0_branch_reached_05dd: followupDiagnostics
          ? followupDiagnostics.k80_07d0_branch_reached_05dd === true
          : false,
        k80_07d0_branch_response_commands: followupDiagnostics
          ? (Array.isArray(followupDiagnostics.k80_07d0_branch_response_commands)
            ? followupDiagnostics.k80_07d0_branch_response_commands
            : [])
          : [],
        followup_frames: followupDiagnostics ? followupDiagnostics.frames : [],
        ok,
        error: stepError || (response.ok
          ? (commandExpectationMet ? null : 'unexpected_response_command')
          : (response.error || FAILURE_REASON.ATTLOG_STAGE_FAILED))
      };
      diagnostics.protocol.zktime_sequence_steps.push(stepDiagnostics);

      if (response && response.response) {
        replyId = response.response.reply_id;
      } else {
        replyId = requestReplyId;
      }
      stepDiagnostics.reply_id_response = response && response.response
        ? response.response.reply_id
        : null;
      if (followupDiagnostics && Number.isInteger(followupDiagnostics.last_reply_id)) {
        replyId = followupDiagnostics.last_reply_id;
      }
      stepDiagnostics.reply_id_next = replyId;
      if (valueField && parsedTextValue) {
        diagnostics.protocol[valueField] = parsedTextValue;
      }

      if (!ok && required) {
        if (unexpectedPullResponseDetail) {
          diagnostics.protocol.zktime_pull_request_unexpected_response = unexpectedPullResponseDetail;
        }
        diagnostics.protocol.zktime_sequence_failure_step = stepId;
        diagnostics.failure_reason = FAILURE_REASON.ATTLOG_STAGE_FAILED;
        diagnostics.failure_stage = 'attlog';
        diagnostics.failure_step = stepId;
        recordRawError(stepError || (response ? response.error : null));
        return {
          ok: false,
          payload: stepPayload,
          response_command: responseCommand
        };
      }

      return {
        ok,
        payload: stepPayload,
        response_command: responseCommand
      };
    }

    async function runK80SessionContextHoldBlock() {
      diagnostics.protocol.zktime_session_context_hold_executed = true;
      const startedAtMs = Date.now();
      const holdWindowMs = k80SessionContextHoldPolicy.window_ms;
      const holdPollMs = k80SessionContextHoldPolicy.poll_ms;
      let framesSeen = 0;
      let rt01f4FramesCount = 0;
      let firstEventLocal = null;
      let lastEventLocal = null;
      let holdError = null;

      while ((Date.now() - startedAtMs) < holdWindowMs) {
        const elapsedMs = Date.now() - startedAtMs;
        const remainingMs = holdWindowMs - elapsedMs;
        const waitMs = Math.max(50, Math.min(holdPollMs, remainingMs));
        let frame;
        try {
          frame = await receiveFrameWithSessionTap(waitMs, 'k80_session_context_hold');
        } catch (err) {
          const code = err && err.code ? String(err.code) : '';
          if (code === 'REPLY_TIMEOUT') {
            continue;
          }
          holdError = code || mapSocketErrorCode(err);
          break;
        }

        framesSeen += 1;
        const parsed = parsePacket(frame.payload);
        if (!parsed || Number(parsed.command) !== 0x01f4 || !Buffer.isBuffer(parsed.payload)) {
          continue;
        }
        const payloadHex = bufferToHex(parsed.payload).toLowerCase();
        if (!payloadHex || payloadHex.length % 2 !== 0) {
          continue;
        }
        rt01f4FramesCount += 1;
        const decoded = decodeK80RtObservationFromFramePayload(payloadHex);
        if (decoded && normalizeText(decoded.eventTimeLocal)) {
          if (!firstEventLocal) {
            firstEventLocal = decoded.eventTimeLocal;
          }
          lastEventLocal = decoded.eventTimeLocal;
        }
      }

      diagnostics.protocol.zktime_session_context_hold_elapsed_ms = Date.now() - startedAtMs;
      diagnostics.protocol.zktime_session_context_hold_frames_seen = framesSeen;
      diagnostics.protocol.zktime_session_context_hold_rt01f4_seen = rt01f4FramesCount > 0;
      diagnostics.protocol.zktime_session_context_hold_rt01f4_frames_count = rt01f4FramesCount;
      diagnostics.protocol.zktime_session_context_hold_rt01f4_first_event_local = firstEventLocal;
      diagnostics.protocol.zktime_session_context_hold_rt01f4_last_event_local = lastEventLocal;
      diagnostics.protocol.zktime_session_context_hold_error = holdError || null;
    }

    if (resolvedAttlogSequence === ATTLOG_SEQUENCE.ZKTIME_K80) {
      setLifecycleStage('pre_sequence');
      diagnostics.protocol.preflight_enabled = true;
      diagnostics.protocol.preflight_profile = resolvedAttlogSequence;
      diagnostics.protocol.zktime_sequence_enabled = true;

      const sequenceSteps = [
        {
          stepId: 'device_id',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('DeviceID\x00', 'ascii'),
          expectedResponseCommand: ACK.OK,
          valueField: 'preflight_device_id',
          required: true
        },
        {
          stepId: 'status_probe',
          command: COMMANDS.ZKTIME_STATUS_PROBE,
          payload: Buffer.alloc(0),
          expectedResponseCommand: ACK.OK,
          valueField: 'preflight_device_status',
          required: true
        },
        {
          stepId: 'pre_size_query',
          command: COMMANDS.ZKTIME_PRE_SIZE_QUERY,
          payload: Buffer.from('10270000', 'hex'),
          expectedResponseCommand: ACK.OK,
          required: true
        },
        {
          stepId: 'size_query',
          command: COMMANDS.ZKTIME_SIZE_QUERY,
          payload: Buffer.alloc(0),
          expectedResponseCommand: ACK.OK,
          required: true
        },
        {
          stepId: 'pull_request',
          command: COMMANDS.ZKTIME_PULL_REQUEST,
          payload: Buffer.from('010d000000000000000000', 'hex'),
          expectedResponseCommand: COMMANDS.ZKTIME_PULL_RESPONSE,
          required: true
        }
      ];

      if (connectOnlyProbeEnabled) {
        setLifecycleStage('pre_sequence', 'connect_only_probe');
        diagnostics.protocol.zktime_connect_only_probe_executed = true;
        diagnostics.protocol.zktime_connect_only_probe_attlog_skipped = true;
        const connectProbeStartedAtMs = Date.now();

        const deviceIdStep = await runZkTimeK80Step(sequenceSteps[0]);
        if (!deviceIdStep.ok) {
          diagnostics.protocol.zktime_connect_only_probe_ok = false;
          diagnostics.protocol.zktime_connect_only_probe_elapsed_ms = Date.now() - connectProbeStartedAtMs;
          diagnostics.protocol.zktime_connect_only_probe_error =
            diagnostics.protocol.zktime_sequence_failure_step || 'device_id_failed';
          return failWithContext({
            failureStage: diagnostics.failure_stage || 'pre_sequence',
            failureReason: diagnostics.failure_reason || FAILURE_REASON.ATTLOG_STAGE_FAILED,
            failureStep: diagnostics.protocol.zktime_sequence_failure_step || 'device_id',
            lifecycleStage: 'pre_sequence'
          });
        }

        const statusProbeStep = await runZkTimeK80Step(sequenceSteps[1]);
        if (!statusProbeStep.ok) {
          diagnostics.protocol.zktime_connect_only_probe_ok = false;
          diagnostics.protocol.zktime_connect_only_probe_elapsed_ms = Date.now() - connectProbeStartedAtMs;
          diagnostics.protocol.zktime_connect_only_probe_error =
            diagnostics.protocol.zktime_sequence_failure_step || 'status_probe_failed';
          return failWithContext({
            failureStage: diagnostics.failure_stage || 'pre_sequence',
            failureReason: diagnostics.failure_reason || FAILURE_REASON.ATTLOG_STAGE_FAILED,
            failureStep: diagnostics.protocol.zktime_sequence_failure_step || 'status_probe',
            lifecycleStage: 'pre_sequence'
          });
        }

        if (k80StartupNegotiationPolicy.enabled) {
          const startupNegotiationStep = await runZkTimeK80Step({
            stepId: 'startup_negotiation',
            command: COMMANDS.ZKTIME_STARTUP_NEGOTIATION,
            payload: Buffer.from(K80_STARTUP_NEGOTIATION_PAYLOAD_HEX, 'hex'),
            expectedResponseCommand: ACK.OK,
            required: false
          });
          diagnostics.protocol.zktime_startup_negotiation_executed = true;
          diagnostics.protocol.zktime_startup_negotiation_ok = startupNegotiationStep.ok === true;
          diagnostics.protocol.zktime_startup_negotiation_response_command =
            Number.isInteger(startupNegotiationStep.response_command)
              ? startupNegotiationStep.response_command
              : null;
        }

        if (k80PreAttlogModeEntryPolicy.enabled) {
          const premode000cStep = await runZkTimeK80Step({
            stepId: 'premode_000c_sdkbuild',
            command: COMMANDS.ZKTIME_PREMODE_000C,
            payload: Buffer.from('53444b4275696c643d3100', 'hex'),
            expectedResponseCommand: ACK.OK,
            required: false
          });
          diagnostics.protocol.zktime_premode_000c_executed = true;
          diagnostics.protocol.zktime_premode_000c_ok = premode000cStep.ok === true;
          diagnostics.protocol.zktime_premode_000c_response_command =
            Number.isInteger(premode000cStep.response_command)
              ? premode000cStep.response_command
              : null;

          const premode0045Step = await runZkTimeK80Step({
            stepId: 'premode_0045',
            command: COMMANDS.ZKTIME_PREMODE_0045,
            payload: Buffer.from('2080', 'hex'),
            expectedResponseCommand: ACK.OK,
            required: false
          });
          diagnostics.protocol.zktime_premode_0045_executed = true;
          diagnostics.protocol.zktime_premode_0045_ok = premode0045Step.ok === true;
          diagnostics.protocol.zktime_premode_0045_response_command =
            Number.isInteger(premode0045Step.response_command)
              ? premode0045Step.response_command
              : null;

          const premode2710Step = await runZkTimeK80Step({
            stepId: 'premode_2710',
            command: COMMANDS.ZKTIME_PREMODE_2710,
            payload: Buffer.alloc(0),
            expectedResponseCommand: ACK.OK,
            required: false
          });
          diagnostics.protocol.zktime_premode_2710_executed = true;
          diagnostics.protocol.zktime_premode_2710_ok = premode2710Step.ok === true;
          diagnostics.protocol.zktime_premode_2710_response_command =
            Number.isInteger(premode2710Step.response_command)
              ? premode2710Step.response_command
              : null;
        }

        if (k80Premode044cPolicy.enabled) {
          const premode044cStep = await runZkTimeK80Step({
            stepId: 'premode_044c',
            command: COMMANDS.ZKTIME_PREMODE_044C,
            payload: Buffer.alloc(0),
            expectedResponseCommand: ACK.OK,
            required: false
          });
          diagnostics.protocol.zktime_premode_044c_executed = true;
          diagnostics.protocol.zktime_premode_044c_ok = premode044cStep.ok === true;
          diagnostics.protocol.zktime_premode_044c_response_command =
            Number.isInteger(premode044cStep.response_command)
              ? premode044cStep.response_command
              : null;
        }

        if (k80RtSubscribePolicy.enabled) {
          const rtSubscribeStep = await runZkTimeK80Step({
            stepId: 'rt_subscribe',
            command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
            payload: Buffer.from('ffff0000', 'hex'),
            expectedResponseCommand: ACK.OK,
            required: false
          });
          diagnostics.protocol.zktime_rt_subscribe_executed = true;
          diagnostics.protocol.zktime_rt_subscribe_ok = rtSubscribeStep.ok === true;
          diagnostics.protocol.zktime_rt_subscribe_response_command =
            Number.isInteger(rtSubscribeStep.response_command)
              ? rtSubscribeStep.response_command
              : null;
        }

        let probeRt01f4FramesCount = 0;
        let probeFirstEventLocal = null;
        let probeLastEventLocal = null;
        let probeHoldError = null;
        if (connectOnlyProbeHoldWindowMs > 0) {
          const holdStartedAtMs = Date.now();
          while ((Date.now() - holdStartedAtMs) < connectOnlyProbeHoldWindowMs) {
            const elapsedMs = Date.now() - holdStartedAtMs;
            const remainingMs = connectOnlyProbeHoldWindowMs - elapsedMs;
            const waitMs = Math.max(50, Math.min(500, remainingMs));
            let frame;
            try {
              frame = await receiveFrameWithSessionTap(waitMs, 'k80_connect_only_probe_hold');
            } catch (err) {
              const code = err && err.code ? String(err.code) : '';
              if (code === 'REPLY_TIMEOUT') {
                continue;
              }
              probeHoldError = code || mapSocketErrorCode(err);
              break;
            }

            const parsed = parsePacket(frame.payload);
            if (!parsed || Number(parsed.command) !== 0x01f4 || !Buffer.isBuffer(parsed.payload)) {
              continue;
            }
            const payloadHex = bufferToHex(parsed.payload).toLowerCase();
            if (!payloadHex || payloadHex.length % 2 !== 0) {
              continue;
            }
            probeRt01f4FramesCount += 1;
            const decoded = decodeK80RtObservationFromFramePayload(payloadHex);
            if (decoded && normalizeText(decoded.eventTimeLocal)) {
              if (!probeFirstEventLocal) {
                probeFirstEventLocal = decoded.eventTimeLocal;
              }
              probeLastEventLocal = decoded.eventTimeLocal;
            }
          }
        }

        diagnostics.protocol.zktime_connect_only_probe_rt01f4_seen = probeRt01f4FramesCount > 0;
        diagnostics.protocol.zktime_connect_only_probe_rt01f4_frames_count = probeRt01f4FramesCount;
        diagnostics.protocol.zktime_connect_only_probe_rt01f4_first_event_local = probeFirstEventLocal;
        diagnostics.protocol.zktime_connect_only_probe_rt01f4_last_event_local = probeLastEventLocal;
        if (probeHoldError) {
          diagnostics.protocol.zktime_connect_only_probe_error = probeHoldError;
        }

        const cleanupStep = await runZkTimeK80Step({
          stepId: 'cleanup',
          command: COMMANDS.ZKTIME_CLEANUP,
          payload: Buffer.alloc(0),
          required: false
        });
        diagnostics.protocol.zktime_connect_only_probe_cleanup_ok = cleanupStep.ok === true;
        diagnostics.protocol.zktime_connect_only_probe_ok = true;
        diagnostics.protocol.zktime_connect_only_probe_elapsed_ms = Date.now() - connectProbeStartedAtMs;

        diagnostics.protocol.data_mode = 'zktime_k80_connect_only_probe';
        diagnostics.protocol.data_packets = 0;
        diagnostics.protocol.data_bytes = 0;
        diagnostics.protocol.data_first_payload_hex = null;
        diagnostics.protocol.zktime_sequence_data_received = false;
        diagnostics.protocol.zktime_sequence_data_payload_bytes = 0;
        diagnostics.protocol.zktime_sequence_data_payload_hex = null;

        return {
          ok: true,
          data: Buffer.alloc(0),
          diagnostics
        };
      }

      let zktimePayload = Buffer.alloc(0);
      let firstCyclePullPath = null;
      for (const sequenceStep of sequenceSteps) {
        if (sequenceStep.stepId === 'pre_size_query') {
          if (k80StartupNegotiationPolicy.enabled) {
            const startupNegotiationStep = await runZkTimeK80Step({
              stepId: 'startup_negotiation',
              command: COMMANDS.ZKTIME_STARTUP_NEGOTIATION,
              payload: Buffer.from(K80_STARTUP_NEGOTIATION_PAYLOAD_HEX, 'hex'),
              expectedResponseCommand: ACK.OK,
              required: false
            });
            diagnostics.protocol.zktime_startup_negotiation_executed = true;
            diagnostics.protocol.zktime_startup_negotiation_ok = startupNegotiationStep.ok === true;
            diagnostics.protocol.zktime_startup_negotiation_response_command =
              Number.isInteger(startupNegotiationStep.response_command)
                ? startupNegotiationStep.response_command
                : null;
          }
          if (k80PreAttlogModeEntryPolicy.enabled) {
            const premode000cStep = await runZkTimeK80Step({
              stepId: 'premode_000c_sdkbuild',
              command: COMMANDS.ZKTIME_PREMODE_000C,
              payload: Buffer.from('53444b4275696c643d3100', 'hex'),
              expectedResponseCommand: ACK.OK,
              required: false
            });
            diagnostics.protocol.zktime_premode_000c_executed = true;
            diagnostics.protocol.zktime_premode_000c_ok = premode000cStep.ok === true;
            diagnostics.protocol.zktime_premode_000c_response_command =
              Number.isInteger(premode000cStep.response_command)
                ? premode000cStep.response_command
                : null;

            const premode0045Step = await runZkTimeK80Step({
              stepId: 'premode_0045',
              command: COMMANDS.ZKTIME_PREMODE_0045,
              payload: Buffer.from('2080', 'hex'),
              expectedResponseCommand: ACK.OK,
              required: false
            });
            diagnostics.protocol.zktime_premode_0045_executed = true;
            diagnostics.protocol.zktime_premode_0045_ok = premode0045Step.ok === true;
            diagnostics.protocol.zktime_premode_0045_response_command =
              Number.isInteger(premode0045Step.response_command)
                ? premode0045Step.response_command
                : null;

            const premode2710Step = await runZkTimeK80Step({
              stepId: 'premode_2710',
              command: COMMANDS.ZKTIME_PREMODE_2710,
              payload: Buffer.alloc(0),
              expectedResponseCommand: ACK.OK,
              required: false
            });
            diagnostics.protocol.zktime_premode_2710_executed = true;
            diagnostics.protocol.zktime_premode_2710_ok = premode2710Step.ok === true;
            diagnostics.protocol.zktime_premode_2710_response_command =
              Number.isInteger(premode2710Step.response_command)
                ? premode2710Step.response_command
                : null;
          }
          if (k80Premode044cPolicy.enabled) {
            const premode044cStep = await runZkTimeK80Step({
              stepId: 'premode_044c',
              command: COMMANDS.ZKTIME_PREMODE_044C,
              payload: Buffer.alloc(0),
              expectedResponseCommand: ACK.OK,
              required: false
            });
            diagnostics.protocol.zktime_premode_044c_executed = true;
            diagnostics.protocol.zktime_premode_044c_ok = premode044cStep.ok === true;
            diagnostics.protocol.zktime_premode_044c_response_command =
              Number.isInteger(premode044cStep.response_command)
                ? premode044cStep.response_command
                : null;
          }
          if (k80RtSubscribePolicy.enabled) {
            const rtSubscribeStep = await runZkTimeK80Step({
              stepId: 'rt_subscribe',
              command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
              payload: Buffer.from('ffff0000', 'hex'),
              expectedResponseCommand: ACK.OK,
              required: false
            });
            diagnostics.protocol.zktime_rt_subscribe_executed = true;
            diagnostics.protocol.zktime_rt_subscribe_ok = rtSubscribeStep.ok === true;
            diagnostics.protocol.zktime_rt_subscribe_response_command =
              Number.isInteger(rtSubscribeStep.response_command)
                ? rtSubscribeStep.response_command
                : null;
          }
          if (k80SessionContextHoldPolicy.enabled) {
            await runK80SessionContextHoldBlock();
          }
          if (k80AppParityRestartPolicy.enabled) {
            const appParityRestart = await runAppParityRestartBeforeAttlog();
            if (!appParityRestart.ok) {
              diagnostics.protocol.zktime_app_parity_family_restart_ok = false;
            }
          }
          if (k80PreRetrievalSubfamilyPolicy.enabled) {
            await runPreRetrievalSubfamilyBlock();
            const statusProbeAfterSubfamily = await runZkTimeK80Step({
              stepId: 'pre_retrieval_post_status_probe',
              command: COMMANDS.ZKTIME_STATUS_PROBE,
              payload: Buffer.alloc(0),
              expectedResponseCommand: ACK.OK,
              required: false
            });
            if (!statusProbeAfterSubfamily.ok) {
              diagnostics.protocol.zktime_pre_retrieval_subfamily_03ea_ok =
                diagnostics.protocol.zktime_pre_retrieval_subfamily_03ea_ok && false;
            }
          }
          if (k80PreAttlogEnableBoundaryPolicy.enabled) {
            diagnostics.protocol.pre_attlog_enable_boundary_entered = true;
            diagnostics.protocol.pre_attlog_enable_boundary_sent = true;
            const boundaryStep = await runZkTimeK80Step({
              stepId: 'pre_attlog_enable_boundary',
              command: COMMANDS.ZKTIME_CLEANUP,
              payload: Buffer.alloc(0),
              expectedResponseCommand: ACK.OK,
              required: false
            });
            diagnostics.protocol.pre_attlog_enable_boundary_response_command =
              Number.isInteger(boundaryStep.response_command)
                ? boundaryStep.response_command
                : null;
            diagnostics.protocol.pre_attlog_enable_boundary_ok = boundaryStep.ok === true;
            diagnostics.protocol.final_path_variant = 'boundary_before_attlog';
          } else {
            diagnostics.protocol.final_path_variant = 'baseline_inline';
          }

          if (k80PreSizeSelectorAbPolicy.enabled) {
            diagnostics.protocol.selector_ab_entered = true;
            const selectorAHex = '10270000';
            const selectorBHex = k80PreSizeSelectorAbPolicy.selector_b_payload_hex;

            const runSelectorVariant = async ({ variantKey, preSizePayloadHex, required }) => {
              const preSize = await runZkTimeK80Step({
                stepId: 'pre_size_query',
                command: COMMANDS.ZKTIME_PRE_SIZE_QUERY,
                payload: Buffer.from(preSizePayloadHex, 'hex'),
                expectedResponseCommand: ACK.OK,
                required
              });
              if (!preSize.ok) {
                return { ok: false, reason: 'pre_size_query_failed' };
              }
              const size = await runZkTimeK80Step({
                stepId: 'size_query',
                command: COMMANDS.ZKTIME_SIZE_QUERY,
                payload: Buffer.alloc(0),
                expectedResponseCommand: ACK.OK,
                required
              });
              if (!size.ok) {
                return { ok: false, reason: 'size_query_failed' };
              }
              const pull = await runZkTimeK80Step({
                stepId: 'pull_request',
                command: COMMANDS.ZKTIME_PULL_REQUEST,
                payload: Buffer.from('010d000000000000000000', 'hex'),
                expectedResponseCommand: COMMANDS.ZKTIME_PULL_RESPONSE,
                required
              });
              if (!pull.ok || !Buffer.isBuffer(pull.payload) || pull.payload.length === 0) {
                return { ok: false, reason: 'pull_request_failed' };
              }
              return {
                ok: true,
                payload: pull.payload,
                pull_path: diagnostics.protocol.zktime_pull_path || null,
                summary: summarizeCyclePayload(pull.payload)
              };
            };

            const selectorA = await runSelectorVariant({
              variantKey: 'a',
              preSizePayloadHex: selectorAHex,
              required: true
            });
            if (!selectorA.ok) {
              return failWithContext({
                failureStage: diagnostics.failure_stage || 'attlog',
                failureReason: diagnostics.failure_reason || FAILURE_REASON.ATTLOG_STAGE_FAILED,
                failureStep: diagnostics.protocol.zktime_sequence_failure_step || 'selector_a',
                lifecycleStage: 'sequence_step'
              });
            }
            diagnostics.protocol.selector_a_attlog_payload_bytes = selectorA.summary.payload_bytes;
            diagnostics.protocol.selector_a_parser_merged_candidates = selectorA.summary.parser_candidates;
            diagnostics.protocol.selector_a_events_count = selectorA.summary.normalized_events_count;
            diagnostics.protocol.selector_a_earliest_event_time_utc =
              selectorA.summary.earliest_event_time_utc || null;
            diagnostics.protocol.selector_a_latest_event_time_utc =
              selectorA.summary.latest_event_time_utc || null;

            const selectorBSnapshot = {
              failure_reason: diagnostics.failure_reason,
              failure_stage: diagnostics.failure_stage,
              failure_step: diagnostics.failure_step,
              sequence_failure_step: diagnostics.protocol.zktime_sequence_failure_step,
              raw_error_code: diagnostics.raw_error_code,
              raw_error_message: diagnostics.raw_error_message
            };
            const selectorB = await runSelectorVariant({
              variantKey: 'b',
              preSizePayloadHex: selectorBHex,
              required: false
            });
            if (selectorB.ok) {
              diagnostics.protocol.selector_b_attlog_payload_bytes = selectorB.summary.payload_bytes;
              diagnostics.protocol.selector_b_parser_merged_candidates = selectorB.summary.parser_candidates;
              diagnostics.protocol.selector_b_events_count = selectorB.summary.normalized_events_count;
              diagnostics.protocol.selector_b_earliest_event_time_utc =
                selectorB.summary.earliest_event_time_utc || null;
              diagnostics.protocol.selector_b_latest_event_time_utc =
                selectorB.summary.latest_event_time_utc || null;
            } else {
              diagnostics.failure_reason = selectorBSnapshot.failure_reason;
              diagnostics.failure_stage = selectorBSnapshot.failure_stage;
              diagnostics.failure_step = selectorBSnapshot.failure_step;
              diagnostics.protocol.zktime_sequence_failure_step = selectorBSnapshot.sequence_failure_step;
              diagnostics.raw_error_code = selectorBSnapshot.raw_error_code;
              diagnostics.raw_error_message = selectorBSnapshot.raw_error_message;
            }

            let selectedVariant = 'selector_a';
            let selectionReason = 'fallback_selector_a';
            let selectedPayload = selectorA.payload;
            let selectedPullPath = selectorA.pull_path;
            if (selectorB.ok) {
              const aSummary = selectorA.summary;
              const bSummary = selectorB.summary;
              if (bSummary.normalized_events_count > aSummary.normalized_events_count) {
                selectedVariant = 'selector_b';
                selectionReason = 'higher_normalized_events';
                selectedPayload = selectorB.payload;
                selectedPullPath = selectorB.pull_path;
              } else if (bSummary.normalized_events_count === aSummary.normalized_events_count
                && bSummary.parser_candidates > aSummary.parser_candidates) {
                selectedVariant = 'selector_b';
                selectionReason = 'higher_merged_candidates';
                selectedPayload = selectorB.payload;
                selectedPullPath = selectorB.pull_path;
              } else if (bSummary.normalized_events_count === aSummary.normalized_events_count
                && bSummary.parser_candidates === aSummary.parser_candidates
                && bSummary.payload_bytes > aSummary.payload_bytes) {
                selectedVariant = 'selector_b';
                selectionReason = 'larger_attlog_payload_bytes';
                selectedPayload = selectorB.payload;
                selectedPullPath = selectorB.pull_path;
              } else {
                selectionReason = 'selector_a_preferred_by_tie_break';
              }
            } else {
              selectionReason = 'selector_b_failed_selector_a_fallback';
            }

            diagnostics.protocol.selector_ab_selected_variant = selectedVariant;
            diagnostics.protocol.selector_ab_selection_reason = selectionReason;
            zktimePayload = selectedPayload;
            firstCyclePullPath = selectedPullPath || firstCyclePullPath;
            break;
          }
        }
        if (sequenceStep.stepId === 'pull_request') {
          const pendingStateBefore = { session_id: sessionId, reply_id: replyId };
          const pending = await collectK80PrePullPendingFrames();
          diagnostics.protocol.zktime_pre_pull_pending_frames = pending.frames;
          diagnostics.protocol.zktime_pre_pull_pending_timeout = pending.timeoutHit;
          diagnostics.protocol.zktime_pre_pull_pending_fatal_error = pending.fatalError || null;
          diagnostics.protocol.zktime_pre_pull_state_before = pendingStateBefore;

          const lastParsedPendingFrame = pending.frames
            .slice()
            .reverse()
            .find(frame => frame.parse_ok && Number.isInteger(frame.reply_id));
          if (lastParsedPendingFrame) {
            if (Number.isInteger(lastParsedPendingFrame.session_id)
              && lastParsedPendingFrame.session_id === sessionId) {
              replyId = lastParsedPendingFrame.reply_id;
              diagnostics.protocol.zktime_pre_pull_state_adjusted = true;
            } else {
              diagnostics.protocol.zktime_pre_pull_session_mismatch = {
                expected_session_id: sessionId,
                observed_session_id: Number.isInteger(lastParsedPendingFrame.session_id)
                  ? lastParsedPendingFrame.session_id
                  : null
              };
            }
          }

          diagnostics.protocol.zktime_pre_pull_state_after = { session_id: sessionId, reply_id: replyId };
          if (pending.fatalError) {
            return failWithContext({
              failureStage: 'attlog',
              failureReason: FAILURE_REASON.ATTLOG_STAGE_FAILED,
              failureStep: 'pull_request_pre_pending',
              lifecycleStage: 'followup',
              error: pending.fatalError
            });
          }
        }

        const result = await runZkTimeK80Step(sequenceStep);
        if (!result.ok && sequenceStep.required !== false) {
          return failWithContext({
            failureStage: diagnostics.failure_stage || 'attlog',
            failureReason: diagnostics.failure_reason || FAILURE_REASON.ATTLOG_STAGE_FAILED,
            failureStep: diagnostics.protocol.zktime_sequence_failure_step || sequenceStep.stepId,
            lifecycleStage: 'sequence_step'
          });
        }
        if (sequenceStep.stepId === 'pull_request' && Buffer.isBuffer(result.payload)) {
          zktimePayload = result.payload;
          firstCyclePullPath = diagnostics.protocol.zktime_pull_path || null;
        }
      }

      if (k80LedgerRefreshPolicy.enabled && zktimePayload.length > 0) {
        const cycleSummaries = [];
        const cycle1Summary = summarizeCyclePayload(zktimePayload);
        const cycle1KeySet = new Set(cycle1Summary.normalized_event_keys);
        let selectedPayload = zktimePayload;
        let selectedCycleIndex = 1;
        let selectedNormalizedEvents = cycle1Summary.normalized_events_count;
        let selectedNewVsCycle1 = 0;

        cycleSummaries.push({
          cycle_index: 1,
          payload_bytes: cycle1Summary.payload_bytes,
          pull_path: firstCyclePullPath,
          parser_candidates: cycle1Summary.parser_candidates,
          normalized_events_count: cycle1Summary.normalized_events_count,
          first_event_local: cycle1Summary.first_event_local,
          last_event_local: cycle1Summary.last_event_local,
          new_events_vs_cycle1: 0,
          improved_over_cycle1: false
        });

        const maxCycles = Math.max(1, Number.isInteger(k80LedgerRefreshPolicy.max_cycles)
          ? k80LedgerRefreshPolicy.max_cycles
          : 1);
        for (let cycleIndex = 2; cycleIndex <= maxCycles; cycleIndex += 1) {
          if (k80LedgerRefreshPolicy.interval_ms > 0) {
            await new Promise(resolve => setTimeout(resolve, k80LedgerRefreshPolicy.interval_ms));
          }

          const cycleResult = await runZkTimeK80Step({
            stepId: 'pull_request',
            command: COMMANDS.ZKTIME_PULL_REQUEST,
            payload: Buffer.from('010d000000000000000000', 'hex'),
            expectedResponseCommand: COMMANDS.ZKTIME_PULL_RESPONSE,
            required: false
          });
          const cyclePullPath = diagnostics.protocol.zktime_pull_path || null;
          let cycleSummary = {
            cycle_index: cycleIndex,
            payload_bytes: 0,
            pull_path: cyclePullPath,
            parser_candidates: 0,
            normalized_events_count: 0,
            first_event_local: null,
            last_event_local: null,
            new_events_vs_cycle1: 0,
            improved_over_cycle1: false
          };

          if (cycleResult.ok && Buffer.isBuffer(cycleResult.payload) && cycleResult.payload.length > 0) {
            const parsedCycle = summarizeCyclePayload(cycleResult.payload);
            const newVsCycle1 = parsedCycle.normalized_event_keys
              .filter(key => !cycle1KeySet.has(key))
              .length;
            const improvedOverCycle1 = newVsCycle1 > 0
              || parsedCycle.normalized_events_count > cycle1Summary.normalized_events_count;
            cycleSummary = {
              cycle_index: cycleIndex,
              payload_bytes: parsedCycle.payload_bytes,
              pull_path: cyclePullPath,
              parser_candidates: parsedCycle.parser_candidates,
              normalized_events_count: parsedCycle.normalized_events_count,
              first_event_local: parsedCycle.first_event_local,
              last_event_local: parsedCycle.last_event_local,
              new_events_vs_cycle1: newVsCycle1,
              improved_over_cycle1: improvedOverCycle1
            };

            if (improvedOverCycle1) {
              const isBetterSelection = parsedCycle.normalized_events_count > selectedNormalizedEvents
                || (parsedCycle.normalized_events_count === selectedNormalizedEvents
                  && newVsCycle1 > selectedNewVsCycle1);
              if (isBetterSelection) {
                selectedPayload = cycleResult.payload;
                selectedCycleIndex = cycleIndex;
                selectedNormalizedEvents = parsedCycle.normalized_events_count;
                selectedNewVsCycle1 = newVsCycle1;
              }
            }
          }

          cycleSummaries.push(cycleSummary);
        }

        diagnostics.protocol.zktime_ledger_refresh_executed = cycleSummaries.length > 1;
        diagnostics.protocol.zktime_ledger_refresh_selected_cycle_index = selectedCycleIndex;
        diagnostics.protocol.zktime_ledger_refresh_improved_over_cycle1 = selectedCycleIndex > 1;
        diagnostics.protocol.zktime_ledger_refresh_cycles_summary = cycleSummaries.slice(0, 8);
        zktimePayload = selectedPayload;
      }

      if (k80FreeDataPolicy.enabled && zktimePayload.length > 0) {
        const freeDataStep = await runZkTimeK80Step({
          stepId: 'pull_free_data',
          command: COMMANDS.FREE_DATA,
          payload: Buffer.alloc(0),
          expectedResponseCommand: ACK.OK,
          required: false
        });
        diagnostics.protocol.zktime_free_data_executed = true;
        diagnostics.protocol.zktime_free_data_ok = freeDataStep.ok === true;
        diagnostics.protocol.zktime_free_data_response_command = Number.isInteger(freeDataStep.response_command)
          ? freeDataStep.response_command
          : null;
      }

      const cleanupStep = await runZkTimeK80Step({
        stepId: 'cleanup',
        command: COMMANDS.ZKTIME_CLEANUP,
        payload: Buffer.alloc(0),
        required: false
      });
      if (!cleanupStep.ok) {
        diagnostics.protocol.zktime_sequence_failure_step = diagnostics.protocol.zktime_sequence_failure_step || 'cleanup';
      }

      diagnostics.protocol.data_mode = 'zktime_k80_sequence';
      diagnostics.protocol.data_packets = zktimePayload.length > 0 ? 1 : 0;
      diagnostics.protocol.data_bytes = zktimePayload.length;
      diagnostics.protocol.data_first_payload_hex = zktimePayload.length > 0 ? bufferToHex(zktimePayload) : null;
      diagnostics.protocol.zktime_sequence_data_received = zktimePayload.length > 0;
      diagnostics.protocol.zktime_sequence_data_payload_bytes = zktimePayload.length;
      diagnostics.protocol.zktime_sequence_data_payload_hex = zktimePayload.length > 0
        ? bufferToHex(zktimePayload)
        : null;
      diagnostics.protocol.final_attlog_payload_bytes = zktimePayload.length;
      const holdAttlogSummary = summarizeCyclePayload(zktimePayload);
      diagnostics.protocol.zktime_session_context_hold_attlog_payload_bytes = holdAttlogSummary.payload_bytes;
      diagnostics.protocol.zktime_session_context_hold_attlog_parser_candidates = holdAttlogSummary.parser_candidates;
      diagnostics.protocol.zktime_session_context_hold_attlog_normalized_events_count =
        holdAttlogSummary.normalized_events_count;
      diagnostics.protocol.zktime_session_context_hold_attlog_first_event_local =
        holdAttlogSummary.first_event_local;
      diagnostics.protocol.zktime_session_context_hold_attlog_last_event_local =
        holdAttlogSummary.last_event_local;
      diagnostics.protocol.final_parser_merged_candidates = holdAttlogSummary.parser_candidates;
      diagnostics.protocol.final_events_count = holdAttlogSummary.normalized_events_count;
      diagnostics.protocol.earliest_event_time_utc =
        Array.isArray(holdAttlogSummary.normalized_events) && holdAttlogSummary.normalized_events.length > 0
          ? holdAttlogSummary.normalized_events[0].event_time_utc
          : null;
      diagnostics.protocol.latest_event_time_utc =
        Array.isArray(holdAttlogSummary.normalized_events) && holdAttlogSummary.normalized_events.length > 0
          ? holdAttlogSummary.normalized_events[holdAttlogSummary.normalized_events.length - 1].event_time_utc
          : null;

      if (zktimePayload.length === 0) {
        diagnostics.protocol.data_followup_timeout = true;
        return failWithContext({
          failureStage: 'data',
          failureReason: FAILURE_REASON.ATTLOG_STAGE_FAILED,
          failureStep: diagnostics.protocol.zktime_sequence_failure_step || 'pull_request',
          lifecycleStage: 'final_result'
        });
      }

      setLifecycleStage('final_result');
      return {
        ok: true,
        data: zktimePayload,
        alternate_payloads: {
          premode_2710_drained_payload: premode2710DrainedPayload
        },
        diagnostics
      };
    }

    if (resolvedAttlogSequence !== ATTLOG_SEQUENCE.OFF) {
      setLifecycleStage('pre_sequence');
      diagnostics.protocol.preflight_enabled = true;
      diagnostics.protocol.preflight_profile = resolvedAttlogSequence;

      const preflightSteps = [
        {
          stepId: 'device_id',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('DeviceID\x00', 'ascii'),
          valueField: 'preflight_device_id'
        },
        {
          stepId: 'platform',
          command: COMMANDS.OPTIONS_RRQ,
          payload: Buffer.from('~Platform\x00', 'ascii'),
          valueField: 'preflight_platform'
        }
      ];
      if (resolvedAttlogSequence === ATTLOG_SEQUENCE.DEVICEID_PLATFORM_VERSION) {
        preflightSteps.push({
          stepId: 'version',
          command: COMMANDS.GET_VERSION,
          payload: Buffer.alloc(0),
          valueField: 'preflight_version'
        });
      }

      for (const preflightStep of preflightSteps) {
        await runAttlogPreflightStep(preflightStep);
      }
    }

    async function collectTcpDataPayload({ expectedBytes = 0, mode }) {
      const chunks = [];
      let packets = 0;
      let bytes = 0;
      diagnostics.protocol.data_mode = mode;
      while (packets < maxPackets && (expectedBytes <= 0 || bytes < expectedBytes)) {
        let frame;
        try {
          frame = await receiveFrameWithSessionTap(timeoutMs, 'attlog_data_followup');
        } catch (err) {
          const code = err && err.code ? String(err.code) : '';
          if (code === 'REPLY_TIMEOUT') {
            diagnostics.protocol.data_followup_timeout = true;
            break;
          }
          diagnostics.protocol.data_parse_failure_layer = 'framing';
          diagnostics.protocol.data_framing_error = code || FAILURE_REASON.ATTLOG_STAGE_FAILED;
          diagnostics.failure_reason = code === FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH
            ? FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH
            : FAILURE_REASON.ATTLOG_STAGE_FAILED;
          diagnostics.failure_stage = 'data';
          return { fatal: true, buffer: Buffer.alloc(0) };
        }

        if (!diagnostics.protocol.data_first_packet_hex) {
          diagnostics.protocol.data_first_packet_hex = bufferToHex(frame.payload);
        }

        const parsed = parsePacket(frame.payload);
        if (!parsed) {
          diagnostics.protocol.parse_failures += 1;
          diagnostics.protocol.data_inner_packet_parse_failures += 1;
          diagnostics.protocol.data_parse_failure_layer = 'framing';
          continue;
        }

        packets += 1;
        if (parsed.command === COMMANDS.DATA || parsed.command === ACK.DATA || parsed.command === ACK.OK) {
          if (!diagnostics.protocol.data_first_payload_hex && parsed.payload.length > 0) {
            diagnostics.protocol.data_first_payload_hex = bufferToHex(parsed.payload);
          }
          if (parsed.payload.length > 0) {
            chunks.push(parsed.payload);
            bytes += parsed.payload.length;
          }
        }

        if (expectedBytes > 0 && bytes >= expectedBytes) {
          break;
        }
      }

      diagnostics.protocol.data_packets = packets;
      diagnostics.protocol.data_bytes = bytes;
      return {
        fatal: false,
        buffer: Buffer.concat(chunks)
      };
    }

    const attlogTrace = { stage: 'attlog' };
    setLifecycleStage('sequence_step', 'attlog_request');
    const attLogReply = await sendTcpCommandWithSessionTap({
      channel,
      timeoutMs,
      command: COMMANDS.ATTLOG_RRQ,
      sessionId,
      replyId,
      payload: Buffer.alloc(0),
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
      deviceNumber,
      trace: attlogTrace
    });

    if (attlogTrace.response) {
      diagnostics.protocol.attlog_response_hex = attlogTrace.response.inner_packet_hex || null;
      diagnostics.protocol.attlog_response_payload_hex = attlogTrace.response.payload_hex || null;
    }

    if (!attLogReply.ok || !attLogReply.response) {
      if (attlogTrace.error === FAILURE_REASON.ACK_PARSE_FAILED
        || attlogTrace.error === FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH) {
        diagnostics.protocol.data_parse_failure_layer = 'framing';
        diagnostics.protocol.data_framing_error = attlogTrace.error;
      }
      return failWithContext({
        failureStage: 'attlog',
        failureReason: attLogReply.error === FAILURE_REASON.ACK_PARSE_FAILED
          ? FAILURE_REASON.ACK_PARSE_FAILED
          : FAILURE_REASON.ATTLOG_STAGE_FAILED,
        failureStep: 'attlog_request',
        lifecycleStage: 'sequence_step',
        error: attLogReply.error || attlogTrace.error
      });
    }

    diagnostics.protocol.wrapper_profile = attLogReply.wrapper || diagnostics.protocol.wrapper_profile;
    diagnostics.protocol.attlog_ack = attLogReply.response.command;
    diagnostics.protocol.attlog_prepare_data_received = attLogReply.response.command === COMMANDS.PREPARE_DATA;
    replyId = attLogReply.response.reply_id;

    if (attLogReply.response.command === ACK.ERROR) {
      return failWithContext({
        failureStage: 'attlog',
        failureReason: FAILURE_REASON.ATTLOG_STAGE_FAILED,
        failureStep: 'attlog_request',
        lifecycleStage: 'sequence_step'
      });
    }

    let dataBuffer = Buffer.alloc(0);
    let shouldSendFreeData = false;
    let expectedBytes = null;

    if (attLogReply.response.command === COMMANDS.PREPARE_DATA || attLogReply.response.command === ACK.DATA) {
      expectedBytes = attLogReply.response.payload.length >= 4
        ? attLogReply.response.payload.readUInt32LE(0)
        : 0;
      diagnostics.protocol.attlog_expected_bytes = expectedBytes;
      const collected = await collectTcpDataPayload({
        expectedBytes,
        mode: attLogReply.response.command === COMMANDS.PREPARE_DATA ? 'prepare_data' : 'ack_data'
      });
      if (collected.fatal) {
        return failWithContext({
          failureStage: diagnostics.failure_stage || 'data',
          failureReason: diagnostics.failure_reason || FAILURE_REASON.ATTLOG_STAGE_FAILED,
          failureStep: diagnostics.failure_step || 'collect_data',
          lifecycleStage: 'followup'
        });
      }
      dataBuffer = collected.buffer;
      shouldSendFreeData = true;
    } else if (attLogReply.response.command === ACK.OK && attLogReply.response.payload.length > 0) {
      diagnostics.protocol.data_mode = 'ack_ok_inline';
      diagnostics.protocol.data_first_packet_hex = diagnostics.protocol.attlog_response_hex || null;
      diagnostics.protocol.data_first_payload_hex = bufferToHex(attLogReply.response.payload);
      dataBuffer = attLogReply.response.payload;
      diagnostics.protocol.data_bytes = attLogReply.response.payload.length;
      diagnostics.protocol.data_packets = 1;
    } else if (attLogReply.response.command === ACK.OK) {
      diagnostics.protocol.attlog_expected_bytes = 0;
      const collected = await collectTcpDataPayload({
        expectedBytes: 0,
        mode: 'ack_ok_followup'
      });
      if (collected.fatal) {
        return failWithContext({
          failureStage: diagnostics.failure_stage || 'data',
          failureReason: diagnostics.failure_reason || FAILURE_REASON.ATTLOG_STAGE_FAILED,
          failureStep: diagnostics.failure_step || 'collect_data',
          lifecycleStage: 'followup'
        });
      }
      dataBuffer = collected.buffer;
      shouldSendFreeData = true;
    } else {
      return failWithContext({
        failureStage: 'attlog',
        failureReason: FAILURE_REASON.ATTLOG_STAGE_FAILED,
        failureStep: 'attlog_response_unexpected',
        lifecycleStage: 'sequence_step'
      });
    }

    if (shouldSendFreeData) {
      try {
        replyId = nextReplyId(replyId);
        await sendTcpCommandWithSessionTap({
          channel,
          timeoutMs: Math.min(timeoutMs, 500),
          command: COMMANDS.FREE_DATA,
          sessionId,
          replyId,
          payload: Buffer.alloc(0),
          noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
          deviceNumber
        });
      } catch (err) {
        // no-op
      }
    }

    if (dataBuffer.length === 0) {
      return failWithContext({
        failureStage: 'data',
        failureReason: probeMode ? FAILURE_REASON.ATTLOG_STAGE_FAILED : 'empty_data',
        failureStep: 'data_empty',
        lifecycleStage: 'final_result'
      });
    }

    setLifecycleStage('final_result');
    return {
      ok: true,
      data: dataBuffer,
      alternate_payloads: {
        premode_2710_drained_payload: premode2710DrainedPayload
      },
      diagnostics
    };
  } catch (err) {
    const failureStage = normalizeText(diagnostics.failure_stage) || 'fatal_unhandled_exception';
    const failureReason = normalizeText(diagnostics.failure_reason) || mapSocketErrorCode(err);
    return failWithContext({
      failureStage,
      failureReason,
      failureStep: diagnostics.failure_step || diagnostics.protocol.zktime_sequence_failure_step || null,
      lifecycleStage: 'final_result',
      error: err
    });
  } finally {
    try {
      replyId = nextReplyId(replyId);
      await sendTcpCommandWithSessionTap({
        channel,
        timeoutMs: Math.min(timeoutMs, 500),
        command: COMMANDS.EXIT,
        sessionId,
        replyId,
        payload: Buffer.alloc(0),
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
        deviceNumber
      });
    } catch (err) {
      // ignore disconnect failures
    }
    channel.close();
  }
}

async function fetchAttendanceBuffer({
  host,
  port,
  timeoutMs,
  authPassword,
  maxPackets,
  transport,
  deviceNumber,
  probeMode,
  attlogSequence,
  deviceUid,
  statusMap,
  vendor,
  ingestMethod,
  deviceTimezone,
  requestedSinceUtc,
  maxEvents,
  connectOnlyProbe,
  connectOnlyProbeHoldMs
}) {
  const requested = normalizeTransportMode(transport, TRANSPORT.UDP);

  if (requested === TRANSPORT.UDP) {
    const udpResult = await fetchAttendanceBufferUdp({
      host,
      port,
      timeoutMs,
      authPassword,
      maxPackets,
      probeMode
    });
    if (udpResult && udpResult.diagnostics && udpResult.diagnostics.protocol) {
      udpResult.diagnostics.protocol.transport_requested = requested;
      udpResult.diagnostics.protocol.transport_used = TRANSPORT.UDP;
    }
    if (udpResult && udpResult.diagnostics) {
      udpResult.diagnostics.failure_reason = normalizeFailureReasonForOutput(
        udpResult.diagnostics.failure_reason,
        probeMode
      );
      if (udpResult.ok !== true) {
        udpResult.diagnostics = ensureFailureDiagnosticsShape(udpResult.diagnostics, {
          fallbackStage: udpResult.diagnostics.failure_stage || 'connect',
          fallbackReason: udpResult.diagnostics.failure_reason || FAILURE_REASON.SOCKET_CONNECT_FAILED
        });
      }
    }
    return udpResult;
  }

  if (requested === TRANSPORT.TCP) {
    const tcpResult = await fetchAttendanceBufferTcp({
      host,
      port,
      timeoutMs,
      authPassword,
      maxPackets,
      deviceNumber,
      probeMode,
      attlogSequence,
      deviceUid,
      statusMap,
      vendor,
      ingestMethod,
      deviceTimezone,
      requestedSinceUtc,
      maxEvents,
      connectOnlyProbe,
      connectOnlyProbeHoldMs
    });
    if (tcpResult && tcpResult.diagnostics && tcpResult.diagnostics.protocol) {
      tcpResult.diagnostics.protocol.transport_requested = requested;
      tcpResult.diagnostics.protocol.transport_used = TRANSPORT.TCP;
    }
    if (tcpResult && tcpResult.diagnostics) {
      tcpResult.diagnostics.failure_reason = normalizeFailureReasonForOutput(
        tcpResult.diagnostics.failure_reason,
        probeMode
      );
      if (tcpResult.ok !== true) {
        tcpResult.diagnostics = ensureFailureDiagnosticsShape(tcpResult.diagnostics, {
          fallbackStage: tcpResult.diagnostics.failure_stage || 'connect',
          fallbackReason: tcpResult.diagnostics.failure_reason || FAILURE_REASON.SOCKET_CONNECT_FAILED
        });
      }
    }
    return tcpResult;
  }

  const attempts = [];

  const udpAttempt = await fetchAttendanceBufferUdp({
    host,
    port,
    timeoutMs,
    authPassword,
    maxPackets,
    probeMode
  });
  attempts.push({
    transport: TRANSPORT.UDP,
    ok: udpAttempt.ok === true,
    failure_reason: udpAttempt.diagnostics ? udpAttempt.diagnostics.failure_reason : null
  });
  if (udpAttempt.ok) {
    if (udpAttempt.diagnostics && udpAttempt.diagnostics.protocol) {
      udpAttempt.diagnostics.protocol.transport_requested = requested;
      udpAttempt.diagnostics.protocol.transport_used = TRANSPORT.UDP;
      udpAttempt.diagnostics.protocol.transport_attempts = attempts;
    }
    if (udpAttempt.diagnostics) {
      udpAttempt.diagnostics.failure_reason = normalizeFailureReasonForOutput(
        udpAttempt.diagnostics.failure_reason,
        probeMode
      );
      if (udpAttempt.ok !== true) {
        udpAttempt.diagnostics = ensureFailureDiagnosticsShape(udpAttempt.diagnostics, {
          fallbackStage: udpAttempt.diagnostics.failure_stage || 'connect',
          fallbackReason: udpAttempt.diagnostics.failure_reason || FAILURE_REASON.SOCKET_CONNECT_FAILED
        });
      }
    }
    return udpAttempt;
  }

  const tcpAttempt = await fetchAttendanceBufferTcp({
    host,
    port,
    timeoutMs,
    authPassword,
    maxPackets,
    deviceNumber,
    probeMode,
    attlogSequence,
    deviceUid,
    statusMap,
    vendor,
    ingestMethod,
    deviceTimezone,
    requestedSinceUtc,
    maxEvents,
    connectOnlyProbe,
    connectOnlyProbeHoldMs
  });
  attempts.push({
    transport: TRANSPORT.TCP,
    ok: tcpAttempt.ok === true,
    failure_reason: tcpAttempt.diagnostics ? tcpAttempt.diagnostics.failure_reason : null
  });
  if (tcpAttempt.ok) {
    if (tcpAttempt.diagnostics && tcpAttempt.diagnostics.protocol) {
      tcpAttempt.diagnostics.protocol.transport_requested = requested;
      tcpAttempt.diagnostics.protocol.transport_used = TRANSPORT.TCP;
      tcpAttempt.diagnostics.protocol.transport_attempts = attempts;
      tcpAttempt.diagnostics.protocol.udp_attempt_failure_reason = attempts[0].failure_reason;
    }
    if (tcpAttempt.diagnostics) {
      tcpAttempt.diagnostics.failure_reason = normalizeFailureReasonForOutput(
        tcpAttempt.diagnostics.failure_reason,
        probeMode
      );
      if (tcpAttempt.ok !== true) {
        tcpAttempt.diagnostics = ensureFailureDiagnosticsShape(tcpAttempt.diagnostics, {
          fallbackStage: tcpAttempt.diagnostics.failure_stage || 'connect',
          fallbackReason: tcpAttempt.diagnostics.failure_reason || FAILURE_REASON.SOCKET_CONNECT_FAILED
        });
      }
    }
    return tcpAttempt;
  }

  const failureReason = normalizeFailureReasonForOutput(
    (tcpAttempt.diagnostics && tcpAttempt.diagnostics.failure_reason)
      || (udpAttempt.diagnostics && udpAttempt.diagnostics.failure_reason)
      || FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH,
    probeMode
  );

  return {
    ok: false,
    diagnostics: ensureFailureDiagnosticsShape({
      protocol: {
        host,
        port,
        transport_requested: requested,
        transport_used: null,
        transport_attempts: attempts
      },
      failure_reason: failureReason,
      failure_stage: (tcpAttempt.diagnostics && tcpAttempt.diagnostics.failure_stage)
        || (udpAttempt.diagnostics && udpAttempt.diagnostics.failure_stage)
        || 'connect'
    }, {
      fallbackStage: 'connect',
      fallbackReason: failureReason
    })
  };
}

function normalizePulledEvents({
  rawEvents,
  deviceUid,
  vendor,
  ingestMethod,
  deviceTimezone,
  requestedSinceUtc,
  maxEvents,
  k80RtEnrichment,
  attlogSequence,
  historyMode,
  historyBeforeUtc,
  historyBeforeDedupKey,
  normalizationReasonDiagnosticsPolicy = null
}) {
  const PULL_DIRECTION_PROVENANCE_CONTRACT_VERSION = 'pull_direction_provenance_v1';
  const events = [];
  const parseErrors = [];
  const sinceMs = requestedSinceUtc ? new Date(requestedSinceUtc).getTime() : null;
  const k80AuthoritativePolicy = resolveK80AuthoritativeDirectionPolicy({
    vendor,
    deviceUid,
    attlogSequence
  });
  const reasonDiagEnabled = Boolean(
    normalizationReasonDiagnosticsPolicy
    && normalizationReasonDiagnosticsPolicy.enabled === true
  );
  const reasonDiagMaxRows = reasonDiagEnabled
    ? Math.max(1, Math.min(
      Number.isInteger(normalizationReasonDiagnosticsPolicy.max_rows)
        ? normalizationReasonDiagnosticsPolicy.max_rows
        : 100,
      500
    ))
    : 0;
  const reasonDiag = reasonDiagEnabled
    ? {
      merged_input_count: Array.isArray(rawEvents) ? rawEvents.length : 0,
      dropped_requested_since_utc_count: 0,
      dropped_invalid_utc_derivation_count: 0,
      dropped_invalid_direction_count: 0,
      dropped_other_gate_count: 0,
      survived_normalization_count: 0,
      samples: {
        dropped_requested_since_utc: [],
        dropped_invalid_utc_derivation: [],
        dropped_invalid_direction: [],
        dropped_other_gate: [],
        survived_normalization: []
      }
    }
    : null;
  const newestFirstEmitPolicy = resolveK80NewestFirstEmitPolicy({
    vendor,
    attlogSequence,
    deviceUid
  });
  const historyDrainPolicy = resolveK80HistoryDrainModePolicy({
    vendor,
    attlogSequence,
    deviceUid
  });
  const historyDrainModeRequested = normalizeText(historyMode).toLowerCase() === 'history_drain';
  const historyDrainModeEnabled = historyDrainPolicy.enabled && historyDrainModeRequested;
  const historyBoundaryBeforeUtcExclusiveRaw = normalizeText(historyBeforeUtc);
  const historyBoundaryBeforeUtcExclusive = historyBoundaryBeforeUtcExclusiveRaw
    && !Number.isNaN(new Date(historyBoundaryBeforeUtcExclusiveRaw).getTime())
    ? new Date(historyBoundaryBeforeUtcExclusiveRaw).toISOString()
    : null;
  const historyBoundaryBeforeMs = historyBoundaryBeforeUtcExclusive
    ? new Date(historyBoundaryBeforeUtcExclusive).getTime()
    : null;
  const historyBoundaryBeforeDedupKeyExclusive = normalizeText(historyBeforeDedupKey).toLowerCase() || null;
  let historyBoundaryDroppedCount = 0;
  const pushReasonSample = (bucketName, payload) => {
    if (!reasonDiag || !reasonDiag.samples || !Array.isArray(reasonDiag.samples[bucketName])) {
      return;
    }
    if (reasonDiag.samples[bucketName].length >= reasonDiagMaxRows) {
      return;
    }
    reasonDiag.samples[bucketName].push(payload);
  };

  for (const raw of rawEvents) {
    const eventTimeUtc = localDateTimeToUtcIso(raw.event_time_local, deviceTimezone);
    if (!eventTimeUtc) {
      if (reasonDiag) {
        reasonDiag.dropped_invalid_utc_derivation_count += 1;
        pushReasonSample('dropped_invalid_utc_derivation', {
          reason_bucket: 'invalid_utc_derivation',
          person: normalizeText(raw.person),
          event_time_local: normalizeText(raw.event_time_local),
          event_time_utc: null,
          direction: normalizeDirection(raw.direction),
          status_code: raw.status_code ?? null,
          verify_state: normalizeText(raw.verify_state) || null,
          verify_method: normalizeText(raw.verify_method) || null,
          parser: normalizeText(raw.parser) || null
        });
      }
      parseErrors.push({
        code: 'time_conversion_failed',
        person: raw.person,
        event_time_local: raw.event_time_local
      });
      continue;
    }
    if (sinceMs !== null && new Date(eventTimeUtc).getTime() < sinceMs) {
      if (reasonDiag) {
        reasonDiag.dropped_requested_since_utc_count += 1;
        pushReasonSample('dropped_requested_since_utc', {
          reason_bucket: 'requested_since_utc',
          person: normalizeText(raw.person),
          event_time_local: normalizeText(raw.event_time_local),
          event_time_utc: eventTimeUtc,
          direction: normalizeDirection(raw.direction),
          status_code: raw.status_code ?? null,
          verify_state: normalizeText(raw.verify_state) || null,
          verify_method: normalizeText(raw.verify_method) || null,
          parser: normalizeText(raw.parser) || null
        });
      }
      continue;
    }
    const legacyDirection = normalizeDirection(raw.direction);
    if (legacyDirection !== 'IN' && legacyDirection !== 'OUT') {
      if (reasonDiag) {
        reasonDiag.dropped_invalid_direction_count += 1;
        pushReasonSample('dropped_invalid_direction', {
          reason_bucket: 'invalid_direction',
          person: normalizeText(raw.person),
          event_time_local: normalizeText(raw.event_time_local),
          event_time_utc: eventTimeUtc,
          direction: normalizeText(raw.direction),
          status_code: raw.status_code ?? null,
          verify_state: normalizeText(raw.verify_state) || null,
          verify_method: normalizeText(raw.verify_method) || null,
          parser: normalizeText(raw.parser) || null
        });
      }
      parseErrors.push({
        code: 'invalid_direction',
        person: raw.person,
        direction: raw.direction
      });
      continue;
    }

    events.push({
      device_uid: deviceUid,
      vendor,
      ingest_method: ingestMethod,
      device_person_id: raw.person,
      event_time_local: raw.event_time_local,
      event_time_utc: eventTimeUtc,
      device_timezone: deviceTimezone,
      direction: legacyDirection,
      event_type: legacyDirection,
      verify_state: raw.verify_state || null,
      verify_method: raw.verify_method || null,
      raw: {
        parser: raw.parser,
        status_code: raw.status_code ?? null,
        direction_provenance_contract_version: PULL_DIRECTION_PROVENANCE_CONTRACT_VERSION,
        direction_source_lane: 'pull_attlog_status',
        direction_basis: 'attendance_status_map',
        direction_basis_field: 'status_code',
        direction_authority: 'non_authoritative',
        direction_confidence: 'low',
        direction_flattening: 'status_to_in_out'
      }
    });

    // Slice 1: non-authoritative K80 enrichment metadata only; business direction stays unchanged.
    if (k80RtEnrichment && isPlainObject(k80RtEnrichment.stateMap)) {
      const correlationKey = buildK80RtCorrelationKey(raw.person, raw.event_time_local);
      const rtStateCode = correlationKey ? k80RtEnrichment.stateMap[correlationKey] : '';
      if (rtStateCode) {
        const provisionalLabel = mapK80RtStateLabelProvisional(rtStateCode);
        const targetRaw = events[events.length - 1].raw;
        targetRaw.k80_rt_state_code = rtStateCode;
        targetRaw.k80_rt_state_label_provisional = provisionalLabel || null;
        targetRaw.k80_rt_correlation_source = k80RtEnrichment.source;
        targetRaw.k80_rt_correlation_confidence = k80RtEnrichment.confidenceByKey
          && k80RtEnrichment.confidenceByKey[correlationKey]
          ? k80RtEnrichment.confidenceByKey[correlationKey]
          : k80RtEnrichment.confidence;
        targetRaw.k80_rt_correlation_match_window_ms = Number.isInteger(k80RtEnrichment.matchWindowMs)
          ? k80RtEnrichment.matchWindowMs
          : null;
        targetRaw.k80_rt_correlation_basis = k80RtEnrichment.basisByKey
          && k80RtEnrichment.basisByKey[correlationKey]
          ? k80RtEnrichment.basisByKey[correlationKey]
          : null;
      }
    }

    const targetEvent = events[events.length - 1];
    const targetRaw = targetEvent.raw;
    let finalDirection = legacyDirection;

    if (k80AuthoritativePolicy.enabled) {
      let decisionSource = 'legacy_status_map';
      let fallbackReason = null;
      const mappedRtDirection = mapK80RtStateCodeToDirection(targetRaw.k80_rt_state_code);
      const rtConfidence = normalizeText(targetRaw.k80_rt_correlation_confidence).toLowerCase();

      if (!normalizeText(targetRaw.k80_rt_state_code)) {
        fallbackReason = 'missing_rt_state_code';
      } else if (!mappedRtDirection) {
        fallbackReason = 'unknown_rt_state_code';
      } else if (rtConfidence !== 'provisional_high') {
        fallbackReason = 'unqualified_rt_confidence';
      } else {
        finalDirection = mappedRtDirection;
        decisionSource = 'k80_rt_authoritative';
      }

      targetRaw.k80_direction_decision_source = decisionSource;
      if (fallbackReason) {
        targetRaw.k80_direction_legacy_fallback_reason = fallbackReason;
      }
    }

    const dedupKey = buildDedupKey({
      vendor,
      deviceUid,
      devicePersonId: raw.person,
      eventTimeUtc,
      direction: finalDirection,
      verifyState: raw.verify_state || '',
      verifyMethod: raw.verify_method || ''
    });

    targetEvent.direction = finalDirection;
    targetEvent.event_type = finalDirection;
    targetEvent.dedup_key = dedupKey;
    targetRaw.direction_basis_value = targetRaw.status_code ?? null;
    targetRaw.direction_flattened_value = finalDirection;

    if (historyDrainModeEnabled && Number.isFinite(historyBoundaryBeforeMs)) {
      const eventMs = new Date(eventTimeUtc).getTime();
      let keepByBoundary = Number.isFinite(eventMs) && eventMs < historyBoundaryBeforeMs;
      if (!keepByBoundary && Number.isFinite(eventMs) && eventMs === historyBoundaryBeforeMs) {
        if (historyBoundaryBeforeDedupKeyExclusive) {
          keepByBoundary = normalizeText(dedupKey).toLowerCase() < historyBoundaryBeforeDedupKeyExclusive;
        } else {
          keepByBoundary = false;
        }
      }
      if (!keepByBoundary) {
        historyBoundaryDroppedCount += 1;
        events.pop();
        if (reasonDiag) {
          reasonDiag.dropped_other_gate_count += 1;
          pushReasonSample('dropped_other_gate', {
            reason_bucket: 'history_before_boundary_exclusive',
            person: normalizeText(raw.person),
            event_time_local: normalizeText(raw.event_time_local),
            event_time_utc: eventTimeUtc,
            direction: normalizeText(finalDirection),
            status_code: raw.status_code ?? null,
            verify_state: normalizeText(raw.verify_state) || null,
            verify_method: normalizeText(raw.verify_method) || null,
            parser: normalizeText(raw.parser) || null
          });
        }
      }
    }
  }

  const orderedAsc = events
    .sort((a, b) => a.event_time_utc.localeCompare(b.event_time_utc));
  const emitCapApplied = orderedAsc.length > maxEvents;
  const emitOrdering = (emitCapApplied && newestFirstEmitPolicy.enabled)
    ? 'newest_first'
    : 'oldest_first';
  let limited = orderedAsc;
  if (emitCapApplied) {
    if (newestFirstEmitPolicy.enabled) {
      limited = orderedAsc
        .slice(-maxEvents)
        .sort((a, b) => b.event_time_utc.localeCompare(a.event_time_utc));
    } else {
      limited = orderedAsc.slice(0, maxEvents);
    }
  }

  if (reasonDiag) {
    reasonDiag.survived_normalization_count = limited.length;
    for (const event of limited) {
      pushReasonSample('survived_normalization', {
        reason_bucket: 'survived_normalization',
        person: normalizeText(event.device_person_id),
        event_time_local: normalizeText(event.event_time_local),
        event_time_utc: normalizeText(event.event_time_utc),
        direction: normalizeText(event.direction),
        status_code: event.raw && Object.prototype.hasOwnProperty.call(event.raw, 'status_code')
          ? event.raw.status_code
          : null,
        verify_state: normalizeText(event.verify_state) || null,
        verify_method: normalizeText(event.verify_method) || null,
        parser: event.raw ? normalizeText(event.raw.parser) || null : null
      });
    }
  }

  const latestEventTimeUtc = limited.length > 0
    ? limited.reduce((maxUtc, event) => {
      if (!maxUtc || event.event_time_utc > maxUtc) {
        return event.event_time_utc;
      }
      return maxUtc;
    }, null)
    : null;

  return {
    events: limited,
    latest_event_time_utc: latestEventTimeUtc,
    parse_errors: parseErrors,
    normalization_reason_diagnostics: reasonDiag,
    emission_ordering: emitOrdering,
    emission_cap_applied: emitCapApplied,
    emission_policy_enabled: newestFirstEmitPolicy.enabled,
    history_mode: historyDrainModeEnabled ? 'history_drain' : 'normal',
    history_mode_requested: historyDrainModeRequested ? 'history_drain' : 'normal',
    history_boundary_before_utc_exclusive: historyBoundaryBeforeUtcExclusive,
    history_boundary_before_dedup_key_exclusive: historyBoundaryBeforeDedupKeyExclusive,
    history_boundary_filter_applied: historyDrainModeEnabled && Number.isFinite(historyBoundaryBeforeMs),
    history_boundary_dropped_count: historyBoundaryDroppedCount
  };
}

async function pullDeviceEvents(commandPayload, options = {}) {
  const deviceUid = normalizeText(commandPayload.device_uid);
  const vendor = normalizeText(commandPayload.vendor).toLowerCase() || 'zkteco';
  const ingestMethod = normalizeText(commandPayload.ingest_method) || 'agent_pull';
  const connection = isPlainObject(commandPayload.connection) ? commandPayload.connection : {};
  const pull = isPlainObject(commandPayload.pull) ? commandPayload.pull : {};
  const payloadOptions = isPlainObject(commandPayload.options) ? commandPayload.options : {};
  const deviceTimezone = normalizeText(pull.device_timezone) || 'Africa/Tunis';
  const requestedSinceUtc = normalizeText(pull.requested_since_utc) || null;
  const requestedSinceOriginalUtc = normalizeText(pull.requested_since_utc_original) || requestedSinceUtc;
  const requestedSinceOriginalSource = normalizeText(pull.requested_since_utc_source) || null;
  const requestedSinceEffectiveSourceFromPayload =
    normalizeText(pull.requested_since_utc_effective_source) || requestedSinceOriginalSource;
  const requestedSinceSourceFixEnteredFromPayload = pull.requested_since_utc_source_fix_entered === true;
  const maxEvents = Number.isInteger(pull.max_events) ? pull.max_events : 500;
  const connectOnlyProbe = pull.connect_only_probe === true || payloadOptions.connect_only_probe === true;
  const connectOnlyProbeHoldMs = connectOnlyProbe
    ? (parsePositiveInt(pull.connect_only_probe_hold_ms, null)
      || parsePositiveInt(payloadOptions.connect_only_probe_hold_ms, 0)
      || 0)
    : 0;
  const timeoutMs = Number.isInteger(options.timeout_ms) ? options.timeout_ms : 1600;
  const maxPackets = Number.isInteger(options.max_packets) ? options.max_packets : 4096;
  const statusMap = parseStatusMap(options);
  const requestedTransport = normalizeTransportMode(
    connection.transport || options.transport,
    TRANSPORT.UDP
  );
  const deviceNumber = Number.isInteger(connection.device_number)
    ? connection.device_number
    : (Number.isInteger(options.device_number) ? options.device_number : null);
  const probeMode = options.probe_mode === true;
  const requestedAttlogSequence = normalizeAttlogSequenceMode(
    connection.attlog_sequence || options.attlog_sequence,
    probeMode ? ATTLOG_SEQUENCE.DEVICEID_PLATFORM : ATTLOG_SEQUENCE.OFF
  );
  const preNormalizationDumpPolicy = resolveK80PreNormalizationDumpPolicy({
    deviceUid
  });
  const normalizationReasonDiagnosticsPolicy = resolveK80NormalizationReasonDiagnosticsPolicy({
    vendor,
    attlogSequence: requestedAttlogSequence,
    deviceUid
  });
  const relaxRequestedSincePolicy = resolveK80RelaxRequestedSincePolicy({
    vendor,
    attlogSequence: requestedAttlogSequence,
    transport: requestedTransport,
    deviceUid
  });
  const historyDrainModePolicy = resolveK80HistoryDrainModePolicy({
    vendor,
    attlogSequence: requestedAttlogSequence,
    deviceUid
  });
  const historyModeRequested = normalizeText(pull.history_mode).toLowerCase() || 'normal';
  const historyBeforeUtcRequested = normalizeText(pull.history_before_utc) || null;
  const historyBeforeDedupKeyRequested = normalizeText(pull.history_before_dedup_key).toLowerCase() || null;
  const historyModeEffective = historyDrainModePolicy.enabled && historyModeRequested === 'history_drain'
    ? 'history_drain'
    : 'normal';
  const historyBeforeUtcEffective = historyModeEffective === 'history_drain'
    ? historyBeforeUtcRequested
    : null;
  const historyBeforeDedupKeyEffective = historyModeEffective === 'history_drain'
    ? historyBeforeDedupKeyRequested
    : null;
  const historyDrainDiagnostics = {
    policy_flag_enabled: historyDrainModePolicy.flag_enabled === true,
    policy_allowlist_applied: historyDrainModePolicy.allowlist_applied === true,
    policy_scope_allowed: historyDrainModePolicy.scope_allowed === true,
    policy_enabled: historyDrainModePolicy.enabled === true,
    mode_requested: historyModeRequested,
    mode_effective: historyModeEffective,
    mode_recognized: historyModeEffective === 'history_drain'
  };
  try {
  if (options.mock_mode) {
    const now = new Date();
    const t1 = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
    const t2 = now.toISOString();
    return {
      ok: true,
      events: [
        {
          device_uid: deviceUid,
          vendor,
          ingest_method: ingestMethod,
          device_person_id: '1001',
          event_time_local: '2026-01-01 08:00:00',
          event_time_utc: t1,
          device_timezone: deviceTimezone,
          direction: 'IN',
          event_type: 'IN',
          verify_state: '0',
          verify_method: null,
          dedup_key: crypto.createHash('sha256').update(`${deviceUid}|1001|${t1}|IN`).digest('hex'),
          raw: { parser: 'mock' }
        },
        {
          device_uid: deviceUid,
          vendor,
          ingest_method: ingestMethod,
          device_person_id: '1001',
          event_time_local: '2026-01-01 17:00:00',
          event_time_utc: t2,
          device_timezone: deviceTimezone,
          direction: 'OUT',
          event_type: 'OUT',
          verify_state: '1',
          verify_method: null,
          dedup_key: crypto.createHash('sha256').update(`${deviceUid}|1001|${t2}|OUT`).digest('hex'),
          raw: { parser: 'mock' }
        }
      ],
      latest_event_time_utc: t2,
      diagnostics: {
        mode: 'mock',
        protocol: {
          host: connection.host || null,
          port: connection.port || PORT_DEFAULT,
          transport_requested: requestedTransport,
          transport_used: 'mock',
          device_number: deviceNumber,
          attlog_sequence_requested: requestedAttlogSequence
        }
      }
    };
  }

  const host = normalizeText(connection.host);
  if (!host) {
    return {
      ok: false,
      events: [],
      latest_event_time_utc: null,
      diagnostics: ensureFailureDiagnosticsShape({
        failure_reason: 'missing_host',
        failure_stage: 'connect',
        failure_step: 'host_validation',
        raw_error_code: null,
        raw_error_message: null,
        last_command_sent: null,
        last_command_hex: null,
        last_response_command: null,
        last_response_command_hex: null,
        last_session_id: null,
        last_reply_id: null,
        protocol: {
          transport_requested: requestedTransport,
          transport_used: null,
          pull_lifecycle_stage: 'connect',
          pull_lifecycle_step: 'host_validation',
          device_number: deviceNumber,
          attlog_sequence_requested: requestedAttlogSequence
        }
      }, {
        fallbackStage: 'connect',
        fallbackReason: 'missing_host',
        failureStep: 'host_validation'
      })
    };
  }
  const port = Number.isInteger(connection.port) ? connection.port : PORT_DEFAULT;
  const authPassword = Number.isInteger(connection.auth_password) ? connection.auth_password : null;

  const rawPull = await fetchAttendanceBuffer({
    host,
    port,
    timeoutMs,
    authPassword,
    maxPackets,
    transport: requestedTransport,
    deviceNumber,
    probeMode,
    attlogSequence: requestedAttlogSequence,
    deviceUid,
    statusMap,
    vendor,
    ingestMethod,
    deviceTimezone,
    requestedSinceUtc,
    maxEvents,
    connectOnlyProbe,
    connectOnlyProbeHoldMs
  });
  if (!rawPull.ok) {
    const failureDiagnostics = ensureFailureDiagnosticsShape(rawPull.diagnostics, {
      fallbackStage: rawPull.diagnostics && rawPull.diagnostics.failure_stage
        ? rawPull.diagnostics.failure_stage
        : 'final_result',
      fallbackReason: rawPull.diagnostics && rawPull.diagnostics.failure_reason
        ? rawPull.diagnostics.failure_reason
        : FAILURE_REASON.ATTLOG_STAGE_FAILED
    });
    if (isPlainObject(failureDiagnostics.protocol)) {
      failureDiagnostics.protocol.pull_lifecycle_stage = 'final_result';
      failureDiagnostics.protocol.pull_lifecycle_step =
        normalizeText(failureDiagnostics.failure_step) || failureDiagnostics.protocol.pull_lifecycle_step || null;
      failureDiagnostics.protocol.zktime_history_mode_requested = historyDrainDiagnostics.mode_requested;
      failureDiagnostics.protocol.zktime_history_mode_effective = historyDrainDiagnostics.mode_effective;
      failureDiagnostics.protocol.zktime_history_drain_policy_flag_enabled =
        historyDrainDiagnostics.policy_flag_enabled;
      failureDiagnostics.protocol.zktime_history_drain_policy_allowlist_applied =
        historyDrainDiagnostics.policy_allowlist_applied;
      failureDiagnostics.protocol.zktime_history_drain_policy_scope_allowed =
        historyDrainDiagnostics.policy_scope_allowed;
      failureDiagnostics.protocol.zktime_history_drain_policy_enabled =
        historyDrainDiagnostics.policy_enabled;
      failureDiagnostics.protocol.zktime_history_drain_mode_recognized = historyDrainDiagnostics.mode_recognized;
    }
    return {
      ok: false,
      events: [],
      latest_event_time_utc: null,
      diagnostics: failureDiagnostics
    };
  }

  if (isPlainObject(rawPull.diagnostics && rawPull.diagnostics.protocol)) {
    rawPull.diagnostics.protocol.pull_lifecycle_stage = 'parser_handoff';
    rawPull.diagnostics.protocol.pull_lifecycle_step = 'parser_handoff';
  }

  if (looksLikeSchemaPayload(rawPull.data)) {
    const protocolDiagnostics = isPlainObject(rawPull.diagnostics && rawPull.diagnostics.protocol)
      ? {
        ...rawPull.diagnostics.protocol,
        pull_lifecycle_stage: 'final_result',
        pull_lifecycle_step: 'schema_guard',
        zktime_pull_schema_payload_detected: true,
        zktime_pull_schema_payload_bytes: rawPull.data.length,
        zktime_pull_schema_payload_prefix_ascii: compactAsciiPrefix(rawPull.data),
        zktime_pull_schema_payload_prefix_hex: rawPull.data
          .subarray(0, Math.min(rawPull.data.length, 48))
          .toString('hex')
      }
      : null;

    return {
      ok: false,
      events: [],
      latest_event_time_utc: null,
      diagnostics: ensureFailureDiagnosticsShape({
        ...rawPull.diagnostics,
        failure_reason: 'non_attendance_payload_schema',
        failure_stage: 'data',
        failure_step: 'schema_guard',
        ...(protocolDiagnostics ? { protocol: protocolDiagnostics } : {}),
        schema_payload: {
          bytes: rawPull.data.length,
          prefix_ascii: compactAsciiPrefix(rawPull.data),
          prefix_hex: rawPull.data.subarray(0, Math.min(rawPull.data.length, 48)).toString('hex')
        }
      }, {
        fallbackStage: 'data',
        fallbackReason: 'non_attendance_payload_schema',
        failureStep: 'schema_guard'
      })
    };
  }

  const primaryPayload = Buffer.isBuffer(rawPull.data) ? rawPull.data : Buffer.alloc(0);
  const drainedPayload = rawPull && rawPull.alternate_payloads
    && Buffer.isBuffer(rawPull.alternate_payloads.premode_2710_drained_payload)
    ? rawPull.alternate_payloads.premode_2710_drained_payload
    : Buffer.alloc(0);
  const rawProtocolDiagnostics = isPlainObject(rawPull.diagnostics && rawPull.diagnostics.protocol)
    ? rawPull.diagnostics.protocol
    : null;
  const sinceRelaxSourceReady = rawProtocolDiagnostics
    && rawProtocolDiagnostics.zktime_dynamic_05e0_payload_app_parity_family_reached === true;
  let effectiveRequestedSinceUtc = requestedSinceUtc;
  let sinceRelaxEntered = false;
  if (relaxRequestedSincePolicy.enabled && sinceRelaxSourceReady) {
    sinceRelaxEntered = true;
    const requestedSinceMs = requestedSinceUtc ? new Date(requestedSinceUtc).getTime() : null;
    if (Number.isFinite(requestedSinceMs)) {
      const floorMs = Date.now() - (relaxRequestedSincePolicy.backfill_minutes * 60 * 1000);
      if (Number.isFinite(floorMs) && requestedSinceMs > floorMs) {
        effectiveRequestedSinceUtc = new Date(floorMs).toISOString();
      }
    }
  }
  const evaluateParserSource = payload => {
    const safePayload = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
    const textEvents = parseTextAttendanceBuffer(safePayload, statusMap);
    const binaryParse = parseBinaryAttendanceWithDiagnostics(safePayload, statusMap);
    const binaryEvents = Array.isArray(binaryParse.events) ? binaryParse.events : [];
    const merged = dedupeParsedEvents([...textEvents, ...binaryEvents]);
    const protocolDiagnosticsRaw = isPlainObject(rawPull.diagnostics && rawPull.diagnostics.protocol)
      ? rawPull.diagnostics.protocol
      : null;
    const k80RtEnrichment = resolveK80RtEnrichmentContext({
      vendor,
      deviceUid,
      attlogSequence: requestedAttlogSequence,
      pullMeta: pull,
      protocolDiagnostics: protocolDiagnosticsRaw,
      rawEvents: merged
    });
    const normalized = normalizePulledEvents({
      rawEvents: merged,
      deviceUid,
      vendor,
      ingestMethod,
      deviceTimezone,
      requestedSinceUtc: effectiveRequestedSinceUtc,
      maxEvents,
      k80RtEnrichment,
      attlogSequence: requestedAttlogSequence,
      historyMode: historyModeEffective,
      historyBeforeUtc: historyBeforeUtcEffective,
      historyBeforeDedupKey: historyBeforeDedupKeyEffective,
      normalizationReasonDiagnosticsPolicy
    });
    const parserFailureLayer = merged.length === 0 && safePayload.length > 0 ? 'record' : null;
    return {
      payload: safePayload,
      textEvents,
      binaryParse,
      binaryEvents,
      merged,
      normalized,
      parserFailureLayer,
      k80RtEnrichment
    };
  };
  const primaryParsed = evaluateParserSource(primaryPayload);
  const drainedParsed = evaluateParserSource(drainedPayload);
  const primaryMergedCount = primaryParsed.merged.length;
  const primaryNormalizedCount = Array.isArray(primaryParsed.normalized.events)
    ? primaryParsed.normalized.events.length
    : 0;
  const drainedMergedCount = drainedParsed.merged.length;
  const drainedNormalizedCount = Array.isArray(drainedParsed.normalized.events)
    ? drainedParsed.normalized.events.length
    : 0;
  const drainedMeaningful = drainedPayload.length > 0 && (drainedMergedCount > 0 || drainedNormalizedCount > 0);
  const drainedBeatsPrimary = drainedMeaningful
    && (
      drainedNormalizedCount > primaryNormalizedCount
      || (
        drainedNormalizedCount === primaryNormalizedCount
        && drainedMergedCount > primaryMergedCount
      )
    );
  const selectedParsed = drainedBeatsPrimary ? drainedParsed : primaryParsed;
  const selectedSource = drainedBeatsPrimary
    ? 'premode_2710_drained_payload'
    : 'primary_attlog_payload';
  const selectionReason = drainedBeatsPrimary
    ? 'drained_strictly_higher_yield'
    : (drainedMeaningful
      ? 'primary_retained_tie_or_lower_yield'
      : 'primary_retained_drained_not_meaningful');
  const textEvents = selectedParsed.textEvents;
  const binaryParse = selectedParsed.binaryParse;
  const binaryEvents = selectedParsed.binaryEvents;
  const merged = selectedParsed.merged;
  const normalized = selectedParsed.normalized;
  const normalizedEvents = Array.isArray(normalized.events) ? normalized.events : [];
  const normalizationReasonDiagnostics = isPlainObject(normalized.normalization_reason_diagnostics)
    ? normalized.normalization_reason_diagnostics
    : null;
  const parserFailureLayer = selectedParsed.parserFailureLayer;
  const protocolDiagnosticsRaw = isPlainObject(rawPull.diagnostics && rawPull.diagnostics.protocol)
    ? rawPull.diagnostics.protocol
    : null;
  const k80RtEnrichment = selectedParsed.k80RtEnrichment;
  const realtimeProvisional = buildK80RtProvisionalEventsFromProtocol({
    protocolDiagnostics: protocolDiagnosticsRaw,
    vendor,
    deviceUid,
    attlogSequence: requestedAttlogSequence,
    ingestMethod: 'agent_realtime',
    deviceTimezone
  });

  const protocolDiagnostics = isPlainObject(rawPull.diagnostics && rawPull.diagnostics.protocol)
    ? {
      ...rawPull.diagnostics.protocol,
      pull_lifecycle_stage: 'final_result',
      pull_lifecycle_step: 'success',
      data_parse_failure_layer: rawPull.diagnostics.protocol.data_parse_failure_layer || parserFailureLayer
    }
    : null;

  if (protocolDiagnostics) {
    const selectedPayload = selectedParsed.payload;
    if (Array.isArray(protocolDiagnostics.zktime_session_rt01f4_frames)) {
      delete protocolDiagnostics.zktime_session_rt01f4_frames;
    }
    protocolDiagnostics.zktime_pull_parser_input_bytes = selectedPayload.length;
    protocolDiagnostics.zktime_pull_parser_input_prefix_hex = selectedPayload.length > 0
      ? selectedPayload.subarray(0, Math.min(selectedPayload.length, 32)).toString('hex')
      : null;
    protocolDiagnostics.zktime_pull_parser_input_suffix_hex = selectedPayload.length > 0
      ? selectedPayload.subarray(Math.max(0, selectedPayload.length - 32)).toString('hex')
      : null;

    if (protocolDiagnostics.zktime_pull_path === 'alternate_07d0_followup') {
      protocolDiagnostics.zktime_pull_07d0_preparse_truncation_stage = classifyK8007d0PreParseStage({
        expectedBytes: protocolDiagnostics.zktime_pull_07d0_expected_bytes_hint,
        observedBytes: protocolDiagnostics.zktime_pull_07d0_observed_payload_bytes,
        observed05ddBytes: protocolDiagnostics.zktime_pull_07d0_observed_05dd_payload_bytes,
        assembledBytes: protocolDiagnostics.zktime_pull_07d0_collected_payload_bytes,
        parserInputBytes: selectedPayload.length,
        payloadHexTruncated: protocolDiagnostics.zktime_pull_07d0_payload_hex_truncated_detected === true
      });
    }
    protocolDiagnostics.zktime_since_relax_enabled = relaxRequestedSincePolicy.enabled;
    protocolDiagnostics.zktime_since_relax_entered = sinceRelaxEntered;
    protocolDiagnostics.zktime_since_relax_original_requested_since_utc = requestedSinceUtc;
    protocolDiagnostics.zktime_since_relax_effective_requested_since_utc = effectiveRequestedSinceUtc;
    protocolDiagnostics.zktime_since_relax_backfill_minutes = relaxRequestedSincePolicy.backfill_minutes;
    protocolDiagnostics.zktime_requested_since_source_fix_entered = requestedSinceSourceFixEnteredFromPayload;
    protocolDiagnostics.zktime_requested_since_original_source = requestedSinceOriginalSource;
    protocolDiagnostics.zktime_requested_since_original_value = requestedSinceOriginalUtc;
    protocolDiagnostics.zktime_requested_since_effective_source = requestedSinceEffectiveSourceFromPayload;
    protocolDiagnostics.zktime_requested_since_effective_value = requestedSinceUtc;
    protocolDiagnostics.zktime_history_mode_requested = historyDrainDiagnostics.mode_requested;
    protocolDiagnostics.zktime_history_mode_effective = historyDrainDiagnostics.mode_effective;
    protocolDiagnostics.zktime_history_drain_mode_entered = historyDrainDiagnostics.mode_recognized;
    protocolDiagnostics.zktime_history_drain_mode_recognized = historyDrainDiagnostics.mode_recognized;
    protocolDiagnostics.zktime_history_drain_policy_flag_enabled = historyDrainDiagnostics.policy_flag_enabled;
    protocolDiagnostics.zktime_history_drain_policy_scope_allowed = historyDrainDiagnostics.policy_scope_allowed;
    protocolDiagnostics.zktime_history_drain_policy_allowlist_applied = historyDrainDiagnostics.policy_allowlist_applied;
    protocolDiagnostics.zktime_history_drain_policy_enabled = historyDrainDiagnostics.policy_enabled;
    protocolDiagnostics.zktime_history_boundary_before_utc_exclusive =
      normalizeText(normalized.history_boundary_before_utc_exclusive) || null;
    protocolDiagnostics.zktime_history_boundary_before_dedup_key_exclusive =
      normalizeText(normalized.history_boundary_before_dedup_key_exclusive) || null;
    protocolDiagnostics.zktime_history_boundary_filter_applied = normalized.history_boundary_filter_applied === true;
    protocolDiagnostics.zktime_history_boundary_dropped_count =
      Number.isInteger(normalized.history_boundary_dropped_count)
        ? normalized.history_boundary_dropped_count
        : 0;
    protocolDiagnostics.zktime_normalization_reason_diagnostics_enabled =
      normalizationReasonDiagnosticsPolicy.enabled === true;
    protocolDiagnostics.zktime_normalization_reason_merged_input_count =
      normalizationReasonDiagnostics ? normalizationReasonDiagnostics.merged_input_count : null;
    protocolDiagnostics.zktime_normalization_reason_dropped_requested_since_utc_count =
      normalizationReasonDiagnostics ? normalizationReasonDiagnostics.dropped_requested_since_utc_count : null;
    protocolDiagnostics.zktime_normalization_reason_dropped_invalid_utc_derivation_count =
      normalizationReasonDiagnostics ? normalizationReasonDiagnostics.dropped_invalid_utc_derivation_count : null;
    protocolDiagnostics.zktime_normalization_reason_dropped_invalid_direction_count =
      normalizationReasonDiagnostics ? normalizationReasonDiagnostics.dropped_invalid_direction_count : null;
    protocolDiagnostics.zktime_normalization_reason_dropped_other_gate_count =
      normalizationReasonDiagnostics ? normalizationReasonDiagnostics.dropped_other_gate_count : null;
    protocolDiagnostics.zktime_normalization_reason_survived_normalization_count =
      normalizationReasonDiagnostics ? normalizationReasonDiagnostics.survived_normalization_count : null;
    protocolDiagnostics.zktime_normalization_reason_samples =
      normalizationReasonDiagnostics && normalizationReasonDiagnostics.samples
        ? normalizationReasonDiagnostics.samples
        : null;
    protocolDiagnostics.zktime_emission_ordering = normalizeText(normalized.emission_ordering) || null;
    protocolDiagnostics.zktime_emission_cap_applied = normalized.emission_cap_applied === true;
    protocolDiagnostics.zktime_newest_first_emit_policy_enabled = normalized.emission_policy_enabled === true;
  }

  let preNormalizationDiagnostics = null;
  if (preNormalizationDumpPolicy.enabled) {
    const sinceMs = effectiveRequestedSinceUtc ? new Date(effectiveRequestedSinceUtc).getTime() : null;
    const mergedRows = Array.isArray(merged) ? merged : [];
    let mergedLtSinceCount = 0;
    let mergedGteSinceCount = 0;
    const mergedRowsWithUtc = [];
    for (const row of mergedRows) {
      const eventTimeUtc = localDateTimeToUtcIso(row.event_time_local, deviceTimezone);
      mergedRowsWithUtc.push({ row, eventTimeUtc });
      if (sinceMs !== null && eventTimeUtc) {
        if (new Date(eventTimeUtc).getTime() < sinceMs) {
          mergedLtSinceCount += 1;
        } else {
          mergedGteSinceCount += 1;
        }
      }
    }
    const mergedUtcValues = mergedRowsWithUtc
      .map(item => item.eventTimeUtc)
      .filter(Boolean)
      .sort();
    const normalizedUtcValues = normalizedEvents
      .map(item => item.event_time_utc)
      .filter(Boolean)
      .sort();
    const normalizedLatestUtc = normalizedUtcValues.length > 0
      ? normalizedUtcValues[normalizedUtcValues.length - 1]
      : null;
    preNormalizationDiagnostics = {
      pre_normalization_dump_enabled: true,
      pre_normalization_dump_max_rows: preNormalizationDumpPolicy.max_rows,
      pre_normalization_dump_requested_since_utc: effectiveRequestedSinceUtc,
      pre_normalization_dump_merged_rows_count: mergedRows.length,
      pre_normalization_dump_merged_lt_since_count: mergedLtSinceCount,
      pre_normalization_dump_merged_gte_since_count: mergedGteSinceCount,
      pre_normalization_dump_merged_min_event_time_utc: mergedUtcValues.length > 0
        ? mergedUtcValues[0]
        : null,
      pre_normalization_dump_merged_max_event_time_utc: mergedUtcValues.length > 0
        ? mergedUtcValues[mergedUtcValues.length - 1]
        : null,
      pre_normalization_dump_normalized_count: normalizedEvents.length,
      pre_normalization_dump_normalized_min_event_time_utc: normalizedUtcValues.length > 0
        ? normalizedUtcValues[0]
        : null,
      pre_normalization_dump_normalized_max_event_time_utc: normalizedLatestUtc,
      pre_normalization_dump_any_merged_gt_latest_normalized:
        Boolean(normalizedLatestUtc && mergedUtcValues.some(value => value > normalizedLatestUtc)),
      pre_normalization_dump_rows: mergedRowsWithUtc
        .slice(0, preNormalizationDumpPolicy.max_rows)
        .map(item => ({
          person: normalizeText(item.row.person),
          event_time_local: normalizeText(item.row.event_time_local),
          event_time_utc: item.eventTimeUtc || null,
          direction: normalizeDirection(item.row.direction),
          status_code: item.row.status_code ?? null,
          verify_state: normalizeText(item.row.verify_state) || null,
          verify_method: normalizeText(item.row.verify_method) || null,
          parser: normalizeText(item.row.parser) || null
        }))
    };
  }

  const staleCutoffUtc = '2026-03-24T14:26:40.000Z';
  const mergedUtcForClassification = merged
    .map(row => localDateTimeToUtcIso(row.event_time_local, deviceTimezone))
    .filter(Boolean)
    .sort();
  const mergedMinUtcForClassification = mergedUtcForClassification.length > 0
    ? mergedUtcForClassification[0]
    : null;
  const mergedMaxUtcForClassification = mergedUtcForClassification.length > 0
    ? mergedUtcForClassification[mergedUtcForClassification.length - 1]
    : null;
  const normalizedUtcForClassification = normalizedEvents
    .map(item => item.event_time_utc)
    .filter(Boolean)
    .sort();
  const normalizedMaxUtcForClassification = normalizedUtcForClassification.length > 0
    ? normalizedUtcForClassification[normalizedUtcForClassification.length - 1]
    : null;
  const anyMergedAfterStaleCutoff = mergedUtcForClassification.some(value => value > staleCutoffUtc);
  const multipageEnabledForClassification =
    protocolDiagnostics && protocolDiagnostics.zktime_multipage_attlog_enabled === true;
  const multipageEnteredForClassification =
    protocolDiagnostics && protocolDiagnostics.zktime_multipage_attlog_entered === true;
  const multipageFinalSourceForClassification =
    protocolDiagnostics && normalizeText(protocolDiagnostics.zktime_multipage_attlog_final_parser_input_source);
  let surfaceExpansionBlockerClassification = 'insufficient_evidence';
  if (multipageEnabledForClassification && !multipageEnteredForClassification) {
    surfaceExpansionBlockerClassification = 'alternate_path_failed';
  } else if (multipageEnabledForClassification && multipageEnteredForClassification && selectedParsed.payload.length === 0) {
    surfaceExpansionBlockerClassification = 'alternate_path_empty';
  } else if (anyMergedAfterStaleCutoff && (!normalizedMaxUtcForClassification || normalizedMaxUtcForClassification <= staleCutoffUtc)) {
    surfaceExpansionBlockerClassification = 'newer_rows_present_but_filtered';
  } else if (!anyMergedAfterStaleCutoff) {
    surfaceExpansionBlockerClassification = 'surface_still_stale';
  }
  if (protocolDiagnostics) {
    protocolDiagnostics.zktime_surface_expansion_variant_executed = multipageEnabledForClassification
      ? `multipage_attlog_${multipageFinalSourceForClassification || 'unknown'}`
      : 'baseline_single_page';
    protocolDiagnostics.zktime_surface_expansion_entered = multipageEnteredForClassification;
    protocolDiagnostics.zktime_surface_expansion_payload_bytes = selectedParsed.payload.length;
    protocolDiagnostics.zktime_surface_expansion_merged_candidates = merged.length;
    protocolDiagnostics.zktime_surface_expansion_merged_min_event_time_utc = mergedMinUtcForClassification;
    protocolDiagnostics.zktime_surface_expansion_merged_max_event_time_utc = mergedMaxUtcForClassification;
    protocolDiagnostics.zktime_surface_expansion_normalized_count = normalizedEvents.length;
    protocolDiagnostics.zktime_surface_expansion_any_merged_after_stale_cutoff =
      anyMergedAfterStaleCutoff;
    protocolDiagnostics.zktime_surface_expansion_blocker_classification =
      surfaceExpansionBlockerClassification;

    const appParityEnabled = protocolDiagnostics.zktime_app_parity_family_enabled === true;
    const appParityEntered = protocolDiagnostics.zktime_app_parity_family_entered === true;
    const appParityRestartOk = protocolDiagnostics.zktime_app_parity_family_restart_ok === true;
    let appParityBlockerClassification = 'insufficient_evidence';
    if (appParityEnabled && !appParityEntered) {
      appParityBlockerClassification = 'family_not_entered';
    } else if (appParityEnabled && appParityEntered && !appParityRestartOk) {
      appParityBlockerClassification = 'family_failed';
    } else if (appParityEnabled && appParityEntered && selectedParsed.payload.length === 0) {
      appParityBlockerClassification = 'family_empty';
    } else if (anyMergedAfterStaleCutoff) {
      appParityBlockerClassification = 'newer_rows_present';
    } else if (appParityEnabled && appParityEntered) {
      appParityBlockerClassification = 'family_still_stale';
    }

    protocolDiagnostics.zktime_app_parity_family_payload_bytes = selectedParsed.payload.length;
    protocolDiagnostics.zktime_app_parity_family_merged_candidates = merged.length;
    protocolDiagnostics.zktime_app_parity_family_merged_min_event_time_utc = mergedMinUtcForClassification;
    protocolDiagnostics.zktime_app_parity_family_merged_max_event_time_utc = mergedMaxUtcForClassification;
    protocolDiagnostics.zktime_app_parity_family_normalized_count = normalizedEvents.length;
    protocolDiagnostics.zktime_app_parity_family_any_merged_after_stale_cutoff =
      anyMergedAfterStaleCutoff;
    protocolDiagnostics.zktime_app_parity_family_blocker_classification =
      appParityBlockerClassification;

    const preRetrievalEnabled = protocolDiagnostics.zktime_pre_retrieval_subfamily_enabled === true;
    const preRetrievalEntered = protocolDiagnostics.zktime_pre_retrieval_subfamily_entered === true;
    const preRetrievalPreSizeOk = protocolDiagnostics.zktime_pre_retrieval_subfamily_03eb_2c010000_ok === true;
    const preRetrievalBoundaryOk = protocolDiagnostics.zktime_pre_retrieval_subfamily_03ea_ok === true;
    let preRetrievalBlockerClassification = 'insufficient_evidence';
    if (preRetrievalEnabled && !preRetrievalEntered) {
      preRetrievalBlockerClassification = 'subfamily_not_entered';
    } else if (preRetrievalEnabled && preRetrievalEntered && (!preRetrievalPreSizeOk || !preRetrievalBoundaryOk)) {
      preRetrievalBlockerClassification = 'subfamily_failed';
    } else if (preRetrievalEnabled && preRetrievalEntered && selectedParsed.payload.length === 0) {
      preRetrievalBlockerClassification = 'subfamily_empty';
    } else if (anyMergedAfterStaleCutoff) {
      preRetrievalBlockerClassification = 'newer_rows_present';
    } else if (preRetrievalEnabled && preRetrievalEntered) {
      preRetrievalBlockerClassification = 'subfamily_still_stale';
    }
    protocolDiagnostics.zktime_pre_retrieval_subfamily_payload_bytes = selectedParsed.payload.length;
    protocolDiagnostics.zktime_pre_retrieval_subfamily_merged_candidates = merged.length;
    protocolDiagnostics.zktime_pre_retrieval_subfamily_merged_min_event_time_utc = mergedMinUtcForClassification;
    protocolDiagnostics.zktime_pre_retrieval_subfamily_merged_max_event_time_utc = mergedMaxUtcForClassification;
    protocolDiagnostics.zktime_pre_retrieval_subfamily_normalized_count = normalizedEvents.length;
    protocolDiagnostics.zktime_pre_retrieval_subfamily_any_merged_after_stale_cutoff =
      anyMergedAfterStaleCutoff;
    protocolDiagnostics.zktime_pre_retrieval_subfamily_blocker_classification =
      preRetrievalBlockerClassification;

    const dynamic05e0Enabled = protocolDiagnostics.zktime_dynamic_05e0_payload_enabled === true;
    const dynamic05e0Entered = protocolDiagnostics.zktime_dynamic_05e0_payload_entered === true;
    const dynamic05e0SentHex = normalizeText(protocolDiagnostics.zktime_dynamic_05e0_payload_sent_hex)
      .toLowerCase();
    const dynamic05e0Sent = dynamic05e0SentHex.length > 0;
    let dynamic05e0BlockerClassification = 'insufficient_evidence';
    if (dynamic05e0Enabled && !dynamic05e0Entered) {
      dynamic05e0BlockerClassification = '05e0_derivation_not_entered';
    } else if (dynamic05e0Enabled && dynamic05e0Entered && !dynamic05e0Sent) {
      dynamic05e0BlockerClassification = '05e0_derivation_failed';
    } else if (dynamic05e0Enabled && dynamic05e0Entered && dynamic05e0Sent && selectedParsed.payload.length === 0) {
      dynamic05e0BlockerClassification = '05e0_dynamic_payload_sent';
    } else if (anyMergedAfterStaleCutoff) {
      dynamic05e0BlockerClassification = 'newer_rows_present';
    } else if (dynamic05e0Enabled && dynamic05e0Entered && dynamic05e0Sent) {
      dynamic05e0BlockerClassification = '05e0_family_still_stale';
    }
    protocolDiagnostics.zktime_dynamic_05e0_blocker_classification = dynamic05e0BlockerClassification;

    const normalized20260401Count = normalizedEvents.filter(event => {
      const utc = normalizeText(event && event.event_time_utc);
      return utc.startsWith('2026-04-01');
    }).length;
    const multiple20260401Survive = normalized20260401Count > 1;
    let sinceRelaxBlockerClassification = 'insufficient_evidence';
    if (!sinceRelaxEntered) {
      sinceRelaxBlockerClassification = 'since_relax_not_entered';
    } else if (multiple20260401Survive) {
      sinceRelaxBlockerClassification = 'newer_rows_survive_normalization';
    } else if (normalizeText(effectiveRequestedSinceUtc) !== normalizeText(requestedSinceUtc)) {
      sinceRelaxBlockerClassification = 'since_relax_applied';
    } else {
      sinceRelaxBlockerClassification = 'since_relax_no_effect';
    }
    protocolDiagnostics.zktime_since_relax_multiple_2026_04_01_rows_survive_normalized =
      multiple20260401Survive;
    protocolDiagnostics.zktime_since_relax_blocker_classification =
      sinceRelaxBlockerClassification;
  }

  return {
    ok: true,
    events: normalizedEvents,
    latest_event_time_utc: normalized.latest_event_time_utc,
    realtime_provisional_events: realtimeProvisional.events,
    realtime_provisional: {
      enabled: realtimeProvisional.enabled,
      ...realtimeProvisional.stats
    },
    diagnostics: {
      ...rawPull.diagnostics,
      ...(protocolDiagnostics ? { protocol: protocolDiagnostics } : {}),
      parser: {
        binary_input_bytes: selectedParsed.payload.length,
        binary_input_prefix_hex: selectedParsed.payload.length > 0
          ? selectedParsed.payload.subarray(0, Math.min(selectedParsed.payload.length, 32)).toString('hex')
          : null,
        binary_input_suffix_hex: selectedParsed.payload.length > 0
          ? selectedParsed.payload.subarray(Math.max(0, selectedParsed.payload.length - 32)).toString('hex')
          : null,
        max_yield_selected_source: selectedSource,
        max_yield_selection_reason: selectionReason,
        max_yield_primary_payload_bytes: primaryPayload.length,
        max_yield_primary_merged_candidates: primaryMergedCount,
        max_yield_primary_normalized_events: primaryNormalizedCount,
        max_yield_drained_payload_bytes: drainedPayload.length,
        max_yield_drained_merged_candidates: drainedMergedCount,
        max_yield_drained_normalized_events: drainedNormalizedCount,
        text_candidates: textEvents.length,
        binary_candidates: binaryEvents.length,
        merged_candidates: merged.length,
        binary_record_size_used: binaryParse.diagnostics
          ? binaryParse.diagnostics.record_size_used
          : null,
        binary_layout_id: binaryParse.diagnostics ? binaryParse.diagnostics.layout_id : null,
        binary_payload_header_bytes: binaryParse.diagnostics
          ? binaryParse.diagnostics.payload_header_bytes
          : 0,
        binary_records_total: binaryParse.diagnostics ? binaryParse.diagnostics.records_total : 0,
        binary_records_decoded: binaryParse.diagnostics ? binaryParse.diagnostics.records_decoded : 0,
        binary_malformed_records: binaryParse.diagnostics ? binaryParse.diagnostics.malformed_records : 0,
        binary_candidate_scores: binaryParse.diagnostics
          ? binaryParse.diagnostics.candidate_scores
          : [],
        binary_warning_samples: binaryParse.diagnostics
          ? binaryParse.diagnostics.malformed_samples
          : [],
        k80_rt_enrichment_source: k80RtEnrichment ? k80RtEnrichment.source : null,
        k80_rt_enrichment_matches: k80RtEnrichment && k80RtEnrichment.stats
          ? k80RtEnrichment.stats.matched
          : 0,
        k80_rt_enrichment_ambiguous: k80RtEnrichment && k80RtEnrichment.stats
          ? k80RtEnrichment.stats.ambiguous
          : 0,
        k80_rt_source_candidates_total: k80RtEnrichment && k80RtEnrichment.stats
          ? k80RtEnrichment.stats.source_candidates_total
          : 0,
        k80_rt_source_candidates_decoded: k80RtEnrichment && k80RtEnrichment.stats
          ? k80RtEnrichment.stats.source_candidates_decoded
          : 0,
        realtime_provisional_candidate_frames_count:
          realtimeProvisional.stats.realtime_provisional_candidate_frames_count,
        realtime_provisional_events_received: realtimeProvisional.stats.realtime_provisional_events_received,
        realtime_provisional_events_inserted: realtimeProvisional.stats.realtime_provisional_events_inserted,
        realtime_provisional_events_skipped_no_person:
          realtimeProvisional.stats.realtime_provisional_events_skipped_no_person,
        normalization_reason_diagnostics: normalizationReasonDiagnostics,
        emission_ordering: normalizeText(normalized.emission_ordering) || null,
        emission_cap_applied: normalized.emission_cap_applied === true,
        newest_first_emit_policy_enabled: normalized.emission_policy_enabled === true,
        parse_failure_layer: parserFailureLayer,
        parse_errors: normalized.parse_errors.slice(0, 50),
        ...(preNormalizationDiagnostics || {})
      }
    }
  };
  } catch (err) {
    return {
      ok: false,
      events: [],
      latest_event_time_utc: null,
      diagnostics: ensureFailureDiagnosticsShape({
        failure_reason: mapSocketErrorCode(err),
        failure_stage: 'fatal_unhandled_exception',
        failure_step: 'pull_device_events',
        raw_error_code: extractRawErrorCode(err),
        raw_error_message: extractRawErrorMessage(err),
        last_command_sent: null,
        last_command_hex: null,
        last_response_command: null,
        last_response_command_hex: null,
        last_session_id: null,
        last_reply_id: null,
        protocol: {
          host: normalizeText(connection.host) || null,
          port: Number.isInteger(connection.port) ? connection.port : PORT_DEFAULT,
          transport_requested: requestedTransport,
          transport_used: null,
          pull_lifecycle_stage: 'final_result',
          pull_lifecycle_step: 'fatal_unhandled_exception',
          device_number: deviceNumber,
          attlog_sequence_requested: requestedAttlogSequence
        }
      }, {
        fallbackStage: 'fatal_unhandled_exception',
        fallbackReason: mapSocketErrorCode(err),
        failureStep: 'pull_device_events',
        error: err
      })
    };
  }
}

async function runK80RealtimeSubscriberSession({
  deviceUid,
  vendor = 'zkteco',
  deviceTimezone = 'Africa/Tunis',
  authPassword = null,
  connection = null,
  signal,
  onFlush
}) {
  const policy = resolveK80RtSubscriberPolicy();
  if (!policy.enabled) {
    return { ok: false, skipped: true, reason: 'subscriber_disabled' };
  }
  if (!normalizeText(deviceUid) || !policy.allowlist.includes(normalizeText(deviceUid))) {
    return { ok: false, skipped: true, reason: 'device_not_allowlisted' };
  }
  const connectionMeta = resolveK80RtSubscriberConnection({ policy, connection });
  if (!connectionMeta.host) {
    return { ok: false, skipped: true, reason: 'missing_host' };
  }
  if (connectionMeta.source === 'connection' && connectionMeta.transport !== TRANSPORT.TCP) {
    return { ok: false, skipped: true, reason: 'transport_not_tcp' };
  }

  const channel = createTcpChannel({
    host: connectionMeta.host,
    port: connectionMeta.port,
    timeoutMs: 3000
  });
  let sessionId = 0;
  let replyId = USHRT_MAX - 1;
  const receivedFrames = [];
  const emittedEventKeys = new Set();
  const frameLimit = 1024;
  const resolvedAuthPassword = Number.isInteger(authPassword)
    ? authPassword
    : connectionMeta.auth_password;
  const deviceNumber = Number.isInteger(connectionMeta.device_number)
    ? connectionMeta.device_number
    : 1;
  let finalFlushAttempted = false;
  let sessionOpened = false;
  let connectResponseReceived = false;
  let authAttempted = false;
  let authResponseReceived = false;
  let authResponseCommand = null;
  let presequenceReached = false;
  let rtSubscribeAttempted = false;
  let rtSubscribeResponseReceived = false;
  let receiveLoopArmed = false;
  const sessionMeta = {
    session_opened: false,
    session_host: connectionMeta.host,
    session_port: connectionMeta.port,
    session_source: connectionMeta.source,
    session_transport: connectionMeta.source === 'connection' ? connectionMeta.transport : null,
    session_rt01f4_frames_count: 0,
    auth_connection_present: Number.isInteger(connectionMeta.auth_password),
    auth_connection_integer: Number.isInteger(connectionMeta.auth_password),
    auth_resolved_present: Number.isInteger(resolvedAuthPassword),
    auth_resolved_integer: Number.isInteger(resolvedAuthPassword),
    connect_response_received: false,
    auth_attempted: false,
    auth_response_received: false,
    auth_response_command: null,
    auth_response_command_hex: null,
    presequence_reached: false,
    rt_subscribe_attempted: false,
    rt_subscribe_response_received: false,
    receive_loop_armed: false,
    session_ended_before_frames: false
  };
  const finalizeSessionResult = result => ({
    ...result,
    ...sessionMeta,
    session_opened: sessionOpened,
    session_rt01f4_frames_count: receivedFrames.length,
    connect_response_received: connectResponseReceived,
    auth_attempted: authAttempted,
    auth_response_received: authResponseReceived,
    auth_response_command: authResponseCommand,
    auth_response_command_hex: Number.isInteger(authResponseCommand)
      ? commandToHex(authResponseCommand)
      : null,
    presequence_reached: presequenceReached,
    rt_subscribe_attempted: rtSubscribeAttempted,
    rt_subscribe_response_received: rtSubscribeResponseReceived,
    receive_loop_armed: receiveLoopArmed,
    session_ended_before_frames: receivedFrames.length === 0 && receiveLoopArmed
  });

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const sendStep = async ({ command, payload = Buffer.alloc(0), expected = ACK.OK, noReplyError }) => {
    const requestReplyId = nextReplyId(replyId);
    const result = await sendTcpCommand({
      channel,
      timeoutMs: 3000,
      command,
      sessionId,
      replyId: requestReplyId,
      payload,
      noReplyError: noReplyError || FAILURE_REASON.ATTLOG_STAGE_FAILED,
      deviceNumber
    });
    if (!result.ok || !result.response) {
      return result;
    }
    sessionId = result.response.session_id;
    replyId = result.response.reply_id;
    if (Number.isInteger(expected) && result.response.command !== expected) {
      return {
        ok: false,
        error: 'unexpected_response_command',
        response: result.response
      };
    }
    return result;
  };

  const drainPendingDataAndFree = async () => {
    let drainedFrames = 0;
    let drainedBytes = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 1500) {
      let frame;
      try {
        frame = await channel.receiveFrame(200);
      } catch (err) {
        break;
      }
      const parsed = parsePacket(frame.payload);
      if (!parsed) {
        continue;
      }
      drainedFrames += 1;
      drainedBytes += Buffer.isBuffer(parsed.payload) ? parsed.payload.length : 0;
      if (Number.isInteger(parsed.reply_id)) {
        replyId = parsed.reply_id;
      }
      if (Number.isInteger(parsed.session_id) && parsed.session_id > 0) {
        sessionId = parsed.session_id;
      }
      if (parsed.command === COMMANDS.ZKTIME_RT_SUBSCRIBE) {
        const payloadHex = bufferToHex(parsed.payload).toLowerCase();
        if (payloadHex) {
          if (receivedFrames.length >= frameLimit) {
            receivedFrames.shift();
          }
          receivedFrames.push({
            parse_ok: true,
            command: parsed.command,
            command_hex: commandToHex(parsed.command),
            session_id: parsed.session_id,
            reply_id: parsed.reply_id,
            payload_bytes: parsed.payload.length,
            payload_hex: payloadHex,
            source: 'subscriber_drain'
          });
        }
      }
    }

    const freeDataReplyId = nextReplyId(replyId);
    const freeData = await sendTcpCommand({
      channel,
      timeoutMs: 2000,
      command: COMMANDS.FREE_DATA,
      sessionId,
      replyId: freeDataReplyId,
      payload: Buffer.alloc(0),
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
      deviceNumber
    });
    if (freeData.ok && freeData.response) {
      sessionId = freeData.response.session_id;
      replyId = freeData.response.reply_id;
    }
    return {
      drained_frames: drainedFrames,
      drained_bytes: drainedBytes,
      free_data_ok: freeData.ok === true && freeData.response && freeData.response.command === ACK.OK
    };
  };

  const flushRealtimeEvents = async ({ reason = 'interval' } = {}) => {
    const protocolDiagnostics = {
      zktime_session_rt01f4_frames: receivedFrames.slice(),
      zktime_rt_subscriber_session_opened: sessionOpened,
      zktime_rt_subscriber_session_source: connectionMeta.source,
      zktime_rt_subscriber_host: connectionMeta.host,
      zktime_rt_subscriber_port: connectionMeta.port,
      zktime_rt_subscriber_device_number: deviceNumber,
      zktime_rt_subscriber_transport: connectionMeta.source === 'connection'
        ? connectionMeta.transport
        : null
    };
    const built = buildK80RtProvisionalEventsFromProtocol({
      protocolDiagnostics,
      vendor,
      deviceUid,
      attlogSequence: ATTLOG_SEQUENCE.ZKTIME_K80,
      ingestMethod: 'agent_realtime',
      deviceTimezone
    });
    if (!built.enabled || !Array.isArray(built.events) || built.events.length === 0) {
      return {
        received: 0,
        submitted: 0
      };
    }
    const newEvents = [];
    for (const event of built.events) {
      if (!event || !normalizeText(event.dedup_key)) {
        continue;
      }
      if (emittedEventKeys.has(event.dedup_key)) {
        continue;
      }
      emittedEventKeys.add(event.dedup_key);
      newEvents.push(event);
      if (newEvents.length >= policy.max_events_per_flush) {
        break;
      }
    }
    if (newEvents.length === 0) {
      return {
        received: built.events.length,
        submitted: 0
      };
    }
    if (typeof onFlush === 'function') {
      await onFlush({
        device_uid: deviceUid,
        vendor,
        ingest_method: 'agent_realtime',
        device_timezone: deviceTimezone,
        events: newEvents,
        diagnostics: {
          mode: 'k80_rt_subscriber',
          reason,
          session_rt01f4_frames_count: receivedFrames.length,
          realtime_provisional_candidate_frames_count:
            built.stats.realtime_provisional_candidate_frames_count,
          realtime_provisional_events_received:
            built.stats.realtime_provisional_events_received,
          realtime_provisional_events_inserted: newEvents.length,
          realtime_provisional_events_skipped_no_person:
            built.stats.realtime_provisional_events_skipped_no_person
        }
      });
    }
    return {
      received: built.events.length,
      submitted: newEvents.length
    };
  };

  try {
    await channel.connect();

    const connect = await sendStep({
      command: COMMANDS.CONNECT,
      payload: Buffer.alloc(0),
      expected: null,
      noReplyError: FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY
    });
    if (!connect.ok || !connect.response) {
      return finalizeSessionResult({
        ok: false,
        reason: connect.error || FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY
      });
    }
    connectResponseReceived = true;
    sessionOpened = true;
    const tryAuth = async () => {
      authAttempted = true;
      if (!Number.isInteger(resolvedAuthPassword)) {
        return finalizeSessionResult({ ok: false, reason: 'auth_password_missing' });
      }
      const auth = await sendStep({
        command: COMMANDS.AUTH,
        payload: makeCommKey(resolvedAuthPassword, sessionId),
        expected: ACK.OK,
        noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED
      });
      authResponseReceived = auth.ok === true && Boolean(auth.response);
      authResponseCommand = auth.response ? auth.response.command : null;
      if (!auth.ok || !auth.response) {
        return finalizeSessionResult({
          ok: false,
          reason: auth.error || FAILURE_REASON.AUTH_STAGE_FAILED
        });
      }
      return { ok: true };
    };
    if (connect.response.command === ACK.UNAUTH) {
      const authRes = await tryAuth();
      if (!authRes.ok) {
        return authRes;
      }
    } else if (connect.response.command !== ACK.OK) {
      return finalizeSessionResult({ ok: false, reason: FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH });
    } else {
      await tryAuth();
    }

    presequenceReached = true;
    await sendStep({ command: COMMANDS.OPTIONS_RRQ, payload: Buffer.from('DeviceID\0', 'ascii'), expected: ACK.OK });
    await sendStep({ command: COMMANDS.ZKTIME_STATUS_PROBE, payload: Buffer.alloc(0), expected: ACK.OK });
    await sendStep({
      command: COMMANDS.ZKTIME_STARTUP_NEGOTIATION,
      payload: Buffer.from(K80_STARTUP_NEGOTIATION_PAYLOAD_HEX, 'hex'),
      expected: ACK.OK
    });
    await sendStep({ command: COMMANDS.ZKTIME_PREMODE_044C, payload: Buffer.alloc(0), expected: ACK.OK });
    await sendStep({ command: COMMANDS.ZKTIME_PREMODE_0045, payload: Buffer.from('2080', 'hex'), expected: ACK.OK });
    const premode2710 = await sendStep({
      command: COMMANDS.ZKTIME_PREMODE_2710,
      payload: Buffer.alloc(0),
      expected: null
    });
    if (premode2710.ok && premode2710.response) {
      const cmd = premode2710.response.command;
      if (cmd === COMMANDS.PREPARE_DATA || cmd === COMMANDS.DATA || cmd === ACK.DATA) {
        await drainPendingDataAndFree();
      }
    }
    rtSubscribeAttempted = true;
    const rtSubscribeStep = await sendStep({
      command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
      payload: Buffer.from('ffff0000', 'hex'),
      expected: ACK.OK
    });
    rtSubscribeResponseReceived = rtSubscribeStep.ok === true && Boolean(rtSubscribeStep.response);

    const sessionEndsAt = Date.now() + policy.session_window_ms;
    let nextFlushAt = Date.now() + policy.flush_interval_ms;
    receiveLoopArmed = true;
    while (!signal || signal.cancelled !== true) {
      if (Date.now() >= sessionEndsAt) {
        break;
      }
      try {
        const frame = await channel.receiveFrame(500);
        const parsed = parsePacket(frame.payload);
        if (parsed && parsed.command === COMMANDS.ZKTIME_RT_SUBSCRIBE && parsed.payload.length > 0) {
          if (receivedFrames.length >= frameLimit) {
            receivedFrames.shift();
          }
          receivedFrames.push({
            parse_ok: true,
            command: parsed.command,
            command_hex: commandToHex(parsed.command),
            session_id: parsed.session_id,
            reply_id: parsed.reply_id,
            payload_bytes: parsed.payload.length,
            payload_hex: bufferToHex(parsed.payload).toLowerCase(),
            source: 'subscriber_session'
          });
        }
      } catch (err) {
        const code = normalizeText(err && err.code).toUpperCase();
        if (code && code !== 'REPLY_TIMEOUT') {
          return { ok: false, reason: mapSocketErrorCode(err) };
        }
      }
      if (Date.now() >= nextFlushAt) {
        await flushRealtimeEvents({ reason: 'interval' });
        nextFlushAt = Date.now() + policy.flush_interval_ms;
      }
      await sleep(10);
    }

    await flushRealtimeEvents({ reason: 'session_end' });
    finalFlushAttempted = true;
    return finalizeSessionResult({ ok: true });
  } catch (err) {
    return finalizeSessionResult({
      ok: false,
      reason: mapSocketErrorCode(err)
    });
  } finally {
    if (!finalFlushAttempted) {
      try {
        await flushRealtimeEvents({ reason: signal && signal.cancelled === true ? 'shutdown' : 'finalize' });
      } catch (err) {
        // no-op
      }
    }
    try {
      const exitReplyId = nextReplyId(replyId);
      await sendTcpCommand({
        channel,
        timeoutMs: 1200,
        command: COMMANDS.EXIT,
        sessionId,
        replyId: exitReplyId,
        payload: Buffer.alloc(0),
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
        deviceNumber
      });
    } catch (err) {
      // no-op
    }
    channel.close();
  }
}

async function runK80RtInitiationSession({
  deviceUid,
  vendor = 'zkteco',
  authPassword = null,
  connection = null
} = {}) {
  const policy = resolveK80RtSubscriberPolicy();
  if (!policy.enabled) {
    return { ok: false, skipped: true, reason: 'subscriber_disabled' };
  }
  if (!normalizeText(deviceUid) || !policy.allowlist.includes(normalizeText(deviceUid))) {
    return { ok: false, skipped: true, reason: 'device_not_allowlisted' };
  }
  const connectionMeta = resolveK80RtSubscriberConnection({ policy, connection });
  if (!connectionMeta.host) {
    return { ok: false, skipped: true, reason: 'missing_host' };
  }
  if (connectionMeta.source === 'connection' && connectionMeta.transport !== TRANSPORT.TCP) {
    return { ok: false, skipped: true, reason: 'transport_not_tcp' };
  }

  const channel = createTcpChannel({
    host: connectionMeta.host,
    port: connectionMeta.port,
    timeoutMs: 3000
  });
  let sessionId = 0;
  let replyId = USHRT_MAX - 1;
  const resolvedAuthPassword = Number.isInteger(authPassword)
    ? authPassword
    : connectionMeta.auth_password;
  const deviceNumber = Number.isInteger(connectionMeta.device_number)
    ? connectionMeta.device_number
    : 1;
  let connectResponseReceived = false;
  let authAttempted = false;
  let authResponseReceived = false;
  let authResponseCommand = null;
  let initiationSent = false;
  let initiationResponseReceived = false;
  let initiationResponseCommand = null;

  const sendStep = async ({ command, payload = Buffer.alloc(0), expected = ACK.OK, noReplyError }) => {
    const requestReplyId = nextReplyId(replyId);
    const result = await sendTcpCommand({
      channel,
      timeoutMs: 3000,
      command,
      sessionId,
      replyId: requestReplyId,
      payload,
      noReplyError: noReplyError || FAILURE_REASON.ATTLOG_STAGE_FAILED,
      deviceNumber
    });
    if (!result.ok || !result.response) {
      return result;
    }
    sessionId = result.response.session_id;
    replyId = result.response.reply_id;
    if (Number.isInteger(expected) && result.response.command !== expected) {
      return {
        ok: false,
        error: 'unexpected_response_command',
        response: result.response
      };
    }
    return result;
  };

  try {
    await channel.connect();
    const connect = await sendStep({
      command: COMMANDS.CONNECT,
      payload: Buffer.alloc(0),
      expected: null,
      noReplyError: FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY
    });
    if (!connect.ok || !connect.response) {
      return {
        ok: false,
        reason: connect.error || FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY,
        initiation_session_opened: false,
        initiation_sent: false,
        initiation_response_received: false,
        initiation_response_command: null
      };
    }
    connectResponseReceived = true;
    const tryAuth = async () => {
      authAttempted = true;
      if (!Number.isInteger(resolvedAuthPassword)) {
        return { ok: false, reason: 'auth_password_missing' };
      }
      const auth = await sendStep({
        command: COMMANDS.AUTH,
        payload: makeCommKey(resolvedAuthPassword, sessionId),
        expected: ACK.OK,
        noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED
      });
      authResponseReceived = auth.ok === true && Boolean(auth.response);
      authResponseCommand = auth.response ? auth.response.command : null;
      if (!auth.ok || !auth.response) {
        return { ok: false, reason: auth.error || FAILURE_REASON.AUTH_STAGE_FAILED };
      }
      return { ok: true };
    };
    if (connect.response.command === ACK.UNAUTH) {
      const authRes = await tryAuth();
      if (!authRes.ok) {
        return {
          ok: false,
          reason: authRes.reason || 'auth_failed',
          initiation_session_opened: true,
          initiation_sent: false,
          initiation_response_received: false,
          initiation_response_command: null,
          connect_response_received: connectResponseReceived,
          auth_attempted: authAttempted,
          auth_response_received: authResponseReceived,
          auth_response_command: authResponseCommand
        };
      }
    } else if (connect.response.command !== ACK.OK) {
      return {
        ok: false,
        reason: FAILURE_REASON.PROTOCOL_VARIANT_MISMATCH,
        initiation_session_opened: true,
        initiation_sent: false,
        initiation_response_received: false,
        initiation_response_command: null,
        connect_response_received: connectResponseReceived,
        auth_attempted: authAttempted,
        auth_response_received: authResponseReceived,
        auth_response_command: authResponseCommand
      };
    } else {
      await tryAuth();
    }

    const initiation = await sendStep({
      command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
      payload: Buffer.from('ffff0000', 'hex'),
      expected: ACK.OK,
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED
    });
    initiationSent = true;
    initiationResponseReceived = initiation.ok === true && Boolean(initiation.response);
    initiationResponseCommand = initiation.response ? initiation.response.command : null;

    return {
      ok: initiation.ok === true,
      reason: initiation.ok === true ? null : (initiation.error || 'initiation_failed'),
      initiation_session_opened: true,
      initiation_sent: initiationSent,
      initiation_response_received: initiationResponseReceived,
      initiation_response_command: initiationResponseCommand,
      initiation_response_command_hex: Number.isInteger(initiationResponseCommand)
        ? commandToHex(initiationResponseCommand)
        : null,
      connect_response_received: connectResponseReceived,
      auth_attempted: authAttempted,
      auth_response_received: authResponseReceived,
      auth_response_command: authResponseCommand,
      auth_response_command_hex: Number.isInteger(authResponseCommand)
        ? commandToHex(authResponseCommand)
        : null
    };
  } catch (err) {
    return {
      ok: false,
      reason: mapSocketErrorCode(err),
      initiation_session_opened: connectResponseReceived,
      initiation_sent: initiationSent,
      initiation_response_received: initiationResponseReceived,
      initiation_response_command: initiationResponseCommand,
      connect_response_received: connectResponseReceived,
      auth_attempted: authAttempted,
      auth_response_received: authResponseReceived,
      auth_response_command: authResponseCommand
    };
  } finally {
    try {
      const exitReplyId = nextReplyId(replyId);
      await sendTcpCommand({
        channel,
        timeoutMs: 1200,
        command: COMMANDS.EXIT,
        sessionId,
        replyId: exitReplyId,
        payload: Buffer.alloc(0),
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
        deviceNumber
      });
    } catch (err) {
      // no-op
    }
    channel.close();
  }
}

function startK80RealtimeSubscriber({
  deviceUid,
  vendor = 'zkteco',
  deviceTimezone = 'Africa/Tunis',
  authPassword = null,
  connection = null,
  onFlush,
  onSessionResult
} = {}) {
  const policy = resolveK80RtSubscriberPolicy();
  if (!policy.enabled) {
    return { started: false, reason: 'subscriber_disabled' };
  }
  if (!normalizeText(deviceUid) || !policy.allowlist.includes(normalizeText(deviceUid))) {
    return { started: false, reason: 'device_not_allowlisted' };
  }
  const connectionMeta = resolveK80RtSubscriberConnection({ policy, connection });
  if (!connectionMeta.host) {
    return { started: false, reason: 'missing_host' };
  }

  const signal = { cancelled: false };
  let loopPromise = null;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  const loop = async () => {
    while (!signal.cancelled) {
      const result = await runK80RealtimeSubscriberSession({
        deviceUid,
        vendor,
        deviceTimezone,
        authPassword,
        connection,
        signal,
        onFlush
      });
      if (typeof onSessionResult === 'function') {
        try {
          onSessionResult(result);
        } catch (err) {
          // no-op
        }
      }
      if (signal.cancelled) {
        break;
      }
      await sleep(policy.reconnect_delay_ms);
    }
  };
  loopPromise = loop();

  return {
    started: true,
    stop: async () => {
      signal.cancelled = true;
      try {
        await loopPromise;
      } catch (err) {
        // no-op
      }
    }
  };
}

async function runK80EnrollmentAttempt(commandPayload = {}, options = {}) {
  const safePayload = isPlainObject(commandPayload) ? commandPayload : {};
  const connection = isPlainObject(safePayload.connection) ? safePayload.connection : {};
  const enrollment = isPlainObject(safePayload.enrollment) ? safePayload.enrollment : {};
  const enrollmentV2Policy = resolveK80EnrollmentV2Policy({
    commandPayload: safePayload,
    connection
  });
  if (enrollmentV2Policy.enabled === true) {
    const stage6DispatchProbe = buildEnrollmentTransitSnapshot(commandPayload, 'v2_stage6_dispatch');
    const safeOptions = isPlainObject(options) ? options : {};
    const incomingProbe = isPlainObject(safeOptions.k80_v2_runtime_probe)
      ? safeOptions.k80_v2_runtime_probe
      : {};
    return runK80EnrollmentAttemptV2(commandPayload, {
      ...safeOptions,
      k80_v2_runtime_probe: {
        ...incomingProbe,
        ...stage6DispatchProbe
      },
      k80_enrollment_v2_policy: enrollmentV2Policy,
      k80_v2_helpers: {
        createTcpChannel,
        sendTcpCommand,
        makeCommKey,
        nextReplyId,
        mapSocketErrorCode,
        COMMANDS,
        ACK,
        FAILURE_REASON
      }
    });
  }
  const timeoutMs = Number.isInteger(options.timeout_ms)
    ? options.timeout_ms
    : 2000;
  const progressTimeoutMs = Number.isInteger(enrollment.progress_timeout_ms)
    ? Math.max(5000, Math.min(enrollment.progress_timeout_ms, 120000))
    : 45000;

  const host = normalizeText(connection.host);
  const port = Number.isInteger(connection.port) ? connection.port : PORT_DEFAULT;
  const authPassword = Number.isInteger(connection.auth_password)
    ? connection.auth_password
    : null;
  const deviceNumber = Number.isInteger(connection.device_number)
    ? connection.device_number
    : 1;

  const evidenceFlags = {
    saw_003e: false,
    saw_003d: false,
    saw_01f4_progress: false,
    saw_05df: false,
    saw_05dd_after_05df: false,
    saw_0058_continue_tx: false,
    saw_05dc_after_0058: false,
    saw_second_05dd_after_05dc: false
  };
  const sequence = [];
  const rawFrameRefs = [];
  let continuationBranchArmed = false;
  const pre003ePrimingPolicy = resolveK80EnrollmentPre003ePrimingPolicy();
  const post2710ClosurePolicy = resolveK80EnrollmentPost2710ClosurePolicy();
  const pre003ePrimingPlan = buildK80EnrollmentPre003ePrimingSteps({
    policy: pre003ePrimingPolicy
  });
  const earlyMarkerDebugPolicy = resolveK80EnrollmentEarlyMarkerDebugPolicy();
  const earlyMarkerDebug = earlyMarkerDebugPolicy.enabled === true
    ? {
      debug_policy_mode: earlyMarkerDebugPolicy.mode,
      cmd_003e: {
        tx_attempted: false,
        tx_ack_observed: false,
        tx_session_id: null,
        tx_reply_id: null,
        legacy_marker_flag: false
      },
      cmd_003d: {
        tx_attempted: false,
        tx_ack_observed: false,
        tx_session_id: null,
        tx_reply_id: null,
        legacy_marker_flag: false
      },
      cmd_01f4: {
        tx_attempted_count: 0,
        tx_ack_observed_count: 0,
        tx_last_session_id: null,
        tx_last_reply_id: null,
        legacy_marker_flag: false
      }
    }
    : null;
  const pre003ePrimingAttemptedSteps = [];
  const pre003ePrimingRepliesObserved = [];
  const pre003ePrimingLineageObserved = [];
  let pre003ePrimingCompletedBefore003e = false;
  let post2710ExpectedFamilyMatched = null;
  let post2710PrepareDataObserved = false;
  let post2710TrailingFramesDrained = 0;
  let post2710FreeDataInvoked = false;
  let post2710ClosureCompletedBeforeFirst000b = false;
  const closePairPolicy = resolveK80EnrollmentClosePairPolicy();
  let postSecond05ddCloseMode = 'disabled_or_ineligible';
  let postSecond05ddCloseClassifier = 'unavailable';
  let postSecond05ddCloseFirstHostCommand = null;
  let postSecond05ddCloseSecondHostCommand = null;
  let postSecond05ddClose003eTx = false;
  let postSecond05ddClose003cTx = false;
  let postSecond05ddClose03e9Tx = false;
  let postSecond05ddClose003eAckObserved = false;
  let postSecond05ddClose003cAckObserved = false;
  let postSecond05ddClose03e9AckObserved = false;
  const promptBoundaryLineagePolicy = resolveK80EnrollmentPromptBoundaryLineagePolicy();
  const promptBoundarySessionHandoffPolicy = resolveK80EnrollmentPromptBoundarySessionHandoffPolicy();
  let promptBoundarySessionHandoffIntroduced = false;
  let promptBoundarySessionBeforeHandoff = null;
  let promptBoundarySessionAfterHandoff = null;
  let promptBoundarySeedReplyFrom01f4Ff7f = null;
  let promptBoundary01f4Ff7fSessionId = null;
  let promptBoundary01f4Ff7fReplyId = null;
  let promptBoundary003eSessionIdSent = null;
  let promptBoundary003eReplyIdSent = null;
  let promptBoundary003eAckSessionIdObserved = null;
  let promptBoundary003eAckReplyIdObserved = null;
  let promptBoundary003dSessionIdSent = null;
  let promptBoundary003dReplyIdSent = null;
  let promptBoundary003dAckSessionIdObserved = null;
  let promptBoundary003dAckReplyIdObserved = null;
  let promptBoundaryFreshSessionIntroduced = false;

  const pushObservedFrame = ({ stage, parsed }) => {
    if (!parsed) {
      return;
    }
    const commandHex = commandToHex(parsed.command);
    sequence.push(commandHex);
    rawFrameRefs.push({
      stage: normalizeText(stage) || null,
      command: parsed.command,
      command_hex: commandHex,
      session_id: parsed.session_id,
      reply_id: parsed.reply_id,
      payload_bytes: Buffer.isBuffer(parsed.payload) ? parsed.payload.length : 0,
      payload_hex: Buffer.isBuffer(parsed.payload) ? bufferToHex(parsed.payload, 256) : ''
    });
    if (parsed.command === COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY) {
      evidenceFlags.saw_003e = true;
    }
    if (parsed.command === COMMANDS.ZKTIME_ENROLL_SELECTION) {
      evidenceFlags.saw_003d = true;
    }
    if (parsed.command === COMMANDS.ZKTIME_RT_SUBSCRIBE && Buffer.isBuffer(parsed.payload) && parsed.payload.length > 0) {
      evidenceFlags.saw_01f4_progress = true;
      progressionFramesObservedCount += 1;
    }
    if (parsed.command === COMMANDS.ZKTIME_PULL_REQUEST) {
      evidenceFlags.saw_05df = true;
    }
    if (parsed.command === COMMANDS.ZKTIME_PULL_RESPONSE && evidenceFlags.saw_05df) {
      evidenceFlags.saw_05dd_after_05df = true;
    }
    if (continuationBranchArmed && parsed.command === COMMANDS.ZKTIME_PULL_CONTINUE_MARKER) {
      evidenceFlags.saw_05dc_after_0058 = true;
    }
    if (
      continuationBranchArmed
      && parsed.command === COMMANDS.ZKTIME_PULL_RESPONSE
      && evidenceFlags.saw_05dc_after_0058
    ) {
      evidenceFlags.saw_second_05dd_after_05dc = true;
    }
  };

  if (!host || !Number.isInteger(authPassword) || !Number.isInteger(enrollment.device_user_id)) {
    return {
      ok: false,
      attempt_status: 'partial_or_failed',
      status_reason: 'enrollment_connection_or_payload_invalid',
      protocol_execution_state: 'not_started',
      protocol_session_ref: null,
      evidence_flags: evidenceFlags,
      evidence_refs: {
        marker_sequence: sequence,
        raw_frames: rawFrameRefs
      },
      source_metadata: {
        conservative_evidence_classification: true
      }
    };
  }

  let channel = createTcpChannel({ host, port, timeoutMs });
  let sessionId = 0;
  let replyId = USHRT_MAX - 1;
  let protocolSessionRef = null;
  let statusReason = 'partial_or_failed_without_success_chain';
  let finalStatus = 'partial_or_failed';
  let enrollControlSessionIdFrom003dTx = null;
  let enrollControlReplyIdFrom003dTx = null;
  const postProgressContinuationPolicy = resolveK80EnrollmentPostProgressContinuationPolicy();
  let postProgressContinuationPlan = {
    mode: 'disabled_or_ineligible',
    session_id_sent: null,
    reply_id_sent: null,
    payload: Buffer.alloc(0),
    context_source: 'disabled_or_ineligible',
    session_source: 'disabled_or_ineligible',
    reply_source: 'disabled_or_ineligible'
  };
  let progressionAckTxCount = 0;
  let progressionAckTxErrorCount = 0;
  let progressionFramesObservedCount = 0;
  let postProgress05dfPlan = {
    mode: 'legacy_empty_probe',
    context_source: 'legacy_live_state',
    payload: Buffer.alloc(0),
    session_id_sent: null,
    reply_id_sent: null
  };
  let selectionPayload = {
    payload_basis: 'conservative_placeholder_unresolved_003d_layout_v1',
    payload_version: 'legacy_8b_v1',
    payload_len: null,
    selection_offset_00_emitted: null,
    selection_offset_01_emitted: null,
    selection_offset_24_emitted: null,
    unresolved_003d_offset_00: true
  };

  try {
    await channel.connect();

    const sendStep = async ({
      stage,
      command,
      payload = Buffer.alloc(0),
      noReplyError,
      requestReplyIdOverride = null
    }) => {
      const requestReplyId = Number.isInteger(requestReplyIdOverride)
        ? requestReplyIdOverride
        : nextReplyId(replyId);
      const response = await sendTcpCommand({
        channel,
        timeoutMs,
        command,
        sessionId,
        replyId: requestReplyId,
        payload,
        noReplyError
      });
      if (response.ok && response.response) {
        sessionId = response.response.session_id;
        replyId = response.response.reply_id;
        protocolSessionRef = `${sessionId}:${replyId}`;
        pushObservedFrame({ stage, parsed: response.response });
      }
      return response;
    };

    const connect = await sendStep({
      stage: 'connect',
      command: COMMANDS.CONNECT,
      noReplyError: FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY
    });
    if (!connect.ok || !connect.response) {
      return {
        ok: false,
        attempt_status: 'partial_or_failed',
        status_reason: connect.error || 'connect_failed',
        protocol_execution_state: 'failed_connect',
        protocol_session_ref: protocolSessionRef,
        evidence_flags: evidenceFlags,
        evidence_refs: {
          marker_sequence: sequence,
          raw_frames: rawFrameRefs
        },
        source_metadata: {
          conservative_evidence_classification: true
        }
      };
    }
    if (connect.response.command === ACK.UNAUTH) {
      const auth = await sendStep({
        stage: 'auth',
        command: COMMANDS.AUTH,
        payload: makeCommKey(authPassword, sessionId),
        noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED
      });
      if (!auth.ok || !auth.response || auth.response.command !== ACK.OK) {
        return {
          ok: false,
          attempt_status: 'partial_or_failed',
          status_reason: auth.error || 'auth_failed',
          protocol_execution_state: 'failed_auth',
          protocol_session_ref: protocolSessionRef,
          evidence_flags: evidenceFlags,
          evidence_refs: {
            marker_sequence: sequence,
            raw_frames: rawFrameRefs
          },
          source_metadata: {
            conservative_evidence_classification: true
          }
        };
      }
    } else if (connect.response.command !== ACK.OK) {
      return {
        ok: false,
        attempt_status: 'partial_or_failed',
        status_reason: 'connect_ack_not_ok',
        protocol_execution_state: 'failed_connect',
        protocol_session_ref: protocolSessionRef,
        evidence_flags: evidenceFlags,
        evidence_refs: {
          marker_sequence: sequence,
          raw_frames: rawFrameRefs
        },
        source_metadata: {
          conservative_evidence_classification: true
        }
      };
    }

    if (
      pre003ePrimingPlan.mode === 'guarded_official_pre003e_subset_v1'
      || pre003ePrimingPlan.mode === 'guarded_official_pre003e_parity_v2'
    ) {
      for (const primingStep of pre003ePrimingPlan.steps) {
        const safeStep = primingStep && typeof primingStep === 'object'
          ? primingStep
          : {};
        const stepId = normalizeText(safeStep.step_id) || 'unknown_step';
        const primingRequestSessionId = sessionId;
        const primingRequestReplyId = nextReplyId(replyId);
        if (earlyMarkerDebug && safeStep.command === COMMANDS.ZKTIME_RT_SUBSCRIBE) {
          earlyMarkerDebug.cmd_01f4.tx_attempted_count += 1;
          earlyMarkerDebug.cmd_01f4.tx_last_session_id = Number.isInteger(primingRequestSessionId)
            ? primingRequestSessionId
            : null;
          earlyMarkerDebug.cmd_01f4.tx_last_reply_id = Number.isInteger(primingRequestReplyId)
            ? primingRequestReplyId
            : null;
        }
        pre003ePrimingAttemptedSteps.push(stepId);
        if (stepId === 'rt_subscribe_ff7f0000') {
          promptBoundarySeedReplyFrom01f4Ff7f = Number.isInteger(primingRequestReplyId)
            ? primingRequestReplyId
            : null;
          promptBoundary01f4Ff7fSessionId = Number.isInteger(primingRequestSessionId)
            ? primingRequestSessionId
            : null;
          promptBoundary01f4Ff7fReplyId = Number.isInteger(primingRequestReplyId)
            ? primingRequestReplyId
            : null;
        }
        const primingResult = await sendStep({
          stage: `pre003e_priming_${stepId}`,
          command: safeStep.command,
          payload: Buffer.isBuffer(safeStep.payload) ? safeStep.payload : Buffer.alloc(0),
          noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED
        });
        if (
          earlyMarkerDebug
          && safeStep.command === COMMANDS.ZKTIME_RT_SUBSCRIBE
          && primingResult
          && primingResult.ok
          && primingResult.response
          && primingResult.response.command === ACK.OK
        ) {
          earlyMarkerDebug.cmd_01f4.tx_ack_observed_count += 1;
        }
        if (primingResult && primingResult.ok && primingResult.response) {
          pre003ePrimingRepliesObserved.push({
            step_id: stepId,
            response_command: primingResult.response.command,
            response_command_hex: commandToHex(primingResult.response.command)
          });
        } else {
          pre003ePrimingRepliesObserved.push({
            step_id: stepId,
            response_command: null,
            response_command_hex: null
          });
        }
        pre003ePrimingLineageObserved.push({
          step_id: stepId,
          request_command: safeStep.command,
          request_command_hex: commandToHex(safeStep.command),
          request_session_id: Number.isInteger(primingRequestSessionId) ? primingRequestSessionId : null,
          request_reply_id: Number.isInteger(primingRequestReplyId) ? primingRequestReplyId : null,
          response_command: primingResult && primingResult.ok && primingResult.response
            ? primingResult.response.command
            : null,
          response_command_hex: primingResult && primingResult.ok && primingResult.response
            ? commandToHex(primingResult.response.command)
            : null,
          response_session_id: primingResult && primingResult.ok && primingResult.response
            ? primingResult.response.session_id
            : null,
          response_reply_id: primingResult && primingResult.ok && primingResult.response
            ? primingResult.response.reply_id
            : null,
          response_payload_len: primingResult && primingResult.ok && primingResult.response && Buffer.isBuffer(primingResult.response.payload)
            ? primingResult.response.payload.length
            : null,
          control_lineage: 'same_session_pre_003e'
        });

        if (
          post2710ClosurePolicy.guarded_enabled === true
          && stepId === 'premode_2710'
        ) {
          const responseCommand = primingResult && primingResult.ok && primingResult.response
            ? primingResult.response.command
            : null;
          post2710ExpectedFamilyMatched = isK80Post2710ExpectedResponseCommand(responseCommand);
          post2710PrepareDataObserved = responseCommand === COMMANDS.PREPARE_DATA;

          if (post2710PrepareDataObserved) {
            const drainDeadline = Date.now() + 1200;
            while (Date.now() < drainDeadline) {
              let trailingFrame = null;
              try {
                trailingFrame = await channel.receiveFrame(180);
              } catch (err) {
                const code = err && err.code ? String(err.code) : '';
                if (code === 'REPLY_TIMEOUT') {
                  break;
                }
                break;
              }
              if (!trailingFrame || !Buffer.isBuffer(trailingFrame.payload)) {
                continue;
              }
              const trailingParsed = parsePacket(trailingFrame.payload);
              if (!trailingParsed) {
                continue;
              }
              post2710TrailingFramesDrained += 1;
              sessionId = trailingParsed.session_id;
              replyId = trailingParsed.reply_id;
              protocolSessionRef = `${sessionId}:${replyId}`;
              pushObservedFrame({ stage: 'pre003e_post2710_closure_drain', parsed: trailingParsed });
              if (trailingParsed.command === ACK.OK || trailingParsed.command === ACK.ERROR) {
                break;
              }
            }

            post2710FreeDataInvoked = true;
            const freeDataReplyId = nextReplyId(replyId);
            const freeDataResult = await sendTcpCommand({
              channel,
              timeoutMs,
              command: COMMANDS.FREE_DATA,
              sessionId,
              replyId: freeDataReplyId,
              payload: Buffer.alloc(0),
              noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
              deviceNumber
            });
            if (freeDataResult.ok && freeDataResult.response) {
              sessionId = freeDataResult.response.session_id;
              replyId = freeDataResult.response.reply_id;
              protocolSessionRef = `${sessionId}:${replyId}`;
              pushObservedFrame({ stage: 'pre003e_post2710_closure_free_data', parsed: freeDataResult.response });
            }
          }
          post2710ClosureCompletedBeforeFirst000b = true;
        }
      }
      pre003ePrimingCompletedBefore003e = true;
    }

    if (promptBoundarySessionHandoffPolicy.guarded_enabled === true) {
      promptBoundarySessionBeforeHandoff = Number.isInteger(sessionId)
        ? sessionId
        : null;
      try {
        channel.close();
      } catch (err) {
        // no-op
      }
      channel = createTcpChannel({ host, port, timeoutMs });
      sessionId = 0;
      replyId = USHRT_MAX - 1;
      protocolSessionRef = null;
      await channel.connect();

      const handoffConnect = await sendStep({
        stage: 'prompt_boundary_handoff_connect',
        command: COMMANDS.CONNECT,
        noReplyError: FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY
      });
      if (!handoffConnect.ok || !handoffConnect.response) {
        return {
          ok: false,
          attempt_status: 'partial_or_failed',
          status_reason: handoffConnect.error || 'connect_failed',
          protocol_execution_state: 'failed_connect',
          protocol_session_ref: protocolSessionRef,
          evidence_flags: evidenceFlags,
          evidence_refs: {
            marker_sequence: sequence,
            raw_frames: rawFrameRefs
          },
          source_metadata: {
            conservative_evidence_classification: true
          }
        };
      }
      if (handoffConnect.response.command === ACK.UNAUTH) {
        const handoffAuth = await sendStep({
          stage: 'prompt_boundary_handoff_auth',
          command: COMMANDS.AUTH,
          payload: makeCommKey(authPassword, sessionId),
          noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED
        });
        if (!handoffAuth.ok || !handoffAuth.response || handoffAuth.response.command !== ACK.OK) {
          return {
            ok: false,
            attempt_status: 'partial_or_failed',
            status_reason: handoffAuth.error || 'auth_failed',
            protocol_execution_state: 'failed_auth',
            protocol_session_ref: protocolSessionRef,
            evidence_flags: evidenceFlags,
            evidence_refs: {
              marker_sequence: sequence,
              raw_frames: rawFrameRefs
            },
            source_metadata: {
              conservative_evidence_classification: true
            }
          };
        }
      } else if (handoffConnect.response.command !== ACK.OK) {
        return {
          ok: false,
          attempt_status: 'partial_or_failed',
          status_reason: 'connect_ack_not_ok',
          protocol_execution_state: 'failed_connect',
          protocol_session_ref: protocolSessionRef,
          evidence_flags: evidenceFlags,
          evidence_refs: {
            marker_sequence: sequence,
            raw_frames: rawFrameRefs
          },
          source_metadata: {
            conservative_evidence_classification: true
          }
        };
      }
      promptBoundarySessionHandoffIntroduced = true;
      promptBoundaryFreshSessionIntroduced = true;
      promptBoundarySessionAfterHandoff = Number.isInteger(sessionId)
        ? sessionId
        : null;
    }

    const boundaryTxSessionId = sessionId;
    const boundaryTxReplyId = (
      promptBoundaryLineagePolicy.guarded_enabled === true
      && Number.isInteger(promptBoundarySeedReplyFrom01f4Ff7f)
    )
      ? nextReplyId(promptBoundarySeedReplyFrom01f4Ff7f)
      : nextReplyId(replyId);
    promptBoundary003eSessionIdSent = Number.isInteger(boundaryTxSessionId)
      ? boundaryTxSessionId
      : null;
    promptBoundary003eReplyIdSent = Number.isInteger(boundaryTxReplyId)
      ? boundaryTxReplyId
      : null;
    if (earlyMarkerDebug) {
      earlyMarkerDebug.cmd_003e.tx_attempted = true;
      earlyMarkerDebug.cmd_003e.tx_session_id = Number.isInteger(boundaryTxSessionId)
        ? boundaryTxSessionId
        : null;
      earlyMarkerDebug.cmd_003e.tx_reply_id = Number.isInteger(boundaryTxReplyId)
        ? boundaryTxReplyId
        : null;
    }
    const boundary = await sendStep({
      stage: 'enroll_boundary',
      command: COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY,
      payload: Buffer.alloc(0),
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
      requestReplyIdOverride: boundaryTxReplyId
    });
    if (boundary.ok && boundary.response) {
      promptBoundary003eAckSessionIdObserved = Number.isInteger(boundary.response.session_id)
        ? boundary.response.session_id
        : null;
      promptBoundary003eAckReplyIdObserved = Number.isInteger(boundary.response.reply_id)
        ? boundary.response.reply_id
        : null;
    }
    if (earlyMarkerDebug) {
      earlyMarkerDebug.cmd_003e.tx_ack_observed = boundary.ok === true
        && !!boundary.response
        && boundary.response.command === ACK.OK;
    }
    if (boundary.ok && boundary.response && boundary.response.command === COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY) {
      evidenceFlags.saw_003e = true;
    }

    const selectionPayloadPolicy = resolveK80Enrollment003dPayloadPolicy();
    selectionPayload = buildConservativeEnrollmentSelectionPayload({
      deviceUserId: enrollment.device_user_id,
      selectedFinger: enrollment.selected_finger,
      payloadPolicy: selectionPayloadPolicy
    });
    const selectionTxSessionId = sessionId;
    const selectionTxReplyId = (
      promptBoundaryLineagePolicy.guarded_enabled === true
      && Number.isInteger(promptBoundarySeedReplyFrom01f4Ff7f)
    )
      ? nextReplyId(nextReplyId(promptBoundarySeedReplyFrom01f4Ff7f))
      : nextReplyId(replyId);
    promptBoundary003dSessionIdSent = Number.isInteger(selectionTxSessionId)
      ? selectionTxSessionId
      : null;
    promptBoundary003dReplyIdSent = Number.isInteger(selectionTxReplyId)
      ? selectionTxReplyId
      : null;
    const selection = await sendStep({
      stage: 'enroll_selection',
      command: COMMANDS.ZKTIME_ENROLL_SELECTION,
      payload: selectionPayload.payload,
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
      requestReplyIdOverride: selectionTxReplyId
    });
    if (selection.ok && selection.response) {
      promptBoundary003dAckSessionIdObserved = Number.isInteger(selection.response.session_id)
        ? selection.response.session_id
        : null;
      promptBoundary003dAckReplyIdObserved = Number.isInteger(selection.response.reply_id)
        ? selection.response.reply_id
        : null;
    }
    if (earlyMarkerDebug) {
      earlyMarkerDebug.cmd_003d.tx_attempted = true;
      earlyMarkerDebug.cmd_003d.tx_session_id = Number.isInteger(selectionTxSessionId)
        ? selectionTxSessionId
        : null;
      earlyMarkerDebug.cmd_003d.tx_reply_id = Number.isInteger(selectionTxReplyId)
        ? selectionTxReplyId
        : null;
      earlyMarkerDebug.cmd_003d.tx_ack_observed = selection.ok === true
        && !!selection.response
        && selection.response.command === ACK.OK;
    }
    enrollControlSessionIdFrom003dTx = selection && selection.ok
      ? selectionTxSessionId
      : enrollControlSessionIdFrom003dTx;
    enrollControlReplyIdFrom003dTx = selection && selection.ok
      ? selectionTxReplyId
      : enrollControlReplyIdFrom003dTx;
    if (selection.ok && selection.response) {
      if (selection.response.command === COMMANDS.ZKTIME_ENROLL_SELECTION) {
        evidenceFlags.saw_003d = true;
      }
    }

    const progressDeadline = Date.now() + progressTimeoutMs;
    while (Date.now() < progressDeadline) {
      let frame = null;
      try {
        frame = await channel.receiveFrame(1000);
      } catch (err) {
        const code = err && err.code ? String(err.code) : '';
        if (code === 'REPLY_TIMEOUT') {
          continue;
        }
        break;
      }
      if (!frame || !Buffer.isBuffer(frame.payload)) {
        continue;
      }
      const parsed = parsePacket(frame.payload);
      if (!parsed) {
        continue;
      }
      pushObservedFrame({ stage: 'progress_monitor', parsed });
      if (postProgressContinuationPolicy.guarded_enabled === true && parsed.command === COMMANDS.ZKTIME_RT_SUBSCRIBE) {
        const ackSessionId = Number.isInteger(enrollControlSessionIdFrom003dTx)
          ? enrollControlSessionIdFrom003dTx
          : sessionId;
        const ackReplyId = Number.isInteger(parsed.reply_id) ? parsed.reply_id : 0;
        try {
          const ackPacket = buildPacket({
            command: ACK.OK,
            sessionId: ackSessionId,
            replyId: ackReplyId,
            payload: Buffer.alloc(0)
          });
          const wrappedAck = buildTcpWrappedPacket(ackPacket);
          await channel.send(wrappedAck.frame);
          progressionAckTxCount += 1;
          sequence.push('0x07D0(tx_progress_ack)');
          rawFrameRefs.push({
            stage: 'progress_ack_tx',
            command: ACK.OK,
            command_hex: commandToHex(ACK.OK),
            session_id: ackSessionId,
            reply_id: ackReplyId,
            payload_bytes: 0,
            payload_hex: ''
          });
        } catch (err) {
          progressionAckTxErrorCount += 1;
        }
      }
    }

    const postProgress05dfPolicy = resolveK80EnrollmentPostProgress05dfPolicy();
    postProgress05dfPlan = buildPostProgress05dfProbePlan({
      policy: postProgress05dfPolicy,
      enrollControlSessionIdFrom003dTx,
      enrollControlReplyIdFrom003dTx
    });

    let resultProbe = null;
    evidenceFlags.saw_05df = true;
    sequence.push('0x05DF(tx)');
    if (postProgress05dfPlan.mode === 'guarded_enroll_probe_v1') {
      resultProbe = await sendTcpCommand({
        channel,
        timeoutMs,
        command: COMMANDS.ZKTIME_PULL_REQUEST,
        sessionId: postProgress05dfPlan.session_id_sent,
        replyId: postProgress05dfPlan.reply_id_sent,
        payload: postProgress05dfPlan.payload,
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
        deviceNumber
      });
      if (resultProbe && resultProbe.ok && resultProbe.response) {
        sessionId = resultProbe.response.session_id;
        replyId = resultProbe.response.reply_id;
        protocolSessionRef = `${sessionId}:${replyId}`;
        pushObservedFrame({ stage: 'result_probe_05df', parsed: resultProbe.response });
      }
    } else {
      resultProbe = await sendStep({
        stage: 'result_probe_05df',
        command: COMMANDS.ZKTIME_PULL_REQUEST,
        payload: postProgress05dfPlan.payload,
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED
      });
    }
    if (resultProbe && resultProbe.ok && resultProbe.response && resultProbe.response.command === COMMANDS.ZKTIME_PULL_REQUEST) {
      evidenceFlags.saw_05df = true;
    }

    if (
      postProgressContinuationPolicy.guarded_enabled === true
      && resultProbe
      && resultProbe.ok
      && resultProbe.response
      && resultProbe.response.command === COMMANDS.ZKTIME_PULL_RESPONSE
    ) {
      postProgressContinuationPlan = buildPostProgressContinuationPlan({
        policy: postProgressContinuationPolicy,
        enrollControlSessionIdFrom003dTx,
        first05ddReplyId: resultProbe.response.reply_id,
        first05ddPayload: Buffer.isBuffer(resultProbe.response.payload)
          ? resultProbe.response.payload
          : null,
        selectionOffset24From003dPayload: Number.isInteger(selectionPayload.selection_offset_24_emitted)
          ? selectionPayload.selection_offset_24_emitted
          : null,
        selectedFinger: enrollment.selected_finger
      });
      if (postProgressContinuationPlan.mode === 'guarded_post_progress_continuation_v1') {
        evidenceFlags.saw_0058_continue_tx = true;
        continuationBranchArmed = true;
        sequence.push('0x0058(tx_continue_after_05dd)');
        const continuationProbe = await sendTcpCommand({
          channel,
          timeoutMs,
          command: postProgressContinuationPlan.policy_command || COMMANDS.ZKTIME_ENROLL_RESULT_CONTINUE,
          sessionId: postProgressContinuationPlan.session_id_sent,
          replyId: postProgressContinuationPlan.reply_id_sent,
          payload: postProgressContinuationPlan.payload,
          noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
          deviceNumber
        });
        if (continuationProbe && continuationProbe.ok && continuationProbe.response) {
          sessionId = continuationProbe.response.session_id;
          replyId = continuationProbe.response.reply_id;
          protocolSessionRef = `${sessionId}:${replyId}`;
          pushObservedFrame({ stage: 'result_probe_0058', parsed: continuationProbe.response });
        }
        const continuationDeadline = Date.now() + 1400;
        while (Date.now() < continuationDeadline && !evidenceFlags.saw_second_05dd_after_05dc) {
          let continuationFrame = null;
          try {
            continuationFrame = await channel.receiveFrame(300);
          } catch (err) {
            const code = err && err.code ? String(err.code) : '';
            if (code === 'REPLY_TIMEOUT') {
              continue;
            }
            break;
          }
          if (!continuationFrame || !Buffer.isBuffer(continuationFrame.payload)) {
            continue;
          }
          const continuationParsed = parsePacket(continuationFrame.payload);
          if (!continuationParsed) {
            continue;
          }
          pushObservedFrame({ stage: 'result_probe_0058_followup', parsed: continuationParsed });
        }
      }
    }

    const continuationEvidenceObserved = (
      evidenceFlags.saw_0058_continue_tx
      && evidenceFlags.saw_05dc_after_0058
      && evidenceFlags.saw_second_05dd_after_05dc
    );
    if (
      evidenceFlags.saw_05df
      && evidenceFlags.saw_05dd_after_05df
      && (
        postProgressContinuationPolicy.guarded_enabled !== true
        || continuationEvidenceObserved
      )
    ) {
      finalStatus = 'success';
      statusReason = 'success_chain_observed_05df_05dd';
    } else if (
      postProgressContinuationPolicy.guarded_enabled === true
      && evidenceFlags.saw_05df
      && evidenceFlags.saw_05dd_after_05df
      && !continuationEvidenceObserved
    ) {
      finalStatus = 'partial_or_failed';
      statusReason = 'continuation_branch_missing_after_first_05dd';
    } else if (evidenceFlags.saw_003d && !evidenceFlags.saw_01f4_progress) {
      finalStatus = 'cancelled';
      statusReason = 'cancelled_or_no_progress_after_selection';
    } else {
      finalStatus = 'partial_or_failed';
      statusReason = 'partial_or_failed_without_success_chain';
    }
  } catch (err) {
    statusReason = mapSocketErrorCode(err);
    finalStatus = 'partial_or_failed';
  } finally {
    const closeHostCommandSequence = [];
    const pushCloseCommand = commandHex => {
      closeHostCommandSequence.push(commandHex);
      if (closeHostCommandSequence.length >= 1) {
        postSecond05ddCloseFirstHostCommand = closeHostCommandSequence[0];
      }
      if (closeHostCommandSequence.length >= 2) {
        postSecond05ddCloseSecondHostCommand = closeHostCommandSequence[1];
      }
    };
    if (evidenceFlags.saw_second_05dd_after_05dc === true) {
      if (closePairPolicy.guarded_enabled === true) {
        postSecond05ddCloseMode = closePairPolicy.mode;
        try {
          const boundaryReplyId = nextReplyId(replyId);
          postSecond05ddClose003eTx = true;
          pushCloseCommand(commandToHex(COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY));
          const boundaryClose = await sendTcpCommand({
            channel,
            timeoutMs: 1200,
            command: COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY,
            sessionId,
            replyId: boundaryReplyId,
            payload: Buffer.alloc(0),
            noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
            deviceNumber
          });
          if (boundaryClose && boundaryClose.ok && boundaryClose.response) {
            postSecond05ddClose003eAckObserved = boundaryClose.response.command === ACK.OK;
            sessionId = boundaryClose.response.session_id;
            replyId = boundaryClose.response.reply_id;
            protocolSessionRef = `${sessionId}:${replyId}`;
          }
        } catch (err) {
          // no-op
        }
        try {
          const verifyReplyId = nextReplyId(replyId);
          postSecond05ddClose003cTx = true;
          pushCloseCommand(commandToHex(COMMANDS.ZKTIME_ENROLL_START_VERIFY));
          const verifyClose = await sendTcpCommand({
            channel,
            timeoutMs: 1200,
            command: COMMANDS.ZKTIME_ENROLL_START_VERIFY,
            sessionId,
            replyId: verifyReplyId,
            payload: Buffer.alloc(0),
            noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
            deviceNumber
          });
          if (verifyClose && verifyClose.ok && verifyClose.response) {
            postSecond05ddClose003cAckObserved = verifyClose.response.command === ACK.OK;
            sessionId = verifyClose.response.session_id;
            replyId = verifyClose.response.reply_id;
            protocolSessionRef = `${sessionId}:${replyId}`;
          }
        } catch (err) {
          // no-op
        }
      } else {
        postSecond05ddCloseMode = closePairPolicy.mode;
      }
    }
    try {
      const exitReplyId = nextReplyId(replyId);
      postSecond05ddClose03e9Tx = true;
      pushCloseCommand(commandToHex(COMMANDS.EXIT));
      const exitClose = await sendTcpCommand({
        channel,
        timeoutMs: 1200,
        command: COMMANDS.EXIT,
        sessionId,
        replyId: exitReplyId,
        payload: Buffer.alloc(0),
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED,
        deviceNumber
      });
      if (exitClose && exitClose.ok && exitClose.response) {
        postSecond05ddClose03e9AckObserved = exitClose.response.command === ACK.OK;
      }
    } catch (err) {
      // no-op
    }
    if (evidenceFlags.saw_second_05dd_after_05dc === true) {
      if (postSecond05ddClose003eTx === true && postSecond05ddClose003cTx === true) {
        postSecond05ddCloseClassifier = 'working-close-pair-present';
      } else if (
        postSecond05ddCloseFirstHostCommand === commandToHex(COMMANDS.EXIT)
        && postSecond05ddClose003eTx !== true
        && postSecond05ddClose003cTx !== true
      ) {
        postSecond05ddCloseClassifier = 'direct-exit';
      } else {
        postSecond05ddCloseClassifier = 'other-close-pattern';
      }
    }
    if (postSecond05ddCloseFirstHostCommand === null && closeHostCommandSequence.length > 0) {
      postSecond05ddCloseFirstHostCommand = closeHostCommandSequence[0];
    }
    if (postSecond05ddCloseSecondHostCommand === null && closeHostCommandSequence.length > 1) {
      postSecond05ddCloseSecondHostCommand = closeHostCommandSequence[1];
    }
    channel.close();
  }

  if (earlyMarkerDebug) {
    earlyMarkerDebug.cmd_003e.legacy_marker_flag = evidenceFlags.saw_003e === true;
    earlyMarkerDebug.cmd_003d.legacy_marker_flag = evidenceFlags.saw_003d === true;
    earlyMarkerDebug.cmd_01f4.legacy_marker_flag = evidenceFlags.saw_01f4_progress === true;
  }

  return {
    ok: finalStatus === 'success',
    attempt_status: finalStatus,
    status_reason: statusReason,
    protocol_execution_state: finalStatus === 'success' ? 'completed_success' : 'completed_non_success',
    protocol_session_ref: protocolSessionRef,
    evidence_flags: evidenceFlags,
    evidence_refs: {
      marker_sequence: sequence,
      raw_frames: rawFrameRefs
    },
    source_metadata: {
      conservative_evidence_classification: true,
      unresolved_003d_field_map_guarded: true,
      unresolved_003d_offset_00: selectionPayload.unresolved_003d_offset_00 === true,
      unresolved_01f4_short_value_semantics_guarded: true,
      selection_payload_basis: selectionPayload.payload_basis || 'conservative_placeholder_unresolved_003d_layout_v1',
      selection_payload_version: selectionPayload.payload_version || 'legacy_8b_v1',
      selection_payload_len: Number.isInteger(selectionPayload.payload_len) ? selectionPayload.payload_len : null,
      selection_offset_00_emitted: Number.isInteger(selectionPayload.selection_offset_00_emitted)
        ? selectionPayload.selection_offset_00_emitted
        : null,
      selection_offset_01_emitted: Number.isInteger(selectionPayload.selection_offset_01_emitted)
        ? selectionPayload.selection_offset_01_emitted
        : null,
      selection_offset_24_emitted: Number.isInteger(selectionPayload.selection_offset_24_emitted)
        ? selectionPayload.selection_offset_24_emitted
        : null,
      post_progress_05df_mode: postProgress05dfPlan && postProgress05dfPlan.mode
        ? postProgress05dfPlan.mode
        : 'legacy_empty_probe',
      post_progress_05df_body_len: postProgress05dfPlan && Buffer.isBuffer(postProgress05dfPlan.payload)
        ? postProgress05dfPlan.payload.length
        : null,
      post_progress_05df_body_hex_prefix: postProgress05dfPlan && Buffer.isBuffer(postProgress05dfPlan.payload)
        ? bufferToHex(postProgress05dfPlan.payload, 64)
        : '',
      post_progress_05df_session_id_sent: postProgress05dfPlan && Number.isInteger(postProgress05dfPlan.session_id_sent)
        ? postProgress05dfPlan.session_id_sent
        : null,
      post_progress_05df_reply_id_sent: postProgress05dfPlan && Number.isInteger(postProgress05dfPlan.reply_id_sent)
        ? postProgress05dfPlan.reply_id_sent
        : null,
      post_progress_05df_context_source: postProgress05dfPlan && postProgress05dfPlan.context_source
        ? postProgress05dfPlan.context_source
        : 'legacy_live_state',
      post_progress_05df_session_source: postProgress05dfPlan && postProgress05dfPlan.session_source
        ? postProgress05dfPlan.session_source
        : 'legacy_live_state',
      post_progress_05df_reply_source: postProgress05dfPlan && postProgress05dfPlan.reply_source
        ? postProgress05dfPlan.reply_source
        : 'legacy_live_state',
      unresolved_05df_body_semantics_guarded: true,
      post_progress_continuation_mode: postProgressContinuationPlan && postProgressContinuationPlan.mode
        ? postProgressContinuationPlan.mode
        : 'disabled_or_ineligible',
      post_progress_continuation_payload_len: postProgressContinuationPlan && Buffer.isBuffer(postProgressContinuationPlan.payload)
        ? postProgressContinuationPlan.payload.length
        : null,
      post_progress_continuation_payload_hex_prefix: postProgressContinuationPlan && Buffer.isBuffer(postProgressContinuationPlan.payload)
        ? bufferToHex(postProgressContinuationPlan.payload, 16)
        : null,
      post_progress_continuation_session_id_sent: postProgressContinuationPlan && Number.isInteger(postProgressContinuationPlan.session_id_sent)
        ? postProgressContinuationPlan.session_id_sent
        : null,
      post_progress_continuation_reply_id_sent: postProgressContinuationPlan && Number.isInteger(postProgressContinuationPlan.reply_id_sent)
        ? postProgressContinuationPlan.reply_id_sent
        : null,
      post_progress_continuation_context_source: postProgressContinuationPlan && postProgressContinuationPlan.context_source
        ? postProgressContinuationPlan.context_source
        : 'disabled_or_ineligible',
      post_progress_continuation_session_source: postProgressContinuationPlan && postProgressContinuationPlan.session_source
        ? postProgressContinuationPlan.session_source
        : 'disabled_or_ineligible',
      post_progress_continuation_reply_source: postProgressContinuationPlan && postProgressContinuationPlan.reply_source
        ? postProgressContinuationPlan.reply_source
        : 'disabled_or_ineligible',
      continuation_0058_mode: postProgressContinuationPlan && postProgressContinuationPlan.continuation_0058_mode
        ? postProgressContinuationPlan.continuation_0058_mode
        : 'disabled_or_ineligible',
      continuation_0058_word0_source: postProgressContinuationPlan && postProgressContinuationPlan.continuation_0058_word0_source
        ? postProgressContinuationPlan.continuation_0058_word0_source
        : 'disabled_or_ineligible',
      continuation_0058_word0_value: postProgressContinuationPlan && Number.isInteger(postProgressContinuationPlan.continuation_0058_word0_value)
        ? postProgressContinuationPlan.continuation_0058_word0_value
        : null,
      continuation_0058_byte0_derived: postProgressContinuationPlan && Number.isInteger(postProgressContinuationPlan.continuation_0058_byte0_derived)
        ? postProgressContinuationPlan.continuation_0058_byte0_derived
        : null,
      continuation_0058_byte1_emitted: postProgressContinuationPlan && Number.isInteger(postProgressContinuationPlan.continuation_0058_byte1_emitted)
        ? postProgressContinuationPlan.continuation_0058_byte1_emitted
        : null,
      continuation_0058_byte2_emitted: postProgressContinuationPlan && Number.isInteger(postProgressContinuationPlan.continuation_0058_byte2_emitted)
        ? postProgressContinuationPlan.continuation_0058_byte2_emitted
        : null,
      continuation_0058_byte2_source: postProgressContinuationPlan && postProgressContinuationPlan.continuation_0058_byte2_source
        ? postProgressContinuationPlan.continuation_0058_byte2_source
        : 'disabled_or_ineligible',
      continuation_0058_payload_hex: postProgressContinuationPlan && postProgressContinuationPlan.continuation_0058_payload_hex
        ? postProgressContinuationPlan.continuation_0058_payload_hex
        : null,
      unresolved_0058_byte2_semantics_guarded: postProgressContinuationPlan && postProgressContinuationPlan.unresolved_0058_byte2_semantics_guarded === true,
      progression_ack_tx_count: progressionAckTxCount,
      progression_ack_tx_error_count: progressionAckTxErrorCount,
      pre_003e_priming_mode: pre003ePrimingPlan.mode || 'disabled_or_ineligible',
      pre_003e_priming_steps_attempted: pre003ePrimingAttemptedSteps,
      pre_003e_priming_replies_observed: pre003ePrimingRepliesObserved,
      pre_003e_priming_lineage_observed: pre003ePrimingLineageObserved,
      pre_003e_priming_completed_before_003e: pre003ePrimingCompletedBefore003e,
      pre_003e_progression_frames_observed_count: progressionFramesObservedCount,
      pre_003e_first_progression_evidence_observed: progressionFramesObservedCount > 0,
      post_2710_closure_mode: post2710ClosurePolicy.mode,
      post_2710_expected_family_matched: post2710ExpectedFamilyMatched,
      post_2710_prepare_data_observed: post2710PrepareDataObserved,
      post_2710_trailing_frames_drained: post2710TrailingFramesDrained,
      post_2710_free_data_invoked: post2710FreeDataInvoked,
      post_2710_closure_completed_before_first_000b: post2710ClosureCompletedBeforeFirst000b,
      post_second_05dd_close_mode: postSecond05ddCloseMode,
      post_second_05dd_close_classifier: postSecond05ddCloseClassifier,
      post_second_05dd_close_first_host_command: postSecond05ddCloseFirstHostCommand,
      post_second_05dd_close_second_host_command: postSecond05ddCloseSecondHostCommand,
      post_second_05dd_close_003e_tx: postSecond05ddClose003eTx,
      post_second_05dd_close_003c_tx: postSecond05ddClose003cTx,
      post_second_05dd_close_03e9_tx: postSecond05ddClose03e9Tx,
      post_second_05dd_close_003e_ack_observed: postSecond05ddClose003eAckObserved,
      post_second_05dd_close_003c_ack_observed: postSecond05ddClose003cAckObserved,
      post_second_05dd_close_03e9_ack_observed: postSecond05ddClose03e9AckObserved,
      prompt_boundary_session_handoff_mode: promptBoundarySessionHandoffPolicy.mode,
      prompt_boundary_session_handoff_introduced: promptBoundarySessionHandoffIntroduced,
      prompt_boundary_session_before_handoff: Number.isInteger(promptBoundarySessionBeforeHandoff)
        ? promptBoundarySessionBeforeHandoff
        : null,
      prompt_boundary_session_after_handoff: Number.isInteger(promptBoundarySessionAfterHandoff)
        ? promptBoundarySessionAfterHandoff
        : null,
      prompt_boundary_lineage_mode: promptBoundaryLineagePolicy.mode,
      prompt_boundary_seed_reply_from_01f4_ff7f: Number.isInteger(promptBoundarySeedReplyFrom01f4Ff7f)
        ? promptBoundarySeedReplyFrom01f4Ff7f
        : null,
      prompt_boundary_01f4_ff7f_session_id: Number.isInteger(promptBoundary01f4Ff7fSessionId)
        ? promptBoundary01f4Ff7fSessionId
        : null,
      prompt_boundary_01f4_ff7f_reply_id: Number.isInteger(promptBoundary01f4Ff7fReplyId)
        ? promptBoundary01f4Ff7fReplyId
        : null,
      prompt_boundary_003e_session_id_sent: Number.isInteger(promptBoundary003eSessionIdSent)
        ? promptBoundary003eSessionIdSent
        : null,
      prompt_boundary_003e_reply_id_sent: Number.isInteger(promptBoundary003eReplyIdSent)
        ? promptBoundary003eReplyIdSent
        : null,
      prompt_boundary_003e_ack_session_id_observed: Number.isInteger(promptBoundary003eAckSessionIdObserved)
        ? promptBoundary003eAckSessionIdObserved
        : null,
      prompt_boundary_003e_ack_reply_id_observed: Number.isInteger(promptBoundary003eAckReplyIdObserved)
        ? promptBoundary003eAckReplyIdObserved
        : null,
      prompt_boundary_003d_session_id_sent: Number.isInteger(promptBoundary003dSessionIdSent)
        ? promptBoundary003dSessionIdSent
        : null,
      prompt_boundary_003d_reply_id_sent: Number.isInteger(promptBoundary003dReplyIdSent)
        ? promptBoundary003dReplyIdSent
        : null,
      prompt_boundary_003d_ack_session_id_observed: Number.isInteger(promptBoundary003dAckSessionIdObserved)
        ? promptBoundary003dAckSessionIdObserved
        : null,
      prompt_boundary_003d_ack_reply_id_observed: Number.isInteger(promptBoundary003dAckReplyIdObserved)
        ? promptBoundary003dAckReplyIdObserved
        : null,
      prompt_boundary_fresh_session_introduced: promptBoundaryFreshSessionIntroduced,
      ...(earlyMarkerDebug
        ? { early_marker_debug: earlyMarkerDebug }
        : {})
    }
  };
}

module.exports = {
  id: 'zkteco',
  pullDeviceEvents,
  runK80EnrollmentAttempt,
  runK80RtInitiationSession,
  startK80RealtimeSubscriber,
  __test: {
    parseTextAttendanceBuffer,
    parseBinaryAttendanceBuffer,
    decodeZkTimestamp,
    localDateTimeToUtcIso,
    normalizePulledEvents,
    resolveK80RtEnrichmentContext,
    buildK80RtCorrelationKey,
    buildK80RtStateMapFromRuntimeDiagnostics,
    buildK80RtProvisionalEventsFromProtocol,
    resolveK80AuthoritativeDirectionPolicy,
    decodeUnexpectedPullPayload,
    resolveK80Enrollment003dPayloadPolicy,
    buildConservativeEnrollmentSelectionPayload,
    resolveK80EnrollmentPostProgress05dfPolicy,
    buildPostProgress05dfProbePlan,
    resolveK80EnrollmentPostProgressContinuationPolicy,
    buildPostProgressContinuationPlan,
    resolveK80EnrollmentPre003ePrimingPolicy,
    resolveK80EnrollmentEarlyMarkerDebugPolicy,
    resolveK80EnrollmentClosePairPolicy,
    resolveK80EnrollmentPost2710ClosurePolicy,
    resolveK80EnrollmentPromptBoundaryLineagePolicy,
    resolveK80EnrollmentPromptBoundarySessionHandoffPolicy,
    resolveK80EnrollmentV2Policy,
    isK80Post2710ExpectedResponseCommand,
    buildK80EnrollmentPre003ePrimingSteps,
    resolveK8007d0FollowupPolicy,
    shouldEnterK8007d0FollowupBranch,
    summarizeK8007d0Continuation,
    classifyK8007d0PreParseStage,
    PRE_PARSE_TRUNCATION_STAGE
  }
};
