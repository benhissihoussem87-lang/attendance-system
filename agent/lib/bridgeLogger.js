const crypto = require('crypto');

function createRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }
  if (depth >= 5) {
    return '[truncated]';
  }
  if (typeof value === 'string') {
    return value.length > 600 ? `${value.slice(0, 600)}...` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 128).map(item => sanitize(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = sanitize(val, depth + 1);
    }
    return out;
  }
  return String(value);
}

function logAgentEvent(event, context) {
  const payload = {
    ts: new Date().toISOString(),
    scope: 'agent_bridge',
    event,
    ...(context && typeof context === 'object' ? sanitize(context) : {})
  };
  console.log(JSON.stringify(payload));
}

module.exports = {
  createRunId,
  logAgentEvent
};
