const os = require('os');
const { readState, writeState } = require('./stateStore');
const { COMMAND_TYPES } = require('../../contracts/agentBridgeContract');

function nowIso() {
  return new Date().toISOString();
}

function text(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
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

function parseTime(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function withRecent(list, item, maxEntries) {
  list.unshift(item);
  if (list.length > maxEntries) {
    list.length = maxEntries;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultState() {
  return {
    version: 1,
    started_at: nowIso(),
    agent: {
      agent_id: null,
      company_id: null,
      agent_name: null,
      credential_version: null,
      active_runtime_identity_id: null,
      identity_status: null,
      runtime_identity_issued_at: null,
      base_url: null,
      version: null,
      hostname: os.hostname(),
      platform: process.platform,
      node_version: process.version,
      k80_rt_subscriber_enabled: null,
      k80_rt_subscriber_device_uid: null,
      k80_rt_subscriber_allowlist_count: null
    },
    heartbeat: {
      last_attempt_at: null,
      last_success_at: null,
      last_failure_at: null,
      last_status: null,
      last_error: null,
      saas_last_heartbeat_at: null
    },
    polling: {
      last_attempt_at: null,
      last_success_at: null,
      last_failure_at: null,
      last_empty_at: null,
      last_error: null,
      last_command_received_at: null
    },
    commands: {
      last_received: null,
      last_success: null,
      last_failure: null,
      recent: []
    },
      devices: {},
      rt_subscriber: {
        last_session: null,
        last_auth_trace: [],
        last_initiation: null,
        last_timing: null
      }
    };
  }

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultState();
  }
  const fallback = defaultState();
  const candidate = {
    ...fallback,
    ...raw
  };

  if (!candidate.agent || typeof candidate.agent !== 'object' || Array.isArray(candidate.agent)) {
    candidate.agent = { ...fallback.agent };
  } else {
    candidate.agent = {
      ...fallback.agent,
      ...candidate.agent
    };
  }

  if (!candidate.heartbeat || typeof candidate.heartbeat !== 'object' || Array.isArray(candidate.heartbeat)) {
    candidate.heartbeat = { ...fallback.heartbeat };
  } else {
    candidate.heartbeat = {
      ...fallback.heartbeat,
      ...candidate.heartbeat
    };
  }

  if (!candidate.polling || typeof candidate.polling !== 'object' || Array.isArray(candidate.polling)) {
    candidate.polling = { ...fallback.polling };
  } else {
    candidate.polling = {
      ...fallback.polling,
      ...candidate.polling
    };
  }

  if (!candidate.rt_subscriber || typeof candidate.rt_subscriber !== 'object' || Array.isArray(candidate.rt_subscriber)) {
    candidate.rt_subscriber = { ...fallback.rt_subscriber };
  } else {
    candidate.rt_subscriber = {
      ...fallback.rt_subscriber,
      ...candidate.rt_subscriber
    };
  }

  if (!candidate.commands || typeof candidate.commands !== 'object' || Array.isArray(candidate.commands)) {
    candidate.commands = { ...fallback.commands };
  } else {
    candidate.commands = {
      ...fallback.commands,
      ...candidate.commands,
      recent: Array.isArray(candidate.commands.recent) ? candidate.commands.recent : []
    };
  }

  if (!candidate.devices || typeof candidate.devices !== 'object' || Array.isArray(candidate.devices)) {
    candidate.devices = {};
  }

  return candidate;
}

function createDeviceRecord(uid) {
  return {
    device_uid: uid,
    provider: null,
    model: null,
    firmware: null,
    host: null,
    port: null,
    transport: null,
    attlog_sequence: null,
    device_number: null,
    last_command_received_at: null,
    last_validation: null,
    last_pull: null
  };
}

function buildFreshness(lastIso, staleMs, nowMs) {
  const parsed = parseTime(lastIso);
  if (!parsed) {
    return {
      last_at: null,
      age_ms: null,
      stale: true
    };
  }
  const ageMs = Math.max(0, nowMs - parsed);
  return {
    last_at: lastIso,
    age_ms: ageMs,
    stale: ageMs > staleMs
  };
}

function createLocalDiagnosticsTracker(options = {}) {
  const filePath = text(options.filePath);
  const maxRecentActivity = Number.isInteger(options.maxRecentActivity) && options.maxRecentActivity > 0
    ? options.maxRecentActivity
    : 40;
  const maxKnownDevices = Number.isInteger(options.maxKnownDevices) && options.maxKnownDevices > 0
    ? options.maxKnownDevices
    : 100;
  const heartbeatStaleMs = Number.isInteger(options.heartbeatStaleMs) && options.heartbeatStaleMs > 0
    ? options.heartbeatStaleMs
    : 120000;
  const pollStaleMs = Number.isInteger(options.pollStaleMs) && options.pollStaleMs > 0
    ? options.pollStaleMs
    : 30000;

  let state = normalizeState(filePath ? readState(filePath) : null);

  function persist() {
    if (!filePath) {
      return;
    }
    writeState(filePath, state);
  }

  function pushActivity(kind, message, details = {}, level = 'info') {
    withRecent(state.commands.recent, {
      ts: nowIso(),
      kind,
      level,
      message,
      details: details && typeof details === 'object' ? details : {}
    }, maxRecentActivity);
  }

  function ensureDeviceFromPayload(payload, observedAt) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    const uid = text(payload.device_uid);
    if (!uid) {
      return null;
    }
    if (!state.devices[uid]) {
      if (Object.keys(state.devices).length >= maxKnownDevices) {
        const evictUid = Object.values(state.devices)
          .sort((a, b) => {
            const aTs = parseTime(a.last_command_received_at) || 0;
            const bTs = parseTime(b.last_command_received_at) || 0;
            return aTs - bTs;
          })
          .map(item => item.device_uid)[0];
        if (evictUid) {
          delete state.devices[evictUid];
        }
      }
      state.devices[uid] = createDeviceRecord(uid);
    }
    const record = state.devices[uid];
    const provider = text(payload.provider) || text(payload.vendor);
    const deviceProfile = payload.device_profile && typeof payload.device_profile === 'object'
      ? payload.device_profile
      : {};
    const connection = payload.connection && typeof payload.connection === 'object'
      ? payload.connection
      : {};
    record.provider = provider || record.provider;
    record.model = text(deviceProfile.model) || record.model;
    record.firmware = text(deviceProfile.firmware) || record.firmware;
    record.host = text(connection.host) || record.host;
    record.port = integerLike(connection.port) || record.port;
    record.transport = text(connection.transport) || record.transport;
    record.attlog_sequence = text(connection.attlog_sequence) || record.attlog_sequence;
    record.device_number = integerLike(connection.device_number) || record.device_number;
    record.last_command_received_at = observedAt || nowIso();
    return record;
  }

  return {
    setAgentIdentity(identity = {}) {
      const agent = state.agent;
      agent.agent_id = text(identity.agent_id) || agent.agent_id;
      agent.company_id = text(identity.company_id) || agent.company_id;
      agent.agent_name = text(identity.agent_name) || agent.agent_name;
      agent.credential_version = integerLike(identity.credential_version) || agent.credential_version;
      agent.active_runtime_identity_id = text(identity.active_runtime_identity_id) || agent.active_runtime_identity_id;
      agent.identity_status = text(identity.identity_status) || agent.identity_status;
      agent.runtime_identity_issued_at = text(identity.runtime_identity_issued_at) || agent.runtime_identity_issued_at;
      agent.base_url = text(identity.base_url) || agent.base_url;
      agent.version = text(identity.version) || agent.version;
      agent.hostname = text(identity.hostname) || agent.hostname;
      agent.platform = text(identity.platform) || agent.platform;
      agent.node_version = text(identity.node_version) || agent.node_version;
      if (typeof identity.k80_rt_subscriber_enabled === 'boolean') {
        agent.k80_rt_subscriber_enabled = identity.k80_rt_subscriber_enabled;
      }
      agent.k80_rt_subscriber_device_uid = text(identity.k80_rt_subscriber_device_uid)
        || agent.k80_rt_subscriber_device_uid;
      agent.k80_rt_subscriber_allowlist_count = integerLike(identity.k80_rt_subscriber_allowlist_count)
        ?? agent.k80_rt_subscriber_allowlist_count;
      persist();
    },

    recordHeartbeatAttempt() {
      state.heartbeat.last_attempt_at = nowIso();
      persist();
    },

    recordHeartbeatResult(result = {}) {
      const ts = nowIso();
      const ok = result.ok === true;
      state.heartbeat.last_status = Number.isInteger(result.status) ? result.status : null;
      if (ok) {
        state.heartbeat.last_success_at = ts;
        state.heartbeat.last_error = null;
        state.heartbeat.saas_last_heartbeat_at = text(result.saasLastHeartbeatAt) || null;
        pushActivity('heartbeat_ok', 'Heartbeat succeeded', {
          status: state.heartbeat.last_status
        });
      } else {
        state.heartbeat.last_failure_at = ts;
        state.heartbeat.last_error = text(result.error) || 'heartbeat_failed';
        pushActivity('heartbeat_failed', 'Heartbeat failed', {
          status: state.heartbeat.last_status,
          error: state.heartbeat.last_error
        }, 'warn');
      }
      persist();
    },

    recordPollAttempt() {
      state.polling.last_attempt_at = nowIso();
      persist();
    },

    recordPollEmpty() {
      const ts = nowIso();
      state.polling.last_success_at = ts;
      state.polling.last_empty_at = ts;
      state.polling.last_error = null;
      persist();
    },

    recordPollFailure(errorText) {
      state.polling.last_failure_at = nowIso();
      state.polling.last_error = text(errorText) || 'poll_failed';
      pushActivity('poll_failed', 'Command polling failed', {
        error: state.polling.last_error
      }, 'warn');
      persist();
    },

    recordCommandReceived(command) {
      const ts = nowIso();
      const received = {
        command_id: text(command && command.id) || null,
        command_type: text(command && command.type) || null,
        received_at: ts
      };
      state.polling.last_success_at = ts;
      state.polling.last_command_received_at = ts;
      state.polling.last_error = null;
      state.commands.last_received = received;
      pushActivity('command_received', 'Command received', received);
      persist();
    },

    recordCommandStarted(command, payload) {
      const ts = nowIso();
      const commandType = text(command && command.type);
      const commandId = text(command && command.id) || null;
      const device = ensureDeviceFromPayload(payload, ts);
      const details = {
        command_id: commandId,
        command_type: commandType,
        device_uid: device ? device.device_uid : null
      };
      pushActivity('command_started', 'Command execution started', details);
      persist();
      return {
        command_id: commandId,
        command_type: commandType,
        started_at: ts,
        device_uid: device ? device.device_uid : null
      };
    },

    recordCommandFinished(command, payload, outcome = {}) {
      const ts = nowIso();
      const commandType = text(command && command.type);
      const commandId = text(command && command.id) || null;
      const ok = outcome.ok === true;
      const reasonCode = text(outcome.reason_code) || (ok ? 'command_completed' : 'command_failed');
      const device = ensureDeviceFromPayload(payload, ts);
      const entry = {
        command_id: commandId,
        command_type: commandType,
        device_uid: device ? device.device_uid : null,
        completed_at: ts,
        ok,
        reason_code: reasonCode,
        details: outcome.details && typeof outcome.details === 'object' ? outcome.details : {}
      };

      if (ok) {
        state.commands.last_success = entry;
        pushActivity('command_succeeded', 'Command execution succeeded', entry.details);
      } else {
        state.commands.last_failure = entry;
        pushActivity('command_failed', 'Command execution failed', {
          reason_code: reasonCode,
          ...entry.details
        }, 'warn');
      }

      if (device) {
        if (commandType === COMMAND_TYPES.PULL_DEVICE_EVENTS) {
          device.last_pull = {
            status: ok ? 'succeeded' : 'failed',
            completed_at: ts,
            reason_code: reasonCode,
            event_count: Number.isInteger(outcome.event_count) ? outcome.event_count : null,
            latest_event_time_utc: text(outcome.latest_event_time_utc) || null
          };
        } else if (commandType === COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE) {
          device.last_validation = {
            status: ok ? 'succeeded' : 'failed',
            completed_at: ts,
            reason_code: reasonCode,
            handshake_proved: outcome.handshake_proved === true
          };
        }
      }

      persist();
    },

    recordRtSubscriberSession(result = {}) {
      const ts = nowIso();
      state.rt_subscriber.last_session = {
        observed_at: ts,
        ok: result && result.ok === true,
        skipped: result && result.skipped === true,
        reason: text(result && result.reason) || null,
        session_opened: result && result.session_opened === true,
        session_host: text(result && result.session_host) || null,
        session_port: integerLike(result && result.session_port),
        session_source: text(result && result.session_source) || null,
        session_transport: text(result && result.session_transport) || null,
        session_rt01f4_frames_count: integerLike(result && result.session_rt01f4_frames_count) || 0,
        auth_connection_present: result && result.auth_connection_present === true,
        auth_connection_integer: result && result.auth_connection_integer === true,
        auth_resolved_present: result && result.auth_resolved_present === true,
        auth_resolved_integer: result && result.auth_resolved_integer === true,
        connect_response_received: result && result.connect_response_received === true,
        auth_attempted: result && result.auth_attempted === true,
        auth_response_received: result && result.auth_response_received === true,
        auth_response_command: integerLike(result && result.auth_response_command),
        auth_response_command_hex: text(result && result.auth_response_command_hex) || null,
        presequence_reached: result && result.presequence_reached === true,
        rt_subscribe_attempted: result && result.rt_subscribe_attempted === true,
        rt_subscribe_response_received: result && result.rt_subscribe_response_received === true,
        receive_loop_armed: result && result.receive_loop_armed === true,
        session_ended_before_frames: result && result.session_ended_before_frames === true
      };
      persist();
    },
    recordRtSubscriberInitiation(result = {}) {
      const ts = nowIso();
      state.rt_subscriber.last_initiation = {
        observed_at: ts,
        ok: result && result.ok === true,
        skipped: result && result.skipped === true,
        reason: text(result && result.reason) || null,
        initiation_session_opened: result && result.initiation_session_opened === true,
        initiation_sent: result && result.initiation_sent === true,
        initiation_response_received: result && result.initiation_response_received === true,
        initiation_response_command: integerLike(result && result.initiation_response_command),
        initiation_response_command_hex: text(result && result.initiation_response_command_hex) || null,
        connect_response_received: result && result.connect_response_received === true,
        auth_attempted: result && result.auth_attempted === true,
        auth_response_received: result && result.auth_response_received === true,
        auth_response_command: integerLike(result && result.auth_response_command),
        auth_response_command_hex: text(result && result.auth_response_command_hex) || null
      };
      persist();
    },
    recordRtSubscriberTiming(entry = {}) {
      const ts = nowIso();
      state.rt_subscriber.last_timing = {
        observed_at: ts,
        initiation_observed_at: text(entry.initiation_observed_at) || null,
        subscriber_started_at: text(entry.subscriber_started_at) || null,
        delta_ms: integerLike(entry.delta_ms)
      };
      persist();
    },
    recordRtSubscriberAuthTrace(entry = {}) {
      const ts = nowIso();
      const trace = Array.isArray(state.rt_subscriber.last_auth_trace)
        ? state.rt_subscriber.last_auth_trace
        : [];
      trace.push({
        observed_at: ts,
        hop: text(entry.hop) || null,
        auth_present: entry.auth_present === true,
        auth_integer: entry.auth_integer === true,
        source: text(entry.source) || null
      });
      state.rt_subscriber.last_auth_trace = trace.slice(-10);
      persist();
    },

    buildSnapshot(extra = {}) {
      const nowMs = Date.now();
      const heartbeatFreshness = buildFreshness(state.heartbeat.last_success_at, heartbeatStaleMs, nowMs);
      const pollFreshness = buildFreshness(state.polling.last_success_at, pollStaleMs, nowMs);
      const pendingBufferedBatches = Number.isInteger(extra.pendingBufferedBatches)
        ? extra.pendingBufferedBatches
        : 0;

      const hasHeartbeatSuccess = Boolean(state.heartbeat.last_success_at);
      const hasPollSuccess = Boolean(state.polling.last_success_at);

      let supportStatus = 'healthy';
      let primaryIssue = null;
      let summary = 'Agent runtime looks healthy.';
      const hints = [];

      if (!hasHeartbeatSuccess) {
        supportStatus = 'attention';
        primaryIssue = 'saas_connectivity_not_proven';
        summary = 'No successful SaaS heartbeat has been recorded yet.';
        hints.push('Verify SaaS base URL and outbound network reachability from this host.');
      } else if (heartbeatFreshness.stale) {
        supportStatus = 'attention';
        primaryIssue = 'heartbeat_stale';
        summary = 'Heartbeat is stale; SaaS connectivity may be degraded.';
        hints.push('Check local network, SaaS availability, and agent credentials.');
      } else if (!hasPollSuccess || pollFreshness.stale) {
        supportStatus = 'attention';
        primaryIssue = 'polling_stale';
        summary = 'Command polling is stale; new commands may not be picked up.';
        hints.push('Confirm agent process is running and polling interval is active.');
      } else if (state.commands.last_failure
          && (!state.commands.last_success
            || (parseTime(state.commands.last_failure.completed_at) || 0)
              > (parseTime(state.commands.last_success.completed_at) || 0))) {
        supportStatus = 'attention';
        primaryIssue = 'recent_command_failure';
        summary = 'The most recent command execution failed.';
        hints.push('Inspect recent activity and command details for the failure reason.');
      }

      if (pendingBufferedBatches > 0) {
        hints.push('Buffered event batches are waiting for SaaS acceptance.');
      }

      const devices = Object.values(state.devices)
        .sort((a, b) => {
          const aTs = parseTime(a.last_command_received_at) || 0;
          const bTs = parseTime(b.last_command_received_at) || 0;
          return bTs - aTs;
        });

      return {
        generated_at: nowIso(),
        support_summary: {
          status: supportStatus,
          primary_issue: primaryIssue,
          summary,
          hints
        },
        agent: {
          ...state.agent,
          started_at: state.started_at,
          uptime_sec: Math.floor(process.uptime())
        },
        saas_connectivity: {
          status: !hasHeartbeatSuccess
            ? 'unknown'
            : (heartbeatFreshness.stale ? 'degraded' : 'connected'),
          last_attempt_at: state.heartbeat.last_attempt_at,
          last_success_at: state.heartbeat.last_success_at,
          last_failure_at: state.heartbeat.last_failure_at,
          last_status: state.heartbeat.last_status,
          last_error: state.heartbeat.last_error,
          saas_last_heartbeat_at: state.heartbeat.saas_last_heartbeat_at,
          freshness: heartbeatFreshness
        },
        command_polling: {
          status: !hasPollSuccess
            ? 'unknown'
            : (pollFreshness.stale ? 'stale' : 'fresh'),
          last_attempt_at: state.polling.last_attempt_at,
          last_success_at: state.polling.last_success_at,
          last_failure_at: state.polling.last_failure_at,
          last_empty_at: state.polling.last_empty_at,
          last_error: state.polling.last_error,
          last_command_received_at: state.polling.last_command_received_at,
          freshness: pollFreshness
        },
        commands: {
          last_received: state.commands.last_received,
          last_success: state.commands.last_success,
          last_failure: state.commands.last_failure,
          recent: state.commands.recent
        },
        rt_subscriber: state.rt_subscriber,
        devices,
        buffered_event_batches: pendingBufferedBatches
      };
    },

    __test: {
      getState() {
        return cloneJson(state);
      }
    }
  };
}

module.exports = {
  createLocalDiagnosticsTracker
};
