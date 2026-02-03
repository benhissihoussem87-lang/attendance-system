function getTimeZoneOffset(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const parts = dtf.formatToParts(date);
  const values = {};
  parts.forEach(part => {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
  });

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return (asUtc - date.getTime()) / 60000;
}

function computeMetricsFixedShift(input, ruleSet, timezone) {
  const flags = [];
  const notes = [];

  if (!input || !input.first_in_utc) {
    return {
      minutes_late: null,
      flags,
      notes
    };
  }

  const firstIn = new Date(input.first_in_utc);
  if (Number.isNaN(firstIn.getTime())) {
    return {
      minutes_late: null,
      flags,
      notes
    };
  }

  const fixedShift = ruleSet && ruleSet.fixed_shift ? ruleSet.fixed_shift : null;
  if (!fixedShift || !fixedShift.start_local) {
    return {
      minutes_late: null,
      flags,
      notes
    };
  }

  const [startHour, startMinute] = fixedShift.start_local.split(':').map(Number);
  const [year, month, day] = String(input.day).split('-').map(Number);
  const baseUtc = new Date(Date.UTC(year, month - 1, day, startHour, startMinute, 0));
  const offsetMinutes = getTimeZoneOffset(baseUtc, timezone || 'UTC');
  const shiftStartUtcMs = baseUtc.getTime() - (offsetMinutes * 60000);
  const graceMinutes = Number(fixedShift.late_grace_minutes || 0);
  const graceMs = graceMinutes * 60000;

  let minutes_late = 0;
  if (firstIn.getTime() > shiftStartUtcMs + graceMs) {
    minutes_late = Math.floor((firstIn.getTime() - (shiftStartUtcMs + graceMs)) / 60000);
    flags.push('LATE');
    notes.push('late arrival beyond grace period');
  }

  return {
    minutes_late,
    flags,
    notes
  };
}

module.exports = { computeMetricsFixedShift };
