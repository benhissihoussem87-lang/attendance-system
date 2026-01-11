module.exports = {
  build(events) {
    const inEvents = events.filter(e => e.direction === 'IN');
    const outEvents = events.filter(e => e.direction === 'OUT');

    const inEvent = inEvents.length > 0
      ? inEvents.reduce((earliest, current) =>
        new Date(current.event_time) < new Date(earliest.event_time) ? current : earliest
      )
      : null;

    const outEvent = outEvents.length > 0
      ? outEvents.reduce((latest, current) =>
        new Date(current.event_time) > new Date(latest.event_time) ? current : latest
      )
      : null;

    return {
      inEvent,
      outEvent
    };
  }
};
