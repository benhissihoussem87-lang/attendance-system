function deriveDayStatus({ events, first_in_utc, last_out_utc }) {
  const flags = [];
  const notes = [];
  const eventCount = Array.isArray(events) ? events.length : 0;

  if (eventCount === 0) {
    flags.push('NO_EVENTS');
    notes.push('no attendance events recorded');
    return { status: 'ABSENT', flags, notes };
  }

  if (first_in_utc && !last_out_utc) {
    flags.push('MISSING_OUT');
    notes.push('missing OUT event for attendance day');
    return { status: 'INCOMPLETE', flags, notes };
  }

  if (!first_in_utc && last_out_utc) {
    flags.push('MISSING_IN');
    notes.push('missing IN event for attendance day');
    return { status: 'INCOMPLETE', flags, notes };
  }

  return { status: 'PRESENT', flags, notes };
}

module.exports = { deriveDayStatus };
