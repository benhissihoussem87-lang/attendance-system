const os = require('os');
const path = require('path');
const { requestJson } = require('./lib/apiClient');
const { readState, writeState } = require('./lib/stateStore');
const { createLocalDiagnosticsTracker } = require('./lib/localDiagnosticsTracker');
const { startLocalDiagnosticsServer } = require('./lib/localDiagnosticsServer');
const { discoverDevices } = require('./lib/discovery');
const { pullDeviceEvents, runK80EnrollmentAttempt } = require('./lib/events');
const zktecoPullAdapter = require('./lib/events/zktecoPullAdapter');
const {
  countPendingBatches,
  peekNextBatch,
  enqueueBatch,
  dequeueBatch,
  markHeadBatchAttemptStarted,
  markHeadBatchAttemptFailed,
  deferHeadBatch
} = require('./lib/eventBatchBuffer');
const { createRunId, logAgentEvent } = require('./lib/bridgeLogger');
const { COMMAND_TYPES } = require('../contracts/agentBridgeContract');
const { buildDefaultRuntimeHeartbeatCapabilities } = require('../contracts/capabilityContract');
const packageJson = require('../package.json');

function envText(name, fallback = '') {
  const value = process.env[name];
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function envBool(name, fallback = false) {
  const raw = envText(name);
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on', 'y'].includes(raw.toLowerCase());
}

function integerLike(value) {
  if (Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function normalizeRolloutChannel(value, fallback = 'stable') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'stable' || normalized === 'beta') {
    return normalized;
  }
  return fallback;
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

function parseChecktypeMap(raw) {
  const input = envText(raw, '');
  if (!input) {
    return {};
  }
  try {
    const parsed = JSON.parse(input);
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

function parseAllowlistCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

const config = {
  baseUrl: envText('SAAS_BASE_URL', 'http://localhost:3000'),
  provisioningToken: envText('AGENT_PROVISIONING_TOKEN', ''),
  agentName: envText('AGENT_NAME', os.hostname()),
  stateFile: envText('AGENT_STATE_FILE', path.join(__dirname, '.state', 'agent-state.json')),
  diagnosticsStateFile: envText('AGENT_DIAGNOSTICS_STATE_FILE', path.join(__dirname, '.state', 'agent-diagnostics.json')),
  eventQueueFile: envText('AGENT_EVENT_QUEUE_FILE', path.join(__dirname, '.state', 'agent-event-batches.json')),
  heartbeatIntervalMs: envInt('AGENT_HEARTBEAT_MS', 30000),
  commandPollMs: envInt('AGENT_COMMAND_POLL_MS', 5000),
  adapterDefault: envText('AGENT_DISCOVERY_ADAPTER', 'zkteco'),
  mockDiscovery: envBool('AGENT_DISCOVERY_MOCK', false),
  mockEventPull: envBool('AGENT_EVENT_PULL_MOCK', false),
  logEmptyPolls: envBool('AGENT_LOG_EMPTY_POLLS', false),
  pullTimeoutMs: envInt('AGENT_EVENT_PULL_TIMEOUT_MS', 1600),
  pullMaxPackets: envInt('AGENT_EVENT_PULL_MAX_PACKETS', 4096),
  maxBufferedBatches: envInt('AGENT_EVENT_MAX_BUFFERED_BATCHES', 200),
  maxFlushBatchesPerLoop: envInt('AGENT_EVENT_FLUSH_MAX_PER_LOOP', 5),
  eventRetryBaseMs: Math.max(500, envInt('AGENT_EVENT_RETRY_BASE_MS', 5000)),
  eventRetryMaxMs: Math.max(1000, envInt('AGENT_EVENT_RETRY_MAX_MS', 60000)),
  diagnosticsEnabled: envBool('AGENT_DIAGNOSTICS_ENABLED', true),
  diagnosticsHost: envText('AGENT_DIAGNOSTICS_HOST', '127.0.0.1'),
  diagnosticsPort: envInt('AGENT_DIAGNOSTICS_PORT', 4780),
  rolloutChannel: normalizeRolloutChannel(envText('AGENT_ROLLOUT_CHANNEL', 'stable'), 'stable'),
  diagnosticsMaxRecentActivity: envInt('AGENT_DIAGNOSTICS_MAX_ACTIVITY', 40),
  diagnosticsMaxKnownDevices: envInt('AGENT_DIAGNOSTICS_MAX_DEVICES', 100),
  checktypeMap: parseChecktypeMap('ZKTECO_CHECKTYPE_MAP'),
  k80RtSubscriberEnabled: envBool('K80_RT_SUBSCRIBER_ENABLED', false),
  k80RtSubscriberAllowlist: parseAllowlistCsv(process.env.K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST)
};
const subscriberDeviceUid = config.k80RtSubscriberAllowlist[0] || '';
let startRealtimeSubscriberForCommand = null;
let handleMonitoringCommandForRuntime = null;

const diagnosticsTracker = createLocalDiagnosticsTracker({
  filePath: config.diagnosticsStateFile,
  maxRecentActivity: config.diagnosticsMaxRecentActivity,
  maxKnownDevices: config.diagnosticsMaxKnownDevices,
  heartbeatStaleMs: Math.max(config.heartbeatIntervalMs * 3, 90000),
  pollStaleMs: Math.max(config.commandPollMs * 3, 20000)
});

diagnosticsTracker.setAgentIdentity({
  agent_name: config.agentName,
  base_url: config.baseUrl,
  version: packageJson && packageJson.version ? packageJson.version : null,
  hostname: os.hostname(),
  platform: process.platform,
  node_version: process.version,
  k80_rt_subscriber_enabled: config.k80RtSubscriberEnabled,
  k80_rt_subscriber_device_uid: config.k80RtSubscriberAllowlist[0] || null,
  k80_rt_subscriber_allowlist_count: config.k80RtSubscriberAllowlist.length
});

function resolveRtSubscriberConnection(deviceUid, fallbackConnection) {
  const snapshot = diagnosticsTracker.buildSnapshot();
  const devices = Array.isArray(snapshot.devices) ? snapshot.devices : [];
  const device = devices.find(item => item && item.device_uid === deviceUid) || null;
  const fallback = isPlainObject(fallbackConnection) ? fallbackConnection : {};
  return {
    host: fallback.host || (device ? device.host : null) || null,
    port: integerLike(fallback.port) || (device ? device.port : null) || null,
    transport: fallback.transport || (device ? device.transport : null) || null,
    attlog_sequence: fallback.attlog_sequence || (device ? device.attlog_sequence : null) || null,
    device_number: integerLike(fallback.device_number) || (device ? device.device_number : null) || null,
    auth_password: integerLike(fallback.auth_password)
  };
}

function buildContext(state, extra) {
  return {
    agent_id: state && state.agent_id ? state.agent_id : null,
    company_id: state && state.company_id ? state.company_id : null,
    agent_name: state && state.agent_name ? state.agent_name : config.agentName,
    ...(extra && typeof extra === 'object' ? extra : {})
  };
}

async function bootstrapIfNeeded(state) {
  if (state.agent_id && state.auth_token && state.company_id) {
    logAgentEvent('agent.bootstrap.skipped', buildContext(state, {
      reason: 'state_exists',
      credential_version: state.credential_version || null
    }));
    return state;
  }
  if (!config.provisioningToken) {
    throw new Error('AGENT_PROVISIONING_TOKEN is required for first bootstrap');
  }
  logAgentEvent('agent.bootstrap.requested', {
    agent_name: config.agentName,
    base_url: config.baseUrl
  });
  const response = await requestJson({
    baseUrl: config.baseUrl,
    method: 'POST',
    path: '/api/agent/bootstrap',
    body: {
      provisioning_token: config.provisioningToken,
      agent_name: config.agentName,
      metadata: {
        hostname: os.hostname(),
        platform: process.platform,
        release: os.release(),
        node_version: process.version
      }
    }
  });
  if (response.status !== 201 || !response.body || !response.body.auth_token) {
    logAgentEvent('agent.bootstrap.failed', {
      agent_name: config.agentName,
      status: response.status,
      error_code: response.body && response.body.code ? response.body.code : null
    });
    throw new Error(`bootstrap failed: status=${response.status}`);
  }
  const nextState = {
    agent_id: response.body.agent_id,
    company_id: response.body.company_id,
    agent_name: response.body.agent_name,
    auth_token: response.body.auth_token,
    credential_version: response.body.credential_version,
    active_runtime_identity_id: response.body.active_runtime_identity_id || null,
    identity_status: response.body.identity_status || 'active',
    runtime_identity_issued_at: response.body.runtime_identity_issued_at || null,
    registered_at: response.body.registered_at
  };
  writeState(config.stateFile, nextState);
  logAgentEvent('agent.bootstrap.succeeded', buildContext(nextState, {
    credential_version: nextState.credential_version,
    registered_at: nextState.registered_at
  }));
  return nextState;
}

async function sendHeartbeat(state, trace) {
  diagnosticsTracker.recordHeartbeatAttempt();
  try {
    const response = await requestJson({
      baseUrl: config.baseUrl,
      method: 'POST',
      path: '/api/agent/heartbeat',
      authToken: state.auth_token,
      body: {
        uptime_sec: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        loadavg: os.loadavg(),
        hostname: os.hostname(),
        platform: process.platform,
        agent_version: packageJson && packageJson.version ? packageJson.version : null,
        rollout_channel: config.rolloutChannel,
        capabilities: buildDefaultRuntimeHeartbeatCapabilities()
      }
    });
    if (response.status !== 200) {
      diagnosticsTracker.recordHeartbeatResult({
        ok: false,
        status: response.status,
        error: response.body && response.body.code ? response.body.code : 'heartbeat_rejected'
      });
      logAgentEvent('agent.heartbeat.failed', buildContext(state, {
        ...(trace && typeof trace === 'object' ? trace : {}),
        status: response.status,
        error_code: response.body && response.body.code ? response.body.code : null
      }));
      return false;
    }
    diagnosticsTracker.recordHeartbeatResult({
      ok: true,
      status: response.status,
      saasLastHeartbeatAt: response.body ? response.body.last_heartbeat_at : null
    });
    logAgentEvent('agent.heartbeat.ok', buildContext(state, {
      ...(trace && typeof trace === 'object' ? trace : {}),
      status: response.status,
      last_heartbeat_at: response.body ? response.body.last_heartbeat_at : null
    }));
    return true;
  } catch (err) {
    diagnosticsTracker.recordHeartbeatResult({
      ok: false,
      error: err && err.message ? err.message : 'heartbeat_request_error'
    });
    logAgentEvent('agent.heartbeat.failed', buildContext(state, {
      ...(trace && typeof trace === 'object' ? trace : {}),
      status: null,
      error_code: null,
      error: err && err.message ? err.message : String(err)
    }));
    return false;
  }
}

async function pollNextCommand(state) {
  diagnosticsTracker.recordPollAttempt();
  try {
    const response = await requestJson({
      baseUrl: config.baseUrl,
      method: 'POST',
      path: '/api/agent/commands/next',
      authToken: state.auth_token,
      body: {}
    });
    if (response.status !== 200) {
      diagnosticsTracker.recordPollFailure(
        response.body && response.body.code ? response.body.code : `status_${response.status}`
      );
      logAgentEvent('agent.command.poll_failed', buildContext(state, {
        status: response.status,
        error_code: response.body && response.body.code ? response.body.code : null
      }));
      return null;
    }
    const command = response.body ? response.body.command : null;
    if (!command) {
      diagnosticsTracker.recordPollEmpty();
      if (config.logEmptyPolls) {
        logAgentEvent('agent.command.poll_empty', buildContext(state));
      }
      return null;
    }
    diagnosticsTracker.recordCommandReceived(command);
    logAgentEvent('agent.command.received', buildContext(state, {
      command_id: command.id,
      command_type: command.type
    }));
    return command;
  } catch (err) {
    diagnosticsTracker.recordPollFailure(err && err.message ? err.message : 'poll_request_error');
    logAgentEvent('agent.command.poll_failed', buildContext(state, {
      status: null,
      error_code: null,
      error: err && err.message ? err.message : String(err)
    }));
    return null;
  }
}

async function handleScanSubnetCommand(state, command) {
  const payload = command.payload || {};
  const subnetTargets = Array.isArray(payload.subnet_targets) ? payload.subnet_targets : [];
  const options = payload.options || {};
  const adapterId = options.adapter || config.adapterDefault;
  const runId = createRunId();
  const trace = {
    command_id: command.id,
    run_id: runId,
    adapter_id: adapterId
  };

  logAgentEvent('agent.discovery.scan_started', buildContext(state, {
    ...trace,
    subnet_targets: subnetTargets
  }));
  const discovery = await discoverDevices({
    adapterId,
    subnetTargets,
    options: {
      ...options,
      mock_mode: config.mockDiscovery,
      on_host_result: hostResult => {
        logAgentEvent('agent.discovery.host_result', buildContext(state, {
          ...trace,
          ip: hostResult.ip,
          outcome_class: hostResult.outcome_class,
          confirmation_state: hostResult.confirmation_state,
          confidence: hostResult.confidence,
          confidence_class: hostResult.confidence_class,
          failure_reason: hostResult.failure_reason,
          tcp_port_open: hostResult.tcp_port_open,
          zk_response_received: hostResult.zk_response_received,
          zk_handshake_ok: hostResult.zk_handshake_ok,
          serial_number: hostResult.serial_number,
          mac: hostResult.mac
        }));
      }
    }
  });
  logAgentEvent('agent.discovery.scan_completed', buildContext(state, {
    ...trace,
    summary: discovery.summary || {},
    discovered_devices_count: Array.isArray(discovery.discovered_devices)
      ? discovery.discovered_devices.length
      : 0
  }));

  const reportResponse = await requestJson({
    baseUrl: config.baseUrl,
    method: 'POST',
    path: '/api/agent/discovery-reports',
    authToken: state.auth_token,
    body: {
      command_id: command.id,
      adapter_id: discovery.adapter_id,
      subnet_targets: subnetTargets,
      reported_at: new Date().toISOString(),
      discovered_devices: discovery.discovered_devices,
      summary: {
        discovered_devices_count: discovery.discovered_devices.length,
        run_id: runId,
        command_id: command.id,
        ...(discovery.summary || {})
      }
    }
  });

  if (reportResponse.status !== 201) {
    logAgentEvent('agent.discovery.report_failed', buildContext(state, {
      ...trace,
      status: reportResponse.status,
      error_code: reportResponse.body && reportResponse.body.code ? reportResponse.body.code : null
    }));
    return {
      ok: false,
      reason_code: 'discovery_report_submit_failed',
      details: {
        status: reportResponse.status,
        error_code: reportResponse.body && reportResponse.body.code ? reportResponse.body.code : null
      }
    };
  }
  const reportId = reportResponse.body ? reportResponse.body.report_id : null;
  logAgentEvent('agent.discovery.report_submitted', buildContext(state, {
    ...trace,
    report_id: reportId
  }));
  return {
    ok: true,
    reason_code: 'discovery_report_submitted',
    details: {
      report_id: reportId,
      discovered_devices_count: Array.isArray(discovery.discovered_devices)
        ? discovery.discovered_devices.length
        : 0
    }
  };
}

function buildEventBatchPayload({
  command,
  runId,
  pullStartedAt,
  pullCompletedAt,
  commandPayload,
  pullResult
}) {
  const payload = isPlainObject(commandPayload) ? commandPayload : {};
  const pullMeta = isPlainObject(payload.pull) ? payload.pull : {};
  const diagnostics = pullResult && isPlainObject(pullResult.diagnostics)
    ? pullResult.diagnostics
    : {};
  const events = pullResult && Array.isArray(pullResult.events) ? pullResult.events : [];
  const latestEventTimeUtc = pullResult && typeof pullResult.latest_event_time_utc === 'string'
    ? pullResult.latest_event_time_utc
    : null;

  return {
    command_id: command.id,
    run_id: runId,
    delivery_id: runId,
    delivery_attempt: 1,
    device_uid: payload.device_uid,
    vendor: payload.vendor || 'zkteco',
    ingest_method: payload.ingest_method || 'agent_pull',
    device_timezone: pullMeta.device_timezone || null,
    pull_started_at: pullStartedAt,
    pull_completed_at: pullCompletedAt,
    cursor: {
      requested_since_utc: pullMeta.requested_since_utc || null,
      latest_event_time_utc: latestEventTimeUtc,
      has_more: false
    },
    summary: {
      pull_ok: pullResult ? pullResult.ok === true : false,
      events_count: events.length,
      diagnostics
    },
    events
  };
}

function buildRealtimeProvisionalBatchPayload({
  runId,
  pullStartedAt,
  pullCompletedAt,
  commandPayload,
  pullResult
}) {
  const payload = isPlainObject(commandPayload) ? commandPayload : {};
  const pullMeta = isPlainObject(payload.pull) ? payload.pull : {};
  const diagnostics = pullResult && isPlainObject(pullResult.diagnostics)
    ? pullResult.diagnostics
    : {};
  const provisional = pullResult && isPlainObject(pullResult.realtime_provisional)
    ? pullResult.realtime_provisional
    : {};
  const events = pullResult && Array.isArray(pullResult.realtime_provisional_events)
    ? pullResult.realtime_provisional_events
    : [];
  const latestEventTimeUtc = events.length > 0
    ? events
      .map(event => (event && typeof event.event_time_utc === 'string' ? event.event_time_utc : null))
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || null
    : null;
  return {
    run_id: `${runId}:rt01f4`,
    delivery_id: `${runId}:rt01f4`,
    delivery_attempt: 1,
    device_uid: payload.device_uid,
    vendor: payload.vendor || 'zkteco',
    ingest_method: 'agent_realtime',
    device_timezone: pullMeta.device_timezone || null,
    pull_started_at: pullStartedAt,
    pull_completed_at: pullCompletedAt,
    cursor: {
      requested_since_utc: pullMeta.requested_since_utc || null,
      latest_event_time_utc: latestEventTimeUtc,
      has_more: false
    },
    summary: {
      pull_ok: true,
      events_count: events.length,
      diagnostics: {
        ...diagnostics,
        realtime_provisional_events_received:
          Number.isInteger(provisional.realtime_provisional_events_received)
            ? provisional.realtime_provisional_events_received
            : 0,
        realtime_provisional_events_inserted:
          Number.isInteger(provisional.realtime_provisional_events_inserted)
            ? provisional.realtime_provisional_events_inserted
            : 0,
        realtime_provisional_events_skipped_no_person:
          Number.isInteger(provisional.realtime_provisional_events_skipped_no_person)
            ? provisional.realtime_provisional_events_skipped_no_person
            : 0,
        realtime_provisional_events_reconciled_by_pull: 0,
        realtime_provisional_events_left_unreconciled:
          Number.isInteger(provisional.realtime_provisional_events_inserted)
            ? provisional.realtime_provisional_events_inserted
            : events.length
      }
    },
    events
  };
}

function buildRealtimeSubscriberBatchPayload({
  runId,
  pullStartedAt,
  pullCompletedAt,
  deviceUid,
  vendor,
  deviceTimezone,
  events,
  diagnostics
}) {
  const safeEvents = Array.isArray(events) ? events : [];
  const latestEventTimeUtc = safeEvents.length > 0
    ? safeEvents
      .map(event => (event && typeof event.event_time_utc === 'string' ? event.event_time_utc : null))
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || null
    : null;
  return {
    run_id: `${runId}:rt_subscriber`,
    delivery_id: `${runId}:rt_subscriber`,
    delivery_attempt: 1,
    device_uid: deviceUid,
    vendor: vendor || 'zkteco',
    ingest_method: 'agent_realtime',
    device_timezone: deviceTimezone || null,
    pull_started_at: pullStartedAt,
    pull_completed_at: pullCompletedAt,
    cursor: {
      requested_since_utc: null,
      latest_event_time_utc: latestEventTimeUtc,
      has_more: false
    },
    summary: {
      pull_ok: true,
      events_count: safeEvents.length,
      diagnostics: isPlainObject(diagnostics) ? diagnostics : {}
    },
    events: safeEvents
  };
}

function classifyValidationResult(pullResult) {
  const result = isPlainObject(pullResult) ? pullResult : {};
  const diagnostics = isPlainObject(result.diagnostics) ? result.diagnostics : {};
  const protocol = isPlainObject(diagnostics.protocol) ? diagnostics.protocol : {};
  const connectAckSeen = Number.isInteger(protocol.connect_ack);
  const authRequired = protocol.auth_required === true;
  const authSucceeded = authRequired ? protocol.auth_succeeded === true : true;
  const attlogAckSeen = Number.isInteger(protocol.attlog_ack);
  const handshakeProof = connectAckSeen && authSucceeded && attlogAckSeen;

  const success = result.ok === true || handshakeProof;
  return {
    success,
    reason_code: success
      ? (result.ok === true ? 'validation_succeeded' : 'validation_handshake_succeeded')
      : (typeof diagnostics.failure_reason === 'string' && diagnostics.failure_reason.trim()
          ? diagnostics.failure_reason.trim()
          : 'validation_failed'),
    evidence: {
      pull_ok: result.ok === true,
      handshake_proved: handshakeProof,
      event_count: Array.isArray(result.events) ? result.events.length : 0,
      latest_event_time_utc: typeof result.latest_event_time_utc === 'string'
        ? result.latest_event_time_utc
        : null,
      diagnostics
    }
  };
}

async function submitEventBatch(state, payload, trace) {
  let response;
  try {
    response = await requestJson({
      baseUrl: config.baseUrl,
      method: 'POST',
      path: '/api/agent/device-events/batch',
      authToken: state.auth_token,
      body: payload
    });
  } catch (err) {
    const errorMessage = err && err.message ? err.message : 'request_error';
    logAgentEvent('agent.events.batch_submit.failed', buildContext(state, {
      ...(trace && typeof trace === 'object' ? trace : {}),
      status: null,
      error_code: null,
      error: errorMessage,
      event_count: Array.isArray(payload.events) ? payload.events.length : 0
    }));
    return {
      ok: false,
      status: null,
      error: errorMessage
    };
  }

  if (response.status !== 201) {
    logAgentEvent('agent.events.batch_submit.failed', buildContext(state, {
      ...(trace && typeof trace === 'object' ? trace : {}),
      status: response.status,
      error_code: response.body && response.body.code ? response.body.code : null,
      event_count: Array.isArray(payload.events) ? payload.events.length : 0
    }));
    return {
      ok: false,
      status: response.status,
      error: response.body && response.body.code ? response.body.code : 'submit_rejected'
    };
  }

  logAgentEvent('agent.events.batch_submit.succeeded', buildContext(state, {
    ...(trace && typeof trace === 'object' ? trace : {}),
    status: response.status,
    batch_id: response.body ? response.body.batch_id : null,
    inserted_count: response.body ? response.body.inserted_count : null,
    deduped_count: response.body ? response.body.deduped_count : null,
    rejected_count: response.body ? response.body.rejected_count : null
  }));
  return {
    ok: true,
    status: response.status,
    body: response.body || {}
  };
}

async function submitMonitoringCommandResult(state, payload, trace) {
  const response = await requestJson({
    baseUrl: config.baseUrl,
    method: 'POST',
    path: '/api/agent/monitoring-command-results',
    authToken: state.auth_token,
    body: payload
  });

  if (response.status < 200 || response.status >= 300) {
    logAgentEvent('agent.monitoring.result_submit.failed', buildContext(state, {
      ...(trace && typeof trace === 'object' ? trace : {}),
      status: response.status,
      error_code: response.body && response.body.code ? response.body.code : null
    }));
    return {
      ok: false,
      status: response.status,
      error: response.body && response.body.code ? response.body.code : 'submit_rejected'
    };
  }

  logAgentEvent('agent.monitoring.result_submit.succeeded', buildContext(state, {
    ...(trace && typeof trace === 'object' ? trace : {}),
    status: response.status,
    monitoring_session_id: payload.monitoring_session_id || null,
    runtime_monitoring_state: payload.runtime_monitoring_state || null
  }));
  return { ok: true, status: response.status, body: response.body || {} };
}

async function submitDeviceValidationResult(state, payload, trace) {
  const response = await requestJson({
    baseUrl: config.baseUrl,
    method: 'POST',
    path: '/api/agent/device-validations/result',
    authToken: state.auth_token,
    body: payload
  });

  if (response.status !== 201) {
    logAgentEvent('agent.validation.result_submit.failed', buildContext(state, {
      ...(trace && typeof trace === 'object' ? trace : {}),
      status: response.status,
      error_code: response.body && response.body.code ? response.body.code : null
    }));
    return { ok: false, status: response.status };
  }

  logAgentEvent('agent.validation.result_submit.succeeded', buildContext(state, {
    ...(trace && typeof trace === 'object' ? trace : {}),
    status: response.status,
    validation_status: response.body ? response.body.validation_status : null
  }));
  return {
    ok: true,
    status: response.status,
    body: response.body || {}
  };
}

async function submitDevicePathPullCapabilityProbeResult(state, payload, trace) {
  const response = await requestJson({
    baseUrl: config.baseUrl,
    method: 'POST',
    path: '/api/agent/device-path-pull-capability-probes/result',
    authToken: state.auth_token,
    body: payload
  });

  if (response.status !== 201) {
    logAgentEvent('agent.device_path_pull_capability_probe.result_submit.failed', buildContext(state, {
      ...(trace && typeof trace === 'object' ? trace : {}),
      status: response.status,
      error_code: response.body && response.body.code ? response.body.code : null
    }));
    return { ok: false, status: response.status };
  }

  logAgentEvent('agent.device_path_pull_capability_probe.result_submit.succeeded', buildContext(state, {
    ...(trace && typeof trace === 'object' ? trace : {}),
    status: response.status,
    capability_status: response.body ? response.body.capability_status : null
  }));
  return {
    ok: true,
    status: response.status,
    body: response.body || {}
  };
}

async function submitEnrollmentAttemptResult(state, payload, trace) {
  const response = await requestJson({
    baseUrl: config.baseUrl,
    method: 'POST',
    path: '/api/agent/enrollment-attempts/result',
    authToken: state.auth_token,
    body: payload
  });

  if (response.status !== 201) {
    logAgentEvent('agent.enrollment.result_submit.failed', buildContext(state, {
      ...(trace && typeof trace === 'object' ? trace : {}),
      status: response.status,
      error_code: response.body && response.body.code ? response.body.code : null
    }));
    return { ok: false, status: response.status };
  }

  logAgentEvent('agent.enrollment.result_submit.succeeded', buildContext(state, {
    ...(trace && typeof trace === 'object' ? trace : {}),
    status: response.status,
    attempt_status: response.body ? response.body.attempt_status : null
  }));
  return {
    ok: true,
    status: response.status,
    body: response.body || {}
  };
}

function normalizeIsoOrNull(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function computeRetryDelayMs(attemptCount) {
  const attempt = Number.isInteger(attemptCount) && attemptCount > 0 ? attemptCount : 1;
  const exponent = Math.max(0, attempt - 1);
  const raw = config.eventRetryBaseMs * (2 ** exponent);
  return Math.min(raw, config.eventRetryMaxMs);
}

async function flushPendingEventBatches(state, trace = {}) {
  const pending = countPendingBatches(config.eventQueueFile);
  if (pending <= 0) {
    return;
  }

  logAgentEvent('agent.events.buffer.flush_started', buildContext(state, {
    ...(trace && typeof trace === 'object' ? trace : {}),
    pending_batches: pending
  }));

  let flushed = 0;
  for (let i = 0; i < config.maxFlushBatchesPerLoop; i += 1) {
    const next = peekNextBatch(config.eventQueueFile);
    if (!next) {
      break;
    }
    const nowIso = new Date().toISOString();
    const nextRetryAt = normalizeIsoOrNull(next.next_retry_at);
    if (nextRetryAt && new Date(nextRetryAt).getTime() > Date.now()) {
      if (countPendingBatches(config.eventQueueFile) > 1) {
        const deferred = deferHeadBatch(config.eventQueueFile, {
          attemptedAtIso: nowIso,
          httpStatus: next.last_attempt_http_status,
          error: next.last_attempt_error || null,
          nextRetryAtIso: nextRetryAt,
          deferredReason: 'head_retry_window_blocking'
        });
        logAgentEvent('agent.events.buffer.head_deferred', buildContext(state, {
          ...(trace && typeof trace === 'object' ? trace : {}),
          command_id: next.command_id || null,
          run_id: next.run_id || null,
          device_uid: next.device_uid || null,
          delivery_id: next.delivery_id || null,
          delivery_attempt: next.delivery_attempt_count || null,
          defer_reason: 'head_retry_window_blocking',
          blocked_retry_at: nextRetryAt,
          blocked_status: next.last_attempt_http_status,
          blocked_error: next.last_attempt_error || null,
          pending_batches: countPendingBatches(config.eventQueueFile),
          deferred_delivery_id: deferred ? deferred.delivery_id : null,
          blocker_classification: 'head_entry_blocking_fixed'
        }));
        continue;
      }
      break;
    }

    const claimed = markHeadBatchAttemptStarted(config.eventQueueFile, nowIso);
    const batchForAttempt = claimed || next;

    const submit = await submitEventBatch(state, batchForAttempt.payload, {
      ...(trace && typeof trace === 'object' ? trace : {}),
      command_id: batchForAttempt.command_id || null,
      run_id: batchForAttempt.run_id || null,
      device_uid: batchForAttempt.device_uid || null,
      delivery_id: batchForAttempt.delivery_id || null,
      delivery_attempt: batchForAttempt.delivery_attempt_count || null,
      buffered: true
    });
    if (!submit.ok) {
      const currentAttempt = Number.isInteger(batchForAttempt.delivery_attempt_count)
        ? batchForAttempt.delivery_attempt_count
        : 1;
      const retryDelayMs = computeRetryDelayMs(currentAttempt);
      const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
      if (countPendingBatches(config.eventQueueFile) > 1) {
        const deferred = deferHeadBatch(config.eventQueueFile, {
          attemptedAtIso: nowIso,
          httpStatus: submit.status,
          error: submit.error || null,
          nextRetryAtIso: retryAt,
          deferredReason: 'head_submit_failed_blocking'
        });
        logAgentEvent('agent.events.buffer.head_deferred', buildContext(state, {
          ...(trace && typeof trace === 'object' ? trace : {}),
          command_id: batchForAttempt.command_id || null,
          run_id: batchForAttempt.run_id || null,
          device_uid: batchForAttempt.device_uid || null,
          delivery_id: batchForAttempt.delivery_id || null,
          delivery_attempt: currentAttempt,
          defer_reason: 'head_submit_failed_blocking',
          retry_in_ms: retryDelayMs,
          retry_at: retryAt,
          submit_status: submit.status,
          submit_error: submit.error || null,
          deferred_delivery_id: deferred ? deferred.delivery_id : null,
          pending_batches: countPendingBatches(config.eventQueueFile),
          blocker_classification: 'head_entry_blocking_fixed'
        }));
        continue;
      }
      const failed = markHeadBatchAttemptFailed(config.eventQueueFile, {
        attemptedAtIso: nowIso,
        httpStatus: submit.status,
        error: submit.error || null,
        nextRetryAtIso: retryAt
      });
      logAgentEvent('agent.events.buffer.retry_scheduled', buildContext(state, {
        ...(trace && typeof trace === 'object' ? trace : {}),
        command_id: batchForAttempt.command_id || null,
        run_id: batchForAttempt.run_id || null,
        device_uid: batchForAttempt.device_uid || null,
        delivery_id: batchForAttempt.delivery_id || null,
        delivery_attempt: currentAttempt,
        retry_in_ms: retryDelayMs,
        retry_at: retryAt,
        submit_status: submit.status,
        submit_error: submit.error || null,
        pending_batches: countPendingBatches(config.eventQueueFile),
        next_retry_at: failed ? failed.next_retry_at : retryAt
      }));
      break;
    }
    dequeueBatch(config.eventQueueFile);
    flushed += 1;
  }

  logAgentEvent('agent.events.buffer.flush_completed', buildContext(state, {
    ...(trace && typeof trace === 'object' ? trace : {}),
    flushed_batches: flushed,
    remaining_batches: countPendingBatches(config.eventQueueFile)
  }));
}

async function handlePullDeviceEventsCommand(state, command) {
  const commandPayload = isPlainObject(command.payload) ? command.payload : {};
  const pullMeta = isPlainObject(commandPayload.pull) ? commandPayload.pull : {};
  const connection = isPlainObject(commandPayload.connection) ? commandPayload.connection : {};
  diagnosticsTracker.recordRtSubscriberAuthTrace({
    hop: 'command_payload_connection',
    auth_present: Object.prototype.hasOwnProperty.call(connection, 'auth_password'),
    auth_integer: Number.isInteger(integerLike(connection.auth_password)),
    source: 'command_payload'
  });
  if (config.k80RtSubscriberEnabled && subscriberDeviceUid
      && typeof startRealtimeSubscriberForCommand === 'function'
      && String(commandPayload.device_uid || '').trim() === String(subscriberDeviceUid || '').trim()) {
    startRealtimeSubscriberForCommand(connection);
  }
  const runId = createRunId();
  const trace = {
    command_id: command.id,
    run_id: runId,
    device_uid: commandPayload.device_uid || null
  };

  const pullStartedAt = new Date().toISOString();
  logAgentEvent('agent.events.pull.started', buildContext(state, {
    ...trace,
    host: connection.host || null,
    port: connection.port || null,
    requested_since_utc: pullMeta.requested_since_utc || null,
    max_events: pullMeta.max_events || null,
    device_timezone: pullMeta.device_timezone || null
  }));

  let pullResult;
  try {
    pullResult = await pullDeviceEvents(commandPayload, {
      timeout_ms: config.pullTimeoutMs,
      max_packets: config.pullMaxPackets,
      mock_mode: config.mockEventPull,
      checktype_map: config.checktypeMap
    });
  } catch (err) {
    pullResult = {
      ok: false,
      events: [],
      latest_event_time_utc: null,
      diagnostics: {
        failure_reason: err && err.message ? err.message : 'pull_exception'
      }
    };
  }

  const pullCompletedAt = new Date().toISOString();
  logAgentEvent('agent.events.pull.completed', buildContext(state, {
    ...trace,
    pull_ok: pullResult.ok === true,
    event_count: Array.isArray(pullResult.events) ? pullResult.events.length : 0,
    latest_event_time_utc: pullResult.latest_event_time_utc || null,
    diagnostics: isPlainObject(pullResult.diagnostics) ? pullResult.diagnostics : {}
  }));

  const eventBatchPayload = buildEventBatchPayload({
    command,
    runId,
    pullStartedAt,
    pullCompletedAt,
    commandPayload,
    pullResult
  });

  const submit = await submitEventBatch(state, eventBatchPayload, trace);
  if (submit.ok) {
    const realtimeBatchPayload = buildRealtimeProvisionalBatchPayload({
      runId,
      pullStartedAt,
      pullCompletedAt,
      commandPayload,
      pullResult
    });
    let realtimeSubmit = null;
    if (Array.isArray(realtimeBatchPayload.events) && realtimeBatchPayload.events.length > 0) {
      realtimeSubmit = await submitEventBatch(state, realtimeBatchPayload, {
        ...trace,
        reason: 'realtime_provisional_01f4'
      });
    }
    return {
      ok: true,
      reason_code: 'pull_batch_submitted',
      event_count: Array.isArray(pullResult.events) ? pullResult.events.length : 0,
      latest_event_time_utc: pullResult.latest_event_time_utc || null,
      details: {
        batch_id: submit.body && submit.body.batch_id ? submit.body.batch_id : null,
        inserted_count: submit.body && Number.isInteger(submit.body.inserted_count)
          ? submit.body.inserted_count
          : null,
        deduped_count: submit.body && Number.isInteger(submit.body.deduped_count)
          ? submit.body.deduped_count
          : null,
        realtime_provisional_batch_id: realtimeSubmit && realtimeSubmit.ok && realtimeSubmit.body
          ? realtimeSubmit.body.batch_id || null
          : null
      }
    };
  }

  const enqueueResult = enqueueBatch(config.eventQueueFile, {
    ts: new Date().toISOString(),
    command_id: command.id,
    run_id: runId,
    device_uid: commandPayload.device_uid || null,
    payload: eventBatchPayload
  }, config.maxBufferedBatches);

  if (!enqueueResult.ok) {
    logAgentEvent('agent.events.batch_buffer_failed', buildContext(state, {
      ...trace,
      error: enqueueResult.error,
      pending_batches: enqueueResult.count
    }));
    return {
      ok: false,
      reason_code: 'pull_batch_buffer_failed',
      event_count: Array.isArray(pullResult.events) ? pullResult.events.length : 0,
      latest_event_time_utc: pullResult.latest_event_time_utc || null,
      details: {
        buffer_error: enqueueResult.error,
        pending_batches: enqueueResult.count
      }
    };
  }

  logAgentEvent('agent.events.batch_buffered', buildContext(state, {
    ...trace,
    pending_batches: enqueueResult.count
  }));
  return {
    ok: true,
    reason_code: 'pull_batch_buffered',
    event_count: Array.isArray(pullResult.events) ? pullResult.events.length : 0,
    latest_event_time_utc: pullResult.latest_event_time_utc || null,
    details: {
      pending_batches: enqueueResult.count
    }
  };
}

async function handleDeviceMonitoringCommand(state, command) {
  const commandPayload = isPlainObject(command.payload) ? command.payload : {};
  const trace = {
    command_id: command.id,
    command_type: command.type,
    monitoring_session_id: commandPayload.monitoring_session_id || null,
    device_uid: commandPayload.device_uid || null
  };
  let result;
  if (typeof handleMonitoringCommandForRuntime !== 'function') {
    result = {
      ok: false,
      runtime_monitoring_state: 'failed',
      reason_code: 'monitoring_runtime_unavailable',
      diagnostics: { handler_available: false }
    };
  } else {
    result = await handleMonitoringCommandForRuntime(command.type, commandPayload);
  }
  const payload = {
    command_id: command.id,
    monitoring_session_id: commandPayload.monitoring_session_id || null,
    device_uid: commandPayload.device_uid || null,
    ok: result && result.ok === true,
    runtime_monitoring_state: result && result.runtime_monitoring_state
      ? result.runtime_monitoring_state
      : (result && result.ok === true ? 'active' : 'failed'),
    rt_subscriber_started: result && result.rt_subscriber_started === true,
    rt_subscriber_already_running: result && result.rt_subscriber_already_running === true,
    rt_subscriber_stopped: result && result.rt_subscriber_stopped === true,
    stop_reason: result && result.stop_reason ? result.stop_reason : commandPayload.reason,
    reason_code: result && result.reason_code ? result.reason_code : null,
    error: result && result.error ? result.error : null,
    diagnostics: result && isPlainObject(result.diagnostics) ? result.diagnostics : {}
  };
  const submit = await submitMonitoringCommandResult(state, payload, trace);
  if (!submit.ok) {
    return {
      ok: false,
      reason_code: submit.error || 'monitoring_result_submit_failed',
      details: payload
    };
  }
  return {
    ok: payload.ok,
    reason_code: payload.ok ? 'monitoring_command_completed' : (payload.reason_code || 'monitoring_command_failed'),
    details: payload
  };
}

async function handleDevicePathPullCapabilityRefreshCommand(state, command) {
  const commandPayload = isPlainObject(command.payload) ? command.payload : {};
  const pullMeta = isPlainObject(commandPayload.pull) ? commandPayload.pull : {};
  const connection = isPlainObject(commandPayload.connection) ? commandPayload.connection : {};
  const runId = createRunId();
  const trace = {
    command_id: command.id,
    run_id: runId,
    device_uid: commandPayload.device_uid || null,
    probe_mode: 'bounded_pull_path_probe_v1'
  };

  logAgentEvent('agent.device_path_pull_capability_probe.started', buildContext(state, {
    ...trace,
    host: connection.host || null,
    port: connection.port || null,
    requested_since_utc: pullMeta.requested_since_utc || null,
    max_events: pullMeta.max_events || null
  }));

  let pullResult;
  try {
    pullResult = await pullDeviceEvents(commandPayload, {
      timeout_ms: config.pullTimeoutMs,
      max_packets: config.pullMaxPackets,
      mock_mode: config.mockEventPull,
      checktype_map: config.checktypeMap,
      probe_mode: true
    });
  } catch (err) {
    pullResult = {
      ok: false,
      events: [],
      latest_event_time_utc: null,
      diagnostics: {
        failure_reason: err && err.message ? err.message : 'pull_probe_exception'
      }
    };
  }

  const diagnostics = isPlainObject(pullResult.diagnostics) ? pullResult.diagnostics : {};
  const protocol = isPlainObject(diagnostics.protocol) ? diagnostics.protocol : {};
  const success = pullResult.ok === true;
  const reasonCode = success
    ? 'fresh_pull_path_probe_succeeded'
    : (typeof diagnostics.failure_reason === 'string' && diagnostics.failure_reason.trim()
      ? diagnostics.failure_reason.trim()
      : 'fresh_pull_path_probe_failed');

  logAgentEvent('agent.device_path_pull_capability_probe.completed', buildContext(state, {
    ...trace,
    probe_ok: success,
    reason_code: reasonCode,
    final_attlog_payload_bytes: Number.isInteger(protocol.final_attlog_payload_bytes)
      ? protocol.final_attlog_payload_bytes
      : null,
    events_count: Array.isArray(pullResult.events) ? pullResult.events.length : 0
  }));

  const submit = await submitDevicePathPullCapabilityProbeResult(state, {
    command_id: command.id,
    device_uid: commandPayload.device_uid || null,
    completed_at: new Date().toISOString(),
    result: {
      success,
      reason_code: reasonCode,
      diagnostics: {
        pull_ok: pullResult.ok === true,
        event_count: Array.isArray(pullResult.events) ? pullResult.events.length : 0,
        latest_event_time_utc: pullResult.latest_event_time_utc || null,
        final_attlog_payload_bytes: Number.isInteger(protocol.final_attlog_payload_bytes)
          ? protocol.final_attlog_payload_bytes
          : null,
        final_parser_merged_candidates: Number.isInteger(protocol.final_parser_merged_candidates)
          ? protocol.final_parser_merged_candidates
          : null,
        failure_reason: diagnostics.failure_reason || null
      }
    }
  }, trace);

  return {
    ok: submit.ok === true && success,
    reason_code: submit.ok === true ? reasonCode : 'probe_result_submit_failed',
    details: {
      result_submit_ok: submit.ok === true,
      capability_status: submit.body ? submit.body.capability_status || null : null
    }
  };
}

async function handleValidateDeviceCandidateCommand(state, command) {
  const commandPayload = isPlainObject(command.payload) ? command.payload : {};
  const validation = isPlainObject(commandPayload.validation) ? commandPayload.validation : {};
  const connection = isPlainObject(commandPayload.connection) ? commandPayload.connection : {};
  const runId = createRunId();
  const trace = {
    command_id: command.id,
    run_id: runId,
    device_uid: commandPayload.device_uid || null
  };

  const startedAt = new Date().toISOString();
  logAgentEvent('agent.validation.started', buildContext(state, {
    ...trace,
    host: connection.host || null,
    port: connection.port || null,
    transport: connection.transport || null,
    attlog_sequence: connection.attlog_sequence || null
  }));

  let pullResult;
  try {
    pullResult = await pullDeviceEvents(commandPayload, {
      timeout_ms: Number.isInteger(validation.timeout_ms) ? validation.timeout_ms : config.pullTimeoutMs,
      max_packets: Number.isInteger(validation.max_packets) ? validation.max_packets : config.pullMaxPackets,
      checktype_map: config.checktypeMap,
      mock_mode: validation.mock_mode === true ? true : config.mockEventPull,
      probe_mode: true
    });
  } catch (err) {
    pullResult = {
      ok: false,
      events: [],
      latest_event_time_utc: null,
      diagnostics: {
        failure_reason: err && err.message ? err.message : 'validation_exception'
      }
    };
  }

  const completedAt = new Date().toISOString();
  const classified = classifyValidationResult(pullResult);
  const resultPayload = {
    command_id: command.id,
    run_id: runId,
    device_uid: commandPayload.device_uid || '',
    started_at: startedAt,
    completed_at: completedAt,
    result: classified
  };

  logAgentEvent('agent.validation.completed', buildContext(state, {
    ...trace,
    success: classified.success,
    reason_code: classified.reason_code,
    handshake_proved: classified.evidence.handshake_proved === true
  }));

  const submit = await submitDeviceValidationResult(state, resultPayload, trace);
  if (!submit.ok) {
    return {
      ok: false,
      reason_code: 'validation_result_submit_failed',
      handshake_proved: classified.evidence.handshake_proved === true,
      details: {
        submit_status: submit.status,
        validation_reason_code: classified.reason_code
      }
    };
  }
  return {
    ok: classified.success,
    reason_code: classified.reason_code,
    handshake_proved: classified.evidence.handshake_proved === true,
    event_count: Number.isInteger(classified.evidence.event_count)
      ? classified.evidence.event_count
      : 0,
    latest_event_time_utc: classified.evidence.latest_event_time_utc || null,
    details: {
      validation_status: submit.body ? submit.body.validation_status : null
    }
  };
}

async function handleRunK80EnrollmentAttemptCommand(state, command) {
  const handlerPayloadStageProbe = buildEnrollmentTransitSnapshot(
    command && Object.prototype.hasOwnProperty.call(command, 'payload') ? command.payload : undefined,
    'v2_stage5_handler'
  );
  const commandPayload = isPlainObject(command.payload) ? command.payload : {};
  const preExecutionStageProbe = buildEnrollmentTransitSnapshot(commandPayload, 'v2_stage5_pre_exec');
  const enrollment = isPlainObject(commandPayload.enrollment) ? commandPayload.enrollment : {};
  const connection = isPlainObject(commandPayload.connection) ? commandPayload.connection : {};
  const runId = createRunId();
  const trace = {
    command_id: command.id,
    run_id: runId,
    enrollment_attempt_id: commandPayload.enrollment_attempt_id || null,
    device_uid: commandPayload.device_uid || null
  };

  const startedAt = new Date().toISOString();
  logAgentEvent('agent.enrollment.started', buildContext(state, {
    ...trace,
    selected_finger: enrollment.selected_finger || null,
    device_user_id: Number.isInteger(enrollment.device_user_id) ? enrollment.device_user_id : null,
    host: connection.host || null,
    port: connection.port || null
  }));

  let runnerResult;
  try {
    runnerResult = await runK80EnrollmentAttempt(commandPayload, {
      timeout_ms: config.pullTimeoutMs,
      k80_v2_runtime_probe: {
        ...handlerPayloadStageProbe,
        ...preExecutionStageProbe
      }
    });
  } catch (err) {
    runnerResult = {
      ok: false,
      attempt_status: 'partial_or_failed',
      status_reason: err && err.message ? err.message : 'enrollment_runner_exception',
      protocol_execution_state: 'runner_exception',
      protocol_session_ref: null,
      evidence_flags: {},
      evidence_refs: {},
      source_metadata: {
        conservative_evidence_classification: true
      }
    };
  }

  const completedAt = new Date().toISOString();
  const resultPayload = {
    command_id: command.id,
    enrollment_attempt_id: commandPayload.enrollment_attempt_id || '',
    run_id: runId,
    device_uid: commandPayload.device_uid || '',
    started_at: startedAt,
    completed_at: completedAt,
    result: {
      attempt_status: runnerResult.attempt_status || 'partial_or_failed',
      status_reason: runnerResult.status_reason || null,
      protocol_execution_state: runnerResult.protocol_execution_state || null,
      protocol_session_ref: runnerResult.protocol_session_ref || null,
      evidence_flags: isPlainObject(runnerResult.evidence_flags) ? runnerResult.evidence_flags : {},
      evidence_refs: isPlainObject(runnerResult.evidence_refs) ? runnerResult.evidence_refs : {},
      source_metadata: isPlainObject(runnerResult.source_metadata) ? runnerResult.source_metadata : {}
    }
  };

  logAgentEvent('agent.enrollment.completed', buildContext(state, {
    ...trace,
    attempt_status: resultPayload.result.attempt_status,
    status_reason: resultPayload.result.status_reason,
    protocol_execution_state: resultPayload.result.protocol_execution_state
  }));

  const submit = await submitEnrollmentAttemptResult(state, resultPayload, trace);
  if (!submit.ok) {
    return {
      ok: false,
      reason_code: 'enrollment_result_submit_failed',
      details: {
        submit_status: submit.status,
        attempt_status: resultPayload.result.attempt_status
      }
    };
  }

  return {
    ok: resultPayload.result.attempt_status === 'success',
    reason_code: resultPayload.result.attempt_status === 'success'
      ? 'enrollment_success'
      : 'enrollment_non_success',
    details: {
      enrollment_attempt_id: commandPayload.enrollment_attempt_id || null,
      attempt_status: resultPayload.result.attempt_status,
      status_reason: resultPayload.result.status_reason,
      protocol_execution_state: resultPayload.result.protocol_execution_state
    }
  };
}

async function commandLoop(state) {
  await flushPendingEventBatches(state, { reason: 'poll_loop' });

  const command = await pollNextCommand(state);
  if (!command) {
    return;
  }
  const commandPayload = isPlainObject(command.payload) ? command.payload : {};
  diagnosticsTracker.recordCommandStarted(command, commandPayload);

  try {
    let outcome;
    if (command.type === COMMAND_TYPES.SCAN_SUBNET) {
      outcome = await handleScanSubnetCommand(state, command);
    } else if (command.type === COMMAND_TYPES.PULL_DEVICE_EVENTS) {
      outcome = await handlePullDeviceEventsCommand(state, command);
    } else if (command.type === COMMAND_TYPES.REFRESH_DEVICE_PATH_PULL_CAPABILITY) {
      outcome = await handleDevicePathPullCapabilityRefreshCommand(state, command);
    } else if (command.type === COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE) {
      outcome = await handleValidateDeviceCandidateCommand(state, command);
    } else if (command.type === COMMAND_TYPES.RUN_K80_ENROLLMENT_ATTEMPT) {
      outcome = await handleRunK80EnrollmentAttemptCommand(state, command);
    } else if (
      command.type === COMMAND_TYPES.START_DEVICE_MONITORING
      || command.type === COMMAND_TYPES.STOP_DEVICE_MONITORING
    ) {
      outcome = await handleDeviceMonitoringCommand(state, command);
    } else {
      logAgentEvent('agent.command.unsupported', buildContext(state, {
        command_id: command.id || null,
        command_type: command.type
      }));
      outcome = {
        ok: false,
        reason_code: 'command_unsupported'
      };
    }

    diagnosticsTracker.recordCommandFinished(command, commandPayload, {
      ok: outcome && outcome.ok === true,
      reason_code: outcome && outcome.reason_code ? outcome.reason_code : 'command_completed',
      event_count: outcome && Number.isInteger(outcome.event_count) ? outcome.event_count : null,
      latest_event_time_utc: outcome && outcome.latest_event_time_utc ? outcome.latest_event_time_utc : null,
      handshake_proved: outcome && outcome.handshake_proved === true,
      details: outcome && outcome.details && typeof outcome.details === 'object' ? outcome.details : {}
    });
  } catch (err) {
    diagnosticsTracker.recordCommandFinished(command, commandPayload, {
      ok: false,
      reason_code: 'command_exception',
      details: {
        error: err && err.message ? err.message : String(err)
      }
    });
    throw err;
  }
}

async function start() {
  logAgentEvent('agent.starting', {
    base_url: config.baseUrl,
    state_file: config.stateFile,
    diagnostics_state_file: config.diagnosticsStateFile,
    event_queue_file: config.eventQueueFile,
    agent_name: config.agentName,
    heartbeat_interval_ms: config.heartbeatIntervalMs,
    command_poll_ms: config.commandPollMs,
    adapter_default: config.adapterDefault,
    mock_discovery: config.mockDiscovery,
    mock_event_pull: config.mockEventPull,
    event_retry_base_ms: config.eventRetryBaseMs,
    event_retry_max_ms: config.eventRetryMaxMs,
    rollout_channel: config.rolloutChannel,
    diagnostics_enabled: config.diagnosticsEnabled,
    diagnostics_host: config.diagnosticsHost,
    diagnostics_port: config.diagnosticsPort,
    k80_rt_subscriber_enabled: config.k80RtSubscriberEnabled,
    k80_rt_subscriber_device_uid: config.k80RtSubscriberAllowlist[0] || null
  });
  let state = readState(config.stateFile);
  state = await bootstrapIfNeeded(state);
  diagnosticsTracker.setAgentIdentity({
    agent_id: state.agent_id,
    company_id: state.company_id,
    agent_name: state.agent_name,
    credential_version: state.credential_version,
    active_runtime_identity_id: state.active_runtime_identity_id || null,
    identity_status: state.identity_status || null,
    runtime_identity_issued_at: state.runtime_identity_issued_at || null,
    base_url: config.baseUrl,
    version: packageJson && packageJson.version ? packageJson.version : null,
    hostname: os.hostname(),
    platform: process.platform,
    node_version: process.version,
    k80_rt_subscriber_enabled: config.k80RtSubscriberEnabled,
    k80_rt_subscriber_device_uid: config.k80RtSubscriberAllowlist[0] || null,
    k80_rt_subscriber_allowlist_count: config.k80RtSubscriberAllowlist.length
  });
  logAgentEvent('agent.identity.ready', {
    agent_id: state.agent_id,
    company_id: state.company_id,
    agent_name: state.agent_name
  });

  startLocalDiagnosticsServer({
    enabled: config.diagnosticsEnabled,
    host: config.diagnosticsHost,
    port: config.diagnosticsPort,
    snapshotProvider: () => diagnosticsTracker.buildSnapshot({
      pendingBufferedBatches: countPendingBatches(config.eventQueueFile)
    }),
    onServerEvent: (event, details) => {
      logAgentEvent(event, buildContext(state, details));
    }
  });

  await sendHeartbeat(state, { reason: 'startup' });
  await flushPendingEventBatches(state, { reason: 'startup' });

  let realtimeSubscriber = null;
  let realtimeSubscriberDeviceUid = null;
  let realtimeSubscriberSessionId = null;
  const startRealtimeSubscriber = async ({
    deviceUid = subscriberDeviceUid,
    connection,
    monitoringSessionId = null
  } = {}) => {
    const safeDeviceUid = String(deviceUid || '').trim();
    if (!safeDeviceUid) {
      return { ok: false, reason_code: 'device_uid_required' };
    }
    if (!config.k80RtSubscriberEnabled) {
      return { ok: false, reason_code: 'subscriber_disabled' };
    }
    if (!config.k80RtSubscriberAllowlist.includes(safeDeviceUid)) {
      return { ok: false, reason_code: 'subscriber_device_not_allowed' };
    }
    if (realtimeSubscriber) {
      if (realtimeSubscriberDeviceUid === safeDeviceUid) {
        return {
          ok: true,
          runtime_monitoring_state: 'active',
          rt_subscriber_started: false,
          rt_subscriber_already_running: true,
          diagnostics: {
            existing_device_uid: realtimeSubscriberDeviceUid,
            existing_monitoring_session_id: realtimeSubscriberSessionId
          }
        };
      }
      return {
        ok: false,
        runtime_monitoring_state: 'failed',
        reason_code: 'monitoring_subscriber_conflict',
        diagnostics: {
          existing_device_uid: realtimeSubscriberDeviceUid,
          requested_device_uid: safeDeviceUid
        }
      };
    }
    const resolvedConnection = resolveRtSubscriberConnection(safeDeviceUid, connection);
    diagnosticsTracker.recordRtSubscriberAuthTrace({
      hop: 'resolved_connection',
      auth_present: Object.prototype.hasOwnProperty.call(resolvedConnection, 'auth_password'),
      auth_integer: Number.isInteger(integerLike(resolvedConnection.auth_password)),
      source: 'resolved_connection'
    });
    const envAuthPassword = envText('K80_RT_SUBSCRIBER_AUTH_PASSWORD', '');
    const resolvedAuthPassword = Number.isInteger(resolvedConnection.auth_password)
      ? resolvedConnection.auth_password
      : integerLike(envAuthPassword);
    diagnosticsTracker.recordRtSubscriberAuthTrace({
      hop: 'auth_for_subscriber',
      auth_present: Number.isInteger(resolvedAuthPassword),
      auth_integer: Number.isInteger(resolvedAuthPassword),
      source: Number.isInteger(resolvedConnection.auth_password) ? 'connection' : (envAuthPassword ? 'env' : 'none')
    });
    if (!Number.isInteger(resolvedAuthPassword)) {
      logAgentEvent('agent.events.rt_subscriber.skipped', buildContext(state, {
        device_uid: safeDeviceUid,
        reason: 'auth_password_missing'
      }));
      return { ok: false, reason_code: 'auth_password_missing' };
    }
    const initiationResult = await zktecoPullAdapter.runK80RtInitiationSession({
      deviceUid: safeDeviceUid,
      vendor: 'zkteco',
      authPassword: resolvedAuthPassword,
      connection: resolvedConnection
    });
    const initiationObservedAt = new Date().toISOString();
    diagnosticsTracker.recordRtSubscriberInitiation(initiationResult);
    const subscriberStartedAt = new Date().toISOString();
    diagnosticsTracker.recordRtSubscriberTiming({
      initiation_observed_at: initiationObservedAt,
      subscriber_started_at: subscriberStartedAt,
      delta_ms: Date.parse(subscriberStartedAt) - Date.parse(initiationObservedAt)
    });
    if (realtimeSubscriber && typeof realtimeSubscriber.stop === 'function') {
      try {
        await realtimeSubscriber.stop();
      } catch (err) {
        // no-op
      }
      realtimeSubscriber = null;
    }
    realtimeSubscriber = zktecoPullAdapter.startK80RealtimeSubscriber({
      deviceUid: safeDeviceUid,
      vendor: 'zkteco',
      deviceTimezone: 'Africa/Tunis',
      authPassword: resolvedAuthPassword,
      connection: resolvedConnection,
      onFlush: async realtimeSlice => {
        const trace = {
          reason: 'k80_rt_subscriber',
          device_uid: safeDeviceUid
        };
        const runId = createRunId();
        const completedAt = new Date().toISOString();
        const payload = buildRealtimeSubscriberBatchPayload({
          runId,
          pullStartedAt: completedAt,
          pullCompletedAt: completedAt,
          deviceUid: safeDeviceUid,
          vendor: 'zkteco',
          deviceTimezone: 'Africa/Tunis',
          events: realtimeSlice && Array.isArray(realtimeSlice.events) ? realtimeSlice.events : [],
          diagnostics: realtimeSlice && isPlainObject(realtimeSlice.diagnostics)
            ? realtimeSlice.diagnostics
            : {}
        });
        await submitEventBatch(state, payload, trace);
      },
      onSessionResult: result => {
        diagnosticsTracker.recordRtSubscriberSession(result);
        logAgentEvent('agent.events.rt_subscriber.session', buildContext(state, {
          device_uid: safeDeviceUid,
          ok: result && result.ok === true,
          skipped: result && result.skipped === true,
          reason: result && result.reason ? result.reason : null,
          session_opened: result && result.session_opened === true,
          session_rt01f4_frames_count: result && Number.isInteger(result.session_rt01f4_frames_count)
            ? result.session_rt01f4_frames_count
            : null
        }));
      }
    });
    if (realtimeSubscriber && realtimeSubscriber.started === true) {
      realtimeSubscriberDeviceUid = safeDeviceUid;
      realtimeSubscriberSessionId = monitoringSessionId || null;
    } else {
      realtimeSubscriber = null;
      realtimeSubscriberDeviceUid = null;
      realtimeSubscriberSessionId = null;
    }
    logAgentEvent('agent.events.rt_subscriber.started', buildContext(state, {
      device_uid: safeDeviceUid,
      started: realtimeSubscriber && realtimeSubscriber.started === true,
      reason: realtimeSubscriber && realtimeSubscriber.reason ? realtimeSubscriber.reason : null,
      connection_source: resolvedConnection && resolvedConnection.host ? 'metadata' : 'unknown'
    }));
    return {
      ok: realtimeSubscriber && realtimeSubscriber.started === true,
      runtime_monitoring_state: realtimeSubscriber && realtimeSubscriber.started === true ? 'active' : 'failed',
      rt_subscriber_started: realtimeSubscriber && realtimeSubscriber.started === true,
      rt_subscriber_already_running: false,
      reason_code: realtimeSubscriber && realtimeSubscriber.reason ? realtimeSubscriber.reason : null,
      diagnostics: {
        initiation_ok: initiationResult && initiationResult.ok === true,
        subscriber_reason: realtimeSubscriber && realtimeSubscriber.reason ? realtimeSubscriber.reason : null
      }
    };
  };
  startRealtimeSubscriberForCommand = connection => {
    startRealtimeSubscriber({ deviceUid: subscriberDeviceUid, connection }).catch(err => {
      logAgentEvent('agent.events.rt_subscriber.init_failed', buildContext(state, {
        device_uid: subscriberDeviceUid,
        error: err && err.message ? err.message : String(err)
      }));
    });
  };
  const stopRealtimeSubscriber = async ({ deviceUid = null, monitoringSessionId = null } = {}) => {
    const safeDeviceUid = String(deviceUid || '').trim();
    if (!realtimeSubscriber || typeof realtimeSubscriber.stop !== 'function') {
      return {
        ok: true,
        runtime_monitoring_state: 'stopped',
        rt_subscriber_stopped: false,
        diagnostics: { already_stopped: true }
      };
    }
    if (safeDeviceUid && realtimeSubscriberDeviceUid && safeDeviceUid !== realtimeSubscriberDeviceUid) {
      return {
        ok: false,
        runtime_monitoring_state: 'failed',
        reason_code: 'monitoring_subscriber_conflict',
        diagnostics: {
          existing_device_uid: realtimeSubscriberDeviceUid,
          requested_device_uid: safeDeviceUid,
          monitoring_session_id: monitoringSessionId || null
        }
      };
    }
    await realtimeSubscriber.stop();
    realtimeSubscriber = null;
    realtimeSubscriberDeviceUid = null;
    realtimeSubscriberSessionId = null;
    return {
      ok: true,
      runtime_monitoring_state: 'stopped',
      rt_subscriber_stopped: true,
      stop_reason: 'operator_stop'
    };
  };
  handleMonitoringCommandForRuntime = async (commandType, payload) => {
    const safePayload = isPlainObject(payload) ? payload : {};
    if (commandType === COMMAND_TYPES.START_DEVICE_MONITORING) {
      if (String(safePayload.vendor || 'zkteco').trim().toLowerCase() !== 'zkteco') {
        return { ok: false, runtime_monitoring_state: 'failed', reason_code: 'unsupported_vendor' };
      }
      if (safePayload.rt_enabled === false) {
        return { ok: false, runtime_monitoring_state: 'failed', reason_code: 'rt_disabled_for_session' };
      }
      return startRealtimeSubscriber({
        deviceUid: safePayload.device_uid,
        connection: isPlainObject(safePayload.connection) ? safePayload.connection : {},
        monitoringSessionId: safePayload.monitoring_session_id || null
      });
    }
    if (commandType === COMMAND_TYPES.STOP_DEVICE_MONITORING) {
      const result = await stopRealtimeSubscriber({
        deviceUid: safePayload.device_uid,
        monitoringSessionId: safePayload.monitoring_session_id || null
      });
      return {
        ...result,
        stop_reason: safePayload.reason || result.stop_reason || 'operator_stop'
      };
    }
    return { ok: false, runtime_monitoring_state: 'failed', reason_code: 'command_unsupported' };
  };


  let commandLoopRunning = false;
  const runCommandLoop = () => {
    if (commandLoopRunning) {
      return;
    }
    commandLoopRunning = true;
    commandLoop(state)
      .catch(err => {
        logAgentEvent('agent.command.loop_error', buildContext(state, {
          error: err && err.message ? err.message : String(err)
        }));
      })
      .finally(() => {
        commandLoopRunning = false;
      });
  };

  setInterval(() => {
    sendHeartbeat(state).catch(err => {
      logAgentEvent('agent.heartbeat.loop_error', buildContext(state, {
        error: err && err.message ? err.message : String(err)
      }));
    });
  }, config.heartbeatIntervalMs);

  runCommandLoop();
  setInterval(runCommandLoop, config.commandPollMs);

  process.once('SIGINT', () => {
    stopRealtimeSubscriber({}).finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    stopRealtimeSubscriber({}).finally(() => process.exit(0));
  });
}

start().catch(err => {
  logAgentEvent('agent.fatal', {
    error: err && err.message ? err.message : String(err)
  });
  process.exit(1);
});
