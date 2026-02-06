const fs = require('fs');
const path = require('path');

const LOG_PATH = path.resolve(__dirname, '..', 'logs', 'audit', 'audit.log');

function emitAuditEvent(event) {
  if (!event || typeof event !== 'object') {
    return;
  }
  const payload = {
    ts: new Date().toISOString(),
    actor_key_id: event.actor_key_id || null,
    company_id: event.company_id || null,
    role: event.role || null,
    action: event.action || null,
    target: event.target || null,
    metadata: event.metadata || {}
  };

  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    const line = JSON.stringify(payload) + '\n';
    fs.promises.appendFile(LOG_PATH, line, 'utf8').catch(() => {});
  } catch (err) {
    // Best-effort logging only.
  }
}

module.exports = {
  emitAuditEvent
};
