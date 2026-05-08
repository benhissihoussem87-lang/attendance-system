const zktecoPullAdapter = require('./zktecoPullAdapter');

const adapters = {
  zkteco: zktecoPullAdapter
};

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function getAdapter(vendor) {
  const key = normalizeText(vendor).toLowerCase() || 'zkteco';
  return adapters[key] || adapters.zkteco;
}

async function pullDeviceEvents(commandPayload, options = {}) {
  const payload = commandPayload && typeof commandPayload === 'object'
    ? commandPayload
    : {};
  const adapter = getAdapter(payload.vendor);
  if (!adapter || typeof adapter.pullDeviceEvents !== 'function') {
    return {
      ok: false,
      events: [],
      latest_event_time_utc: null,
      diagnostics: {
        failure_reason: 'unsupported_vendor'
      }
    };
  }
  return adapter.pullDeviceEvents(payload, options);
}

async function runK80EnrollmentAttempt(commandPayload, options = {}) {
  const payload = commandPayload && typeof commandPayload === 'object'
    ? commandPayload
    : {};
  const adapter = getAdapter(payload.vendor);
  if (!adapter || typeof adapter.runK80EnrollmentAttempt !== 'function') {
    return {
      ok: false,
      attempt_status: 'partial_or_failed',
      status_reason: 'unsupported_vendor',
      protocol_execution_state: 'runner_not_supported',
      evidence_flags: {},
      evidence_refs: {},
      source_metadata: {
        conservative_evidence_classification: true
      }
    };
  }
  return adapter.runK80EnrollmentAttempt(payload, options);
}

module.exports = {
  pullDeviceEvents,
  runK80EnrollmentAttempt
};
