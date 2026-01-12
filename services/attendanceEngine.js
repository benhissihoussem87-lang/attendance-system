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

function validateEventSequence(events) {
  const flags = [];
  const notes = [];
  const seenFlags = new Set();

  const addFlag = (flag, note) => {
    if (!seenFlags.has(flag)) {
      seenFlags.add(flag);
      flags.push(flag);
    }
    if (note) {
      notes.push(note);
    }
  };

  if (!Array.isArray(events)) {
    addFlag('events_not_array', 'events must be an array');
    return {
      is_valid: false,
      flags,
      notes
    };
  }

  if (events.length === 0) {
    return {
      is_valid: true,
      flags,
      notes
    };
  }

  if (events[0] && events[0].direction === 'OUT') {
    addFlag('first_event_out', 'first event direction is OUT');
  }

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const direction = event ? event.direction : undefined;
    if (direction !== 'IN' && direction !== 'OUT') {
      addFlag('invalid_direction', `invalid direction at index ${i}`);
    }

    if (i > 0) {
      const prevEvent = events[i - 1];
      const prevTime = String(prevEvent && prevEvent.event_time_utc ? prevEvent.event_time_utc : '');
      const currTime = String(event && event.event_time_utc ? event.event_time_utc : '');
      if (prevTime.localeCompare(currTime) > 0) {
        addFlag('events_unsorted', `event_time_utc out of order at index ${i}`);
      }

      const prevDirection = prevEvent ? prevEvent.direction : undefined;
      if ((prevDirection === 'IN' || prevDirection === 'OUT') &&
          (direction === 'IN' || direction === 'OUT') &&
          prevDirection === direction) {
        addFlag('non_alternating_sequence', `repeated direction at index ${i}`);
      }
    }
  }

  return {
    is_valid: flags.length === 0,
    flags,
    notes
  };
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

  const validation = validateEventSequence(input.events);
  if (!validation.is_valid) {
    return {
      person_id: input.person_id,
      day: input.day,
      first_in_utc: null,
      last_out_utc: null,
      total_events: input.events.length,
      minutes_late: null,
      minutes_early_leave: null,
      work_minutes: null,
      status: 'INVALID',
      flags: validation.flags,
      audit: {
        rule_set_id: 'contract-only',
        computed_at_utc: new Date().toISOString(),
        notes: validation.notes
      }
    };
  }

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

module.exports = { computeAttendanceDay, validateEventSequence };
