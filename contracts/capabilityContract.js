function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

const CAPABILITY_STATUS = Object.freeze({
  SUPPORTED: 'supported',
  UNSUPPORTED: 'unsupported',
  DISABLED: 'disabled',
  UNKNOWN: 'unknown'
});

const STORED_CAPABILITY_STATUSES = new Set([
  CAPABILITY_STATUS.SUPPORTED,
  CAPABILITY_STATUS.UNSUPPORTED,
  CAPABILITY_STATUS.DISABLED
]);

const RUNTIME_CAPABILITY_KEYS = Object.freeze({
  COMMAND_VALIDATE_DEVICE_CANDIDATE: 'command.validate_device_candidate',
  COMMAND_PULL_DEVICE_EVENTS: 'command.pull_device_events',
  COMMAND_START_DEVICE_MONITORING: 'command.start_device_monitoring',
  COMMAND_STOP_DEVICE_MONITORING: 'command.stop_device_monitoring',
  HEARTBEAT_REPORTING: 'runtime.heartbeat_reporting',
  VERSION_REPORTING: 'runtime.version_reporting',
  LOCAL_DIAGNOSTICS: 'runtime.local_diagnostics',
  BUFFERED_BATCH_DELIVERY: 'runtime.buffered_batch_delivery'
});

const DEVICE_PATH_CAPABILITY_KEYS = Object.freeze({
  VALIDATE_DEVICE_CANDIDATE: 'device_path.validate_device_candidate',
  PULL_DEVICE_EVENTS: 'device_path.pull_device_events'
});

const COMMAND_CAPABILITY_REQUIREMENTS = Object.freeze({
  VALIDATE_DEVICE_CANDIDATE: Object.freeze({
    runtime_capability_key: RUNTIME_CAPABILITY_KEYS.COMMAND_VALIDATE_DEVICE_CANDIDATE,
    device_capability_key: DEVICE_PATH_CAPABILITY_KEYS.VALIDATE_DEVICE_CANDIDATE
  }),
  PULL_DEVICE_EVENTS: Object.freeze({
    runtime_capability_key: RUNTIME_CAPABILITY_KEYS.COMMAND_PULL_DEVICE_EVENTS,
    device_capability_key: DEVICE_PATH_CAPABILITY_KEYS.PULL_DEVICE_EVENTS
  }),
  REFRESH_DEVICE_PATH_PULL_CAPABILITY: Object.freeze({
    runtime_capability_key: RUNTIME_CAPABILITY_KEYS.COMMAND_PULL_DEVICE_EVENTS,
    device_capability_key: null
  }),
  START_DEVICE_MONITORING: Object.freeze({
    runtime_capability_key: RUNTIME_CAPABILITY_KEYS.COMMAND_START_DEVICE_MONITORING,
    device_capability_key: null
  }),
  STOP_DEVICE_MONITORING: Object.freeze({
    runtime_capability_key: RUNTIME_CAPABILITY_KEYS.COMMAND_STOP_DEVICE_MONITORING,
    device_capability_key: null
  })
});

function normalizeCapabilityKey(value) {
  const normalized = normalizeText(value).toLowerCase();
  return normalized || '';
}

function normalizeCapabilityStatus(value, fallback = CAPABILITY_STATUS.UNKNOWN) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === CAPABILITY_STATUS.UNKNOWN) {
    return CAPABILITY_STATUS.UNKNOWN;
  }
  if (!STORED_CAPABILITY_STATUSES.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function normalizeStoredCapabilityStatus(value, fallback = null) {
  const normalized = normalizeCapabilityStatus(value, fallback);
  if (!normalized) {
    return fallback;
  }
  if (!STORED_CAPABILITY_STATUSES.has(normalized)) {
    return fallback;
  }
  return normalized;
}

function resolveCommandCapabilityRequirements(commandType) {
  const normalized = normalizeText(commandType).toUpperCase();
  if (!normalized) {
    return null;
  }
  return COMMAND_CAPABILITY_REQUIREMENTS[normalized] || null;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseCapabilityReportMap(value) {
  if (!isPlainObject(value)) {
    return [];
  }

  const entries = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const capabilityKey = normalizeCapabilityKey(rawKey);
    if (!capabilityKey) {
      continue;
    }

    let status = null;
    let reason = null;
    let metadata = {};
    if (typeof rawValue === 'string') {
      status = normalizeStoredCapabilityStatus(rawValue, null);
    } else if (isPlainObject(rawValue)) {
      status = normalizeStoredCapabilityStatus(rawValue.status, null);
      reason = normalizeText(rawValue.reason) || null;
      metadata = isPlainObject(rawValue.metadata) ? rawValue.metadata : {};
    }

    if (!status) {
      continue;
    }

    entries.push({
      capability_key: capabilityKey,
      capability_status: status,
      capability_reason: reason,
      metadata
    });
  }

  return entries;
}

function buildDefaultRuntimeHeartbeatCapabilities() {
  return {
    [RUNTIME_CAPABILITY_KEYS.HEARTBEAT_REPORTING]: CAPABILITY_STATUS.SUPPORTED,
    [RUNTIME_CAPABILITY_KEYS.VERSION_REPORTING]: CAPABILITY_STATUS.SUPPORTED,
    [RUNTIME_CAPABILITY_KEYS.LOCAL_DIAGNOSTICS]: CAPABILITY_STATUS.SUPPORTED,
    [RUNTIME_CAPABILITY_KEYS.BUFFERED_BATCH_DELIVERY]: CAPABILITY_STATUS.SUPPORTED,
    [RUNTIME_CAPABILITY_KEYS.COMMAND_VALIDATE_DEVICE_CANDIDATE]: CAPABILITY_STATUS.SUPPORTED,
    [RUNTIME_CAPABILITY_KEYS.COMMAND_PULL_DEVICE_EVENTS]: CAPABILITY_STATUS.SUPPORTED,
    [RUNTIME_CAPABILITY_KEYS.COMMAND_START_DEVICE_MONITORING]: CAPABILITY_STATUS.SUPPORTED,
    [RUNTIME_CAPABILITY_KEYS.COMMAND_STOP_DEVICE_MONITORING]: CAPABILITY_STATUS.SUPPORTED
  };
}

module.exports = {
  CAPABILITY_STATUS,
  RUNTIME_CAPABILITY_KEYS,
  DEVICE_PATH_CAPABILITY_KEYS,
  COMMAND_CAPABILITY_REQUIREMENTS,
  normalizeCapabilityKey,
  normalizeCapabilityStatus,
  normalizeStoredCapabilityStatus,
  resolveCommandCapabilityRequirements,
  parseCapabilityReportMap,
  buildDefaultRuntimeHeartbeatCapabilities
};
