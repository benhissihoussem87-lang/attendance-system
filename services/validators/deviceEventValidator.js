const { ALLOWED_DIRECTIONS } = require('../../contracts/deviceEventContract');

function addError(errors, field, code, message) {
  errors.push({ field, code, message });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateCanonicalEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object') {
    addError(errors, 'event', 'INVALID_EVENT', 'Event must be an object');
    return { ok: false, errors };
  }

  if (typeof event.person_id !== 'string' || event.person_id.trim() === '') {
    addError(errors, 'person_id', 'REQUIRED', 'person_id is required');
  }

  if (typeof event.event_time_utc !== 'string' || event.event_time_utc.trim() === '') {
    addError(errors, 'event_time_utc', 'REQUIRED', 'event_time_utc is required');
  } else if (Number.isNaN(new Date(event.event_time_utc).valueOf())) {
    addError(errors, 'event_time_utc', 'INVALID_DATE', 'event_time_utc must be a valid ISO date');
  }

  if (typeof event.direction !== 'string' || !ALLOWED_DIRECTIONS.includes(event.direction)) {
    addError(errors, 'direction', 'INVALID_DIRECTION', 'direction must be IN or OUT');
  }

  if (event.device_uid === null || event.device_uid === undefined) {
    addError(errors, 'device_uid', 'REQUIRED', 'device_uid is required');
  }

  if (!isPlainObject(event.raw_payload)) {
    addError(errors, 'raw_payload', 'REQUIRED', 'raw_payload must be an object');
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true };
}

module.exports = {
  validateCanonicalEvent
};
