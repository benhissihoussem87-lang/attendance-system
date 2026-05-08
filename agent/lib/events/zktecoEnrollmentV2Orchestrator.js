function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseInteger(value, fallback = null) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return parsed;
}

function commandToHex(command) {
  const value = Number.isInteger(command) ? command : 0;
  return `0x${(value & 0xffff).toString(16).padStart(4, '0')}`;
}

const V2_STEP2_STARTUP_NEGOTIATION_PAYLOAD_HEX = '7e4f533d3f2c457874656e64466d743d3f2c7e457874656e64466d743d3f2c457874656e644f504c6f673d3f2c7e457874656e644f504c6f673d3f2c7e506c6174666f726d3d3f2c7e5a4b465056657273696f6e3d3f2c576f726b436f64653d3f2c7e5353523d3f2c7e50494e3257696474683d3f2c7e55736572457874466d743d3f2c4275696c6456657273696f6e3d3f2c41747450686f746f466f7253444b3d3f2c7e49734f6e6c7952464d616368696e653d3f2c43616d6572614f70656e3d3f2c436f6d7061744f6c644669726d776172653d3f2c4973537570706f727450756c6c3d3f2c4c616e67756167653d3f2c7e53657269616c4e756d6265723d3f2c4661636546756e4f6e3d3f2c7e4465766963654e616d653d3f';
const V2_STEP3_SELECTION_PAYLOAD_HEX = '3700000000000000000000000000000000000000000000000601';
const V2_STEP4_05DF_PAYLOAD_HEX = '0109000500000000000000';
const V2_STEP3_SETTLE_DELAY_BEFORE_003D_MS = 500;
const V2_STEP4_PROGRESS_ACK_WINDOW_MS = 60000;
const V2_STEP4_PROGRESS_ACK_POST_SHORT_GRACE_MS = 10000;
const V2_STEP4_POST_05DC_DRAIN_TIMEOUT_MS = 3000;
const V2_STEP3_DEVICE_STATE_MAX_USER_ID = 3;
const V2_STEP3_SELECTED_FINGER_TO_BYTE24_MAP = {
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

function normalizeSelectedFingerKey(selectedFinger) {
  return normalizeText(selectedFinger).toUpperCase().replace(/[\s_]+/g, '-');
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

function metadataTypeOrUndefined(value) {
  return typeof value === 'string' ? value : 'undefined';
}

function buildPhasePlaceholder(phaseName) {
  return {
    phase_name: normalizeText(phaseName) || 'unknown_phase',
    phase_status: 'not_implemented',
    phase_reason: 'v2_scaffold_placeholder',
    diagnostics: {},
    state: {}
  };
}

function clonePhaseForMetadata(phaseResult) {
  const safePhase = isPlainObject(phaseResult) ? phaseResult : {};
  const cloned = { ...safePhase };
  delete cloned.runtime;
  return cloned;
}

function buildV2LaneOwnershipState() {
  return {
    workflow_owner: 'k80_enrollment_v2',
    final_close_eligible: false,
    workflow_ready_for_step3_entry: false,
    workflow_ready_for_step4_entry: false,
    background_lane: {
      owner: 'background_baseline_phase',
      retained_for_continuation: false,
      active: false,
      session_id: null,
      last_reply_id: null
    },
    enroll_lane: {
      owner: 'enroll_workflow_phase',
      retained_for_continuation: false,
      active: false,
      session_id: null,
      last_reply_id: null,
      ff7f_reply_seed: null
    }
  };
}

function buildV2Step3SelectionPayload({ deviceUserId, selectedFinger } = {}) {
  let userIdAscii = null;
  let userIdValue = null;
  if (Number.isInteger(deviceUserId)) {
    if (deviceUserId < 0) {
      return { ok: false, error: 'v2_step3_003d_device_user_id_unavailable_or_ambiguous', guard_reason: 'device_user_id_invalid' };
    }
    userIdAscii = String(deviceUserId);
    userIdValue = deviceUserId;
  } else {
    const normalized = normalizeText(deviceUserId);
    if (!normalized) {
      return { ok: false, error: 'v2_step3_003d_device_user_id_unavailable_or_ambiguous', guard_reason: 'device_user_id_missing' };
    }
    if (!/^\d+$/.test(normalized)) {
      return { ok: false, error: 'v2_step3_003d_device_user_id_unavailable_or_ambiguous', guard_reason: 'device_user_id_invalid' };
    }
    userIdAscii = normalized;
    userIdValue = Number.parseInt(normalized, 10);
  }

  const userIdField = Buffer.from(userIdAscii, 'ascii');
  if (userIdField.length < 1 || userIdField.length > 4 || !Number.isSafeInteger(userIdValue)) {
    return { ok: false, error: 'v2_step3_003d_device_user_id_unavailable_or_ambiguous', guard_reason: 'device_user_id_invalid' };
  }

  const selectedFingerKey = normalizeSelectedFingerKey(selectedFinger);
  if (
    !selectedFingerKey
    || !Object.prototype.hasOwnProperty.call(V2_STEP3_SELECTED_FINGER_TO_BYTE24_MAP, selectedFingerKey)
  ) {
    return { ok: false, error: 'v2_step3_003d_selected_finger_unavailable_or_ambiguous', guard_reason: 'device_user_id_invalid' };
  }

  const payload = Buffer.alloc(26, 0);
  userIdField.copy(payload, 0);
  payload[24] = V2_STEP3_SELECTED_FINGER_TO_BYTE24_MAP[selectedFingerKey] & 0xff;
  payload[25] = 0x01;

  return {
    ok: true,
    value: userIdValue,
    source: 'command_payload.enrollment.device_user_id',
    user_id_ascii: userIdAscii,
    user_id_encoding: 'ascii_decimal_null_padded_4',
    selected_finger: selectedFingerKey,
    payload,
    payload_hex: payload.toString('hex'),
    field_00_03_hex: payload.subarray(0, 4).toString('hex'),
    field_24_hex: payload.subarray(24, 25).toString('hex'),
    field_25_hex: payload.subarray(25, 26).toString('hex')
  };
}

function checksumPacket(packet) {
  let checksum = 0;
  let index = 0;
  let remaining = packet.length;
  while (remaining > 1) {
    checksum += packet[index] + (packet[index + 1] << 8);
    index += 2;
    remaining -= 2;
  }
  if (remaining > 0) {
    checksum += packet[index];
  }
  checksum = (~checksum + 1) & 0xffff;
  return checksum;
}

function buildInnerPacket({ command, sessionId, replyId, payload }) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
  const packet = Buffer.alloc(8 + body.length);
  packet.writeUInt16LE(command & 0xffff, 0);
  packet.writeUInt16LE(0, 2);
  packet.writeUInt16LE(sessionId & 0xffff, 4);
  packet.writeUInt16LE(replyId & 0xffff, 6);
  if (body.length) {
    body.copy(packet, 8);
  }
  const checksum = checksumPacket(packet);
  packet.writeUInt16LE(checksum, 2);
  return packet;
}

function buildTcpWrappedPacket(innerPacket) {
  const payload = Buffer.isBuffer(innerPacket) ? innerPacket : Buffer.alloc(0);
  const header = Buffer.alloc(8);
  header[0] = 0x50;
  header[1] = 0x50;
  header[2] = 0x82;
  header[3] = 0x7d;
  header.writeUInt16LE(payload.length & 0xffff, 4);
  header.writeUInt16LE(0, 6);
  return Buffer.concat([header, payload]);
}

async function runV2PhaseBackgroundBaseline(context = {}) {
  const safeContext = isPlainObject(context) ? context : {};
  const safePayload = isPlainObject(safeContext.commandPayload) ? safeContext.commandPayload : {};
  const safeConnection = isPlainObject(safePayload.connection) ? safePayload.connection : {};
  const safeOptions = isPlainObject(safeContext.options) ? safeContext.options : {};
  const helpers = isPlainObject(safeOptions.k80_v2_helpers) ? safeOptions.k80_v2_helpers : {};

  const diagnostics = {
    v2_bg_lane_present: false,
    v2_bg_session_id: null,
    v2_bg_last_reply_id: null,
    v2_bg_keepalive_ok: false,
    v2_step1_connect_seen: false,
    v2_step1_auth_seen: false,
    v2_step1_reply_progression_ok: false,
    v2_step1_session_stable: false
  };

  const createTcpChannel = typeof helpers.createTcpChannel === 'function'
    ? helpers.createTcpChannel
    : null;
  const sendTcpCommand = typeof helpers.sendTcpCommand === 'function'
    ? helpers.sendTcpCommand
    : null;
  const makeCommKey = typeof helpers.makeCommKey === 'function'
    ? helpers.makeCommKey
    : null;
  const nextReplyId = typeof helpers.nextReplyId === 'function'
    ? helpers.nextReplyId
    : null;
  const mapSocketErrorCode = typeof helpers.mapSocketErrorCode === 'function'
    ? helpers.mapSocketErrorCode
    : err => (err && err.message ? String(err.message) : 'v2_step1_error');
  const COMMANDS = isPlainObject(helpers.COMMANDS) ? helpers.COMMANDS : {};
  const ACK = isPlainObject(helpers.ACK) ? helpers.ACK : {};
  const FAILURE_REASON = isPlainObject(helpers.FAILURE_REASON) ? helpers.FAILURE_REASON : {};

  const host = normalizeText(safeConnection.host);
  const timeoutMs = Number.isInteger(safeOptions.timeout_ms)
    ? safeOptions.timeout_ms
    : 2000;
  const keepLaneAlive = safeContext.keepLaneAlive === true;
  const port = Number.isInteger(safeConnection.port)
    ? safeConnection.port
    : 4370;
  const authPassword = Number.isInteger(safeConnection.auth_password)
    ? safeConnection.auth_password
    : null;
  const deviceNumber = Number.isInteger(safeConnection.device_number)
    ? safeConnection.device_number
    : 1;

  if (
    !createTcpChannel
    || !sendTcpCommand
    || !makeCommKey
    || !nextReplyId
    || !host
    || !Number.isInteger(authPassword)
    || !Number.isInteger(COMMANDS.CONNECT)
    || !Number.isInteger(COMMANDS.AUTH)
    || !Number.isInteger(COMMANDS.OPTIONS_RRQ)
    || !Number.isInteger(ACK.OK)
    || !Number.isInteger(ACK.UNAUTH)
  ) {
    return {
      phase_name: 'background_baseline_coexistence',
      phase_status: 'failed',
      phase_reason: 'v2_step1_missing_prerequisites',
      diagnostics,
      state: {},
      runtime: {}
    };
  }

  let channel = null;
  let closeChannelOnFinally = true;
  let sessionId = 0;
  let replyId = 0xffff - 1;
  const txTrace = [];
  const rxTrace = [];
  let phaseStatus = 'failed';
  let phaseReason = 'v2_step1_not_started';

  try {
    channel = createTcpChannel({ host, port, timeoutMs });
    await channel.connect();
    diagnostics.v2_bg_lane_present = true;

    const sendStep = async ({ command, payload = Buffer.alloc(0), stage, noReplyError }) => {
      const requestSessionId = sessionId;
      const requestReplyId = nextReplyId(replyId);
      txTrace.push({
        stage: normalizeText(stage) || null,
        command,
        command_hex: commandToHex(command),
        session_id: requestSessionId,
        reply_id: requestReplyId,
        payload_bytes: Buffer.isBuffer(payload) ? payload.length : 0
      });
      const result = await sendTcpCommand({
        channel,
        timeoutMs,
        command,
        sessionId: requestSessionId,
        replyId: requestReplyId,
        payload,
        noReplyError,
        deviceNumber
      });
      if (result && result.ok && result.response) {
        sessionId = result.response.session_id;
        replyId = result.response.reply_id;
        rxTrace.push({
          stage: normalizeText(stage) || null,
          command: result.response.command,
          command_hex: commandToHex(result.response.command),
          session_id: result.response.session_id,
          reply_id: result.response.reply_id,
          payload_bytes: Buffer.isBuffer(result.response.payload)
            ? result.response.payload.length
            : 0
        });
      }
      return result;
    };

    const connect = await sendStep({
      stage: 'v2_step1_connect',
      command: COMMANDS.CONNECT,
      noReplyError: FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY || 'connect_packet_sent_no_reply'
    });
    diagnostics.v2_step1_connect_seen = !!(connect && connect.ok && connect.response);
    if (!connect || !connect.ok || !connect.response) {
      phaseReason = connect && connect.error ? String(connect.error) : 'v2_step1_connect_failed';
      return {
        phase_name: 'background_baseline_coexistence',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: {
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: {}
      };
    }

    if (connect.response.command === ACK.UNAUTH) {
      const auth = await sendStep({
        stage: 'v2_step1_auth',
        command: COMMANDS.AUTH,
        payload: makeCommKey(authPassword, sessionId),
        noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED || 'auth_stage_failed'
      });
      diagnostics.v2_step1_auth_seen = !!(auth && auth.ok && auth.response && auth.response.command === ACK.OK);
      if (!auth || !auth.ok || !auth.response || auth.response.command !== ACK.OK) {
        phaseReason = auth && auth.error ? String(auth.error) : 'v2_step1_auth_failed';
        return {
          phase_name: 'background_baseline_coexistence',
          phase_status: 'failed',
          phase_reason: phaseReason,
          diagnostics,
          state: {
            tx_trace: txTrace,
            rx_trace: rxTrace
          },
          runtime: {}
        };
      }
    } else {
      diagnostics.v2_step1_auth_seen = connect.response.command === ACK.OK;
      if (connect.response.command !== ACK.OK) {
        phaseReason = 'v2_step1_connect_ack_unexpected';
        return {
          phase_name: 'background_baseline_coexistence',
          phase_status: 'failed',
          phase_reason: phaseReason,
          diagnostics,
          state: {
            tx_trace: txTrace,
            rx_trace: rxTrace
          },
          runtime: {}
        };
      }
    }

    const keepalivePayload = Buffer.from('DeviceID\0', 'ascii');
    let keepaliveOk = true;
    for (let i = 0; i < 3; i += 1) {
      const step = await sendStep({
        stage: `v2_step1_keepalive_${i + 1}`,
        command: COMMANDS.OPTIONS_RRQ,
        payload: keepalivePayload,
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed'
      });
      if (!step || !step.ok || !step.response || step.response.command !== ACK.OK) {
        keepaliveOk = false;
        break;
      }
    }
    diagnostics.v2_bg_keepalive_ok = keepaliveOk;

    const txReplyIds = txTrace.map(item => item.reply_id).filter(Number.isInteger);
    diagnostics.v2_step1_reply_progression_ok = txReplyIds.every((value, index) => {
      if (index === 0) {
        return true;
      }
      return value > txReplyIds[index - 1];
    });

    const postConnectTx = txTrace.filter(item => item.command !== COMMANDS.CONNECT);
    const stableSessionExpected = Number.isInteger(sessionId) && sessionId > 0;
    diagnostics.v2_step1_session_stable = stableSessionExpected
      && postConnectTx.every(item => Number.isInteger(item.session_id) && item.session_id === sessionId);

    diagnostics.v2_bg_session_id = stableSessionExpected ? sessionId : null;
    diagnostics.v2_bg_last_reply_id = Number.isInteger(replyId) ? replyId : null;

    if (keepLaneAlive) {
      closeChannelOnFinally = false;
    }

    phaseStatus = (
      diagnostics.v2_step1_connect_seen
      && diagnostics.v2_step1_auth_seen
      && diagnostics.v2_step1_reply_progression_ok
      && diagnostics.v2_step1_session_stable
      && diagnostics.v2_bg_keepalive_ok
    )
      ? 'completed_step1_baseline'
      : 'completed_step1_with_warnings';
    phaseReason = phaseStatus === 'completed_step1_baseline'
      ? 'v2_step1_baseline_ready'
      : 'v2_step1_baseline_incomplete';
  } catch (err) {
    phaseStatus = 'failed';
    phaseReason = mapSocketErrorCode(err);
  } finally {
    if (closeChannelOnFinally && channel && typeof channel.close === 'function') {
      channel.close();
    }
  }

  return {
    phase_name: 'background_baseline_coexistence',
    phase_status: phaseStatus,
    phase_reason: phaseReason,
    diagnostics,
    state: {
      protocol_session_ref: (
        Number.isInteger(diagnostics.v2_bg_session_id)
        && Number.isInteger(diagnostics.v2_bg_last_reply_id)
      )
        ? `${diagnostics.v2_bg_session_id}:${diagnostics.v2_bg_last_reply_id}`
        : null,
      tx_trace: txTrace,
      rx_trace: rxTrace
    },
    runtime: keepLaneAlive
      ? {
        bg_channel: channel,
        bg_session_id: Number.isInteger(sessionId) ? sessionId : null,
        bg_reply_id: Number.isInteger(replyId) ? replyId : null
      }
      : {}
  };
}

async function runV2PhaseEnrollLaneBringUp(context = {}) {
  const safeContext = isPlainObject(context) ? context : {};
  const safePayload = isPlainObject(safeContext.commandPayload) ? safeContext.commandPayload : {};
  const safeConnection = isPlainObject(safePayload.connection) ? safePayload.connection : {};
  const safeOptions = isPlainObject(safeContext.options) ? safeContext.options : {};
  const helpers = isPlainObject(safeOptions.k80_v2_helpers) ? safeOptions.k80_v2_helpers : {};
  const runtime = isPlainObject(safeContext.runtime) ? safeContext.runtime : {};

  const diagnostics = {
    v2_enroll_lane_created: false,
    v2_enroll_session_id: null,
    v2_step2_sequence_ok: false,
    v2_ff7f_reply_seed: null,
    v2_step2_bg_lane_still_alive: false,
    v2_step2_last_command_sent: null,
    v2_step2_reply_progression_ok: false,
    v2_step2_session_stable: false,
    v2_step2_tail_000b_count_sent: 0,
    v2_step2_tail_ffff_sent: false,
    v2_step2_tail_ff7f_sent: false,
    v2_step2_bg_lane_alive_after_tail: false,
    v2_step2_post_2710_family_observed: [],
    v2_step2_post_2710_closure_ok: false,
    v2_step2_early_termination_before_tail: true,
    v2_step2_enroll_lane_retained_for_continuation: false,
    v2_step2_bg_lane_retained_for_continuation: false,
    v2_step2_client_teardown_sent_at_step2_completion: false,
    v2_step2_late_tail_session_continuity_ok: false,
    v2_step2_late_tail_reply_continuity_ok: false,
    v2_step2_bg_interleave_sent_count: 0,
    v2_step2_bg_interleave_during_window: false,
    v2_step2_bg_interleave_last_reply_id: null,
    v2_step2_bg_interleave_session_continuity_ok: false,
    v2_step2_bg_interleave_reply_continuity_ok: false
  };

  const createTcpChannel = typeof helpers.createTcpChannel === 'function'
    ? helpers.createTcpChannel
    : null;
  const sendTcpCommand = typeof helpers.sendTcpCommand === 'function'
    ? helpers.sendTcpCommand
    : null;
  const makeCommKey = typeof helpers.makeCommKey === 'function'
    ? helpers.makeCommKey
    : null;
  const nextReplyId = typeof helpers.nextReplyId === 'function'
    ? helpers.nextReplyId
    : null;
  const mapSocketErrorCode = typeof helpers.mapSocketErrorCode === 'function'
    ? helpers.mapSocketErrorCode
    : err => (err && err.message ? String(err.message) : 'v2_step2_error');
  const COMMANDS = isPlainObject(helpers.COMMANDS) ? helpers.COMMANDS : {};
  const ACK = isPlainObject(helpers.ACK) ? helpers.ACK : {};
  const FAILURE_REASON = isPlainObject(helpers.FAILURE_REASON) ? helpers.FAILURE_REASON : {};
  const CMD_PREPARE_DATA = Number.isInteger(COMMANDS.PREPARE_DATA) ? COMMANDS.PREPARE_DATA : 0x05dc;
  const CMD_DATA = Number.isInteger(COMMANDS.DATA) ? COMMANDS.DATA : 0x05dd;
  const CMD_BUSY = 0x1387;

  const host = normalizeText(safeConnection.host);
  const timeoutMs = Number.isInteger(safeOptions.timeout_ms)
    ? safeOptions.timeout_ms
    : 2000;
  const port = Number.isInteger(safeConnection.port)
    ? safeConnection.port
    : 4370;
  const authPassword = Number.isInteger(safeConnection.auth_password)
    ? safeConnection.auth_password
    : null;
  const deviceNumber = Number.isInteger(safeConnection.device_number)
    ? safeConnection.device_number
    : 1;

  if (
    !createTcpChannel
    || !sendTcpCommand
    || !makeCommKey
    || !nextReplyId
    || !host
    || !Number.isInteger(authPassword)
    || !Number.isInteger(COMMANDS.CONNECT)
    || !Number.isInteger(COMMANDS.AUTH)
    || !Number.isInteger(COMMANDS.ZKTIME_PREMODE_000C)
    || !Number.isInteger(COMMANDS.ZKTIME_STARTUP_NEGOTIATION)
    || !Number.isInteger(COMMANDS.OPTIONS_RRQ)
    || !Number.isInteger(COMMANDS.ZKTIME_PREMODE_044C)
    || !Number.isInteger(COMMANDS.ZKTIME_PREMODE_0045)
    || !Number.isInteger(COMMANDS.ZKTIME_PREMODE_2710)
    || !Number.isInteger(COMMANDS.ZKTIME_RT_SUBSCRIBE)
    || !Number.isInteger(ACK.OK)
    || !Number.isInteger(ACK.UNAUTH)
  ) {
    return {
      phase_name: 'registration_enroll_lane_bring_up',
      phase_status: 'failed',
      phase_reason: 'v2_step2_missing_prerequisites',
      diagnostics,
      state: {},
      runtime: {}
    };
  }

  const pre000bQueries = [
    Buffer.from('MaskDetectionFunOn\0', 'ascii'),
    Buffer.from('IRTempDetectionFunOn\0', 'ascii'),
    Buffer.from('DeviceID\0', 'ascii'),
    Buffer.from('IsSupportP2P\0', 'ascii'),
    Buffer.from('IsSupportSFZ\0', 'ascii'),
    Buffer.from('SFZFunOn\0', 'ascii'),
    Buffer.from('VisilightFun\0', 'ascii'),
    Buffer.from('MaskDetectionFunOn\0', 'ascii'),
    Buffer.from('IRTempDetectionFunOn\0', 'ascii')
  ];

  let enrollChannel = null;
  let closeEnrollChannelOnFinally = true;
  let enrollSessionId = 0;
  let enrollReplyId = 0xffff - 1;
  const bgChannel = runtime.bg_channel;
  let bgSessionId = Number.isInteger(runtime.bg_session_id) ? runtime.bg_session_id : null;
  let bgReplyId = Number.isInteger(runtime.bg_reply_id) ? runtime.bg_reply_id : null;
  const txTrace = [];
  const rxTrace = [];
  const bgInterleaveTx = [];
  let phaseStatus = 'failed';
  let phaseReason = 'v2_step2_not_started';

  try {
    enrollChannel = createTcpChannel({ host, port, timeoutMs });
    await enrollChannel.connect();
    diagnostics.v2_enroll_lane_created = true;

    const sendEnrollStep = async ({ command, payload = Buffer.alloc(0), stage, noReplyError }) => {
      const requestSessionId = enrollSessionId;
      const requestReplyId = nextReplyId(enrollReplyId);
      txTrace.push({
        stage: normalizeText(stage) || null,
        command,
        command_hex: commandToHex(command),
        session_id: requestSessionId,
        reply_id: requestReplyId,
        payload_bytes: Buffer.isBuffer(payload) ? payload.length : 0,
        payload_hex: Buffer.isBuffer(payload) ? payload.toString('hex') : ''
      });
      diagnostics.v2_step2_last_command_sent = commandToHex(command);
      const result = await sendTcpCommand({
        channel: enrollChannel,
        timeoutMs,
        command,
        sessionId: requestSessionId,
        replyId: requestReplyId,
        payload,
        noReplyError,
        deviceNumber
      });
      if (result && result.ok && result.response) {
        if (Number.isInteger(result.response.session_id) && result.response.session_id > 0) {
          enrollSessionId = result.response.session_id;
        }
        enrollReplyId = requestReplyId;
        rxTrace.push({
          stage: normalizeText(stage) || null,
          command: result.response.command,
          command_hex: commandToHex(result.response.command),
          session_id: result.response.session_id,
          reply_id: result.response.reply_id,
          payload_bytes: Buffer.isBuffer(result.response.payload)
            ? result.response.payload.length
            : 0,
          payload_hex: Buffer.isBuffer(result.response.payload)
            ? result.response.payload.toString('hex')
            : ''
        });
      }
      return result;
    };

    const sendBackgroundInterleave = async stage => {
      if (
        !bgChannel
        || !Number.isInteger(bgSessionId)
        || bgSessionId <= 0
        || !Number.isInteger(bgReplyId)
      ) {
        return null;
      }
      const requestReplyId = nextReplyId(bgReplyId);
      const requestSessionId = bgSessionId;
      diagnostics.v2_step2_bg_interleave_sent_count += 1;
      diagnostics.v2_step2_bg_interleave_during_window = true;
      bgInterleaveTx.push({
        stage: normalizeText(stage) || 'v2_step2_bg_interleave',
        session_id: requestSessionId,
        reply_id: requestReplyId
      });
      const result = await sendTcpCommand({
        channel: bgChannel,
        timeoutMs,
        command: COMMANDS.OPTIONS_RRQ,
        sessionId: requestSessionId,
        replyId: requestReplyId,
        payload: Buffer.from('DeviceID\0', 'ascii'),
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed',
        deviceNumber
      });
      if (result && result.ok && result.response) {
        if (Number.isInteger(result.response.session_id) && result.response.session_id > 0) {
          bgSessionId = result.response.session_id;
        }
        if (Number.isInteger(result.response.reply_id)) {
          bgReplyId = result.response.reply_id;
          diagnostics.v2_step2_bg_interleave_last_reply_id = result.response.reply_id;
        }
      }
      return result;
    };

    const connect = await sendEnrollStep({
      stage: 'v2_step2_connect',
      command: COMMANDS.CONNECT,
      noReplyError: FAILURE_REASON.CONNECT_PACKET_SENT_NO_REPLY || 'connect_packet_sent_no_reply'
    });
    if (!connect || !connect.ok || !connect.response) {
      phaseReason = connect && connect.error ? String(connect.error) : 'v2_step2_connect_failed';
      return {
        phase_name: 'registration_enroll_lane_bring_up',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: { tx_trace: txTrace, rx_trace: rxTrace },
        runtime: {}
      };
    }

    if (connect.response.command === ACK.UNAUTH) {
      const auth = await sendEnrollStep({
        stage: 'v2_step2_auth',
        command: COMMANDS.AUTH,
        payload: makeCommKey(authPassword, enrollSessionId),
        noReplyError: FAILURE_REASON.AUTH_STAGE_FAILED || 'auth_stage_failed'
      });
      if (!auth || !auth.ok || !auth.response || auth.response.command !== ACK.OK) {
        phaseReason = auth && auth.error ? String(auth.error) : 'v2_step2_auth_failed';
        return {
          phase_name: 'registration_enroll_lane_bring_up',
          phase_status: 'failed',
          phase_reason: phaseReason,
          diagnostics,
          state: { tx_trace: txTrace, rx_trace: rxTrace },
          runtime: {}
        };
      }
    } else if (connect.response.command !== ACK.OK) {
      phaseReason = 'v2_step2_connect_ack_unexpected';
      return {
        phase_name: 'registration_enroll_lane_bring_up',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: { tx_trace: txTrace, rx_trace: rxTrace },
        runtime: {}
      };
    }

    const sequence = [
      {
        stage: 'v2_step2_premode_000c',
        command: COMMANDS.ZKTIME_PREMODE_000C,
        payload: Buffer.from('SDKBuild=1\0', 'ascii')
      },
      {
        stage: 'v2_step2_startup_negotiation',
        command: COMMANDS.ZKTIME_STARTUP_NEGOTIATION,
        payload: Buffer.from(V2_STEP2_STARTUP_NEGOTIATION_PAYLOAD_HEX, 'hex')
      },
      {
        stage: 'v2_step2_premode_000b_face_version',
        command: COMMANDS.OPTIONS_RRQ,
        payload: Buffer.from('ZKFaceVersion\0', 'ascii')
      },
      {
        stage: 'v2_step2_premode_044c',
        command: COMMANDS.ZKTIME_PREMODE_044C,
        payload: Buffer.alloc(0)
      },
      {
        stage: 'v2_step2_premode_0045',
        command: COMMANDS.ZKTIME_PREMODE_0045,
        payload: Buffer.from('2030', 'hex')
      },
      {
        stage: 'v2_step2_premode_2710',
        command: COMMANDS.ZKTIME_PREMODE_2710,
        payload: Buffer.alloc(0)
      }
    ];

    const tailSequence = [];
    for (const queryPayload of pre000bQueries) {
      tailSequence.push({
        stage: 'v2_step2_tail_000b_query',
        command: COMMANDS.OPTIONS_RRQ,
        payload: queryPayload
      });
    }
    tailSequence.push({
      stage: 'v2_step2_tail_rt_subscribe_ffff',
      command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
      payload: Buffer.from('ffff0000', 'hex')
    });
    tailSequence.push({
      stage: 'v2_step2_tail_rt_subscribe_ff7f',
      command: COMMANDS.ZKTIME_RT_SUBSCRIBE,
      payload: Buffer.from('ff7f0000', 'hex')
    });

    const post2710Observed = new Set();
    const notePost2710Family = command => {
      if (!Number.isInteger(command)) {
        return;
      }
      if (command === CMD_PREPARE_DATA || command === CMD_DATA || command === ACK.OK) {
        post2710Observed.add(commandToHex(command));
      }
      diagnostics.v2_step2_post_2710_family_observed = Array.from(post2710Observed);
    };
    const post2710ClosureReady = () => {
      const prepareSeen = post2710Observed.has(commandToHex(CMD_PREPARE_DATA));
      const ackSeen = post2710Observed.has(commandToHex(ACK.OK));
      return prepareSeen && ackSeen;
    };

    let sequenceOk = true;
    for (const step of sequence) {
      const result = await sendEnrollStep({
        stage: step.stage,
        command: step.command,
        payload: step.payload,
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed'
      });
      if (!result || !result.ok || !result.response) {
        sequenceOk = false;
        break;
      }
      if (step.stage === 'v2_step2_premode_2710') {
        notePost2710Family(result.response.command);
        if (![CMD_PREPARE_DATA, ACK.OK].includes(result.response.command)) {
          sequenceOk = false;
          break;
        }
        continue;
      }
      if (result.response.command !== ACK.OK) {
        sequenceOk = false;
        break;
      }
      if (step.stage === 'v2_step2_premode_0045') {
        await sendBackgroundInterleave('v2_step2_bg_interleave_after_0045');
      }
    }

    if (sequenceOk) {
      let tailInterleaveScheduled = false;
      for (const step of tailSequence) {
        const result = await sendEnrollStep({
          stage: step.stage,
          command: step.command,
          payload: step.payload,
          noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed'
        });
        if (!result || !result.ok || !result.response) {
          sequenceOk = false;
          break;
        }
        const responseCommand = result.response.command;
        notePost2710Family(responseCommand);
        if (
          responseCommand !== ACK.OK
          && responseCommand !== CMD_DATA
          && responseCommand !== CMD_BUSY
        ) {
          sequenceOk = false;
          break;
        }
        if (step.stage === 'v2_step2_tail_000b_query') {
          diagnostics.v2_step2_tail_000b_count_sent += 1;
          if (
            !tailInterleaveScheduled
            && diagnostics.v2_step2_tail_000b_count_sent >= 2
          ) {
            await sendBackgroundInterleave('v2_step2_bg_interleave_tail_midpoint');
            tailInterleaveScheduled = true;
          }
        } else if (step.stage === 'v2_step2_tail_rt_subscribe_ffff') {
          diagnostics.v2_step2_tail_ffff_sent = true;
        } else if (step.stage === 'v2_step2_tail_rt_subscribe_ff7f') {
          diagnostics.v2_step2_tail_ff7f_sent = true;
        }
      }
    }

    diagnostics.v2_step2_post_2710_closure_ok = post2710ClosureReady();
    diagnostics.v2_step2_early_termination_before_tail = !(
      diagnostics.v2_step2_tail_ffff_sent && diagnostics.v2_step2_tail_ff7f_sent
    );
    if (!diagnostics.v2_step2_post_2710_closure_ok) {
      sequenceOk = false;
    }

    const lateTailTx = txTrace.filter(item => normalizeText(item.stage).startsWith('v2_step2_tail_'));
    diagnostics.v2_step2_late_tail_session_continuity_ok = (
      lateTailTx.length > 0
      && Number.isInteger(enrollSessionId)
      && enrollSessionId > 0
      && lateTailTx.every(item => Number.isInteger(item.session_id) && item.session_id === enrollSessionId)
    );
    diagnostics.v2_step2_late_tail_reply_continuity_ok = (() => {
      if (lateTailTx.length === 0) {
        return false;
      }
      const replyIds = lateTailTx.map(item => item.reply_id).filter(Number.isInteger);
      if (replyIds.length !== lateTailTx.length) {
        return false;
      }
      for (let i = 1; i < replyIds.length; i += 1) {
        if (replyIds[i] <= replyIds[i - 1]) {
          return false;
        }
      }
      const ffff = lateTailTx.find(item => item.stage === 'v2_step2_tail_rt_subscribe_ffff');
      const ff7f = lateTailTx.find(item => item.stage === 'v2_step2_tail_rt_subscribe_ff7f');
      if (!ffff || !ff7f) {
        return false;
      }
      return Number.isInteger(ffff.reply_id)
        && Number.isInteger(ff7f.reply_id)
        && ff7f.reply_id > ffff.reply_id;
    })();
    diagnostics.v2_step2_bg_interleave_session_continuity_ok = (() => {
      if (bgInterleaveTx.length === 0) {
        return false;
      }
      const sessionIds = bgInterleaveTx.map(item => item.session_id).filter(Number.isInteger);
      if (sessionIds.length !== bgInterleaveTx.length) {
        return false;
      }
      if (!sessionIds.every(value => value > 0)) {
        return false;
      }
      return sessionIds.every(value => value === sessionIds[0]);
    })();
    diagnostics.v2_step2_bg_interleave_reply_continuity_ok = (() => {
      if (bgInterleaveTx.length === 0) {
        return false;
      }
      const replyIds = bgInterleaveTx.map(item => item.reply_id).filter(Number.isInteger);
      if (replyIds.length !== bgInterleaveTx.length) {
        return false;
      }
      for (let i = 1; i < replyIds.length; i += 1) {
        if (replyIds[i] <= replyIds[i - 1]) {
          return false;
        }
      }
      return true;
    })();

    diagnostics.v2_step2_sequence_ok = sequenceOk;
    if (!sequenceOk) {
      phaseReason = 'v2_step2_sequence_failed';
      return {
        phase_name: 'registration_enroll_lane_bring_up',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: { tx_trace: txTrace, rx_trace: rxTrace },
        runtime: {}
      };
    }

    const ff7fTx = [...txTrace].reverse().find(item => item.stage === 'v2_step2_tail_rt_subscribe_ff7f');
    diagnostics.v2_ff7f_reply_seed = Number.isInteger(ff7fTx && ff7fTx.reply_id)
      ? ff7fTx.reply_id
      : null;
    diagnostics.v2_enroll_session_id = Number.isInteger(enrollSessionId) && enrollSessionId > 0
      ? enrollSessionId
      : null;

    const txReplyIds = txTrace.map(item => item.reply_id).filter(Number.isInteger);
    diagnostics.v2_step2_reply_progression_ok = txReplyIds.every((value, index) => {
      if (index === 0) {
        return true;
      }
      return value > txReplyIds[index - 1];
    });

    const postConnectTx = txTrace.filter(item => item.command !== COMMANDS.CONNECT);
    const stableSessionExpected = Number.isInteger(enrollSessionId) && enrollSessionId > 0;
    diagnostics.v2_step2_session_stable = stableSessionExpected
      && postConnectTx.every(item => Number.isInteger(item.session_id) && item.session_id === enrollSessionId);

    if (bgChannel && Number.isInteger(bgSessionId) && Number.isInteger(bgReplyId)) {
      const bgNextReplyId = nextReplyId(bgReplyId);
      const bgProbe = await sendTcpCommand({
        channel: bgChannel,
        timeoutMs,
        command: COMMANDS.OPTIONS_RRQ,
        sessionId: bgSessionId,
        replyId: bgNextReplyId,
        payload: Buffer.from('DeviceID\0', 'ascii'),
        noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed',
        deviceNumber
      });
      diagnostics.v2_step2_bg_lane_still_alive = !!(
        bgProbe
        && bgProbe.ok
        && bgProbe.response
        && bgProbe.response.command === ACK.OK
      );
      diagnostics.v2_step2_bg_lane_alive_after_tail = diagnostics.v2_step2_bg_lane_still_alive;
      if (diagnostics.v2_step2_bg_lane_still_alive) {
        runtime.bg_session_id = bgProbe.response.session_id;
        runtime.bg_reply_id = bgProbe.response.reply_id;
      } else {
        runtime.bg_session_id = bgSessionId;
        runtime.bg_reply_id = bgReplyId;
      }
    }

    phaseStatus = (
      diagnostics.v2_enroll_lane_created
      && diagnostics.v2_step2_sequence_ok
      && diagnostics.v2_step2_reply_progression_ok
      && diagnostics.v2_step2_session_stable
      && diagnostics.v2_step2_bg_lane_alive_after_tail
      && diagnostics.v2_step2_late_tail_session_continuity_ok
      && diagnostics.v2_step2_late_tail_reply_continuity_ok
      && Number.isInteger(diagnostics.v2_ff7f_reply_seed)
    )
      ? 'completed_step2_enroll_lane_ready'
      : 'completed_step2_with_warnings';
    phaseReason = phaseStatus === 'completed_step2_enroll_lane_ready'
      ? 'v2_step2_enroll_lane_ready'
      : 'v2_step2_enroll_lane_incomplete';
    if (phaseStatus === 'completed_step2_enroll_lane_ready') {
      closeEnrollChannelOnFinally = false;
      diagnostics.v2_step2_enroll_lane_retained_for_continuation = true;
      diagnostics.v2_step2_bg_lane_retained_for_continuation = diagnostics.v2_step2_bg_lane_alive_after_tail === true;
      diagnostics.v2_step2_client_teardown_sent_at_step2_completion = false;
    }
  } catch (err) {
    phaseStatus = 'failed';
    phaseReason = mapSocketErrorCode(err);
  } finally {
    if (closeEnrollChannelOnFinally && enrollChannel && typeof enrollChannel.close === 'function') {
      enrollChannel.close();
    }
  }

  return {
    phase_name: 'registration_enroll_lane_bring_up',
    phase_status: phaseStatus,
    phase_reason: phaseReason,
    diagnostics,
    state: {
      protocol_session_ref: (
        Number.isInteger(diagnostics.v2_enroll_session_id)
        && Number.isInteger(diagnostics.v2_ff7f_reply_seed)
      )
        ? `${diagnostics.v2_enroll_session_id}:${diagnostics.v2_ff7f_reply_seed}`
        : null,
      tx_trace: txTrace,
      rx_trace: rxTrace
    },
    runtime: diagnostics.v2_step2_enroll_lane_retained_for_continuation
      ? {
        enroll_channel: enrollChannel,
        enroll_session_id: Number.isInteger(enrollSessionId) ? enrollSessionId : null,
        enroll_reply_id: Number.isInteger(enrollReplyId) ? enrollReplyId : null
      }
      : {}
  };
}

async function runV2PhasePromptBoundary(context = {}) {
  const safeContext = isPlainObject(context) ? context : {};
  const rawCommandPayload = safeContext.commandPayload;
  const safePayload = isPlainObject(safeContext.commandPayload) ? safeContext.commandPayload : {};
  const safeEnrollment = isPlainObject(safePayload.enrollment) ? safePayload.enrollment : {};
  const safeConnection = isPlainObject(safePayload.connection) ? safePayload.connection : {};
  const safeOptions = isPlainObject(safeContext.options) ? safeContext.options : {};
  const helpers = isPlainObject(safeOptions.k80_v2_helpers) ? safeOptions.k80_v2_helpers : {};
  const runtime = isPlainObject(safeContext.runtime) ? safeContext.runtime : {};

  const diagnostics = {
    v2_step3_boundary_entered: false,
    v2_step3_enroll_lane_session_id: null,
    v2_step3_003e_sent: false,
    v2_step3_003e_ack_observed: false,
    v2_step3_003e_reply_id_sent: null,
    v2_step3_003e_ack_reply_id_observed: null,
    v2_step3_003d_sent: false,
    v2_step3_003d_ack_observed: false,
    v2_step3_003d_reply_id_sent: null,
    v2_step3_003d_ack_reply_id_observed: null,
    v2_step3_enroll_lane_session_continuity_ok: false,
    v2_step3_enroll_lane_reply_continuity_ok: false,
    v2_step3_background_lane_still_alive: false,
    v2_step3_enroll_lane_retained_for_step4: false,
    v2_step3_client_teardown_sent_at_completion: false,
    v2_workflow_ready_for_step4_entry: false,
    v2_step3_stale_ack_drain_count_before_003e: 0,
    v2_step3_003e_ack_match_exact: false,
    v2_step3_003d_ack_match_exact: false,
    v2_step3_ignored_stale_ack_reply_ids: [],
    v2_step3_ack_match_timeout: false,
    v2_step3_003d_input_device_user_id: null,
    v2_step3_003d_input_device_user_id_source: null,
    v2_step3_003d_input_selected_finger: null,
    v2_step3_003d_user_id_encoding: null,
    v2_step3_003d_user_id_ascii: null,
    v2_step3_003d_payload_field_00_03_hex: null,
    v2_step3_003d_payload_field_24_hex: null,
    v2_step3_003d_payload_field_25_hex: null,
    v2_step3_003d_payload_hex: null,
    v2_step3_settle_delay_before_003d_ms: 0,
    v2_step3_settle_delay_applied: false,
    v2_step3_003d_final_device_user_id: null,
    v2_step3_003d_final_selected_finger: null,
    v2_step3_003d_final_payload_hex: null,
    v2_step3_003d_final_field_00_03_hex: null,
    v2_step3_003d_final_field_24_hex: null,
    v2_step3_003d_final_field_25_hex: null,
    v2_step3_003d_pre_send_source_of_truth_ok: false,
    v2_step3_003d_device_user_id_device_state_conflict: false,
    v2_step3_003d_device_state_conflict_warning_only: false,
    v2_step3_003d_response_command_hex: null,
    v2_step3_003d_response_reply_id: null,
    v2_step3_003d_device_rejected: false,
    v2_step3_003d_derivation_blocked_reason: null,
    v2_step3_003d_send_attempted: false,
    v2_step3_003d_send_skipped: false,
    v2_step3_003d_skip_reason: null,
    v2_step3_003d_guard_device_user_id_missing: false,
    v2_step3_003d_guard_device_user_id_invalid: false,
    v2_step3_003d_guard_device_user_id_device_state_conflict: false,
    v2_step3_003d_guard_source_of_truth_failed: false,
    v2_step3_003d_guard_final_field_mismatch: false,
    v2_step3_003d_guard_unknown: false,
    v2_stage7_entry_payload_plain: false,
    v2_stage7_entry_enrollment_exists: false,
    v2_stage7_entry_enrollment_plain: false,
    v2_stage7_entry_device_user_id_type: 'undefined',
    v2_stage7_entry_device_user_id_value: null,
    v2_stage7_entry_selected_finger_type: 'undefined',
    v2_stage7_entry_selected_finger_value: null,
    v2_stage7_safePayload_payload_plain: false,
    v2_stage7_safePayload_enrollment_exists: false,
    v2_stage7_safePayload_enrollment_plain: false,
    v2_stage7_safePayload_device_user_id_type: 'undefined',
    v2_stage7_safePayload_device_user_id_value: null,
    v2_stage7_safePayload_selected_finger_type: 'undefined',
    v2_stage7_safePayload_selected_finger_value: null,
    v2_stage7_safeEnrollment_plain: false,
    v2_stage7_safeEnrollment_device_user_id_type: 'undefined',
    v2_stage7_safeEnrollment_device_user_id_value: null,
    v2_stage7_safeEnrollment_selected_finger_type: 'undefined',
    v2_stage7_safeEnrollment_selected_finger_value: null,
    v2_stage7_pre_resolver_device_user_id_type: 'undefined',
    v2_stage7_pre_resolver_device_user_id_value: null,
    v2_step4_progress_ack_window_entered: false,
    v2_step4_progress_ack_count: 0,
    v2_step4_progress_ack_last_reply_id: null,
    v2_step4_progress_ack_last_payload_len: null,
    v2_step4_progress_ack_structured_seen: false,
    v2_step4_progress_ack_timeout: false,
    v2_step4_progress_ack_loop_exit_reason: null,
    v2_step4_progress_ack_sent_before_05df: false,
    v2_step4_progress_ack_session_id_used: null,
    v2_step4_progress_ack_used_retained_enroll_session: false,
    v2_step4_progress_ack_event_session_id_last_seen: null,
    v2_step4_progress_ack_loop_iterations: 0,
    v2_step4_progress_ack_receive_timeout_count: 0,
    v2_step4_progress_ack_receive_frame_count: 0,
    v2_step4_progress_ack_parse_ok_count: 0,
    v2_step4_progress_ack_parse_fail_count: 0,
    v2_step4_progress_ack_last_raw_len: null,
    v2_step4_progress_ack_last_parsed_command_hex: null,
    v2_step4_progress_ack_last_parsed_session_id: null,
    v2_step4_progress_ack_last_parsed_reply_id: null,
    v2_step4_progress_ack_last_parse_error: null,
    v2_step4_progress_ack_non_01f4_frame_count: 0,
    v2_step4_progress_ack_01f4_match_count: 0,
    v2_step4_progress_ack_branch_entered: false,
    v2_step4_progress_ack_structured_ack_count: 0,
    v2_step4_progress_ack_terminal_structured_seen: false,
    v2_step4_progress_ack_terminal_structured_ack_count: 0,
    v2_step4_progress_ack_terminal_structured_payload_len: null,
    v2_step4_progress_ack_terminal_structured_session_id: null,
    v2_step4_progress_ack_total_budget_ms: null,
    v2_step4_progress_ack_first_01f4_elapsed_ms: null,
    v2_step4_progress_ack_terminal_structured_elapsed_ms: null,
    v2_step4_progress_ack_continuation_ready_after_structured: false
  };

  Object.assign(diagnostics, buildEnrollmentTransitSnapshot(rawCommandPayload, 'v2_stage7_entry'));
  Object.assign(diagnostics, buildEnrollmentTransitSnapshot(safePayload, 'v2_stage7_safePayload'));
  diagnostics.v2_stage7_safeEnrollment_plain = isPlainObject(safeEnrollment);
  diagnostics.v2_stage7_safeEnrollment_device_user_id_type = valueTypeLabel(safeEnrollment.device_user_id);
  diagnostics.v2_stage7_safeEnrollment_device_user_id_value = compactValueOrNull(safeEnrollment.device_user_id);
  diagnostics.v2_stage7_safeEnrollment_selected_finger_type = valueTypeLabel(safeEnrollment.selected_finger);
  diagnostics.v2_stage7_safeEnrollment_selected_finger_value = compactValueOrNull(safeEnrollment.selected_finger);

  const sendTcpCommand = typeof helpers.sendTcpCommand === 'function'
    ? helpers.sendTcpCommand
    : null;
  const nextReplyId = typeof helpers.nextReplyId === 'function'
    ? helpers.nextReplyId
    : null;
  const mapSocketErrorCode = typeof helpers.mapSocketErrorCode === 'function'
    ? helpers.mapSocketErrorCode
    : err => (err && err.message ? String(err.message) : 'v2_step3_error');
  const COMMANDS = isPlainObject(helpers.COMMANDS) ? helpers.COMMANDS : {};
  const ACK = isPlainObject(helpers.ACK) ? helpers.ACK : {};
  const FAILURE_REASON = isPlainObject(helpers.FAILURE_REASON) ? helpers.FAILURE_REASON : {};

  const timeoutMs = Number.isInteger(safeOptions.timeout_ms)
    ? safeOptions.timeout_ms
    : 2000;
  const deviceNumber = Number.isInteger(safeConnection.device_number)
    ? safeConnection.device_number
    : 1;

  const enrollChannel = runtime.enroll_channel;
  const bgChannel = runtime.bg_channel;
  let enrollSessionId = Number.isInteger(runtime.enroll_session_id) ? runtime.enroll_session_id : null;
  let enrollReplyId = Number.isInteger(runtime.enroll_reply_id) ? runtime.enroll_reply_id : null;
  let bgSessionId = Number.isInteger(runtime.bg_session_id) ? runtime.bg_session_id : null;
  let bgReplyId = Number.isInteger(runtime.bg_reply_id) ? runtime.bg_reply_id : null;

  const txTrace = [];
  const rxTrace = [];
  let phaseStatus = 'failed';
  let phaseReason = 'v2_step3_not_started';

  if (
    !sendTcpCommand
    || !nextReplyId
    || !enrollChannel
    || !bgChannel
    || !Number.isInteger(enrollSessionId)
    || enrollSessionId <= 0
    || !Number.isInteger(enrollReplyId)
    || !Number.isInteger(bgSessionId)
    || bgSessionId <= 0
    || !Number.isInteger(bgReplyId)
    || !Number.isInteger(COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY)
    || !Number.isInteger(COMMANDS.ZKTIME_ENROLL_SELECTION)
    || !Number.isInteger(COMMANDS.OPTIONS_RRQ)
    || !Number.isInteger(ACK.OK)
  ) {
    setStep3SelectionSkip('v2_step3_missing_prerequisites', 'unknown');
    return {
      phase_name: 'prompt_boundary_entry',
      phase_status: 'failed',
      phase_reason: 'v2_step3_missing_prerequisites',
      diagnostics,
      state: {},
      runtime: {}
    };
  }

  const step3AckMatchMaxExtraFrames = 8;
  const step3DrainMaxFrames = 8;
  const step3DrainWaitMs = Math.max(25, Math.min(150, Math.floor(timeoutMs / 8)));
  const step3SettleDelayBefore003dMs = Math.max(
    0,
    Math.min(
      1000,
      Number.isInteger(V2_STEP3_SETTLE_DELAY_BEFORE_003D_MS)
        ? V2_STEP3_SETTLE_DELAY_BEFORE_003D_MS
        : 500
    )
  );
  diagnostics.v2_step3_settle_delay_before_003d_ms = step3SettleDelayBefore003dMs;
  const step4ProgressAckWindowMs = Math.max(
    1000,
    Math.min(60000, Number.isInteger(V2_STEP4_PROGRESS_ACK_WINDOW_MS) ? V2_STEP4_PROGRESS_ACK_WINDOW_MS : 60000)
  );
  const step4ProgressAckPostShortGraceMs = Math.max(
    0,
    Math.min(10000, Number.isInteger(V2_STEP4_PROGRESS_ACK_POST_SHORT_GRACE_MS) ? V2_STEP4_PROGRESS_ACK_POST_SHORT_GRACE_MS : 10000)
  );
  const step4ProgressAckReceiveMs = Math.max(100, Math.min(500, Math.floor(timeoutMs / 4)));

  async function waitStep3SettleDelay() {
    if (step3SettleDelayBefore003dMs <= 0) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, step3SettleDelayBefore003dMs));
    diagnostics.v2_step3_settle_delay_applied = true;
  }

  function setStep3SelectionSkip(reason, guardKey = 'unknown') {
    diagnostics.v2_step3_003d_send_skipped = true;
    diagnostics.v2_step3_003d_skip_reason = normalizeText(reason) || 'v2_step3_003d_skipped_unclassified';
    diagnostics.v2_step3_003d_guard_device_user_id_missing = false;
    diagnostics.v2_step3_003d_guard_device_user_id_invalid = false;
    diagnostics.v2_step3_003d_guard_device_user_id_device_state_conflict = false;
    diagnostics.v2_step3_003d_guard_source_of_truth_failed = false;
    diagnostics.v2_step3_003d_guard_final_field_mismatch = false;
    diagnostics.v2_step3_003d_guard_unknown = false;

    if (guardKey === 'device_user_id_missing') {
      diagnostics.v2_step3_003d_guard_device_user_id_missing = true;
      return;
    }
    if (guardKey === 'device_user_id_invalid') {
      diagnostics.v2_step3_003d_guard_device_user_id_invalid = true;
      return;
    }
    if (guardKey === 'device_user_id_device_state_conflict') {
      diagnostics.v2_step3_003d_guard_device_user_id_device_state_conflict = true;
      return;
    }
    if (guardKey === 'source_of_truth_failed') {
      diagnostics.v2_step3_003d_guard_source_of_truth_failed = true;
      return;
    }
    if (guardKey === 'final_field_mismatch') {
      diagnostics.v2_step3_003d_guard_final_field_mismatch = true;
      return;
    }
    diagnostics.v2_step3_003d_guard_unknown = true;
  }

  function parseInnerPacket(innerPayload) {
    const payload = Buffer.isBuffer(innerPayload) ? innerPayload : Buffer.alloc(0);
    if (payload.length < 8) {
      return null;
    }
    return {
      command: payload.readUInt16LE(0),
      session_id: payload.readUInt16LE(4),
      reply_id: payload.readUInt16LE(6),
      payload: payload.subarray(8)
    };
  }

  function appendRxTrace(stage, response) {
    if (!isPlainObject(response) || !Number.isInteger(response.command)) {
      return;
    }
    rxTrace.push({
      stage,
      command: response.command,
      command_hex: commandToHex(response.command),
      session_id: Number.isInteger(response.session_id) ? response.session_id : null,
      reply_id: Number.isInteger(response.reply_id) ? response.reply_id : null,
      payload_bytes: Buffer.isBuffer(response.payload) ? response.payload.length : 0,
      payload_hex: Buffer.isBuffer(response.payload) ? response.payload.toString('hex') : ''
    });
  }

  function noteIgnoredStaleReplyId(replyId) {
    if (!Number.isInteger(replyId)) {
      return;
    }
    if (!Array.isArray(diagnostics.v2_step3_ignored_stale_ack_reply_ids)) {
      diagnostics.v2_step3_ignored_stale_ack_reply_ids = [];
    }
    diagnostics.v2_step3_ignored_stale_ack_reply_ids.push(replyId);
  }

  function isExactAck(response, expectedReplyId) {
    return !!(
      isPlainObject(response)
      && response.command === ACK.OK
      && Number.isInteger(response.reply_id)
      && response.reply_id === expectedReplyId
    );
  }

  async function drainStaleFramesBeforeBoundary(replyUpperBound) {
    let drained = 0;
    for (let i = 0; i < step3DrainMaxFrames; i += 1) {
      let wrappedFrame;
      try {
        wrappedFrame = await enrollChannel.receiveFrame(step3DrainWaitMs);
      } catch (err) {
        const code = err && err.code ? String(err.code) : '';
        if (code === 'REPLY_TIMEOUT') {
          break;
        }
        throw err;
      }
      const parsed = parseInnerPacket(wrappedFrame && wrappedFrame.payload);
      if (!parsed) {
        continue;
      }
      appendRxTrace('v2_step3_stale_ack_drain_before_003e', parsed);
      if (
        parsed.command === ACK.OK
        && Number.isInteger(parsed.reply_id)
        && parsed.reply_id <= replyUpperBound
      ) {
        drained += 1;
        noteIgnoredStaleReplyId(parsed.reply_id);
      }
    }
    diagnostics.v2_step3_stale_ack_drain_count_before_003e = drained;
  }

  async function matchExactAckWithinWindow({
    stage,
    expectedReplyId,
    initialResponse
  }) {
    let examined = 0;
    let remaining = timeoutMs;
    let candidate = initialResponse;
    let lastResponse = isPlainObject(candidate) ? candidate : null;

    while (examined < step3AckMatchMaxExtraFrames) {
      if (isPlainObject(candidate)) {
        appendRxTrace(stage, candidate);
        lastResponse = candidate;
        if (isExactAck(candidate, expectedReplyId)) {
          return { matched: true, response: candidate };
        }
        if (
          candidate.command === ACK.OK
          && Number.isInteger(candidate.reply_id)
          && candidate.reply_id < expectedReplyId
        ) {
          noteIgnoredStaleReplyId(candidate.reply_id);
        }
      }

      examined += 1;
      if (examined >= step3AckMatchMaxExtraFrames) {
        break;
      }

      const waitMs = Math.max(25, Math.min(step3DrainWaitMs, remaining));
      remaining = Math.max(0, remaining - waitMs);
      if (waitMs <= 0) {
        break;
      }

      let wrappedFrame;
      try {
        wrappedFrame = await enrollChannel.receiveFrame(waitMs);
      } catch (err) {
        const code = err && err.code ? String(err.code) : '';
        if (code === 'REPLY_TIMEOUT') {
          diagnostics.v2_step3_ack_match_timeout = true;
          return { matched: false, response: lastResponse };
        }
        throw err;
      }
      candidate = parseInnerPacket(wrappedFrame && wrappedFrame.payload);
    }

    diagnostics.v2_step3_ack_match_timeout = true;
    return { matched: false, response: lastResponse };
  }

  async function runPost003dProgressAckWindow(retainedEnrollSessionId) {
    diagnostics.v2_step4_progress_ack_window_entered = true;
    diagnostics.v2_step4_progress_ack_session_id_used = Number.isInteger(retainedEnrollSessionId)
      ? retainedEnrollSessionId
      : null;
    diagnostics.v2_step4_progress_ack_used_retained_enroll_session = Number.isInteger(retainedEnrollSessionId)
      && retainedEnrollSessionId > 0;

    const windowStart = Date.now();
    const absoluteDeadline = windowStart + step4ProgressAckWindowMs;
    let deadline = windowStart + step4ProgressAckWindowMs;
    diagnostics.v2_step4_progress_ack_total_budget_ms = step4ProgressAckWindowMs;
    while (Date.now() < deadline) {
      diagnostics.v2_step4_progress_ack_loop_iterations += 1;
      let wrappedFrame = null;
      try {
        wrappedFrame = await enrollChannel.receiveFrame(step4ProgressAckReceiveMs);
      } catch (err) {
        const code = err && err.code ? String(err.code) : '';
        if (code === 'REPLY_TIMEOUT') {
          diagnostics.v2_step4_progress_ack_receive_timeout_count += 1;
          continue;
        }
        diagnostics.v2_step4_progress_ack_last_parse_error = normalizeText(code) || 'receive_error';
        diagnostics.v2_step4_progress_ack_loop_exit_reason = 'receive_error';
        break;
      }
      diagnostics.v2_step4_progress_ack_receive_frame_count += 1;
      diagnostics.v2_step4_progress_ack_last_raw_len = (
        wrappedFrame
        && Buffer.isBuffer(wrappedFrame.payload)
      )
        ? wrappedFrame.payload.length
        : null;
      const parsed = parseInnerPacket(wrappedFrame && wrappedFrame.payload);
      if (!parsed) {
        diagnostics.v2_step4_progress_ack_parse_fail_count += 1;
        diagnostics.v2_step4_progress_ack_last_parse_error = 'parse_inner_packet_failed';
        continue;
      }
      diagnostics.v2_step4_progress_ack_parse_ok_count += 1;
      diagnostics.v2_step4_progress_ack_last_parse_error = null;
      diagnostics.v2_step4_progress_ack_last_parsed_command_hex = commandToHex(parsed.command);
      diagnostics.v2_step4_progress_ack_last_parsed_session_id = Number.isInteger(parsed.session_id)
        ? parsed.session_id
        : null;
      diagnostics.v2_step4_progress_ack_last_parsed_reply_id = Number.isInteger(parsed.reply_id)
        ? parsed.reply_id
        : null;
      appendRxTrace('v2_step4_progress_window_rx', parsed);
      if (parsed.command !== COMMANDS.ZKTIME_RT_SUBSCRIBE) {
        diagnostics.v2_step4_progress_ack_non_01f4_frame_count += 1;
        continue;
      }
      diagnostics.v2_step4_progress_ack_01f4_match_count += 1;
      diagnostics.v2_step4_progress_ack_branch_entered = true;
      if (!Number.isInteger(diagnostics.v2_step4_progress_ack_first_01f4_elapsed_ms)) {
        diagnostics.v2_step4_progress_ack_first_01f4_elapsed_ms = Date.now() - windowStart;
      }
      if (step4ProgressAckPostShortGraceMs > 0) {
        const shortPhaseExtensionDeadline = Date.now() + step4ProgressAckPostShortGraceMs;
        deadline = Math.min(absoluteDeadline, Math.max(deadline, shortPhaseExtensionDeadline));
      }

      const ackReplyId = Number.isInteger(parsed.reply_id) ? parsed.reply_id : 0;
      const payloadLen = Buffer.isBuffer(parsed.payload) ? parsed.payload.length : 0;
      diagnostics.v2_step4_progress_ack_last_reply_id = ackReplyId;
      diagnostics.v2_step4_progress_ack_last_payload_len = payloadLen;
      diagnostics.v2_step4_progress_ack_event_session_id_last_seen = Number.isInteger(parsed.session_id)
        ? parsed.session_id
        : null;
      diagnostics.v2_step4_progress_ack_structured_seen = diagnostics.v2_step4_progress_ack_structured_seen || payloadLen > 1;

      try {
        const ackInnerPacket = buildInnerPacket({
          command: ACK.OK,
          sessionId: retainedEnrollSessionId,
          replyId: ackReplyId,
          payload: Buffer.alloc(0)
        });
        const ackWrappedPacket = buildTcpWrappedPacket(ackInnerPacket);
        await enrollChannel.send(ackWrappedPacket);
        diagnostics.v2_step4_progress_ack_count += 1;
        diagnostics.v2_step4_progress_ack_sent_before_05df = diagnostics.v2_step4_progress_ack_count > 0;
        if (payloadLen > 1) {
          diagnostics.v2_step4_progress_ack_structured_ack_count += 1;
          if (payloadLen >= 72) {
            diagnostics.v2_step4_progress_ack_terminal_structured_seen = true;
            diagnostics.v2_step4_progress_ack_terminal_structured_ack_count += 1;
            diagnostics.v2_step4_progress_ack_terminal_structured_payload_len = payloadLen;
            diagnostics.v2_step4_progress_ack_terminal_structured_session_id = Number.isInteger(parsed.session_id)
              ? parsed.session_id
              : null;
            diagnostics.v2_step4_progress_ack_terminal_structured_elapsed_ms = Date.now() - windowStart;
            diagnostics.v2_step4_progress_ack_continuation_ready_after_structured = true;
          }
        }
        txTrace.push({
          stage: 'v2_step4_progress_ack_tx',
          command: ACK.OK,
          command_hex: commandToHex(ACK.OK),
          session_id: retainedEnrollSessionId,
          reply_id: ackReplyId,
          payload_bytes: 0,
          payload_hex: ''
        });
      } catch (err) {
        diagnostics.v2_step4_progress_ack_loop_exit_reason = 'send_error';
        break;
      }

      if (diagnostics.v2_step4_progress_ack_terminal_structured_seen === true) {
        diagnostics.v2_step4_progress_ack_loop_exit_reason = 'terminal_structured_01f4_acked';
        break;
      }
    }

    if (!normalizeText(diagnostics.v2_step4_progress_ack_loop_exit_reason)) {
      diagnostics.v2_step4_progress_ack_timeout = true;
      diagnostics.v2_step4_progress_ack_loop_exit_reason = 'timeout';
    }
  }

  try {
    const firstSessionId = enrollSessionId;
    const firstReplyId = nextReplyId(enrollReplyId);
    await drainStaleFramesBeforeBoundary(enrollReplyId);
    diagnostics.v2_step3_003e_sent = true;
    diagnostics.v2_step3_003e_reply_id_sent = firstReplyId;
    txTrace.push({
      stage: 'v2_step3_boundary_003e',
      command: COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY,
      command_hex: commandToHex(COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY),
      session_id: firstSessionId,
      reply_id: firstReplyId,
      payload_bytes: 0,
      payload_hex: ''
    });
    const boundaryResult = await sendTcpCommand({
      channel: enrollChannel,
      timeoutMs,
      command: COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY,
      sessionId: firstSessionId,
      replyId: firstReplyId,
      payload: Buffer.alloc(0),
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed',
      deviceNumber
    });
    if (!boundaryResult || !boundaryResult.ok || !boundaryResult.response) {
      phaseReason = boundaryResult && boundaryResult.error
        ? String(boundaryResult.error)
        : 'v2_step3_003e_send_failed';
      setStep3SelectionSkip(phaseReason, 'unknown');
      return {
        phase_name: 'prompt_boundary_entry',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: { tx_trace: txTrace, rx_trace: rxTrace },
        runtime: {}
      };
    }
    const boundaryAckMatch = await matchExactAckWithinWindow({
      stage: 'v2_step3_boundary_003e',
      expectedReplyId: firstReplyId,
      initialResponse: boundaryResult.response
    });
    diagnostics.v2_step3_003e_ack_match_exact = boundaryAckMatch.matched === true;
    diagnostics.v2_step3_003e_ack_observed = boundaryAckMatch.matched === true;
    diagnostics.v2_step3_003e_ack_reply_id_observed = (
      boundaryAckMatch.matched
      && boundaryAckMatch.response
      && Number.isInteger(boundaryAckMatch.response.reply_id)
    )
      ? boundaryAckMatch.response.reply_id
      : null;
    if (!diagnostics.v2_step3_003e_ack_match_exact) {
      phaseReason = 'v2_step3_003e_ack_not_ok';
      setStep3SelectionSkip(phaseReason, 'unknown');
      return {
        phase_name: 'prompt_boundary_entry',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: { tx_trace: txTrace, rx_trace: rxTrace },
        runtime: {}
      };
    }

    enrollSessionId = Number.isInteger(boundaryAckMatch.response.session_id) && boundaryAckMatch.response.session_id > 0
      ? boundaryAckMatch.response.session_id
      : firstSessionId;
    enrollReplyId = firstReplyId;
    await waitStep3SettleDelay();

    const secondSessionId = enrollSessionId;
    const secondReplyId = nextReplyId(enrollReplyId);
    diagnostics.v2_stage7_pre_resolver_device_user_id_type = valueTypeLabel(safeEnrollment.device_user_id);
    diagnostics.v2_stage7_pre_resolver_device_user_id_value = compactValueOrNull(safeEnrollment.device_user_id);
    const selectionDeviceUserIdInput = buildV2Step3SelectionPayload({
      deviceUserId: safeEnrollment.device_user_id,
      selectedFinger: safeEnrollment.selected_finger
    });
    diagnostics.v2_step3_003d_input_device_user_id = selectionDeviceUserIdInput.ok
      ? selectionDeviceUserIdInput.value
      : null;
    diagnostics.v2_step3_003d_input_device_user_id_source = selectionDeviceUserIdInput.ok
      ? selectionDeviceUserIdInput.source
      : null;
    diagnostics.v2_step3_003d_user_id_encoding = selectionDeviceUserIdInput.ok
      ? selectionDeviceUserIdInput.user_id_encoding
      : null;
    diagnostics.v2_step3_003d_user_id_ascii = selectionDeviceUserIdInput.ok
      ? selectionDeviceUserIdInput.user_id_ascii
      : null;
    if (!selectionDeviceUserIdInput.ok) {
      phaseReason = selectionDeviceUserIdInput.error;
      diagnostics.v2_step3_003d_derivation_blocked_reason = phaseReason;
      setStep3SelectionSkip(
        phaseReason,
        selectionDeviceUserIdInput.guard_reason === 'device_user_id_missing'
          ? 'device_user_id_missing'
          : 'device_user_id_invalid'
      );
      return {
        phase_name: 'prompt_boundary_entry',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: { tx_trace: txTrace, rx_trace: rxTrace },
        runtime: {}
      };
    }
    if (selectionDeviceUserIdInput.value > V2_STEP3_DEVICE_STATE_MAX_USER_ID) {
      diagnostics.v2_step3_003d_device_user_id_device_state_conflict = true;
      diagnostics.v2_step3_003d_device_state_conflict_warning_only = true;
    }
    const selectionPayload = Buffer.from(selectionDeviceUserIdInput.payload);
    diagnostics.v2_step3_003d_input_selected_finger = selectionDeviceUserIdInput.selected_finger || null;
    diagnostics.v2_step3_003d_payload_field_00_03_hex = selectionPayload.subarray(0, 4).toString('hex');
    diagnostics.v2_step3_003d_payload_field_24_hex = selectionPayload.length >= 25
      ? selectionPayload.subarray(24, 25).toString('hex')
      : null;
    diagnostics.v2_step3_003d_payload_field_25_hex = selectionPayload.length >= 26
      ? selectionPayload.subarray(25, 26).toString('hex')
      : null;
    diagnostics.v2_step3_003d_payload_hex = selectionPayload.toString('hex');
    const expectedUserIdFieldHex = Buffer.alloc(4, 0);
    Buffer.from(selectionDeviceUserIdInput.user_id_ascii, 'ascii').copy(expectedUserIdFieldHex, 0);
    const finalSourceOfTruth = {
      device_user_id: selectionDeviceUserIdInput.value,
      selected_finger: selectionDeviceUserIdInput.selected_finger || null,
      payload_hex: selectionPayload.toString('hex'),
      field_00_03_hex: selectionPayload.subarray(0, 4).toString('hex'),
      field_24_hex: selectionPayload.length >= 25
        ? selectionPayload.subarray(24, 25).toString('hex')
        : null,
      field_25_hex: selectionPayload.length >= 26
        ? selectionPayload.subarray(25, 26).toString('hex')
        : null
    };
    diagnostics.v2_step3_003d_final_device_user_id = finalSourceOfTruth.device_user_id;
    diagnostics.v2_step3_003d_final_selected_finger = finalSourceOfTruth.selected_finger;
    diagnostics.v2_step3_003d_final_payload_hex = finalSourceOfTruth.payload_hex;
    diagnostics.v2_step3_003d_final_field_00_03_hex = finalSourceOfTruth.field_00_03_hex;
    diagnostics.v2_step3_003d_final_field_24_hex = finalSourceOfTruth.field_24_hex;
    diagnostics.v2_step3_003d_final_field_25_hex = finalSourceOfTruth.field_25_hex;
    diagnostics.v2_step3_003d_pre_send_source_of_truth_ok = (
      finalSourceOfTruth.field_00_03_hex === expectedUserIdFieldHex.toString('hex')
    );
    if (!diagnostics.v2_step3_003d_pre_send_source_of_truth_ok) {
      phaseReason = 'v2_step3_003d_pre_send_source_of_truth_mismatch';
      diagnostics.v2_step3_003d_derivation_blocked_reason = phaseReason;
      setStep3SelectionSkip(phaseReason, 'final_field_mismatch');
      diagnostics.v2_step3_003d_guard_source_of_truth_failed = true;
      return {
        phase_name: 'prompt_boundary_entry',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: { tx_trace: txTrace, rx_trace: rxTrace },
        runtime: {}
      };
    }
    diagnostics.v2_step3_003d_send_attempted = true;
    diagnostics.v2_step3_003d_send_skipped = false;
    diagnostics.v2_step3_003d_skip_reason = null;
    diagnostics.v2_step3_003d_sent = true;
    diagnostics.v2_step3_003d_reply_id_sent = secondReplyId;
    txTrace.push({
      stage: 'v2_step3_boundary_003d',
      command: COMMANDS.ZKTIME_ENROLL_SELECTION,
      command_hex: commandToHex(COMMANDS.ZKTIME_ENROLL_SELECTION),
      session_id: secondSessionId,
      reply_id: secondReplyId,
      payload_bytes: selectionPayload.length,
      payload_hex: selectionPayload.toString('hex')
    });
    const selectionResult = await sendTcpCommand({
      channel: enrollChannel,
      timeoutMs,
      command: COMMANDS.ZKTIME_ENROLL_SELECTION,
      sessionId: secondSessionId,
      replyId: secondReplyId,
      payload: selectionPayload,
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed',
      deviceNumber
    });
    if (!selectionResult || !selectionResult.ok || !selectionResult.response) {
      phaseReason = selectionResult && selectionResult.error
        ? String(selectionResult.error)
        : 'v2_step3_003d_send_failed';
      return {
        phase_name: 'prompt_boundary_entry',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: { tx_trace: txTrace, rx_trace: rxTrace },
        runtime: {}
      };
    }
    const selectionAckMatch = await matchExactAckWithinWindow({
      stage: 'v2_step3_boundary_003d',
      expectedReplyId: secondReplyId,
      initialResponse: selectionResult.response
    });
    diagnostics.v2_step3_003d_ack_match_exact = selectionAckMatch.matched === true;
    diagnostics.v2_step3_003d_ack_observed = selectionAckMatch.matched === true;
    diagnostics.v2_step3_003d_ack_reply_id_observed = (
      selectionAckMatch.matched
      && selectionAckMatch.response
      && Number.isInteger(selectionAckMatch.response.reply_id)
    )
      ? selectionAckMatch.response.reply_id
      : null;
    diagnostics.v2_step3_003d_response_command_hex = (
      selectionAckMatch.response
      && Number.isInteger(selectionAckMatch.response.command)
    )
      ? commandToHex(selectionAckMatch.response.command)
      : null;
    diagnostics.v2_step3_003d_response_reply_id = (
      selectionAckMatch.response
      && Number.isInteger(selectionAckMatch.response.reply_id)
    )
      ? selectionAckMatch.response.reply_id
      : null;
    diagnostics.v2_step3_003d_device_rejected = (
      selectionAckMatch.matched !== true
      && Number.isInteger(selectionAckMatch.response && selectionAckMatch.response.command)
      && selectionAckMatch.response.command !== ACK.OK
    );
    if (!diagnostics.v2_step3_003d_ack_match_exact) {
      phaseReason = 'v2_step3_003d_ack_not_ok';
      return {
        phase_name: 'prompt_boundary_entry',
        phase_status: 'failed',
        phase_reason: phaseReason,
        diagnostics,
        state: { tx_trace: txTrace, rx_trace: rxTrace },
        runtime: {}
      };
    }

    enrollSessionId = Number.isInteger(selectionAckMatch.response.session_id) && selectionAckMatch.response.session_id > 0
      ? selectionAckMatch.response.session_id
      : secondSessionId;
    enrollReplyId = secondReplyId;
    await runPost003dProgressAckWindow(enrollSessionId);
    diagnostics.v2_step3_boundary_entered = true;

    const bgProbeReplyId = nextReplyId(bgReplyId);
    const bgProbe = await sendTcpCommand({
      channel: bgChannel,
      timeoutMs,
      command: COMMANDS.OPTIONS_RRQ,
      sessionId: bgSessionId,
      replyId: bgProbeReplyId,
      payload: Buffer.from('DeviceID\0', 'ascii'),
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed',
      deviceNumber
    });
    diagnostics.v2_step3_background_lane_still_alive = !!(
      bgProbe
      && bgProbe.ok
      && bgProbe.response
      && bgProbe.response.command === ACK.OK
    );
    if (diagnostics.v2_step3_background_lane_still_alive) {
      bgSessionId = Number.isInteger(bgProbe.response.session_id) && bgProbe.response.session_id > 0
        ? bgProbe.response.session_id
        : bgSessionId;
      bgReplyId = bgProbeReplyId;
    }

    diagnostics.v2_step3_enroll_lane_session_id = enrollSessionId;
    diagnostics.v2_step3_enroll_lane_session_continuity_ok = (
      Number.isInteger(firstSessionId)
      && firstSessionId > 0
      && Number.isInteger(secondSessionId)
      && secondSessionId > 0
      && firstSessionId === secondSessionId
      && Number.isInteger(enrollSessionId)
      && enrollSessionId > 0
      && enrollSessionId === secondSessionId
    );
    diagnostics.v2_step3_enroll_lane_reply_continuity_ok = (
      Number.isInteger(diagnostics.v2_step3_003e_reply_id_sent)
      && Number.isInteger(diagnostics.v2_step3_003d_reply_id_sent)
      && Number.isInteger(diagnostics.v2_step3_003e_ack_reply_id_observed)
      && Number.isInteger(diagnostics.v2_step3_003d_ack_reply_id_observed)
      && diagnostics.v2_step3_003d_reply_id_sent === diagnostics.v2_step3_003e_reply_id_sent + 1
      && diagnostics.v2_step3_003e_ack_reply_id_observed === diagnostics.v2_step3_003e_reply_id_sent
      && diagnostics.v2_step3_003d_ack_reply_id_observed === diagnostics.v2_step3_003d_reply_id_sent
    );
    diagnostics.v2_step3_enroll_lane_retained_for_step4 = (
      diagnostics.v2_step3_boundary_entered === true
      && diagnostics.v2_step3_003e_ack_observed === true
      && diagnostics.v2_step3_003d_ack_observed === true
      && diagnostics.v2_step3_enroll_lane_session_continuity_ok === true
      && diagnostics.v2_step3_enroll_lane_reply_continuity_ok === true
      && diagnostics.v2_step3_background_lane_still_alive === true
    );
    diagnostics.v2_step3_client_teardown_sent_at_completion = false;
    diagnostics.v2_workflow_ready_for_step4_entry = diagnostics.v2_step3_enroll_lane_retained_for_step4;

    phaseStatus = diagnostics.v2_step3_enroll_lane_retained_for_step4
      ? 'completed_step3_prompt_boundary_ready'
      : 'completed_step3_with_warnings';
    phaseReason = phaseStatus === 'completed_step3_prompt_boundary_ready'
      ? 'v2_step3_prompt_boundary_ready_for_step4'
      : 'v2_step3_prompt_boundary_incomplete';
  } catch (err) {
    phaseStatus = 'failed';
    phaseReason = mapSocketErrorCode(err);
  }

  return {
    phase_name: 'prompt_boundary_entry',
    phase_status: phaseStatus,
    phase_reason: phaseReason,
    diagnostics,
    state: {
      protocol_session_ref: (
        Number.isInteger(enrollSessionId)
        && enrollSessionId > 0
        && Number.isInteger(enrollReplyId)
      )
        ? `${enrollSessionId}:${enrollReplyId}`
        : null,
      tx_trace: txTrace,
      rx_trace: rxTrace
    },
    runtime: diagnostics.v2_step3_enroll_lane_retained_for_step4
      ? {
        enroll_channel: enrollChannel,
        enroll_session_id: enrollSessionId,
        enroll_reply_id: enrollReplyId,
        bg_channel: bgChannel,
        bg_session_id: bgSessionId,
        bg_reply_id: bgReplyId
      }
      : {}
  };
}

async function runV2PhaseResultContinuation(context = {}) {
  const safeContext = isPlainObject(context) ? context : {};
  const safeOptions = isPlainObject(safeContext.options) ? safeContext.options : {};
  const helpers = isPlainObject(safeOptions.k80_v2_helpers) ? safeOptions.k80_v2_helpers : {};
  const runtime = isPlainObject(safeContext.runtime) ? safeContext.runtime : {};
  const step3Diagnostics = isPlainObject(safeContext.step3Diagnostics) ? safeContext.step3Diagnostics : {};

  const diagnostics = {
    v2_step4_05df_attempted: false,
    v2_step4_05df_sent: false,
    v2_step4_05df_payload_hex: null,
    v2_step4_05df_session_id_sent: null,
    v2_step4_05df_reply_id_sent: null,
    v2_step4_05df_response_command_hex: null,
    v2_step4_05df_response_reply_id: null,
    v2_step4_05df_05dd_observed: false,
    v2_step4_05df_skipped_reason: null,
    v2_step4_0058_attempted: false,
    v2_step4_0058_sent: false,
    v2_step4_0058_payload_hex: null,
    v2_step4_0058_payload_source_word0: null,
    v2_step4_0058_payload_derived_count: null,
    v2_step4_0058_selected_finger_byte: null,
    v2_step4_0058_payload_rule: null,
    v2_step4_0058_session_id_sent: null,
    v2_step4_0058_reply_id_sent: null,
    v2_step4_0058_response_command_hex: null,
    v2_step4_0058_response_reply_id: null,
    v2_step4_0058_05dc_observed: false,
    v2_step4_0058_skipped_reason: null,
    v2_step4_post_05dc_drain_entered: false,
    v2_step4_post_05dc_later_05dd_observed: false,
    v2_step4_post_05dc_later_05dd_reply_id: null,
    v2_step4_post_05dc_later_05dd_payload_len: null,
    v2_step4_post_05dc_trailing_07d0_observed: false,
    v2_step4_post_05dc_trailing_07d0_reply_id: null,
    v2_step4_post_05dc_loop_exit_reason: null,
    v2_step4_post_05dc_drain_timeout_ms: V2_STEP4_POST_05DC_DRAIN_TIMEOUT_MS,
    v2_step4_post_05dc_later_05dd_elapsed_ms: null,
    v2_step4_post_05dc_trailing_07d0_elapsed_ms: null
  };

  const sendTcpCommand = typeof helpers.sendTcpCommand === 'function'
    ? helpers.sendTcpCommand
    : null;
  const nextReplyId = typeof helpers.nextReplyId === 'function'
    ? helpers.nextReplyId
    : null;
  const mapSocketErrorCode = typeof helpers.mapSocketErrorCode === 'function'
    ? helpers.mapSocketErrorCode
    : err => (err && err.message ? String(err.message) : 'v2_step4_05df_error');
  const COMMANDS = isPlainObject(helpers.COMMANDS) ? helpers.COMMANDS : {};
  const ACK = isPlainObject(helpers.ACK) ? helpers.ACK : {};
  const FAILURE_REASON = isPlainObject(helpers.FAILURE_REASON) ? helpers.FAILURE_REASON : {};

  const timeoutMs = Number.isInteger(safeOptions.timeout_ms)
    ? safeOptions.timeout_ms
    : 2000;
  const deviceNumber = Number.isInteger(
    isPlainObject(safeContext.commandPayload) && isPlainObject(safeContext.commandPayload.connection)
      ? safeContext.commandPayload.connection.device_number
      : null
  )
    ? safeContext.commandPayload.connection.device_number
    : 1;

  const enrollChannel = runtime.enroll_channel;
  let enrollSessionId = Number.isInteger(runtime.enroll_session_id) ? runtime.enroll_session_id : null;
  let enrollReplyId = Number.isInteger(runtime.enroll_reply_id) ? runtime.enroll_reply_id : null;
  const bgChannel = runtime.bg_channel;
  const bgSessionId = Number.isInteger(runtime.bg_session_id) ? runtime.bg_session_id : null;
  const bgReplyId = Number.isInteger(runtime.bg_reply_id) ? runtime.bg_reply_id : null;

  const txTrace = [];
  const rxTrace = [];

  const buildRuntime = () => ({
    enroll_channel: enrollChannel,
    enroll_session_id: enrollSessionId,
    enroll_reply_id: enrollReplyId,
    bg_channel: bgChannel,
    bg_session_id: bgSessionId,
    bg_reply_id: bgReplyId
  });

  function parseHexByte(hexValue) {
    if (typeof hexValue !== 'string' || !/^[0-9a-fA-F]{2}$/.test(hexValue)) {
      return null;
    }
    const parsed = Number.parseInt(hexValue, 16);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xff ? parsed : null;
  }

  function selectedFingerByteFromPayloadHex(payloadHex) {
    if (typeof payloadHex !== 'string' || !/^[0-9a-fA-F]+$/.test(payloadHex) || payloadHex.length % 2 !== 0) {
      return null;
    }
    const payload = Buffer.from(payloadHex, 'hex');
    if (payload.length < 26) {
      return null;
    }
    return payload[payload.length - 2];
  }

  function resolveSelectedFingerByteFromStep3() {
    const finalPayloadByte = selectedFingerByteFromPayloadHex(step3Diagnostics.v2_step3_003d_final_payload_hex);
    if (Number.isInteger(finalPayloadByte)) {
      return { ok: true, value: finalPayloadByte };
    }
    const finalFieldByte = parseHexByte(step3Diagnostics.v2_step3_003d_final_field_24_hex);
    if (Number.isInteger(finalFieldByte)) {
      return { ok: true, value: finalFieldByte };
    }
    const payloadByte = selectedFingerByteFromPayloadHex(step3Diagnostics.v2_step3_003d_payload_hex);
    if (Number.isInteger(payloadByte)) {
      return { ok: true, value: payloadByte };
    }
    const fieldByte = parseHexByte(step3Diagnostics.v2_step3_003d_payload_field_24_hex);
    if (Number.isInteger(fieldByte)) {
      return { ok: true, value: fieldByte };
    }
    return { ok: false, reason: 'selected_finger_byte_unavailable' };
  }

  function parseContinuationInnerPacket(innerPayload) {
    const payload = Buffer.isBuffer(innerPayload) ? innerPayload : Buffer.alloc(0);
    if (payload.length < 8) {
      return null;
    }
    return {
      command: payload.readUInt16LE(0),
      checksum: payload.readUInt16LE(2),
      session_id: payload.readUInt16LE(4),
      reply_id: payload.readUInt16LE(6),
      payload: payload.subarray(8)
    };
  }

  async function drainPost05dcResponseFamily(expectedReplyId) {
    if (!Number.isInteger(expectedReplyId)) {
      diagnostics.v2_step4_post_05dc_loop_exit_reason = 'invalid_0058_reply_id';
      return;
    }

    diagnostics.v2_step4_post_05dc_drain_entered = true;
    const drainStart = Date.now();
    const deadline = drainStart + V2_STEP4_POST_05DC_DRAIN_TIMEOUT_MS;

    while (Date.now() < deadline) {
      const waitMs = Math.max(25, Math.min(timeoutMs, deadline - Date.now()));
      let wrappedFrame = null;
      try {
        wrappedFrame = await enrollChannel.receiveFrame(waitMs);
      } catch (err) {
        const code = err && err.code ? String(err.code) : '';
        if (code === 'REPLY_TIMEOUT') {
          continue;
        }
        diagnostics.v2_step4_post_05dc_loop_exit_reason = normalizeText(code) || 'receive_error';
        return;
      }

      const parsed = parseContinuationInnerPacket(wrappedFrame && wrappedFrame.payload);
      if (!parsed) {
        continue;
      }
      rxTrace.push({
        stage: 'v2_step4_post_05dc_drain',
        command: parsed.command,
        command_hex: commandToHex(parsed.command),
        session_id: Number.isInteger(parsed.session_id) ? parsed.session_id : null,
        reply_id: Number.isInteger(parsed.reply_id) ? parsed.reply_id : null,
        payload_bytes: Buffer.isBuffer(parsed.payload) ? parsed.payload.length : 0,
        payload_hex: Buffer.isBuffer(parsed.payload) ? parsed.payload.toString('hex') : ''
      });

      if (
        parsed.command === command05dd
        && parsed.reply_id === expectedReplyId
      ) {
        diagnostics.v2_step4_post_05dc_later_05dd_observed = true;
        diagnostics.v2_step4_post_05dc_later_05dd_reply_id = parsed.reply_id;
        diagnostics.v2_step4_post_05dc_later_05dd_payload_len = Buffer.isBuffer(parsed.payload)
          ? parsed.payload.length
          : 0;
        diagnostics.v2_step4_post_05dc_later_05dd_elapsed_ms = Date.now() - drainStart;
      }

      if (
        parsed.command === command07d0
        && parsed.reply_id === expectedReplyId
        && parsed.session_id === enrollSessionId
      ) {
        diagnostics.v2_step4_post_05dc_trailing_07d0_observed = true;
        diagnostics.v2_step4_post_05dc_trailing_07d0_reply_id = parsed.reply_id;
        diagnostics.v2_step4_post_05dc_trailing_07d0_elapsed_ms = Date.now() - drainStart;
      }

      if (
        diagnostics.v2_step4_post_05dc_later_05dd_observed === true
        && diagnostics.v2_step4_post_05dc_trailing_07d0_observed === true
      ) {
        diagnostics.v2_step4_post_05dc_loop_exit_reason = 'later_05dd_and_trailing_07d0_observed';
        return;
      }
    }

    diagnostics.v2_step4_post_05dc_loop_exit_reason = 'timeout';
  }

  if (step3Diagnostics.v2_step4_progress_ack_continuation_ready_after_structured !== true) {
    diagnostics.v2_step4_05df_skipped_reason = 'structured_continuation_not_ready';
    return {
      phase_name: 'result_continuation',
      phase_status: 'skipped',
      phase_reason: diagnostics.v2_step4_05df_skipped_reason,
      diagnostics,
      state: {
        tx_trace: txTrace,
        rx_trace: rxTrace
      },
      runtime: buildRuntime()
    };
  }

  if (!enrollChannel || typeof enrollChannel.send !== 'function' || typeof enrollChannel.receiveFrame !== 'function') {
    diagnostics.v2_step4_05df_skipped_reason = 'missing_enroll_channel';
    return {
      phase_name: 'result_continuation',
      phase_status: 'skipped',
      phase_reason: diagnostics.v2_step4_05df_skipped_reason,
      diagnostics,
      state: {
        tx_trace: txTrace,
        rx_trace: rxTrace
      },
      runtime: buildRuntime()
    };
  }

  if (!Number.isInteger(enrollSessionId) || enrollSessionId <= 0 || !Number.isInteger(enrollReplyId)) {
    diagnostics.v2_step4_05df_skipped_reason = 'invalid_enroll_lineage';
    return {
      phase_name: 'result_continuation',
      phase_status: 'skipped',
      phase_reason: diagnostics.v2_step4_05df_skipped_reason,
      diagnostics,
      state: {
        tx_trace: txTrace,
        rx_trace: rxTrace
      },
      runtime: buildRuntime()
    };
  }

    if (
      !sendTcpCommand
      || !nextReplyId
      || !Number.isInteger(COMMANDS.ZKTIME_PULL_REQUEST)
    ) {
    diagnostics.v2_step4_05df_skipped_reason = 'missing_05df_prerequisites';
    return {
      phase_name: 'result_continuation',
      phase_status: 'skipped',
      phase_reason: diagnostics.v2_step4_05df_skipped_reason,
      diagnostics,
      state: {
        tx_trace: txTrace,
        rx_trace: rxTrace
      },
      runtime: buildRuntime()
    };
  }
  const command0058 = Number.isInteger(COMMANDS.ZKTIME_ENROLL_RESULT_CONTINUE)
    ? COMMANDS.ZKTIME_ENROLL_RESULT_CONTINUE
    : 0x0058;
  const command05dd = Number.isInteger(COMMANDS.DATA)
    ? COMMANDS.DATA
    : 0x05dd;
  const command05dc = Number.isInteger(COMMANDS.PREPARE_DATA)
    ? COMMANDS.PREPARE_DATA
    : 0x05dc;
  const command07d0 = Number.isInteger(ACK.OK)
    ? ACK.OK
    : 0x07d0;

  diagnostics.v2_step4_05df_attempted = true;
  const payload = Buffer.from(V2_STEP4_05DF_PAYLOAD_HEX, 'hex');
  const replyId = nextReplyId(enrollReplyId);
  diagnostics.v2_step4_05df_payload_hex = payload.toString('hex');
  diagnostics.v2_step4_05df_session_id_sent = enrollSessionId;
  diagnostics.v2_step4_05df_reply_id_sent = replyId;
  txTrace.push({
    stage: 'v2_step4_05df',
    command: COMMANDS.ZKTIME_PULL_REQUEST,
    command_hex: commandToHex(COMMANDS.ZKTIME_PULL_REQUEST),
    session_id: enrollSessionId,
    reply_id: replyId,
    payload_bytes: payload.length,
    payload_hex: payload.toString('hex')
  });

  try {
    const result = await sendTcpCommand({
      channel: enrollChannel,
      timeoutMs,
      command: COMMANDS.ZKTIME_PULL_REQUEST,
      sessionId: enrollSessionId,
      replyId,
      payload,
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed',
      deviceNumber
    });

    if (!result || !result.ok || !result.response) {
      return {
        phase_name: 'result_continuation',
        phase_status: 'failed',
        phase_reason: result && result.error
          ? String(result.error)
          : 'v2_step4_05df_send_failed',
        diagnostics,
        state: {
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    diagnostics.v2_step4_05df_sent = true;
    diagnostics.v2_step4_05df_response_command_hex = commandToHex(result.response.command);
    diagnostics.v2_step4_05df_response_reply_id = Number.isInteger(result.response.reply_id)
      ? result.response.reply_id
      : null;
    diagnostics.v2_step4_05df_05dd_observed = Number.isInteger(COMMANDS.DATA)
      ? result.response.command === COMMANDS.DATA
      : result.response.command === 0x05dd;
    rxTrace.push({
      stage: 'v2_step4_05df',
      command: result.response.command,
      command_hex: commandToHex(result.response.command),
      session_id: Number.isInteger(result.response.session_id) ? result.response.session_id : null,
      reply_id: diagnostics.v2_step4_05df_response_reply_id,
      payload_bytes: Buffer.isBuffer(result.response.payload) ? result.response.payload.length : 0,
      payload_hex: Buffer.isBuffer(result.response.payload) ? result.response.payload.toString('hex') : ''
    });
    enrollSessionId = Number.isInteger(result.response.session_id) && result.response.session_id > 0
      ? result.response.session_id
      : enrollSessionId;
    enrollReplyId = replyId;

    if (diagnostics.v2_step4_05df_sent !== true || diagnostics.v2_step4_05df_05dd_observed !== true) {
      diagnostics.v2_step4_0058_skipped_reason = 'first_05df_05dd_not_observed';
      return {
        phase_name: 'result_continuation',
        phase_status: 'completed_step4_05df_first_continuation',
        phase_reason: diagnostics.v2_step4_05df_05dd_observed === true
          ? 'v2_step4_05df_sent_05dd_observed'
          : 'v2_step4_05df_sent_response_observed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    if (!Buffer.isBuffer(result.response.payload) || result.response.payload.length < 4) {
      diagnostics.v2_step4_0058_skipped_reason = 'first_05dd_payload_too_short';
      return {
        phase_name: 'result_continuation',
        phase_status: 'completed_step4_05df_first_continuation',
        phase_reason: 'v2_step4_05df_sent_05dd_observed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    const payloadSourceWord0 = result.response.payload.readUInt32LE(0);
    diagnostics.v2_step4_0058_payload_source_word0 = payloadSourceWord0;
    if (payloadSourceWord0 <= 0) {
      diagnostics.v2_step4_0058_skipped_reason = 'first_05dd_word0_not_positive';
      return {
        phase_name: 'result_continuation',
        phase_status: 'completed_step4_05df_first_continuation',
        phase_reason: 'v2_step4_05df_sent_05dd_observed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }
    if (payloadSourceWord0 % 72 !== 0) {
      diagnostics.v2_step4_0058_skipped_reason = 'first_05dd_word0_not_divisible_by_72';
      return {
        phase_name: 'result_continuation',
        phase_status: 'completed_step4_05df_first_continuation',
        phase_reason: 'v2_step4_05df_sent_05dd_observed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    const derivedCount = payloadSourceWord0 / 72;
    diagnostics.v2_step4_0058_payload_derived_count = derivedCount;
    if (!Number.isInteger(derivedCount) || derivedCount <= 0 || derivedCount > 0xff) {
      diagnostics.v2_step4_0058_skipped_reason = 'first_05dd_derived_count_out_of_range';
      return {
        phase_name: 'result_continuation',
        phase_status: 'completed_step4_05df_first_continuation',
        phase_reason: 'v2_step4_05df_sent_05dd_observed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    const selectedFingerByte = resolveSelectedFingerByteFromStep3();
    if (!selectedFingerByte.ok) {
      diagnostics.v2_step4_0058_skipped_reason = selectedFingerByte.reason || 'selected_finger_byte_unavailable';
      return {
        phase_name: 'result_continuation',
        phase_status: 'completed_step4_05df_first_continuation',
        phase_reason: 'v2_step4_05df_sent_05dd_observed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    diagnostics.v2_step4_0058_selected_finger_byte = selectedFingerByte.value;
    diagnostics.v2_step4_0058_payload_rule = 'count_byte_00_selected_finger_byte_from_003d_payload';
    const continuePayload = Buffer.from([derivedCount, 0x00, selectedFingerByte.value]);
    const continueReplyId = nextReplyId(enrollReplyId);
    diagnostics.v2_step4_0058_attempted = true;
    diagnostics.v2_step4_0058_payload_hex = continuePayload.toString('hex');
    diagnostics.v2_step4_0058_session_id_sent = enrollSessionId;
    diagnostics.v2_step4_0058_reply_id_sent = continueReplyId;
    txTrace.push({
      stage: 'v2_step4_0058',
      command: command0058,
      command_hex: commandToHex(command0058),
      session_id: enrollSessionId,
      reply_id: continueReplyId,
      payload_bytes: continuePayload.length,
      payload_hex: continuePayload.toString('hex')
    });

    const continueResult = await sendTcpCommand({
      channel: enrollChannel,
      timeoutMs,
      command: command0058,
      sessionId: enrollSessionId,
      replyId: continueReplyId,
      payload: continuePayload,
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed',
      deviceNumber
    });

    if (!continueResult || !continueResult.ok || !continueResult.response) {
      return {
        phase_name: 'result_continuation',
        phase_status: 'failed',
        phase_reason: continueResult && continueResult.error
          ? String(continueResult.error)
          : 'v2_step4_0058_send_failed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    diagnostics.v2_step4_0058_sent = true;
    diagnostics.v2_step4_0058_response_command_hex = commandToHex(continueResult.response.command);
    diagnostics.v2_step4_0058_response_reply_id = Number.isInteger(continueResult.response.reply_id)
      ? continueResult.response.reply_id
      : null;
    diagnostics.v2_step4_0058_05dc_observed = continueResult.response.command === command05dc;
    rxTrace.push({
      stage: 'v2_step4_0058',
      command: continueResult.response.command,
      command_hex: commandToHex(continueResult.response.command),
      session_id: Number.isInteger(continueResult.response.session_id) ? continueResult.response.session_id : null,
      reply_id: diagnostics.v2_step4_0058_response_reply_id,
      payload_bytes: Buffer.isBuffer(continueResult.response.payload) ? continueResult.response.payload.length : 0,
      payload_hex: Buffer.isBuffer(continueResult.response.payload) ? continueResult.response.payload.toString('hex') : ''
    });
    enrollSessionId = Number.isInteger(continueResult.response.session_id) && continueResult.response.session_id > 0
      ? continueResult.response.session_id
      : enrollSessionId;
    enrollReplyId = continueReplyId;

    if (diagnostics.v2_step4_0058_05dc_observed === true) {
      await drainPost05dcResponseFamily(continueReplyId);
    }

    return {
      phase_name: 'result_continuation',
      phase_status: diagnostics.v2_step4_post_05dc_later_05dd_observed === true
        && diagnostics.v2_step4_post_05dc_trailing_07d0_observed === true
        ? 'completed_step4_post_05dc_drain'
        : diagnostics.v2_step4_0058_05dc_observed === true
          ? 'completed_step4_0058_first_response'
          : 'completed_step4_0058_response_observed',
      phase_reason: diagnostics.v2_step4_post_05dc_later_05dd_observed === true
        && diagnostics.v2_step4_post_05dc_trailing_07d0_observed === true
        ? 'v2_step4_post_05dc_later_05dd_and_07d0_observed'
        : diagnostics.v2_step4_0058_05dc_observed === true
          ? 'v2_step4_0058_sent_05dc_observed'
          : 'v2_step4_0058_sent_response_observed',
      diagnostics,
      state: {
        protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
        tx_trace: txTrace,
        rx_trace: rxTrace
      },
      runtime: buildRuntime()
    };
  } catch (err) {
    return {
      phase_name: 'result_continuation',
      phase_status: 'failed',
      phase_reason: mapSocketErrorCode(err),
      diagnostics,
      state: {
        tx_trace: txTrace,
        rx_trace: rxTrace
      },
      runtime: buildRuntime()
    };
  }
}

async function runV2PhaseFinalize(context = {}) {
  const safeContext = isPlainObject(context) ? context : {};
  const safeOptions = isPlainObject(safeContext.options) ? safeContext.options : {};
  const helpers = isPlainObject(safeOptions.k80_v2_helpers) ? safeOptions.k80_v2_helpers : {};
  const runtime = isPlainObject(safeContext.runtime) ? safeContext.runtime : {};
  const step4Diagnostics = isPlainObject(safeContext.step4Diagnostics) ? safeContext.step4Diagnostics : {};

  const diagnostics = {
    v2_step4_finalize_attempted: false,
    v2_step4_finalize_skipped_reason: null,
    v2_step4_finalize_003e_sent: false,
    v2_step4_finalize_003e_session_id_sent: null,
    v2_step4_finalize_003e_reply_id_sent: null,
    v2_step4_finalize_003e_response_command_hex: null,
    v2_step4_finalize_003e_response_reply_id: null,
    v2_step4_finalize_003e_ack_observed: false,
    v2_step4_finalize_003c_sent: false,
    v2_step4_finalize_003c_session_id_sent: null,
    v2_step4_finalize_003c_reply_id_sent: null,
    v2_step4_finalize_003c_response_command_hex: null,
    v2_step4_finalize_003c_response_reply_id: null,
    v2_step4_finalize_003c_ack_observed: false,
    v2_step4_finalize_completed: false
  };

  const sendTcpCommand = typeof helpers.sendTcpCommand === 'function'
    ? helpers.sendTcpCommand
    : null;
  const nextReplyId = typeof helpers.nextReplyId === 'function'
    ? helpers.nextReplyId
    : null;
  const mapSocketErrorCode = typeof helpers.mapSocketErrorCode === 'function'
    ? helpers.mapSocketErrorCode
    : err => (err && err.message ? String(err.message) : 'v2_step4_finalize_error');
  const COMMANDS = isPlainObject(helpers.COMMANDS) ? helpers.COMMANDS : {};
  const ACK = isPlainObject(helpers.ACK) ? helpers.ACK : {};
  const FAILURE_REASON = isPlainObject(helpers.FAILURE_REASON) ? helpers.FAILURE_REASON : {};

  const timeoutMs = Number.isInteger(safeOptions.timeout_ms)
    ? safeOptions.timeout_ms
    : 2000;
  const deviceNumber = Number.isInteger(
    isPlainObject(safeContext.commandPayload) && isPlainObject(safeContext.commandPayload.connection)
      ? safeContext.commandPayload.connection.device_number
      : null
  )
    ? safeContext.commandPayload.connection.device_number
    : 1;

  const enrollChannel = runtime.enroll_channel;
  let enrollSessionId = Number.isInteger(runtime.enroll_session_id) ? runtime.enroll_session_id : null;
  let enrollReplyId = Number.isInteger(runtime.enroll_reply_id) ? runtime.enroll_reply_id : null;
  const bgChannel = runtime.bg_channel;
  const bgSessionId = Number.isInteger(runtime.bg_session_id) ? runtime.bg_session_id : null;
  const bgReplyId = Number.isInteger(runtime.bg_reply_id) ? runtime.bg_reply_id : null;

  const txTrace = [];
  const rxTrace = [];

  const buildRuntime = () => ({
    enroll_channel: enrollChannel,
    enroll_session_id: enrollSessionId,
    enroll_reply_id: enrollReplyId,
    bg_channel: bgChannel,
    bg_session_id: bgSessionId,
    bg_reply_id: bgReplyId
  });

  const skipped = reason => ({
    phase_name: 'close_finalization',
    phase_status: 'skipped',
    phase_reason: reason,
    diagnostics: {
      ...diagnostics,
      v2_step4_finalize_skipped_reason: reason
    },
    state: {
      protocol_session_ref: Number.isInteger(enrollSessionId) && Number.isInteger(enrollReplyId)
        ? `${enrollSessionId}:${enrollReplyId}`
        : null,
      tx_trace: txTrace,
      rx_trace: rxTrace
    },
    runtime: buildRuntime()
  });

  if (step4Diagnostics.v2_step4_post_05dc_later_05dd_observed !== true) {
    return skipped('post_05dc_later_05dd_not_observed');
  }
  if (step4Diagnostics.v2_step4_post_05dc_trailing_07d0_observed !== true) {
    return skipped('post_05dc_trailing_07d0_not_observed');
  }
  if (!enrollChannel || typeof enrollChannel.send !== 'function' || typeof enrollChannel.receiveFrame !== 'function') {
    return skipped('missing_enroll_channel');
  }
  if (!Number.isInteger(enrollSessionId) || enrollSessionId <= 0) {
    return skipped('retained_enroll_session_unavailable');
  }
  if (!Number.isInteger(enrollReplyId)) {
    return skipped('next_reply_id_unavailable');
  }
  if (!sendTcpCommand || !nextReplyId) {
    return skipped('missing_finalize_prerequisites');
  }

  const command003e = Number.isInteger(COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY)
    ? COMMANDS.ZKTIME_ENROLL_PHASE_BOUNDARY
    : 0x003e;
  const command003c = Number.isInteger(COMMANDS.ZKTIME_STARTVERIFY)
    ? COMMANDS.ZKTIME_STARTVERIFY
    : 0x003c;
  const command07d0 = Number.isInteger(ACK.OK) ? ACK.OK : 0x07d0;

  diagnostics.v2_step4_finalize_attempted = true;

  try {
    const final003eReplyId = nextReplyId(enrollReplyId);
    diagnostics.v2_step4_finalize_003e_session_id_sent = enrollSessionId;
    diagnostics.v2_step4_finalize_003e_reply_id_sent = final003eReplyId;
    txTrace.push({
      stage: 'v2_step4_finalize_003e',
      command: command003e,
      command_hex: commandToHex(command003e),
      session_id: enrollSessionId,
      reply_id: final003eReplyId,
      payload_bytes: 0,
      payload_hex: ''
    });

    const final003eResult = await sendTcpCommand({
      channel: enrollChannel,
      timeoutMs,
      command: command003e,
      sessionId: enrollSessionId,
      replyId: final003eReplyId,
      payload: Buffer.alloc(0),
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed',
      deviceNumber
    });

    if (!final003eResult || !final003eResult.ok || !final003eResult.response) {
      return {
        phase_name: 'close_finalization',
        phase_status: 'failed',
        phase_reason: final003eResult && final003eResult.error
          ? String(final003eResult.error)
          : 'v2_step4_finalize_003e_send_failed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    diagnostics.v2_step4_finalize_003e_sent = true;
    diagnostics.v2_step4_finalize_003e_response_command_hex = commandToHex(final003eResult.response.command);
    diagnostics.v2_step4_finalize_003e_response_reply_id = Number.isInteger(final003eResult.response.reply_id)
      ? final003eResult.response.reply_id
      : null;
    diagnostics.v2_step4_finalize_003e_ack_observed =
      final003eResult.response.command === command07d0
      && final003eResult.response.reply_id === final003eReplyId;
    rxTrace.push({
      stage: 'v2_step4_finalize_003e',
      command: final003eResult.response.command,
      command_hex: commandToHex(final003eResult.response.command),
      session_id: Number.isInteger(final003eResult.response.session_id) ? final003eResult.response.session_id : null,
      reply_id: diagnostics.v2_step4_finalize_003e_response_reply_id,
      payload_bytes: Buffer.isBuffer(final003eResult.response.payload) ? final003eResult.response.payload.length : 0,
      payload_hex: Buffer.isBuffer(final003eResult.response.payload) ? final003eResult.response.payload.toString('hex') : ''
    });
    enrollSessionId = Number.isInteger(final003eResult.response.session_id) && final003eResult.response.session_id > 0
      ? final003eResult.response.session_id
      : enrollSessionId;
    enrollReplyId = final003eReplyId;

    if (diagnostics.v2_step4_finalize_003e_ack_observed !== true) {
      return {
        phase_name: 'close_finalization',
        phase_status: 'completed_finalize_003e_response_observed',
        phase_reason: 'v2_step4_finalize_003e_ack_not_observed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    const final003cReplyId = nextReplyId(enrollReplyId);
    diagnostics.v2_step4_finalize_003c_session_id_sent = enrollSessionId;
    diagnostics.v2_step4_finalize_003c_reply_id_sent = final003cReplyId;
    txTrace.push({
      stage: 'v2_step4_finalize_003c',
      command: command003c,
      command_hex: commandToHex(command003c),
      session_id: enrollSessionId,
      reply_id: final003cReplyId,
      payload_bytes: 0,
      payload_hex: ''
    });

    const final003cResult = await sendTcpCommand({
      channel: enrollChannel,
      timeoutMs,
      command: command003c,
      sessionId: enrollSessionId,
      replyId: final003cReplyId,
      payload: Buffer.alloc(0),
      noReplyError: FAILURE_REASON.ATTLOG_STAGE_FAILED || 'attlog_stage_failed',
      deviceNumber
    });

    if (!final003cResult || !final003cResult.ok || !final003cResult.response) {
      return {
        phase_name: 'close_finalization',
        phase_status: 'failed',
        phase_reason: final003cResult && final003cResult.error
          ? String(final003cResult.error)
          : 'v2_step4_finalize_003c_send_failed',
        diagnostics,
        state: {
          protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
          tx_trace: txTrace,
          rx_trace: rxTrace
        },
        runtime: buildRuntime()
      };
    }

    diagnostics.v2_step4_finalize_003c_sent = true;
    diagnostics.v2_step4_finalize_003c_response_command_hex = commandToHex(final003cResult.response.command);
    diagnostics.v2_step4_finalize_003c_response_reply_id = Number.isInteger(final003cResult.response.reply_id)
      ? final003cResult.response.reply_id
      : null;
    diagnostics.v2_step4_finalize_003c_ack_observed =
      final003cResult.response.command === command07d0
      && final003cResult.response.reply_id === final003cReplyId;
    diagnostics.v2_step4_finalize_completed =
      diagnostics.v2_step4_finalize_003e_ack_observed === true
      && diagnostics.v2_step4_finalize_003c_ack_observed === true;
    rxTrace.push({
      stage: 'v2_step4_finalize_003c',
      command: final003cResult.response.command,
      command_hex: commandToHex(final003cResult.response.command),
      session_id: Number.isInteger(final003cResult.response.session_id) ? final003cResult.response.session_id : null,
      reply_id: diagnostics.v2_step4_finalize_003c_response_reply_id,
      payload_bytes: Buffer.isBuffer(final003cResult.response.payload) ? final003cResult.response.payload.length : 0,
      payload_hex: Buffer.isBuffer(final003cResult.response.payload) ? final003cResult.response.payload.toString('hex') : ''
    });
    enrollSessionId = Number.isInteger(final003cResult.response.session_id) && final003cResult.response.session_id > 0
      ? final003cResult.response.session_id
      : enrollSessionId;
    enrollReplyId = final003cReplyId;

    return {
      phase_name: 'close_finalization',
      phase_status: diagnostics.v2_step4_finalize_completed === true
        ? 'completed_step4_enroll_lane_finalization'
        : 'completed_finalize_003c_response_observed',
      phase_reason: diagnostics.v2_step4_finalize_completed === true
        ? 'v2_step4_finalize_003e_003c_acks_observed'
        : 'v2_step4_finalize_003c_ack_not_observed',
      diagnostics,
      state: {
        protocol_session_ref: `${enrollSessionId}:${enrollReplyId}`,
        tx_trace: txTrace,
        rx_trace: rxTrace
      },
      runtime: buildRuntime()
    };
  } catch (err) {
    return {
      phase_name: 'close_finalization',
      phase_status: 'failed',
      phase_reason: mapSocketErrorCode(err),
      diagnostics,
      state: {
        protocol_session_ref: Number.isInteger(enrollSessionId) && Number.isInteger(enrollReplyId)
          ? `${enrollSessionId}:${enrollReplyId}`
          : null,
        tx_trace: txTrace,
        rx_trace: rxTrace
      },
      runtime: buildRuntime()
    };
  }
}

async function runK80EnrollmentAttemptV2(commandPayload = {}, options = {}) {
  const safePayload = isPlainObject(commandPayload) ? commandPayload : {};
  const safeOptions = isPlainObject(options) ? options : {};
  const runtimeProbe = isPlainObject(safeOptions.k80_v2_runtime_probe)
    ? safeOptions.k80_v2_runtime_probe
    : {};
  const runtime = {};
  const laneOwnershipState = buildV2LaneOwnershipState();

  let step1;
  let step2;
  let step3;
  let step4;
  let finalize;
  let retainLanesForContinuation = false;
  let step3Ready = false;
  let step4Ready = false;
  try {
    step1 = await runV2PhaseBackgroundBaseline({
      commandPayload: safePayload,
      options: safeOptions,
      keepLaneAlive: true
    });
    if (isPlainObject(step1.runtime)) {
      Object.assign(runtime, step1.runtime);
    }
    const safeStep1Diagnostics = isPlainObject(step1 && step1.diagnostics) ? step1.diagnostics : {};
    laneOwnershipState.background_lane.active = !!runtime.bg_channel;
    laneOwnershipState.background_lane.retained_for_continuation = !!runtime.bg_channel;
    laneOwnershipState.background_lane.session_id = Number.isInteger(safeStep1Diagnostics.v2_bg_session_id)
      ? safeStep1Diagnostics.v2_bg_session_id
      : null;
    laneOwnershipState.background_lane.last_reply_id = Number.isInteger(safeStep1Diagnostics.v2_bg_last_reply_id)
      ? safeStep1Diagnostics.v2_bg_last_reply_id
      : null;

    step2 = await runV2PhaseEnrollLaneBringUp({
      commandPayload: safePayload,
      options: safeOptions,
      runtime
    });
    if (isPlainObject(step2.runtime)) {
      Object.assign(runtime, step2.runtime);
    }
    const safeStep2Diagnostics = isPlainObject(step2 && step2.diagnostics) ? step2.diagnostics : {};
    retainLanesForContinuation = safeStep2Diagnostics.v2_step2_enroll_lane_retained_for_continuation === true;
    step3Ready = (
      safeStep2Diagnostics.v2_step2_enroll_lane_retained_for_continuation === true
      && safeStep2Diagnostics.v2_step2_bg_lane_retained_for_continuation === true
      && safeStep2Diagnostics.v2_step2_sequence_ok === true
    );
    laneOwnershipState.background_lane.active = !!runtime.bg_channel;
    laneOwnershipState.background_lane.retained_for_continuation =
      safeStep2Diagnostics.v2_step2_bg_lane_retained_for_continuation === true;
    laneOwnershipState.background_lane.session_id = Number.isInteger(runtime.bg_session_id)
      ? runtime.bg_session_id
      : laneOwnershipState.background_lane.session_id;
    laneOwnershipState.background_lane.last_reply_id = Number.isInteger(runtime.bg_reply_id)
      ? runtime.bg_reply_id
      : laneOwnershipState.background_lane.last_reply_id;
    laneOwnershipState.enroll_lane.active = !!runtime.enroll_channel;
    laneOwnershipState.enroll_lane.retained_for_continuation =
      safeStep2Diagnostics.v2_step2_enroll_lane_retained_for_continuation === true;
    laneOwnershipState.enroll_lane.session_id = Number.isInteger(runtime.enroll_session_id)
      ? runtime.enroll_session_id
      : null;
    laneOwnershipState.enroll_lane.last_reply_id = Number.isInteger(runtime.enroll_reply_id)
      ? runtime.enroll_reply_id
      : null;
    laneOwnershipState.enroll_lane.ff7f_reply_seed = Number.isInteger(safeStep2Diagnostics.v2_ff7f_reply_seed)
      ? safeStep2Diagnostics.v2_ff7f_reply_seed
      : null;
    laneOwnershipState.workflow_ready_for_step3_entry = step3Ready;
    laneOwnershipState.workflow_ready_for_step4_entry = false;
    laneOwnershipState.final_close_eligible = false;

    if (step3Ready) {
      step3 = await runV2PhasePromptBoundary({
        commandPayload: safePayload,
        options: safeOptions,
        runtime
      });
      if (isPlainObject(step3.runtime)) {
        Object.assign(runtime, step3.runtime);
      }
      const safeStep3Diagnostics = isPlainObject(step3 && step3.diagnostics) ? step3.diagnostics : {};
      retainLanesForContinuation = safeStep3Diagnostics.v2_step3_enroll_lane_retained_for_step4 === true;
      step4Ready = (
        safeStep3Diagnostics.v2_step3_enroll_lane_retained_for_step4 === true
        && safeStep3Diagnostics.v2_step3_boundary_entered === true
        && safeStep3Diagnostics.v2_step3_003e_ack_observed === true
        && safeStep3Diagnostics.v2_step3_003d_ack_observed === true
        && safeStep3Diagnostics.v2_step3_enroll_lane_session_continuity_ok === true
        && safeStep3Diagnostics.v2_step3_enroll_lane_reply_continuity_ok === true
        && safeStep3Diagnostics.v2_step3_background_lane_still_alive === true
      );
      laneOwnershipState.background_lane.active = !!runtime.bg_channel;
      laneOwnershipState.background_lane.retained_for_continuation =
        safeStep3Diagnostics.v2_step3_background_lane_still_alive === true;
      laneOwnershipState.background_lane.session_id = Number.isInteger(runtime.bg_session_id)
        ? runtime.bg_session_id
        : laneOwnershipState.background_lane.session_id;
      laneOwnershipState.background_lane.last_reply_id = Number.isInteger(runtime.bg_reply_id)
        ? runtime.bg_reply_id
        : laneOwnershipState.background_lane.last_reply_id;
      laneOwnershipState.enroll_lane.active = !!runtime.enroll_channel;
      laneOwnershipState.enroll_lane.retained_for_continuation =
        safeStep3Diagnostics.v2_step3_enroll_lane_retained_for_step4 === true;
      laneOwnershipState.enroll_lane.session_id = Number.isInteger(runtime.enroll_session_id)
        ? runtime.enroll_session_id
        : laneOwnershipState.enroll_lane.session_id;
      laneOwnershipState.enroll_lane.last_reply_id = Number.isInteger(runtime.enroll_reply_id)
        ? runtime.enroll_reply_id
        : laneOwnershipState.enroll_lane.last_reply_id;
      laneOwnershipState.workflow_ready_for_step4_entry = step4Ready;

      step4 = await runV2PhaseResultContinuation({
        commandPayload: safePayload,
        options: safeOptions,
        runtime,
        step3Diagnostics: safeStep3Diagnostics
      });
      if (isPlainObject(step4.runtime)) {
        Object.assign(runtime, step4.runtime);
      }
      const safeStep4Diagnostics = isPlainObject(step4 && step4.diagnostics) ? step4.diagnostics : {};
      laneOwnershipState.enroll_lane.active = !!runtime.enroll_channel;
      laneOwnershipState.enroll_lane.session_id = Number.isInteger(runtime.enroll_session_id)
        ? runtime.enroll_session_id
        : laneOwnershipState.enroll_lane.session_id;
      laneOwnershipState.enroll_lane.last_reply_id = Number.isInteger(runtime.enroll_reply_id)
        ? runtime.enroll_reply_id
        : laneOwnershipState.enroll_lane.last_reply_id;

      finalize = await runV2PhaseFinalize({
        commandPayload: safePayload,
        options: safeOptions,
        runtime,
        step4Diagnostics: safeStep4Diagnostics
      });
      if (isPlainObject(finalize.runtime)) {
        Object.assign(runtime, finalize.runtime);
      }
      laneOwnershipState.enroll_lane.active = !!runtime.enroll_channel;
      laneOwnershipState.enroll_lane.session_id = Number.isInteger(runtime.enroll_session_id)
        ? runtime.enroll_session_id
        : laneOwnershipState.enroll_lane.session_id;
      laneOwnershipState.enroll_lane.last_reply_id = Number.isInteger(runtime.enroll_reply_id)
        ? runtime.enroll_reply_id
        : laneOwnershipState.enroll_lane.last_reply_id;
    } else {
      retainLanesForContinuation = false;
      step4Ready = false;
      laneOwnershipState.workflow_ready_for_step4_entry = false;
    }
  } finally {
    if (!retainLanesForContinuation) {
      laneOwnershipState.final_close_eligible = true;
      if (runtime.enroll_channel && typeof runtime.enroll_channel.close === 'function') {
        runtime.enroll_channel.close();
      }
      if (runtime.bg_channel && typeof runtime.bg_channel.close === 'function') {
        runtime.bg_channel.close();
      }
      laneOwnershipState.background_lane.active = false;
      laneOwnershipState.background_lane.retained_for_continuation = false;
      laneOwnershipState.enroll_lane.active = false;
      laneOwnershipState.enroll_lane.retained_for_continuation = false;
    }
  }

  const safeStep1 = isPlainObject(step1) ? step1 : buildPhasePlaceholder('background_baseline_coexistence');
  const safeStep2 = isPlainObject(step2) ? step2 : buildPhasePlaceholder('registration_enroll_lane_bring_up');
  const safeStep3 = isPlainObject(step3) ? step3 : buildPhasePlaceholder('prompt_boundary_entry');
  const safeStep4 = isPlainObject(step4) ? step4 : buildPhasePlaceholder('result_continuation');
  const safeFinalize = isPlainObject(finalize) ? finalize : buildPhasePlaceholder('close_finalization');
  const phaseResults = [
    clonePhaseForMetadata(safeStep1),
    clonePhaseForMetadata(safeStep2),
    clonePhaseForMetadata(safeStep3),
    clonePhaseForMetadata(safeStep4),
    clonePhaseForMetadata(safeFinalize)
  ];
  const step1Diagnostics = isPlainObject(safeStep1.diagnostics) ? safeStep1.diagnostics : {};
  const step2Diagnostics = isPlainObject(safeStep2.diagnostics) ? safeStep2.diagnostics : {};
  const step3Diagnostics = isPlainObject(safeStep3.diagnostics) ? safeStep3.diagnostics : {};
  const step4Diagnostics = isPlainObject(safeStep4.diagnostics) ? safeStep4.diagnostics : {};
  const finalizeDiagnostics = isPlainObject(safeFinalize.diagnostics) ? safeFinalize.diagnostics : {};
  const step2State = isPlainObject(safeStep2.state) ? safeStep2.state : {};
  const step3State = isPlainObject(safeStep3.state) ? safeStep3.state : {};
  const finalizeState = isPlainObject(safeFinalize.state) ? safeFinalize.state : {};
  const v2WorkflowReadyForStep3 = step3Ready === true;
  const v2WorkflowReadyForStep4 = step4Ready === true;

  return {
    ok: false,
    attempt_status: 'partial_or_failed',
    status_reason: 'k80_enrollment_v2_step3_only',
    protocol_execution_state: (
      v2WorkflowReadyForStep4
        ? 'v2_step3_completed_ready_for_step4'
        : normalizeText(safeStep3.phase_status) === 'completed_step3_prompt_boundary_ready'
          ? 'v2_step3_completed'
          : v2WorkflowReadyForStep3
            ? 'v2_step3_partial'
            : normalizeText(safeStep2.phase_status) === 'completed_step2_enroll_lane_ready'
              ? 'v2_step2_completed'
              : 'v2_step2_partial'
    ),
    protocol_session_ref: typeof step3State.protocol_session_ref === 'string'
      ? step3State.protocol_session_ref
      : (typeof step2State.protocol_session_ref === 'string' ? step2State.protocol_session_ref : null),
    evidence_flags: {
      saw_003e: step3Diagnostics.v2_step3_003e_sent === true,
      saw_003d: step3Diagnostics.v2_step3_003d_sent === true,
      saw_01f4_progress: false,
      saw_05df: step4Diagnostics.v2_step4_05df_sent === true,
      saw_05dd_after_05df: step4Diagnostics.v2_step4_05df_05dd_observed === true,
      saw_0058_continue_tx: step4Diagnostics.v2_step4_0058_sent === true,
      saw_05dc_after_0058: step4Diagnostics.v2_step4_0058_05dc_observed === true,
      saw_second_05dd_after_05dc: step4Diagnostics.v2_step4_post_05dc_later_05dd_observed === true,
      saw_final_003e_ack: finalizeDiagnostics.v2_step4_finalize_003e_ack_observed === true,
      saw_final_003c_ack: finalizeDiagnostics.v2_step4_finalize_003c_ack_observed === true,
      saw_enroll_lane_finalization_complete: finalizeDiagnostics.v2_step4_finalize_completed === true
    },
    evidence_refs: {
      marker_sequence: [],
      raw_frames: [
        ...(Array.isArray(step2State.rx_trace) ? step2State.rx_trace : []),
        ...(Array.isArray(step3State.rx_trace) ? step3State.rx_trace : []),
        ...(Array.isArray(safeStep4.state && safeStep4.state.rx_trace) ? safeStep4.state.rx_trace : []),
        ...(Array.isArray(finalizeState.rx_trace) ? finalizeState.rx_trace : [])
      ]
    },
    source_metadata: {
      conservative_evidence_classification: true,
      k80_enrollment_v2_scaffold_enabled: true,
      k80_enrollment_v2_mode: 'k80_enrollment_ladder_v2_step1_step2_step3_step4_05df_0058_only',
      k80_enrollment_v2_phases: phaseResults,
      v2_stage5_handler_payload_plain: runtimeProbe.v2_stage5_handler_payload_plain === true,
      v2_stage5_handler_enrollment_exists: runtimeProbe.v2_stage5_handler_enrollment_exists === true,
      v2_stage5_handler_enrollment_plain: runtimeProbe.v2_stage5_handler_enrollment_plain === true,
      v2_stage5_handler_device_user_id_type: metadataTypeOrUndefined(runtimeProbe.v2_stage5_handler_device_user_id_type),
      v2_stage5_handler_device_user_id_value: compactValueOrNull(runtimeProbe.v2_stage5_handler_device_user_id_value),
      v2_stage5_handler_selected_finger_type: metadataTypeOrUndefined(runtimeProbe.v2_stage5_handler_selected_finger_type),
      v2_stage5_handler_selected_finger_value: compactValueOrNull(runtimeProbe.v2_stage5_handler_selected_finger_value),
      v2_stage5_pre_exec_payload_plain: runtimeProbe.v2_stage5_pre_exec_payload_plain === true,
      v2_stage5_pre_exec_enrollment_exists: runtimeProbe.v2_stage5_pre_exec_enrollment_exists === true,
      v2_stage5_pre_exec_enrollment_plain: runtimeProbe.v2_stage5_pre_exec_enrollment_plain === true,
      v2_stage5_pre_exec_device_user_id_type: metadataTypeOrUndefined(runtimeProbe.v2_stage5_pre_exec_device_user_id_type),
      v2_stage5_pre_exec_device_user_id_value: compactValueOrNull(runtimeProbe.v2_stage5_pre_exec_device_user_id_value),
      v2_stage5_pre_exec_selected_finger_type: metadataTypeOrUndefined(runtimeProbe.v2_stage5_pre_exec_selected_finger_type),
      v2_stage5_pre_exec_selected_finger_value: compactValueOrNull(runtimeProbe.v2_stage5_pre_exec_selected_finger_value),
      v2_stage6_dispatch_payload_plain: runtimeProbe.v2_stage6_dispatch_payload_plain === true,
      v2_stage6_dispatch_enrollment_exists: runtimeProbe.v2_stage6_dispatch_enrollment_exists === true,
      v2_stage6_dispatch_enrollment_plain: runtimeProbe.v2_stage6_dispatch_enrollment_plain === true,
      v2_stage6_dispatch_device_user_id_type: metadataTypeOrUndefined(runtimeProbe.v2_stage6_dispatch_device_user_id_type),
      v2_stage6_dispatch_device_user_id_value: compactValueOrNull(runtimeProbe.v2_stage6_dispatch_device_user_id_value),
      v2_stage6_dispatch_selected_finger_type: metadataTypeOrUndefined(runtimeProbe.v2_stage6_dispatch_selected_finger_type),
      v2_stage6_dispatch_selected_finger_value: compactValueOrNull(runtimeProbe.v2_stage6_dispatch_selected_finger_value),
      v2_stage7_entry_payload_plain: step3Diagnostics.v2_stage7_entry_payload_plain === true,
      v2_stage7_entry_enrollment_exists: step3Diagnostics.v2_stage7_entry_enrollment_exists === true,
      v2_stage7_entry_enrollment_plain: step3Diagnostics.v2_stage7_entry_enrollment_plain === true,
      v2_stage7_entry_device_user_id_type: metadataTypeOrUndefined(step3Diagnostics.v2_stage7_entry_device_user_id_type),
      v2_stage7_entry_device_user_id_value: compactValueOrNull(step3Diagnostics.v2_stage7_entry_device_user_id_value),
      v2_stage7_entry_selected_finger_type: metadataTypeOrUndefined(step3Diagnostics.v2_stage7_entry_selected_finger_type),
      v2_stage7_entry_selected_finger_value: compactValueOrNull(step3Diagnostics.v2_stage7_entry_selected_finger_value),
      v2_stage7_safePayload_payload_plain: step3Diagnostics.v2_stage7_safePayload_payload_plain === true,
      v2_stage7_safePayload_enrollment_exists: step3Diagnostics.v2_stage7_safePayload_enrollment_exists === true,
      v2_stage7_safePayload_enrollment_plain: step3Diagnostics.v2_stage7_safePayload_enrollment_plain === true,
      v2_stage7_safePayload_device_user_id_type: metadataTypeOrUndefined(step3Diagnostics.v2_stage7_safePayload_device_user_id_type),
      v2_stage7_safePayload_device_user_id_value: compactValueOrNull(step3Diagnostics.v2_stage7_safePayload_device_user_id_value),
      v2_stage7_safePayload_selected_finger_type: metadataTypeOrUndefined(step3Diagnostics.v2_stage7_safePayload_selected_finger_type),
      v2_stage7_safePayload_selected_finger_value: compactValueOrNull(step3Diagnostics.v2_stage7_safePayload_selected_finger_value),
      v2_stage7_safeEnrollment_plain: step3Diagnostics.v2_stage7_safeEnrollment_plain === true,
      v2_stage7_safeEnrollment_device_user_id_type: metadataTypeOrUndefined(step3Diagnostics.v2_stage7_safeEnrollment_device_user_id_type),
      v2_stage7_safeEnrollment_device_user_id_value: compactValueOrNull(step3Diagnostics.v2_stage7_safeEnrollment_device_user_id_value),
      v2_stage7_safeEnrollment_selected_finger_type: metadataTypeOrUndefined(step3Diagnostics.v2_stage7_safeEnrollment_selected_finger_type),
      v2_stage7_safeEnrollment_selected_finger_value: compactValueOrNull(step3Diagnostics.v2_stage7_safeEnrollment_selected_finger_value),
      v2_stage7_pre_resolver_device_user_id_type: metadataTypeOrUndefined(step3Diagnostics.v2_stage7_pre_resolver_device_user_id_type),
      v2_stage7_pre_resolver_device_user_id_value: compactValueOrNull(step3Diagnostics.v2_stage7_pre_resolver_device_user_id_value),
      v2_bg_lane_present: step1Diagnostics.v2_bg_lane_present === true,
      v2_bg_session_id: Number.isInteger(step1Diagnostics.v2_bg_session_id)
        ? step1Diagnostics.v2_bg_session_id
        : null,
      v2_bg_last_reply_id: Number.isInteger(step1Diagnostics.v2_bg_last_reply_id)
        ? step1Diagnostics.v2_bg_last_reply_id
        : null,
      v2_bg_keepalive_ok: step1Diagnostics.v2_bg_keepalive_ok === true,
      v2_step1_connect_seen: step1Diagnostics.v2_step1_connect_seen === true,
      v2_step1_auth_seen: step1Diagnostics.v2_step1_auth_seen === true,
      v2_step1_reply_progression_ok: step1Diagnostics.v2_step1_reply_progression_ok === true,
      v2_step1_session_stable: step1Diagnostics.v2_step1_session_stable === true,
      v2_enroll_lane_created: step2Diagnostics.v2_enroll_lane_created === true,
      v2_enroll_session_id: Number.isInteger(step2Diagnostics.v2_enroll_session_id)
        ? step2Diagnostics.v2_enroll_session_id
        : null,
      v2_step2_sequence_ok: step2Diagnostics.v2_step2_sequence_ok === true,
      v2_ff7f_reply_seed: Number.isInteger(step2Diagnostics.v2_ff7f_reply_seed)
        ? step2Diagnostics.v2_ff7f_reply_seed
        : null,
      v2_step2_bg_lane_still_alive: step2Diagnostics.v2_step2_bg_lane_still_alive === true,
      v2_step2_last_command_sent: normalizeText(step2Diagnostics.v2_step2_last_command_sent) || null,
      v2_step2_reply_progression_ok: step2Diagnostics.v2_step2_reply_progression_ok === true,
      v2_step2_session_stable: step2Diagnostics.v2_step2_session_stable === true,
      v2_step2_tail_000b_count_sent: Number.isInteger(step2Diagnostics.v2_step2_tail_000b_count_sent)
        ? step2Diagnostics.v2_step2_tail_000b_count_sent
        : 0,
      v2_step2_tail_ffff_sent: step2Diagnostics.v2_step2_tail_ffff_sent === true,
      v2_step2_tail_ff7f_sent: step2Diagnostics.v2_step2_tail_ff7f_sent === true,
      v2_step2_bg_lane_alive_after_tail: step2Diagnostics.v2_step2_bg_lane_alive_after_tail === true,
      v2_step2_post_2710_family_observed: Array.isArray(step2Diagnostics.v2_step2_post_2710_family_observed)
        ? step2Diagnostics.v2_step2_post_2710_family_observed
        : [],
      v2_step2_post_2710_closure_ok: step2Diagnostics.v2_step2_post_2710_closure_ok === true,
      v2_step2_early_termination_before_tail: step2Diagnostics.v2_step2_early_termination_before_tail === true,
      v2_step2_enroll_lane_retained_for_continuation: step2Diagnostics.v2_step2_enroll_lane_retained_for_continuation === true,
      v2_step2_bg_lane_retained_for_continuation: step2Diagnostics.v2_step2_bg_lane_retained_for_continuation === true,
      v2_step2_client_teardown_sent_at_step2_completion: step2Diagnostics.v2_step2_client_teardown_sent_at_step2_completion === true,
      v2_step2_late_tail_session_continuity_ok: step2Diagnostics.v2_step2_late_tail_session_continuity_ok === true,
      v2_step2_late_tail_reply_continuity_ok: step2Diagnostics.v2_step2_late_tail_reply_continuity_ok === true,
      v2_step2_bg_interleave_sent_count: Number.isInteger(step2Diagnostics.v2_step2_bg_interleave_sent_count)
        ? step2Diagnostics.v2_step2_bg_interleave_sent_count
        : 0,
      v2_step2_bg_interleave_during_window: step2Diagnostics.v2_step2_bg_interleave_during_window === true,
      v2_step2_bg_interleave_last_reply_id: Number.isInteger(step2Diagnostics.v2_step2_bg_interleave_last_reply_id)
        ? step2Diagnostics.v2_step2_bg_interleave_last_reply_id
        : null,
      v2_step2_bg_interleave_session_continuity_ok: step2Diagnostics.v2_step2_bg_interleave_session_continuity_ok === true,
      v2_step2_bg_interleave_reply_continuity_ok: step2Diagnostics.v2_step2_bg_interleave_reply_continuity_ok === true,
      v2_step3_boundary_entered: step3Diagnostics.v2_step3_boundary_entered === true,
      v2_step3_enroll_lane_session_id: Number.isInteger(step3Diagnostics.v2_step3_enroll_lane_session_id)
        ? step3Diagnostics.v2_step3_enroll_lane_session_id
        : null,
      v2_step3_003e_sent: step3Diagnostics.v2_step3_003e_sent === true,
      v2_step3_003e_ack_observed: step3Diagnostics.v2_step3_003e_ack_observed === true,
      v2_step3_003e_reply_id_sent: Number.isInteger(step3Diagnostics.v2_step3_003e_reply_id_sent)
        ? step3Diagnostics.v2_step3_003e_reply_id_sent
        : null,
      v2_step3_003e_ack_reply_id_observed: Number.isInteger(step3Diagnostics.v2_step3_003e_ack_reply_id_observed)
        ? step3Diagnostics.v2_step3_003e_ack_reply_id_observed
        : null,
      v2_step3_003d_sent: step3Diagnostics.v2_step3_003d_sent === true,
      v2_step3_003d_ack_observed: step3Diagnostics.v2_step3_003d_ack_observed === true,
      v2_step3_003d_reply_id_sent: Number.isInteger(step3Diagnostics.v2_step3_003d_reply_id_sent)
        ? step3Diagnostics.v2_step3_003d_reply_id_sent
        : null,
      v2_step3_003d_ack_reply_id_observed: Number.isInteger(step3Diagnostics.v2_step3_003d_ack_reply_id_observed)
        ? step3Diagnostics.v2_step3_003d_ack_reply_id_observed
        : null,
      v2_step3_stale_ack_drain_count_before_003e: Number.isInteger(step3Diagnostics.v2_step3_stale_ack_drain_count_before_003e)
        ? step3Diagnostics.v2_step3_stale_ack_drain_count_before_003e
        : 0,
      v2_step3_003e_ack_match_exact: step3Diagnostics.v2_step3_003e_ack_match_exact === true,
      v2_step3_003d_ack_match_exact: step3Diagnostics.v2_step3_003d_ack_match_exact === true,
      v2_step3_ignored_stale_ack_reply_ids: Array.isArray(step3Diagnostics.v2_step3_ignored_stale_ack_reply_ids)
        ? step3Diagnostics.v2_step3_ignored_stale_ack_reply_ids
        : [],
      v2_step3_ack_match_timeout: step3Diagnostics.v2_step3_ack_match_timeout === true,
      v2_step3_003d_input_device_user_id: Number.isInteger(step3Diagnostics.v2_step3_003d_input_device_user_id)
        ? step3Diagnostics.v2_step3_003d_input_device_user_id
        : null,
      v2_step3_003d_input_device_user_id_source: typeof step3Diagnostics.v2_step3_003d_input_device_user_id_source === 'string'
        ? step3Diagnostics.v2_step3_003d_input_device_user_id_source
        : null,
      v2_step3_003d_input_selected_finger: typeof step3Diagnostics.v2_step3_003d_input_selected_finger === 'string'
        ? step3Diagnostics.v2_step3_003d_input_selected_finger
        : null,
      v2_step3_003d_user_id_encoding: typeof step3Diagnostics.v2_step3_003d_user_id_encoding === 'string'
        ? step3Diagnostics.v2_step3_003d_user_id_encoding
        : null,
      v2_step3_003d_user_id_ascii: typeof step3Diagnostics.v2_step3_003d_user_id_ascii === 'string'
        ? step3Diagnostics.v2_step3_003d_user_id_ascii
        : null,
      v2_step3_003d_payload_field_00_03_hex: typeof step3Diagnostics.v2_step3_003d_payload_field_00_03_hex === 'string'
        ? step3Diagnostics.v2_step3_003d_payload_field_00_03_hex
        : null,
      v2_step3_003d_payload_field_24_hex: typeof step3Diagnostics.v2_step3_003d_payload_field_24_hex === 'string'
        ? step3Diagnostics.v2_step3_003d_payload_field_24_hex
        : null,
      v2_step3_003d_payload_field_25_hex: typeof step3Diagnostics.v2_step3_003d_payload_field_25_hex === 'string'
        ? step3Diagnostics.v2_step3_003d_payload_field_25_hex
        : null,
      v2_step3_003d_payload_hex: typeof step3Diagnostics.v2_step3_003d_payload_hex === 'string'
        ? step3Diagnostics.v2_step3_003d_payload_hex
        : null,
      v2_step3_003d_send_attempted: step3Diagnostics.v2_step3_003d_send_attempted === true,
      v2_step3_003d_send_skipped: step3Diagnostics.v2_step3_003d_send_skipped === true,
      v2_step3_003d_skip_reason: typeof step3Diagnostics.v2_step3_003d_skip_reason === 'string'
        ? step3Diagnostics.v2_step3_003d_skip_reason
        : null,
      v2_step3_003d_guard_device_user_id_missing:
        step3Diagnostics.v2_step3_003d_guard_device_user_id_missing === true,
      v2_step3_003d_guard_device_user_id_invalid:
        step3Diagnostics.v2_step3_003d_guard_device_user_id_invalid === true,
      v2_step3_003d_guard_device_user_id_device_state_conflict:
        step3Diagnostics.v2_step3_003d_guard_device_user_id_device_state_conflict === true,
      v2_step3_003d_guard_source_of_truth_failed:
        step3Diagnostics.v2_step3_003d_guard_source_of_truth_failed === true,
      v2_step3_003d_guard_final_field_mismatch:
        step3Diagnostics.v2_step3_003d_guard_final_field_mismatch === true,
      v2_step3_003d_guard_unknown:
        step3Diagnostics.v2_step3_003d_guard_unknown === true,
      v2_step3_003d_device_user_id_device_state_conflict:
        step3Diagnostics.v2_step3_003d_device_user_id_device_state_conflict === true,
      v2_step3_003d_device_state_conflict_warning_only:
        step3Diagnostics.v2_step3_003d_device_state_conflict_warning_only === true,
      v2_step3_003d_derivation_blocked_reason:
        typeof step3Diagnostics.v2_step3_003d_derivation_blocked_reason === 'string'
          ? step3Diagnostics.v2_step3_003d_derivation_blocked_reason
          : null,
      v2_step3_settle_delay_before_003d_ms: Number.isInteger(step3Diagnostics.v2_step3_settle_delay_before_003d_ms)
        ? step3Diagnostics.v2_step3_settle_delay_before_003d_ms
        : 0,
      v2_step3_settle_delay_applied: step3Diagnostics.v2_step3_settle_delay_applied === true,
      v2_step3_003d_response_command_hex: typeof step3Diagnostics.v2_step3_003d_response_command_hex === 'string'
        ? step3Diagnostics.v2_step3_003d_response_command_hex
        : null,
      v2_step3_003d_response_reply_id: Number.isInteger(step3Diagnostics.v2_step3_003d_response_reply_id)
        ? step3Diagnostics.v2_step3_003d_response_reply_id
        : null,
      v2_step3_003d_device_rejected: step3Diagnostics.v2_step3_003d_device_rejected === true,
      v2_step4_progress_ack_window_entered: step3Diagnostics.v2_step4_progress_ack_window_entered === true,
      v2_step4_progress_ack_count: Number.isInteger(step3Diagnostics.v2_step4_progress_ack_count)
        ? step3Diagnostics.v2_step4_progress_ack_count
        : 0,
      v2_step4_progress_ack_last_reply_id: Number.isInteger(step3Diagnostics.v2_step4_progress_ack_last_reply_id)
        ? step3Diagnostics.v2_step4_progress_ack_last_reply_id
        : null,
      v2_step4_progress_ack_last_payload_len: Number.isInteger(step3Diagnostics.v2_step4_progress_ack_last_payload_len)
        ? step3Diagnostics.v2_step4_progress_ack_last_payload_len
        : null,
      v2_step4_progress_ack_structured_seen: step3Diagnostics.v2_step4_progress_ack_structured_seen === true,
      v2_step4_progress_ack_timeout: step3Diagnostics.v2_step4_progress_ack_timeout === true,
      v2_step4_progress_ack_loop_exit_reason: typeof step3Diagnostics.v2_step4_progress_ack_loop_exit_reason === 'string'
        ? step3Diagnostics.v2_step4_progress_ack_loop_exit_reason
        : null,
      v2_step4_progress_ack_sent_before_05df: step3Diagnostics.v2_step4_progress_ack_sent_before_05df === true,
      v2_step4_progress_ack_session_id_used: Number.isInteger(step3Diagnostics.v2_step4_progress_ack_session_id_used)
        ? step3Diagnostics.v2_step4_progress_ack_session_id_used
        : null,
      v2_step4_progress_ack_used_retained_enroll_session:
        step3Diagnostics.v2_step4_progress_ack_used_retained_enroll_session === true,
      v2_step4_progress_ack_event_session_id_last_seen:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_event_session_id_last_seen)
          ? step3Diagnostics.v2_step4_progress_ack_event_session_id_last_seen
          : null,
      v2_step4_progress_ack_loop_iterations:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_loop_iterations)
          ? step3Diagnostics.v2_step4_progress_ack_loop_iterations
          : 0,
      v2_step4_progress_ack_receive_timeout_count:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_receive_timeout_count)
          ? step3Diagnostics.v2_step4_progress_ack_receive_timeout_count
          : 0,
      v2_step4_progress_ack_receive_frame_count:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_receive_frame_count)
          ? step3Diagnostics.v2_step4_progress_ack_receive_frame_count
          : 0,
      v2_step4_progress_ack_parse_ok_count:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_parse_ok_count)
          ? step3Diagnostics.v2_step4_progress_ack_parse_ok_count
          : 0,
      v2_step4_progress_ack_parse_fail_count:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_parse_fail_count)
          ? step3Diagnostics.v2_step4_progress_ack_parse_fail_count
          : 0,
      v2_step4_progress_ack_last_raw_len:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_last_raw_len)
          ? step3Diagnostics.v2_step4_progress_ack_last_raw_len
          : null,
      v2_step4_progress_ack_last_parsed_command_hex:
        typeof step3Diagnostics.v2_step4_progress_ack_last_parsed_command_hex === 'string'
          ? step3Diagnostics.v2_step4_progress_ack_last_parsed_command_hex
          : null,
      v2_step4_progress_ack_last_parsed_session_id:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_last_parsed_session_id)
          ? step3Diagnostics.v2_step4_progress_ack_last_parsed_session_id
          : null,
      v2_step4_progress_ack_last_parsed_reply_id:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_last_parsed_reply_id)
          ? step3Diagnostics.v2_step4_progress_ack_last_parsed_reply_id
          : null,
      v2_step4_progress_ack_last_parse_error:
        typeof step3Diagnostics.v2_step4_progress_ack_last_parse_error === 'string'
          ? step3Diagnostics.v2_step4_progress_ack_last_parse_error
          : null,
      v2_step4_progress_ack_non_01f4_frame_count:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_non_01f4_frame_count)
          ? step3Diagnostics.v2_step4_progress_ack_non_01f4_frame_count
          : 0,
      v2_step4_progress_ack_01f4_match_count:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_01f4_match_count)
          ? step3Diagnostics.v2_step4_progress_ack_01f4_match_count
          : 0,
      v2_step4_progress_ack_branch_entered:
        step3Diagnostics.v2_step4_progress_ack_branch_entered === true,
      v2_step4_progress_ack_structured_ack_count:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_structured_ack_count)
          ? step3Diagnostics.v2_step4_progress_ack_structured_ack_count
          : 0,
      v2_step4_progress_ack_terminal_structured_seen:
        step3Diagnostics.v2_step4_progress_ack_terminal_structured_seen === true,
      v2_step4_progress_ack_terminal_structured_ack_count:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_terminal_structured_ack_count)
          ? step3Diagnostics.v2_step4_progress_ack_terminal_structured_ack_count
          : 0,
      v2_step4_progress_ack_terminal_structured_payload_len:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_terminal_structured_payload_len)
          ? step3Diagnostics.v2_step4_progress_ack_terminal_structured_payload_len
          : null,
      v2_step4_progress_ack_terminal_structured_session_id:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_terminal_structured_session_id)
          ? step3Diagnostics.v2_step4_progress_ack_terminal_structured_session_id
          : null,
      v2_step4_progress_ack_total_budget_ms:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_total_budget_ms)
          ? step3Diagnostics.v2_step4_progress_ack_total_budget_ms
          : null,
      v2_step4_progress_ack_first_01f4_elapsed_ms:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_first_01f4_elapsed_ms)
          ? step3Diagnostics.v2_step4_progress_ack_first_01f4_elapsed_ms
          : null,
      v2_step4_progress_ack_terminal_structured_elapsed_ms:
        Number.isInteger(step3Diagnostics.v2_step4_progress_ack_terminal_structured_elapsed_ms)
          ? step3Diagnostics.v2_step4_progress_ack_terminal_structured_elapsed_ms
          : null,
      v2_step4_progress_ack_continuation_ready_after_structured:
        step3Diagnostics.v2_step4_progress_ack_continuation_ready_after_structured === true,
      v2_step4_05df_attempted: step4Diagnostics.v2_step4_05df_attempted === true,
      v2_step4_05df_sent: step4Diagnostics.v2_step4_05df_sent === true,
      v2_step4_05df_payload_hex: typeof step4Diagnostics.v2_step4_05df_payload_hex === 'string'
        ? step4Diagnostics.v2_step4_05df_payload_hex
        : null,
      v2_step4_05df_session_id_sent: Number.isInteger(step4Diagnostics.v2_step4_05df_session_id_sent)
        ? step4Diagnostics.v2_step4_05df_session_id_sent
        : null,
      v2_step4_05df_reply_id_sent: Number.isInteger(step4Diagnostics.v2_step4_05df_reply_id_sent)
        ? step4Diagnostics.v2_step4_05df_reply_id_sent
        : null,
      v2_step4_05df_response_command_hex: typeof step4Diagnostics.v2_step4_05df_response_command_hex === 'string'
        ? step4Diagnostics.v2_step4_05df_response_command_hex
        : null,
      v2_step4_05df_response_reply_id: Number.isInteger(step4Diagnostics.v2_step4_05df_response_reply_id)
        ? step4Diagnostics.v2_step4_05df_response_reply_id
        : null,
      v2_step4_05df_05dd_observed: step4Diagnostics.v2_step4_05df_05dd_observed === true,
      v2_step4_05df_skipped_reason: typeof step4Diagnostics.v2_step4_05df_skipped_reason === 'string'
        ? step4Diagnostics.v2_step4_05df_skipped_reason
        : null,
      v2_step4_0058_attempted: step4Diagnostics.v2_step4_0058_attempted === true,
      v2_step4_0058_sent: step4Diagnostics.v2_step4_0058_sent === true,
      v2_step4_0058_payload_hex: typeof step4Diagnostics.v2_step4_0058_payload_hex === 'string'
        ? step4Diagnostics.v2_step4_0058_payload_hex
        : null,
      v2_step4_0058_payload_source_word0:
        Number.isInteger(step4Diagnostics.v2_step4_0058_payload_source_word0)
          ? step4Diagnostics.v2_step4_0058_payload_source_word0
          : null,
      v2_step4_0058_payload_derived_count:
        Number.isInteger(step4Diagnostics.v2_step4_0058_payload_derived_count)
          ? step4Diagnostics.v2_step4_0058_payload_derived_count
          : null,
      v2_step4_0058_selected_finger_byte:
        Number.isInteger(step4Diagnostics.v2_step4_0058_selected_finger_byte)
          ? step4Diagnostics.v2_step4_0058_selected_finger_byte
          : null,
      v2_step4_0058_payload_rule:
        typeof step4Diagnostics.v2_step4_0058_payload_rule === 'string'
          ? step4Diagnostics.v2_step4_0058_payload_rule
          : null,
      v2_step4_0058_session_id_sent: Number.isInteger(step4Diagnostics.v2_step4_0058_session_id_sent)
        ? step4Diagnostics.v2_step4_0058_session_id_sent
        : null,
      v2_step4_0058_reply_id_sent: Number.isInteger(step4Diagnostics.v2_step4_0058_reply_id_sent)
        ? step4Diagnostics.v2_step4_0058_reply_id_sent
        : null,
      v2_step4_0058_response_command_hex:
        typeof step4Diagnostics.v2_step4_0058_response_command_hex === 'string'
          ? step4Diagnostics.v2_step4_0058_response_command_hex
          : null,
      v2_step4_0058_response_reply_id:
        Number.isInteger(step4Diagnostics.v2_step4_0058_response_reply_id)
          ? step4Diagnostics.v2_step4_0058_response_reply_id
          : null,
      v2_step4_0058_05dc_observed: step4Diagnostics.v2_step4_0058_05dc_observed === true,
      v2_step4_0058_skipped_reason: typeof step4Diagnostics.v2_step4_0058_skipped_reason === 'string'
        ? step4Diagnostics.v2_step4_0058_skipped_reason
        : null,
      v2_step4_post_05dc_drain_entered:
        step4Diagnostics.v2_step4_post_05dc_drain_entered === true,
      v2_step4_post_05dc_later_05dd_observed:
        step4Diagnostics.v2_step4_post_05dc_later_05dd_observed === true,
      v2_step4_post_05dc_later_05dd_reply_id:
        Number.isInteger(step4Diagnostics.v2_step4_post_05dc_later_05dd_reply_id)
          ? step4Diagnostics.v2_step4_post_05dc_later_05dd_reply_id
          : null,
      v2_step4_post_05dc_later_05dd_payload_len:
        Number.isInteger(step4Diagnostics.v2_step4_post_05dc_later_05dd_payload_len)
          ? step4Diagnostics.v2_step4_post_05dc_later_05dd_payload_len
          : null,
      v2_step4_post_05dc_trailing_07d0_observed:
        step4Diagnostics.v2_step4_post_05dc_trailing_07d0_observed === true,
      v2_step4_post_05dc_trailing_07d0_reply_id:
        Number.isInteger(step4Diagnostics.v2_step4_post_05dc_trailing_07d0_reply_id)
          ? step4Diagnostics.v2_step4_post_05dc_trailing_07d0_reply_id
          : null,
      v2_step4_post_05dc_loop_exit_reason:
        typeof step4Diagnostics.v2_step4_post_05dc_loop_exit_reason === 'string'
          ? step4Diagnostics.v2_step4_post_05dc_loop_exit_reason
          : null,
      v2_step4_post_05dc_drain_timeout_ms:
        Number.isInteger(step4Diagnostics.v2_step4_post_05dc_drain_timeout_ms)
          ? step4Diagnostics.v2_step4_post_05dc_drain_timeout_ms
          : null,
      v2_step4_post_05dc_later_05dd_elapsed_ms:
        Number.isInteger(step4Diagnostics.v2_step4_post_05dc_later_05dd_elapsed_ms)
          ? step4Diagnostics.v2_step4_post_05dc_later_05dd_elapsed_ms
          : null,
      v2_step4_post_05dc_trailing_07d0_elapsed_ms:
        Number.isInteger(step4Diagnostics.v2_step4_post_05dc_trailing_07d0_elapsed_ms)
          ? step4Diagnostics.v2_step4_post_05dc_trailing_07d0_elapsed_ms
          : null,
      v2_step4_finalize_attempted: finalizeDiagnostics.v2_step4_finalize_attempted === true,
      v2_step4_finalize_skipped_reason:
        typeof finalizeDiagnostics.v2_step4_finalize_skipped_reason === 'string'
          ? finalizeDiagnostics.v2_step4_finalize_skipped_reason
          : null,
      v2_step4_finalize_003e_sent: finalizeDiagnostics.v2_step4_finalize_003e_sent === true,
      v2_step4_finalize_003e_session_id_sent:
        Number.isInteger(finalizeDiagnostics.v2_step4_finalize_003e_session_id_sent)
          ? finalizeDiagnostics.v2_step4_finalize_003e_session_id_sent
          : null,
      v2_step4_finalize_003e_reply_id_sent:
        Number.isInteger(finalizeDiagnostics.v2_step4_finalize_003e_reply_id_sent)
          ? finalizeDiagnostics.v2_step4_finalize_003e_reply_id_sent
          : null,
      v2_step4_finalize_003e_response_command_hex:
        typeof finalizeDiagnostics.v2_step4_finalize_003e_response_command_hex === 'string'
          ? finalizeDiagnostics.v2_step4_finalize_003e_response_command_hex
          : null,
      v2_step4_finalize_003e_response_reply_id:
        Number.isInteger(finalizeDiagnostics.v2_step4_finalize_003e_response_reply_id)
          ? finalizeDiagnostics.v2_step4_finalize_003e_response_reply_id
          : null,
      v2_step4_finalize_003e_ack_observed:
        finalizeDiagnostics.v2_step4_finalize_003e_ack_observed === true,
      v2_step4_finalize_003c_sent: finalizeDiagnostics.v2_step4_finalize_003c_sent === true,
      v2_step4_finalize_003c_session_id_sent:
        Number.isInteger(finalizeDiagnostics.v2_step4_finalize_003c_session_id_sent)
          ? finalizeDiagnostics.v2_step4_finalize_003c_session_id_sent
          : null,
      v2_step4_finalize_003c_reply_id_sent:
        Number.isInteger(finalizeDiagnostics.v2_step4_finalize_003c_reply_id_sent)
          ? finalizeDiagnostics.v2_step4_finalize_003c_reply_id_sent
          : null,
      v2_step4_finalize_003c_response_command_hex:
        typeof finalizeDiagnostics.v2_step4_finalize_003c_response_command_hex === 'string'
          ? finalizeDiagnostics.v2_step4_finalize_003c_response_command_hex
          : null,
      v2_step4_finalize_003c_response_reply_id:
        Number.isInteger(finalizeDiagnostics.v2_step4_finalize_003c_response_reply_id)
          ? finalizeDiagnostics.v2_step4_finalize_003c_response_reply_id
          : null,
      v2_step4_finalize_003c_ack_observed:
        finalizeDiagnostics.v2_step4_finalize_003c_ack_observed === true,
      v2_step4_finalize_completed: finalizeDiagnostics.v2_step4_finalize_completed === true,
      v2_step3_enroll_lane_session_continuity_ok: step3Diagnostics.v2_step3_enroll_lane_session_continuity_ok === true,
      v2_step3_enroll_lane_reply_continuity_ok: step3Diagnostics.v2_step3_enroll_lane_reply_continuity_ok === true,
      v2_step3_background_lane_still_alive: step3Diagnostics.v2_step3_background_lane_still_alive === true,
      v2_step3_enroll_lane_retained_for_step4: step3Diagnostics.v2_step3_enroll_lane_retained_for_step4 === true,
      v2_step3_client_teardown_sent_at_completion: step3Diagnostics.v2_step3_client_teardown_sent_at_completion === true,
      v2_dual_lane_contract_state: laneOwnershipState,
      v2_workflow_ready_for_step3_entry: v2WorkflowReadyForStep3,
      v2_workflow_ready_for_step4_entry: v2WorkflowReadyForStep4,
      v2_auto_teardown_at_step2_success: false
    }
  };
}

module.exports = {
  buildV2Step3SelectionPayload,
  runK80EnrollmentAttemptV2,
  runV2PhaseBackgroundBaseline,
  runV2PhaseEnrollLaneBringUp,
  runV2PhasePromptBoundary,
  runV2PhaseResultContinuation,
  runV2PhaseFinalize
};
