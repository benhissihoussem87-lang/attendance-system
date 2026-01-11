const DIRECTION_IN = 'IN';
const DIRECTION_OUT = 'OUT';
const ALLOWED_DIRECTIONS = [DIRECTION_IN, DIRECTION_OUT];

function normalizeDirection(value) {
  if (typeof value !== 'string') {
    return value;
  }
  return value.trim().toUpperCase();
}

function normalizeIsoTime(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.valueOf())) {
    return trimmed;
  }
  return parsed.toISOString();
}

function normalizeCanonicalEvent(input) {
  const personId = typeof input.person_id === 'string'
    ? input.person_id.trim()
    : input.person_id;
  const deviceUid = input.device_uid === null || input.device_uid === undefined
    ? input.device_uid
    : String(input.device_uid).trim();
  const vendor = input.vendor === null || input.vendor === undefined
    ? null
    : String(input.vendor).trim();

  return {
    person_id: personId,
    event_time_utc: normalizeIsoTime(input.event_time_utc),
    direction: normalizeDirection(input.direction),
    device_uid: deviceUid,
    vendor,
    raw_payload: input.raw_payload
  };
}

module.exports = {
  DIRECTION_IN,
  DIRECTION_OUT,
  ALLOWED_DIRECTIONS,
  normalizeCanonicalEvent
};
