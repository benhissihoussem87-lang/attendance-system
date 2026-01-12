function stripVendor(event) {
  if (!event) {
    return null;
  }
  const { vendor, ...clean } = event;
  return clean;
}

function computeAttendanceDay({ person_id, day, events }) {
  // THIS IS A STUB — logic will evolve
  // For now, just return a deterministic structure

  return {
    person_id,
    day,
    total_events: events.length,
    first_event: stripVendor(events[0]),
    last_event: stripVendor(events[events.length - 1])
  };
}

module.exports = { computeAttendanceDay };
