const COMMAND_TYPES = {
  SCAN_SUBNET: 'SCAN_SUBNET',
  PULL_DEVICE_EVENTS: 'PULL_DEVICE_EVENTS',
  REFRESH_DEVICE_PATH_PULL_CAPABILITY: 'REFRESH_DEVICE_PATH_PULL_CAPABILITY',
  VALIDATE_DEVICE_CANDIDATE: 'VALIDATE_DEVICE_CANDIDATE',
  RUN_K80_ENROLLMENT_ATTEMPT: 'RUN_K80_ENROLLMENT_ATTEMPT',
  START_DEVICE_MONITORING: 'START_DEVICE_MONITORING',
  STOP_DEVICE_MONITORING: 'STOP_DEVICE_MONITORING'
};

const DISCOVERY_CONFIRMATION_STATES = new Set([
  'confirmed',
  'zk_service_reachable',
  'host_reachable'
]);

const CONFIDENCE_CLASSES = new Set([
  'high',
  'medium',
  'low'
]);

const OUTCOME_CLASSES = new Set([
  'confirmed',
  'probable',
  'heuristic'
]);

const FAILURE_REASONS = new Set([
  'timeout',
  'auth_required',
  'auth_failed',
  'protocol_error',
  'malformed_response',
  'socket_error',
  'network_unreachable'
]);

const MANUAL_TRANSPORT_MODES = new Set(['udp', 'tcp', 'auto']);
const MANUAL_ATTLOG_SEQUENCES = new Set([
  'off',
  'deviceid_platform',
  'deviceid_platform_version',
  'zktime_k80'
]);

const MANAGED_STATUS = {
  CANDIDATE: 'candidate',
  MANAGED: 'managed',
  INACTIVE: 'inactive',
  UNREACHABLE: 'unreachable'
};

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  return false;
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

function normalizeMacAddress(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return '';
  const clean = raw.replace(/[^a-f0-9]/g, '');
  if (clean.length !== 12) {
    return '';
  }
  return clean.match(/.{1,2}/g).join(':');
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

function isValidSemverTriplet(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }
  return /^v?\d+\.\d+\.\d+(?:[-+].*)?$/i.test(normalized);
}

function validateSubnetTarget(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return { ok: false, error: 'subnet target is required' };
  }

  const cidrMatch = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d|[12]\d|3[0-2]))?$/);
  if (!cidrMatch) {
    return { ok: false, error: `invalid subnet target '${raw}'` };
  }

  const ip = cidrMatch[1];
  const prefix = cidrMatch[2] === undefined ? 32 : Number(cidrMatch[2]);
  if (!isPrivateIPv4(ip)) {
    return { ok: false, error: `subnet target '${raw}' is not private RFC1918 space` };
  }
  if (prefix < 16 || prefix > 32) {
    return { ok: false, error: `subnet target '${raw}' prefix must be between /16 and /32` };
  }

  return {
    ok: true,
    value: `${ip}/${prefix}`
  };
}

function validateScanSubnetCommandPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const targets = Array.isArray(payload.subnet_targets) ? payload.subnet_targets : null;
  if (!targets || targets.length === 0) {
    return { ok: false, error: 'subnet_targets must be a non-empty array' };
  }
  if (targets.length > 8) {
    return { ok: false, error: 'subnet_targets max length is 8' };
  }

  const normalizedTargets = [];
  for (const target of targets) {
    const validated = validateSubnetTarget(target);
    if (!validated.ok) {
      return validated;
    }
    normalizedTargets.push(validated.value);
  }

  const options = isPlainObject(payload.options) ? payload.options : {};
  const timeoutMs = Number.isInteger(options.timeout_ms) ? options.timeout_ms : 1500;
  const maxHosts = Number.isInteger(options.max_hosts) ? options.max_hosts : 1024;
  const authPassword = Number.isInteger(options.auth_password) ? options.auth_password : null;
  if (timeoutMs < 200 || timeoutMs > 10000) {
    return { ok: false, error: 'options.timeout_ms must be between 200 and 10000' };
  }
  if (maxHosts < 1 || maxHosts > 4096) {
    return { ok: false, error: 'options.max_hosts must be between 1 and 4096' };
  }
  if (authPassword !== null && (authPassword < 0 || authPassword > 99999999)) {
    return { ok: false, error: 'options.auth_password must be between 0 and 99999999' };
  }

  return {
    ok: true,
    value: {
      subnet_targets: Array.from(new Set(normalizedTargets)),
      options: {
        timeout_ms: timeoutMs,
        max_hosts: maxHosts,
        adapter: normalizeText(options.adapter).toLowerCase() || 'zkteco',
        ...(authPassword !== null ? { auth_password: authPassword } : {})
      }
    }
  };
}

function validateDiscoveryDevice(item) {
  if (!isPlainObject(item)) {
    return { ok: false, error: 'discovered device must be an object' };
  }
  const ip = normalizeText(item.ip);
  const vendor = normalizeText(item.vendor).toLowerCase();
  const observedAt = normalizeText(item.observed_at);
  if (!ip) return { ok: false, error: 'discovered device ip is required' };
  if (!vendor) return { ok: false, error: 'discovered device vendor is required' };
  if (!observedAt) return { ok: false, error: 'discovered device observed_at is required' };

  const confidence = typeof item.confidence === 'number' ? item.confidence : 0.5;
  if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, error: 'discovered device confidence must be between 0 and 1' };
  }

  const confirmationStateRaw = normalizeText(item.confirmation_state).toLowerCase();
  const confirmationState = confirmationStateRaw || 'zk_service_reachable';
  if (!DISCOVERY_CONFIRMATION_STATES.has(confirmationState)) {
    return { ok: false, error: `discovered device confirmation_state '${confirmationState}' is invalid` };
  }

  const confidenceClassRaw = normalizeText(item.confidence_class).toLowerCase();
  const confidenceClass = confidenceClassRaw || (
    confidence >= 0.9 ? 'high' : (confidence >= 0.6 ? 'medium' : 'low')
  );
  if (!CONFIDENCE_CLASSES.has(confidenceClass)) {
    return { ok: false, error: `discovered device confidence_class '${confidenceClass}' is invalid` };
  }

  const outcomeClassRaw = normalizeText(item.outcome_class).toLowerCase();
  const outcomeClass = outcomeClassRaw || (
    confirmationState === 'confirmed'
      ? 'confirmed'
      : (confirmationState === 'zk_service_reachable' ? 'probable' : 'heuristic')
  );
  if (!OUTCOME_CLASSES.has(outcomeClass)) {
    return { ok: false, error: `discovered device outcome_class '${outcomeClass}' is invalid` };
  }

  const failureReasonRaw = normalizeText(item.failure_reason).toLowerCase();
  const failureReason = failureReasonRaw || null;
  if (failureReason && !FAILURE_REASONS.has(failureReason)) {
    return { ok: false, error: `discovered device failure_reason '${failureReason}' is invalid` };
  }

  return {
    ok: true,
    value: {
      ip,
      mac: normalizeText(item.mac) || null,
      vendor,
      model: normalizeText(item.model) || null,
      serial_number: normalizeText(item.serial_number) || null,
      device_uid: normalizeText(item.device_uid) || null,
      discovery_method: normalizeText(item.discovery_method) || 'network_probe',
      confidence,
      confidence_class: confidenceClass,
      confirmation_state: confirmationState,
      outcome_class: outcomeClass,
      identity_source: normalizeText(item.identity_source) || null,
      failure_reason: failureReason,
      protocol: isPlainObject(item.protocol) ? item.protocol : {},
      observed_at: observedAt,
      raw: isPlainObject(item.raw) ? item.raw : {}
    }
  };
}

function validateDiscoveryReportPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const adapterId = normalizeText(payload.adapter_id).toLowerCase();
  const reportedAt = normalizeText(payload.reported_at);
  const devices = Array.isArray(payload.discovered_devices) ? payload.discovered_devices : null;

  if (!adapterId) return { ok: false, error: 'adapter_id is required' };
  if (!reportedAt) return { ok: false, error: 'reported_at is required' };
  if (!devices) return { ok: false, error: 'discovered_devices must be an array' };
  if (devices.length > 2048) return { ok: false, error: 'discovered_devices max length is 2048' };

  const normalizedDevices = [];
  for (const device of devices) {
    const validated = validateDiscoveryDevice(device);
    if (!validated.ok) {
      return validated;
    }
    normalizedDevices.push(validated.value);
  }

  return {
    ok: true,
    value: {
      command_id: normalizeText(payload.command_id) || null,
      adapter_id: adapterId,
      subnet_targets: Array.isArray(payload.subnet_targets) ? payload.subnet_targets : [],
      reported_at: reportedAt,
      discovered_devices: normalizedDevices,
      summary: isPlainObject(payload.summary) ? payload.summary : {}
    }
  };
}

function validateManualDeviceOnboardingPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const provider = normalizeText(payload.provider).toLowerCase();
  if (!provider) {
    return { ok: false, error: 'provider is required' };
  }

  const deviceUidRaw = normalizeText(payload.device_uid);
  const deviceUid = deviceUidRaw || null;

  const deviceNameRaw = normalizeText(payload.device_name);
  if (deviceNameRaw.length > 255) {
    return { ok: false, error: 'device_name max length is 255' };
  }

  const identityRaw = payload.identity;
  if (identityRaw !== undefined && !isPlainObject(identityRaw)) {
    return { ok: false, error: 'identity must be an object' };
  }
  const identity = isPlainObject(identityRaw) ? identityRaw : {};
  const serialNumber = normalizeText(identity.serial_number).toUpperCase();
  const macRaw = normalizeText(identity.mac);
  const mac = macRaw ? normalizeMacAddress(macRaw) : '';
  if (macRaw && !mac) {
    return { ok: false, error: 'identity.mac must be a valid MAC address' };
  }

  const connectionRaw = payload.connection;
  if (connectionRaw !== undefined && !isPlainObject(connectionRaw)) {
    return { ok: false, error: 'connection must be an object' };
  }
  const connectionInput = isPlainObject(connectionRaw) ? connectionRaw : {};
  const connection = {};

  if (Object.prototype.hasOwnProperty.call(connectionInput, 'host')) {
    const host = normalizeText(connectionInput.host);
    if (!host) {
      return { ok: false, error: 'connection.host cannot be empty when provided' };
    }
    if (!isPrivateIPv4(host)) {
      return { ok: false, error: 'connection.host must be RFC1918 private IPv4' };
    }
    connection.host = host;
  }

  if (Object.prototype.hasOwnProperty.call(connectionInput, 'port')) {
    const port = parseIntegerLike(connectionInput.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: 'connection.port must be between 1 and 65535' };
    }
    connection.port = port;
  }

  const hasCommunicationKey = Object.prototype.hasOwnProperty.call(connectionInput, 'communication_key');
  const hasAuthPassword = Object.prototype.hasOwnProperty.call(connectionInput, 'auth_password');
  if (hasCommunicationKey || hasAuthPassword) {
    const communicationKey = hasCommunicationKey ? parseIntegerLike(connectionInput.communication_key) : null;
    const authPassword = hasAuthPassword ? parseIntegerLike(connectionInput.auth_password) : null;
    if (hasCommunicationKey && (communicationKey === null || communicationKey < 0 || communicationKey > 99999999)) {
      return { ok: false, error: 'connection.communication_key must be between 0 and 99999999' };
    }
    if (hasAuthPassword && (authPassword === null || authPassword < 0 || authPassword > 99999999)) {
      return { ok: false, error: 'connection.auth_password must be between 0 and 99999999' };
    }
    if (hasCommunicationKey && hasAuthPassword && communicationKey !== authPassword) {
      return { ok: false, error: 'connection.communication_key and connection.auth_password must match when both provided' };
    }
    const resolvedAuthPassword = hasCommunicationKey ? communicationKey : authPassword;
    connection.communication_key = resolvedAuthPassword;
    connection.auth_password = resolvedAuthPassword;
  }

  if (Object.prototype.hasOwnProperty.call(connectionInput, 'device_number')) {
    const deviceNumber = parseIntegerLike(connectionInput.device_number);
    if (!Number.isInteger(deviceNumber) || deviceNumber < 0 || deviceNumber > 65535) {
      return { ok: false, error: 'connection.device_number must be between 0 and 65535' };
    }
    connection.device_number = deviceNumber;
  }

  if (Object.prototype.hasOwnProperty.call(connectionInput, 'transport')) {
    const transport = normalizeText(connectionInput.transport).toLowerCase();
    if (!MANUAL_TRANSPORT_MODES.has(transport)) {
      return { ok: false, error: 'connection.transport must be one of udp, tcp, auto' };
    }
    connection.transport = transport;
  }

  if (Object.prototype.hasOwnProperty.call(connectionInput, 'attlog_sequence')) {
    const attlogSequence = normalizeText(connectionInput.attlog_sequence).toLowerCase();
    if (!MANUAL_ATTLOG_SEQUENCES.has(attlogSequence)) {
      return {
        ok: false,
        error: 'connection.attlog_sequence must be one of off, deviceid_platform, deviceid_platform_version, zktime_k80'
      };
    }
    connection.attlog_sequence = attlogSequence;
  }

  const deviceProfileRaw = payload.device_profile;
  if (deviceProfileRaw !== undefined && !isPlainObject(deviceProfileRaw)) {
    return { ok: false, error: 'device_profile must be an object' };
  }
  const deviceProfileInput = isPlainObject(deviceProfileRaw) ? deviceProfileRaw : {};
  const deviceProfile = {};
  if (Object.prototype.hasOwnProperty.call(deviceProfileInput, 'model')) {
    const model = normalizeText(deviceProfileInput.model);
    if (model.length > 255) {
      return { ok: false, error: 'device_profile.model max length is 255' };
    }
    deviceProfile.model = model;
  }
  if (Object.prototype.hasOwnProperty.call(deviceProfileInput, 'firmware')) {
    const firmware = normalizeText(deviceProfileInput.firmware);
    if (firmware.length > 255) {
      return { ok: false, error: 'device_profile.firmware max length is 255' };
    }
    deviceProfile.firmware = firmware;
  }

  const siteContextRaw = payload.site_context;
  if (siteContextRaw !== undefined && !isPlainObject(siteContextRaw)) {
    return { ok: false, error: 'site_context must be an object' };
  }
  const siteContextInput = isPlainObject(siteContextRaw) ? siteContextRaw : {};
  const siteContext = {};
  if (Object.prototype.hasOwnProperty.call(siteContextInput, 'site_label')) {
    const siteLabel = normalizeText(siteContextInput.site_label);
    if (siteLabel.length > 255) {
      return { ok: false, error: 'site_context.site_label max length is 255' };
    }
    siteContext.site_label = siteLabel;
  }

  const operatorNotesRaw = payload.operator_notes;
  if (operatorNotesRaw !== undefined && !isPlainObject(operatorNotesRaw)) {
    return { ok: false, error: 'operator_notes must be an object' };
  }
  const operatorNotesInput = isPlainObject(operatorNotesRaw) ? operatorNotesRaw : {};
  const operatorNotes = {};
  if (Object.prototype.hasOwnProperty.call(operatorNotesInput, 'label')) {
    const label = normalizeText(operatorNotesInput.label);
    if (label.length > 255) {
      return { ok: false, error: 'operator_notes.label max length is 255' };
    }
    operatorNotes.label = label;
  }
  if (Object.prototype.hasOwnProperty.call(operatorNotesInput, 'notes')) {
    const notes = normalizeText(operatorNotesInput.notes);
    if (notes.length > 2000) {
      return { ok: false, error: 'operator_notes.notes max length is 2000' };
    }
    operatorNotes.notes = notes;
  }

  const derivedDeviceUid = deviceUid
    || (serialNumber ? `${provider}:sn:${serialNumber}` : '')
    || (mac ? `${provider}:mac:${mac}` : '')
    || (connection.host ? `${provider}:ip:${connection.host}` : '');
  if (!derivedDeviceUid) {
    return {
      ok: false,
      error: 'device_uid is required when identity.serial_number, identity.mac, and connection.host are all missing'
    };
  }

  return {
    ok: true,
    value: {
      provider,
      device_uid: deviceUid,
      canonical_device_uid: derivedDeviceUid,
      device_name: deviceNameRaw || null,
      identity: {
        serial_number: serialNumber || null,
        mac: mac || null
      },
      connection,
      device_profile: deviceProfile,
      site_context: siteContext,
      operator_notes: operatorNotes
    }
  };
}

function validateManualDeviceValidationRequestPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const agentId = normalizeText(payload.agent_id);
  if (!agentId) {
    return { ok: false, error: 'agent_id is required' };
  }

  const optionsRaw = payload.options;
  if (optionsRaw !== undefined && !isPlainObject(optionsRaw)) {
    return { ok: false, error: 'options must be an object' };
  }
  const optionsInput = isPlainObject(optionsRaw) ? optionsRaw : {};
  const options = {};

  if (Object.prototype.hasOwnProperty.call(optionsInput, 'timeout_ms')) {
    const timeoutMs = parseIntegerLike(optionsInput.timeout_ms);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 200 || timeoutMs > 10000) {
      return { ok: false, error: 'options.timeout_ms must be between 200 and 10000' };
    }
    options.timeout_ms = timeoutMs;
  }

  if (Object.prototype.hasOwnProperty.call(optionsInput, 'max_packets')) {
    const maxPackets = parseIntegerLike(optionsInput.max_packets);
    if (!Number.isInteger(maxPackets) || maxPackets < 1 || maxPackets > 4096) {
      return { ok: false, error: 'options.max_packets must be between 1 and 4096' };
    }
    options.max_packets = maxPackets;
  }

  if (Object.prototype.hasOwnProperty.call(optionsInput, 'probe_mode')) {
    options.probe_mode = optionsInput.probe_mode === true;
  }

  if (Object.prototype.hasOwnProperty.call(optionsInput, 'command_ttl_seconds')) {
    const ttlSeconds = parseIntegerLike(optionsInput.command_ttl_seconds);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) {
      return { ok: false, error: 'options.command_ttl_seconds must be between 1 and 86400' };
    }
    options.command_ttl_seconds = ttlSeconds;
  }

  if (Object.prototype.hasOwnProperty.call(optionsInput, 'sent_stale_seconds')) {
    const sentStaleSeconds = parseIntegerLike(optionsInput.sent_stale_seconds);
    if (!Number.isInteger(sentStaleSeconds) || sentStaleSeconds < 1 || sentStaleSeconds > 86400) {
      return { ok: false, error: 'options.sent_stale_seconds must be between 1 and 86400' };
    }
    options.sent_stale_seconds = sentStaleSeconds;
  }

  const correlationId = normalizeText(payload.correlation_id) || null;

  return {
    ok: true,
    value: {
      agent_id: agentId,
      options,
      correlation_id: correlationId
    }
  };
}

function validateAgentVersionPolicyPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const minimumSupportedVersion = normalizeText(payload.minimum_supported_version);
  if (!minimumSupportedVersion) {
    return { ok: false, error: 'minimum_supported_version is required' };
  }
  if (!isValidSemverTriplet(minimumSupportedVersion)) {
    return { ok: false, error: 'minimum_supported_version must be a semver triplet (for example 1.2.3)' };
  }

  let targetVersion = null;
  if (Object.prototype.hasOwnProperty.call(payload, 'target_version')) {
    const rawTargetVersion = normalizeText(payload.target_version);
    if (rawTargetVersion) {
      if (!isValidSemverTriplet(rawTargetVersion)) {
        return { ok: false, error: 'target_version must be a semver triplet when provided' };
      }
      targetVersion = rawTargetVersion;
    }
  }

  const rolloutChannelRaw = normalizeText(payload.rollout_channel).toLowerCase();
  const rolloutChannel = rolloutChannelRaw || 'stable';
  if (!['stable', 'beta'].includes(rolloutChannel)) {
    return { ok: false, error: 'rollout_channel must be one of stable, beta' };
  }

  const metadataRaw = payload.metadata;
  if (metadataRaw !== undefined && !isPlainObject(metadataRaw)) {
    return { ok: false, error: 'metadata must be an object when provided' };
  }
  const metadata = isPlainObject(metadataRaw) ? metadataRaw : {};

  return {
    ok: true,
    value: {
      minimum_supported_version: minimumSupportedVersion,
      target_version: targetVersion,
      rollout_channel: rolloutChannel,
      metadata
    }
  };
}

function validateAgentDeviceValidationResultPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const commandId = normalizeText(payload.command_id);
  if (!commandId) {
    return { ok: false, error: 'command_id is required' };
  }
  const deviceUid = normalizeText(payload.device_uid);
  if (!deviceUid) {
    return { ok: false, error: 'device_uid is required' };
  }

  const startedAt = normalizeText(payload.started_at);
  if (startedAt && !isValidIsoDate(startedAt)) {
    return { ok: false, error: 'started_at must be valid ISO datetime when provided' };
  }

  const completedAt = normalizeText(payload.completed_at);
  if (!completedAt) {
    return { ok: false, error: 'completed_at is required' };
  }
  if (!isValidIsoDate(completedAt)) {
    return { ok: false, error: 'completed_at must be valid ISO datetime' };
  }

  const resultRaw = payload.result;
  if (!isPlainObject(resultRaw)) {
    return { ok: false, error: 'result must be an object' };
  }
  const success = resultRaw.success === true;
  const reasonCode = normalizeText(resultRaw.reason_code) || null;
  const evidence = isPlainObject(resultRaw.evidence) ? resultRaw.evidence : {};

  return {
    ok: true,
    value: {
      command_id: commandId,
      run_id: normalizeText(payload.run_id) || null,
      device_uid: deviceUid,
      started_at: startedAt ? new Date(startedAt).toISOString() : null,
      completed_at: new Date(completedAt).toISOString(),
      result: {
        success,
        reason_code: reasonCode,
        evidence
      }
    }
  };
}

function validateAgentEnrollmentAttemptResultPayload(payload) {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'payload must be an object' };
  }

  const commandId = normalizeText(payload.command_id);
  if (!commandId) {
    return { ok: false, error: 'command_id is required' };
  }
  const enrollmentAttemptId = normalizeText(payload.enrollment_attempt_id);
  if (!enrollmentAttemptId) {
    return { ok: false, error: 'enrollment_attempt_id is required' };
  }
  const deviceUid = normalizeText(payload.device_uid);
  if (!deviceUid) {
    return { ok: false, error: 'device_uid is required' };
  }

  const completedAt = normalizeText(payload.completed_at);
  if (!completedAt || !isValidIsoDate(completedAt)) {
    return { ok: false, error: 'completed_at must be valid ISO datetime' };
  }
  const startedAt = normalizeText(payload.started_at);
  if (startedAt && !isValidIsoDate(startedAt)) {
    return { ok: false, error: 'started_at must be valid ISO datetime when provided' };
  }

  const result = isPlainObject(payload.result) ? payload.result : null;
  if (!result) {
    return { ok: false, error: 'result must be an object' };
  }
  const attemptStatus = normalizeText(result.attempt_status).toLowerCase();
  const allowedStatus = new Set(['success', 'cancelled', 'partial_or_failed']);
  if (!allowedStatus.has(attemptStatus)) {
    return { ok: false, error: 'result.attempt_status must be one of success, cancelled, partial_or_failed' };
  }
  const statusReason = normalizeText(result.status_reason) || null;
  const protocolExecutionState = normalizeText(result.protocol_execution_state).toLowerCase() || null;
  const evidenceFlags = isPlainObject(result.evidence_flags) ? result.evidence_flags : {};
  const sourceMetadata = isPlainObject(result.source_metadata) ? result.source_metadata : {};
  const evidenceRefs = isPlainObject(result.evidence_refs) ? result.evidence_refs : {};

  return {
    ok: true,
    value: {
      command_id: commandId,
      enrollment_attempt_id: enrollmentAttemptId,
      run_id: normalizeText(payload.run_id) || null,
      device_uid: deviceUid,
      started_at: startedAt ? new Date(startedAt).toISOString() : null,
      completed_at: new Date(completedAt).toISOString(),
      result: {
        attempt_status: attemptStatus,
        status_reason: statusReason,
        protocol_execution_state: protocolExecutionState,
        protocol_session_ref: normalizeText(result.protocol_session_ref) || null,
        evidence_flags: evidenceFlags,
        evidence_refs: evidenceRefs,
        source_metadata: sourceMetadata
      }
    }
  };
}

module.exports = {
  COMMAND_TYPES,
  MANAGED_STATUS,
  validateScanSubnetCommandPayload,
  validateDiscoveryReportPayload,
  validateManualDeviceOnboardingPayload,
  validateManualDeviceValidationRequestPayload,
  validateAgentVersionPolicyPayload,
  validateAgentDeviceValidationResultPayload,
  validateAgentEnrollmentAttemptResultPayload
};
