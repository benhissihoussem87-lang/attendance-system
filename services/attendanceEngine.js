function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRequired(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function assertDayFormat(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('day must be YYYY-MM-DD');
  }
}

function assertEventDirection(direction) {
  if (direction !== 'IN' && direction !== 'OUT') {
    throw new Error('direction must be IN or OUT');
  }
}

function assertNoVendorMetadata(event) {
  if (!isPlainObject(event)) {
    throw new Error('event must be an object');
  }
  if (Object.prototype.hasOwnProperty.call(event, 'vendor') ||
      Object.prototype.hasOwnProperty.call(event, 'raw_payload')) {
    throw new Error('forbidden vendor metadata in events');
  }
}

function computeAttendanceDay(input) {
  if (!input) {
    throw new Error('input is required');
  }

  assertRequired(input.person_id, 'person_id is required');
  assertRequired(input.day, 'day is required');
  assertRequired(input.window_start_utc, 'window_start_utc is required');
  assertRequired(input.window_end_utc, 'window_end_utc is required');

  if (!Array.isArray(input.events)) {
    throw new Error('events must be an array');
  }

  assertDayFormat(input.day);

  const events = input.events.slice();
  events.forEach(event => {
    assertNoVendorMetadata(event);
    assertEventDirection(event.direction);
  });

  events.sort((a, b) => {
    const left = String(a.event_time_utc || '');
    const right = String(b.event_time_utc || '');
    return left.localeCompare(right);
  });

  const firstIn = events.find(event => event.direction === 'IN') || null;
  let lastOut = null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].direction === 'OUT') {
      lastOut = events[i];
      break;
    }
  }

  return {
    person_id: input.person_id,
    day: input.day,
    first_in_utc: firstIn ? firstIn.event_time_utc : null,
    last_out_utc: lastOut ? lastOut.event_time_utc : null,
    total_events: events.length,
    minutes_late: null,
    minutes_early_leave: null,
    work_minutes: null,
    status: 'PRESENT',
    flags: [],
    audit: {
      rule_set_id: 'contract-only',
      computed_at_utc: new Date().toISOString(),
      notes: []
    }
  };
}

module.exports = { computeAttendanceDay };
