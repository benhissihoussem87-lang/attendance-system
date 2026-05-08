const dgram = require('dgram');
const net = require('net');

const PORT_DEFAULT = 4370;
const USHRT_MAX = 0xffff;

const COMMANDS = {
  OPTIONS_RRQ: 11,
  CONNECT: 1000,
  EXIT: 1001,
  AUTH: 1102,
  GET_VERSION: 1100
};

const ACK = {
  OK: 2000,
  ERROR: 2001,
  UNAUTH: 2005
};

const OUTCOME_CLASSES = {
  CONFIRMED: 'confirmed',
  PROBABLE: 'probable',
  HEURISTIC: 'heuristic',
  UNREACHABLE: 'unreachable'
};

const FAILURE_REASONS = {
  TIMEOUT: 'timeout',
  AUTH_REQUIRED: 'auth_required',
  AUTH_FAILED: 'auth_failed',
  PROTOCOL_ERROR: 'protocol_error',
  MALFORMED_RESPONSE: 'malformed_response',
  SOCKET_ERROR: 'socket_error',
  NETWORK_UNREACHABLE: 'network_unreachable'
};

function ipToInt(ip) {
  const parts = String(ip).split('.').map(n => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function intToIp(intValue) {
  return [
    (intValue >>> 24) & 255,
    (intValue >>> 16) & 255,
    (intValue >>> 8) & 255,
    intValue & 255
  ].join('.');
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
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

function expandTargets(targets, maxHosts) {
  const results = [];
  for (const target of targets) {
    const [ip, maskRaw] = String(target).split('/');
    const base = ipToInt(ip);
    const mask = Number.parseInt(maskRaw || '32', 10);
    if (base === null || Number.isNaN(mask) || mask < 16 || mask > 32) {
      continue;
    }

    const hostCount = Math.min(2 ** (32 - mask), maxHosts - results.length);
    if (hostCount <= 0) break;
    const networkMask = mask === 0 ? 0 : ((0xffffffff << (32 - mask)) >>> 0);
    const network = base & networkMask;
    for (let i = 0; i < hostCount; i += 1) {
      results.push(intToIp((network + i) >>> 0));
      if (results.length >= maxHosts) {
        return results;
      }
    }
  }
  return results;
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
  checksum = ~checksum;
  while (checksum < 0) {
    checksum += USHRT_MAX;
  }
  return checksum & USHRT_MAX;
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
  if (!text) return '';
  const eqIndex = text.indexOf('=');
  if (eqIndex < 0) {
    return normalizeText(text);
  }
  return normalizeText(text.slice(eqIndex + 1).replace(/^=+/, ''));
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

function nextReplyId(replyId) {
  const next = (replyId + 1) & 0xffff;
  return next >= USHRT_MAX ? (next - USHRT_MAX) : next;
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

function mapSocketError(err) {
  if (!err || !err.code) {
    return FAILURE_REASONS.SOCKET_ERROR;
  }
  const code = String(err.code).toUpperCase();
  if (code === 'ETIMEDOUT') return FAILURE_REASONS.TIMEOUT;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return FAILURE_REASONS.NETWORK_UNREACHABLE;
  return FAILURE_REASONS.SOCKET_ERROR;
}

async function sendUdpCommand({
  socket,
  ip,
  port,
  timeoutMs,
  command,
  sessionId,
  replyId,
  payload
}) {
  const packet = buildPacket({
    command,
    sessionId,
    replyId,
    payload
  });

  const sendAt = Date.now();
  try {
    await new Promise((resolve, reject) => {
      socket.send(packet, port, ip, err => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    return {
      ok: false,
      error: mapSocketError(err),
      round_trip_ms: Date.now() - sendAt
    };
  }

  let response;
  try {
    response = await receiveUdpResponse(socket, timeoutMs, ip);
  } catch (err) {
    return {
      ok: false,
      error: mapSocketError(err),
      round_trip_ms: Date.now() - sendAt
    };
  }

  if (!response) {
    return {
      ok: false,
      error: FAILURE_REASONS.TIMEOUT,
      round_trip_ms: Date.now() - sendAt
    };
  }

  const parsed = parsePacket(response);
  if (!parsed) {
    return {
      ok: false,
      error: FAILURE_REASONS.MALFORMED_RESPONSE,
      round_trip_ms: Date.now() - sendAt
    };
  }

  return {
    ok: true,
    response: parsed,
    round_trip_ms: Date.now() - sendAt
  };
}

function appendError(errors, code) {
  if (!code) return;
  if (!errors.includes(code)) {
    errors.push(code);
  }
}

function mapErrorToFailureReason(errorCode) {
  const code = normalizeText(errorCode).toLowerCase();
  if (!code) return null;
  if (code.includes('auth_failed')) return FAILURE_REASONS.AUTH_FAILED;
  if (code.includes('auth_required')) return FAILURE_REASONS.AUTH_REQUIRED;
  if (code.includes('malformed')) return FAILURE_REASONS.MALFORMED_RESPONSE;
  if (code.includes('timeout')) return FAILURE_REASONS.TIMEOUT;
  if (code.includes('socket')) return FAILURE_REASONS.SOCKET_ERROR;
  if (code.includes('network_unreachable')) return FAILURE_REASONS.NETWORK_UNREACHABLE;
  if (code.includes('ack_') || code.includes('protocol')) return FAILURE_REASONS.PROTOCOL_ERROR;
  return null;
}

function pickFailureReason(observation) {
  const errors = Array.isArray(observation.errors) ? observation.errors : [];
  for (const error of errors) {
    const mapped = mapErrorToFailureReason(error);
    if (mapped) {
      return mapped;
    }
  }

  if (!observation.tcp_port_open && !observation.zk_response_received) {
    if (errors.length > 0) {
      return FAILURE_REASONS.TIMEOUT;
    }
    return FAILURE_REASONS.NETWORK_UNREACHABLE;
  }

  return null;
}

function normalizeTcpProbeResult(result) {
  if (typeof result === 'boolean') {
    return {
      open: result,
      failure_reason: result ? null : FAILURE_REASONS.NETWORK_UNREACHABLE,
      round_trip_ms: null
    };
  }

  if (result && typeof result === 'object') {
    const open = result.open === true;
    return {
      open,
      failure_reason: open ? null : (normalizeText(result.failure_reason) || FAILURE_REASONS.NETWORK_UNREACHABLE),
      round_trip_ms: Number.isFinite(result.round_trip_ms) ? result.round_trip_ms : null
    };
  }

  return {
    open: false,
    failure_reason: FAILURE_REASONS.NETWORK_UNREACHABLE,
    round_trip_ms: null
  };
}

function normalizeZkProbeResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      handshake_ok: false,
      zk_response_received: false,
      ack_code: null,
      auth_required: false,
      auth_attempted: false,
      auth_succeeded: false,
      option_reads: {},
      firmware: '',
      errors: [FAILURE_REASONS.NETWORK_UNREACHABLE],
      failure_reason: FAILURE_REASONS.NETWORK_UNREACHABLE,
      protocol_evidence: { commands: [] }
    };
  }

  const ackCode = Number.isInteger(result.ack_code) ? result.ack_code : null;
  const handshakeOk = result.handshake_ok === true;
  const zkResponseReceived = result.zk_response_received === true || handshakeOk || ackCode !== null;
  const errors = Array.isArray(result.errors) ? result.errors.filter(Boolean).map(String) : [];
  const explicitFailure = normalizeText(result.failure_reason);

  return {
    handshake_ok: handshakeOk,
    zk_response_received: zkResponseReceived,
    ack_code: ackCode,
    auth_required: result.auth_required === true,
    auth_attempted: result.auth_attempted === true,
    auth_succeeded: result.auth_succeeded === true,
    option_reads: result.option_reads && typeof result.option_reads === 'object' ? result.option_reads : {},
    firmware: normalizeText(result.firmware),
    errors,
    failure_reason: explicitFailure || null,
    protocol_evidence: result.protocol_evidence && typeof result.protocol_evidence === 'object'
      ? result.protocol_evidence
      : { commands: [] }
  };
}

function recordProtocolEvidence(commands, entry) {
  commands.push({
    step: entry.step,
    command: entry.command,
    target: entry.target || null,
    ok: entry.ok === true,
    ack_code: Number.isInteger(entry.ack_code) ? entry.ack_code : null,
    error: normalizeText(entry.error) || null,
    round_trip_ms: Number.isFinite(entry.round_trip_ms) ? entry.round_trip_ms : null
  });
}

async function probeZkProtocol({ ip, port, timeoutMs, authPassword }) {
  const socket = dgram.createSocket('udp4');
  const optionReads = {};
  const errors = [];
  const protocolEvidence = { commands: [] };
  let sessionId = 0;
  let replyId = USHRT_MAX - 1;
  let connectPacket = null;
  let firmware = '';
  let authRequired = false;
  let authAttempted = false;
  let authSucceeded = false;
  let zkResponseReceived = false;

  const optionKeys = [
    { field: 'serial_number', key: '~SerialNumber\x00' },
    { field: 'device_name', key: '~DeviceName\x00' },
    { field: 'platform', key: '~Platform\x00' },
    { field: 'mac', key: 'MAC\x00' }
  ];

  try {
    const connect = await sendUdpCommand({
      socket,
      ip,
      port,
      timeoutMs,
      command: COMMANDS.CONNECT,
      sessionId,
      replyId,
      payload: Buffer.alloc(0)
    });
    recordProtocolEvidence(protocolEvidence.commands, {
      step: 'connect',
      command: 'CONNECT',
      ok: connect.ok,
      ack_code: connect.ok && connect.response ? connect.response.command : null,
      error: connect.ok ? null : connect.error,
      round_trip_ms: connect.round_trip_ms
    });

    if (!connect.ok) {
      appendError(errors, connect.error || `${FAILURE_REASONS.PROTOCOL_ERROR}:connect`);
      return {
        handshake_ok: false,
        zk_response_received: false,
        ack_code: null,
        option_reads: optionReads,
        firmware: '',
        errors,
        failure_reason: pickFailureReason({
          tcp_port_open: false,
          zk_response_received: false,
          errors
        }),
        protocol_evidence: protocolEvidence
      };
    }

    connectPacket = connect.response;
    zkResponseReceived = true;
    sessionId = connectPacket.session_id;
    replyId = connectPacket.reply_id;
    const handshakeOk = connectPacket.command === ACK.OK || connectPacket.command === ACK.UNAUTH;
    authRequired = connectPacket.command === ACK.UNAUTH;
    if (!handshakeOk) {
      appendError(errors, `${FAILURE_REASONS.PROTOCOL_ERROR}:connect_ack_${connectPacket.command}`);
    }

    if (handshakeOk && authRequired && Number.isInteger(authPassword)) {
      authAttempted = true;
      const authResponse = await sendUdpCommand({
        socket,
        ip,
        port,
        timeoutMs,
        command: COMMANDS.AUTH,
        sessionId,
        replyId,
        payload: makeCommKey(authPassword, sessionId)
      });
      recordProtocolEvidence(protocolEvidence.commands, {
        step: 'auth',
        command: 'AUTH',
        ok: authResponse.ok,
        ack_code: authResponse.ok && authResponse.response ? authResponse.response.command : null,
        error: authResponse.ok ? null : authResponse.error,
        round_trip_ms: authResponse.round_trip_ms
      });

      if (authResponse.ok && authResponse.response) {
        zkResponseReceived = true;
        replyId = authResponse.response.reply_id;
        if (authResponse.response.command === ACK.OK) {
          authSucceeded = true;
          authRequired = false;
        } else {
          appendError(errors, FAILURE_REASONS.AUTH_FAILED);
        }
      } else {
        appendError(errors, authResponse.error || FAILURE_REASONS.AUTH_FAILED);
      }
    } else if (handshakeOk && authRequired) {
      appendError(errors, FAILURE_REASONS.AUTH_REQUIRED);
    }

    if (handshakeOk && !authRequired) {
      for (const option of optionKeys) {
        const response = await sendUdpCommand({
          socket,
          ip,
          port,
          timeoutMs,
          command: COMMANDS.OPTIONS_RRQ,
          sessionId,
          replyId,
          payload: Buffer.from(option.key, 'ascii')
        });
        recordProtocolEvidence(protocolEvidence.commands, {
          step: 'options_rrq',
          command: 'OPTIONS_RRQ',
          target: option.field,
          ok: response.ok,
          ack_code: response.ok && response.response ? response.response.command : null,
          error: response.ok ? null : response.error,
          round_trip_ms: response.round_trip_ms
        });

        if (!response.ok || !response.response) {
          optionReads[option.field] = null;
          appendError(errors, response.error || `${FAILURE_REASONS.PROTOCOL_ERROR}:${option.field}`);
          continue;
        }

        zkResponseReceived = true;
        replyId = response.response.reply_id;
        if (response.response.command !== ACK.OK) {
          optionReads[option.field] = null;
          appendError(errors, `${FAILURE_REASONS.PROTOCOL_ERROR}:option_ack_${response.response.command}`);
          continue;
        }

        const value = parseOptionValue(response.response.payload);
        optionReads[option.field] = value || null;
      }

      const versionResponse = await sendUdpCommand({
        socket,
        ip,
        port,
        timeoutMs,
        command: COMMANDS.GET_VERSION,
        sessionId,
        replyId,
        payload: Buffer.alloc(0)
      });
      recordProtocolEvidence(protocolEvidence.commands, {
        step: 'get_version',
        command: 'GET_VERSION',
        ok: versionResponse.ok,
        ack_code: versionResponse.ok && versionResponse.response ? versionResponse.response.command : null,
        error: versionResponse.ok ? null : versionResponse.error,
        round_trip_ms: versionResponse.round_trip_ms
      });

      if (versionResponse.ok && versionResponse.response) {
        zkResponseReceived = true;
        replyId = versionResponse.response.reply_id;
        if (versionResponse.response.command === ACK.OK) {
          firmware = parseOptionValue(versionResponse.response.payload);
        } else {
          appendError(errors, `${FAILURE_REASONS.PROTOCOL_ERROR}:version_ack_${versionResponse.response.command}`);
        }
      } else {
        appendError(errors, versionResponse.error || `${FAILURE_REASONS.PROTOCOL_ERROR}:version`);
      }
    }

    const probe = {
      handshake_ok: handshakeOk,
      zk_response_received: zkResponseReceived,
      ack_code: connectPacket.command,
      session_id: connectPacket.session_id,
      auth_required: authRequired,
      auth_attempted: authAttempted,
      auth_succeeded: authSucceeded,
      option_reads: optionReads,
      firmware,
      connect_rtt_ms: connect.round_trip_ms,
      errors,
      protocol_evidence: protocolEvidence
    };
    probe.failure_reason = pickFailureReason({
      tcp_port_open: false,
      zk_response_received: probe.zk_response_received,
      errors: probe.errors
    });
    return probe;
  } catch (err) {
    appendError(errors, mapSocketError(err));
    return {
      handshake_ok: false,
      zk_response_received: zkResponseReceived,
      ack_code: null,
      option_reads: optionReads,
      firmware: '',
      errors,
      failure_reason: pickFailureReason({
        tcp_port_open: false,
        zk_response_received: zkResponseReceived,
        errors
      }),
      protocol_evidence: protocolEvidence
    };
  } finally {
    if (connectPacket && (connectPacket.command === ACK.OK || connectPacket.command === ACK.UNAUTH)) {
      try {
        replyId = nextReplyId(replyId);
        await sendUdpCommand({
          socket,
          ip,
          port,
          timeoutMs: Math.min(timeoutMs, 600),
          command: COMMANDS.EXIT,
          sessionId,
          replyId,
          payload: Buffer.alloc(0)
        });
      } catch (err) {
        // ignore disconnect failures
      }
    }
    socket.close();
  }
}

function probeTcp(ip, port, timeoutMs) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const startedAt = Date.now();

    const finish = result => {
      if (done) return;
      done = true;
      try {
        socket.destroy();
      } catch (err) {
        // no-op
      }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({
      open: true,
      failure_reason: null,
      round_trip_ms: Date.now() - startedAt
    }));
    socket.once('timeout', () => finish({
      open: false,
      failure_reason: FAILURE_REASONS.TIMEOUT,
      round_trip_ms: Date.now() - startedAt
    }));
    socket.once('error', err => finish({
      open: false,
      failure_reason: mapSocketError(err),
      round_trip_ms: Date.now() - startedAt
    }));
    socket.connect(port, ip);
  });
}

function resolveIdentitySource({ serial, mac, hasProtocolMetadata }) {
  if (serial) return 'serial_number';
  if (mac) return 'mac';
  if (hasProtocolMetadata) return 'protocol_metadata';
  return 'ip';
}

function classifyObservation(observation) {
  const serial = normalizeSerial(observation.serial_number);
  const mac = normalizeMac(observation.mac);
  const deviceName = normalizeText(observation.device_name);
  const platform = normalizeText(observation.platform);
  const firmware = normalizeText(observation.firmware);
  const model = deviceName || platform || null;
  const hasProtocolMetadata = Boolean(deviceName || platform || firmware);
  const hasStableIdentity = Boolean(serial || mac);
  const failureReason = pickFailureReason(observation);

  if (observation.zk_handshake_ok && hasStableIdentity) {
    return {
      outcome_class: OUTCOME_CLASSES.CONFIRMED,
      confirmation_state: 'confirmed',
      confidence: 0.98,
      confidence_class: 'high',
      discovery_method: 'zkteco_udp_protocol_interrogation',
      serial_number: serial || null,
      mac: mac || null,
      model,
      identity_source: resolveIdentitySource({ serial, mac, hasProtocolMetadata }),
      failure_reason: null
    };
  }

  if (observation.zk_handshake_ok || observation.zk_response_received) {
    return {
      outcome_class: OUTCOME_CLASSES.PROBABLE,
      confirmation_state: 'zk_service_reachable',
      confidence: observation.zk_handshake_ok ? 0.74 : 0.62,
      confidence_class: 'medium',
      discovery_method: observation.zk_handshake_ok
        ? 'zkteco_udp_handshake'
        : 'zkteco_udp_ack_probe',
      serial_number: serial || null,
      mac: mac || null,
      model,
      identity_source: resolveIdentitySource({ serial, mac, hasProtocolMetadata }),
      failure_reason: failureReason
    };
  }

  if (observation.tcp_port_open) {
    return {
      outcome_class: OUTCOME_CLASSES.HEURISTIC,
      confirmation_state: 'host_reachable',
      confidence: 0.4,
      confidence_class: 'low',
      discovery_method: 'tcp_4370_service_probe',
      serial_number: serial || null,
      mac: mac || null,
      model: null,
      identity_source: mac ? 'mac' : 'ip',
      failure_reason: failureReason
    };
  }

  return {
    outcome_class: OUTCOME_CLASSES.UNREACHABLE,
    confirmation_state: 'unreachable',
    confidence: 0,
    confidence_class: 'low',
    discovery_method: 'network_unreachable',
    serial_number: null,
    mac: null,
    model: null,
    identity_source: 'none',
    failure_reason: failureReason || FAILURE_REASONS.NETWORK_UNREACHABLE
  };
}

function buildDeviceUid(ip, classification) {
  if (classification.serial_number) {
    return `zkteco:sn:${classification.serial_number}`;
  }
  if (classification.mac) {
    return `zkteco:mac:${classification.mac}`;
  }
  return `zkteco:ip:${ip}`;
}

function buildDeviceRecord(observation, classification) {
  if (classification.outcome_class === OUTCOME_CLASSES.UNREACHABLE) {
    return null;
  }

  const protocol = {
    family: 'zkteco-4370',
    transport: observation.zk_response_received ? 'udp' : 'tcp',
    port: observation.port,
    ack_code: observation.zk_ack_code,
    auth_required: observation.zk_auth_required,
    auth_attempted: observation.zk_auth_attempted,
    auth_succeeded: observation.zk_auth_succeeded,
    zk_response_received: observation.zk_response_received
  };

  return {
    ip: observation.ip,
    mac: classification.mac || null,
    vendor: 'zkteco',
    model: classification.model || null,
    serial_number: classification.serial_number || null,
    device_uid: buildDeviceUid(observation.ip, classification),
    discovery_method: classification.discovery_method,
    confidence: classification.confidence,
    confidence_class: classification.confidence_class,
    confirmation_state: classification.confirmation_state,
    outcome_class: classification.outcome_class,
    identity_source: classification.identity_source,
    failure_reason: classification.failure_reason || null,
    protocol,
    observed_at: observation.observed_at,
    raw: {
      tcp_port_open: observation.tcp_port_open,
      tcp_failure_reason: observation.tcp_failure_reason || null,
      tcp_round_trip_ms: observation.tcp_round_trip_ms,
      zk_handshake_ok: observation.zk_handshake_ok,
      zk_response_received: observation.zk_response_received,
      zk_ack_code: observation.zk_ack_code,
      zk_auth_required: observation.zk_auth_required,
      zk_auth_attempted: observation.zk_auth_attempted,
      zk_auth_succeeded: observation.zk_auth_succeeded,
      option_reads: observation.option_reads,
      firmware: observation.firmware,
      errors: observation.errors,
      protocol_evidence: observation.protocol_evidence
    }
  };
}

function buildHostResult(observation, classification, record) {
  return {
    ip: observation.ip,
    port: observation.port,
    observed_at: observation.observed_at,
    outcome_class: classification.outcome_class,
    confirmation_state: classification.confirmation_state,
    confidence: classification.confidence,
    confidence_class: classification.confidence_class,
    discovery_method: classification.discovery_method,
    failure_reason: classification.failure_reason || null,
    tcp_port_open: observation.tcp_port_open,
    tcp_failure_reason: observation.tcp_failure_reason || null,
    zk_response_received: observation.zk_response_received,
    zk_handshake_ok: observation.zk_handshake_ok,
    zk_ack_code: observation.zk_ack_code,
    zk_auth_required: observation.zk_auth_required,
    zk_auth_attempted: observation.zk_auth_attempted,
    zk_auth_succeeded: observation.zk_auth_succeeded,
    serial_number: classification.serial_number || null,
    mac: classification.mac || null,
    model: classification.model || null,
    device_uid: record ? record.device_uid : null,
    errors: observation.errors
  };
}

function buildSummary(hostObservations) {
  const summary = {
    hosts_total: hostObservations.length,
    hosts_confirmed: 0,
    hosts_probable: 0,
    hosts_heuristic: 0,
    hosts_unreachable: 0,
    hosts_zk_service_reachable: 0,
    hosts_host_reachable: 0,
    failure_reason_counts: {}
  };

  for (const observation of hostObservations) {
    switch (observation.outcome_class) {
      case OUTCOME_CLASSES.CONFIRMED:
        summary.hosts_confirmed += 1;
        break;
      case OUTCOME_CLASSES.PROBABLE:
        summary.hosts_probable += 1;
        summary.hosts_zk_service_reachable += 1;
        break;
      case OUTCOME_CLASSES.HEURISTIC:
        summary.hosts_heuristic += 1;
        summary.hosts_host_reachable += 1;
        break;
      default:
        summary.hosts_unreachable += 1;
        break;
    }

    if (observation.failure_reason) {
      summary.failure_reason_counts[observation.failure_reason] =
        (summary.failure_reason_counts[observation.failure_reason] || 0) + 1;
    }
  }

  return summary;
}

function safeInvokeHostCallback(callback, payload) {
  if (typeof callback !== 'function') {
    return;
  }
  try {
    callback(payload);
  } catch (err) {
    // ignore callback exceptions to keep discovery flow stable
  }
}

async function discover(targets, options = {}) {
  const timeoutMs = Number.isInteger(options.timeout_ms) ? options.timeout_ms : 1500;
  const maxHosts = Number.isInteger(options.max_hosts) ? options.max_hosts : 512;
  const port = Number.isInteger(options.port) ? options.port : PORT_DEFAULT;
  const authPassword = Number.isInteger(options.auth_password) ? options.auth_password : null;
  const probeTcpFn = typeof options.__probeTcp === 'function' ? options.__probeTcp : probeTcp;
  const probeZkFn = typeof options.__probeZkProtocol === 'function'
    ? options.__probeZkProtocol
    : probeZkProtocol;

  if (options.mock_mode) {
    const now = new Date().toISOString();
    const mockDevice = {
      ip: '192.168.1.20',
      mac: '00:11:22:33:44:55',
      vendor: 'zkteco',
      model: 'Mock-ZK-T1',
      serial_number: 'ZKMOCK0001',
      device_uid: 'zkteco:sn:ZKMOCK0001',
      discovery_method: 'mock_seed',
      confidence: 0.99,
      confidence_class: 'high',
      confirmation_state: 'confirmed',
      outcome_class: OUTCOME_CLASSES.CONFIRMED,
      identity_source: 'serial_number',
      failure_reason: null,
      protocol: {
        family: 'zkteco-4370',
        transport: 'mock',
        port: PORT_DEFAULT,
        ack_code: ACK.OK,
        auth_required: false,
        auth_attempted: false,
        auth_succeeded: false,
        zk_response_received: true
      },
      observed_at: now,
      raw: {
        mock: true
      }
    };
    safeInvokeHostCallback(options.on_host_result, {
      ip: mockDevice.ip,
      port: PORT_DEFAULT,
      observed_at: now,
      outcome_class: OUTCOME_CLASSES.CONFIRMED,
      confirmation_state: 'confirmed',
      confidence: mockDevice.confidence,
      confidence_class: mockDevice.confidence_class,
      discovery_method: 'mock_seed',
      failure_reason: null,
      tcp_port_open: true,
      tcp_failure_reason: null,
      zk_response_received: true,
      zk_handshake_ok: true,
      zk_ack_code: ACK.OK,
      zk_auth_required: false,
      zk_auth_attempted: false,
      zk_auth_succeeded: false,
      serial_number: mockDevice.serial_number,
      mac: mockDevice.mac,
      model: mockDevice.model,
      device_uid: mockDevice.device_uid,
      errors: []
    });
    return {
      discovered_devices: [mockDevice],
      summary: {
        hosts_total: 1,
        hosts_confirmed: 1,
        hosts_probable: 0,
        hosts_heuristic: 0,
        hosts_unreachable: 0,
        hosts_zk_service_reachable: 0,
        hosts_host_reachable: 0,
        failure_reason_counts: {},
        mode: 'mock',
        host_observations: [{
          ip: mockDevice.ip,
          outcome_class: OUTCOME_CLASSES.CONFIRMED,
          confirmation_state: 'confirmed',
          failure_reason: null
        }]
      }
    };
  }

  const ips = expandTargets(targets, maxHosts);
  const observations = [];
  const devices = [];

  for (const ip of ips) {
    const observedAt = new Date().toISOString();
    const tcpResultRaw = await probeTcpFn(ip, port, timeoutMs);
    const tcpResult = normalizeTcpProbeResult(tcpResultRaw);
    const zkResultRaw = await probeZkFn({ ip, port, timeoutMs, authPassword });
    const zk = normalizeZkProbeResult(zkResultRaw);

    const errors = [];
    for (const err of zk.errors) {
      appendError(errors, err);
    }
    if (!tcpResult.open && tcpResult.failure_reason) {
      appendError(errors, tcpResult.failure_reason);
    }

    const observation = {
      ip,
      port,
      observed_at: observedAt,
      tcp_port_open: tcpResult.open === true,
      tcp_failure_reason: tcpResult.failure_reason || null,
      tcp_round_trip_ms: tcpResult.round_trip_ms,
      zk_handshake_ok: zk.handshake_ok === true,
      zk_response_received: zk.zk_response_received === true,
      zk_ack_code: zk.ack_code,
      zk_auth_required: zk.auth_required === true,
      zk_auth_attempted: zk.auth_attempted === true,
      zk_auth_succeeded: zk.auth_succeeded === true,
      option_reads: zk.option_reads || {},
      firmware: zk.firmware || '',
      protocol_evidence: zk.protocol_evidence || { commands: [] },
      errors
    };

    const classification = classifyObservation({
      ...observation,
      serial_number: observation.option_reads.serial_number,
      mac: observation.option_reads.mac,
      device_name: observation.option_reads.device_name,
      platform: observation.option_reads.platform
    });
    observation.confirmation_state = classification.confirmation_state;
    observation.outcome_class = classification.outcome_class;
    observation.failure_reason = classification.failure_reason || null;

    const record = buildDeviceRecord(observation, classification);
    if (record) {
      devices.push(record);
    }

    observations.push(observation);
    safeInvokeHostCallback(options.on_host_result, buildHostResult(observation, classification, record));
  }

  return {
    discovered_devices: devices,
    summary: {
      ...buildSummary(observations),
      mode: 'real',
      host_observations: observations
    }
  };
}

module.exports = {
  id: 'zkteco',
  discover,
  __test: {
    parseOptionValue,
    checksumPacket,
    buildPacket,
    parsePacket,
    makeCommKey,
    classifyObservation,
    buildDeviceRecord,
    normalizeMac,
    normalizeSerial,
    buildSummary,
    pickFailureReason
  }
};
