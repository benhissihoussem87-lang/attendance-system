const { DateTime } = require('luxon');

function computeMetricsEarlyLeave(input, ruleSet, timezone) {
  const flags = [];
  const notes = [];

  if (!input || !input.last_out_utc) {
    return {
      minutes_early_leave: null,
      flags,
      notes
    };
  }

  try {
    const fixedShift = ruleSet && ruleSet.fixed_shift ? ruleSet.fixed_shift : null;
    if (!fixedShift || !fixedShift.end_local) {
      notes.push('missing fixed shift end_local for early leave calculation');
      return {
        minutes_early_leave: null,
        flags,
        notes
      };
    }

    const lastOut = DateTime.fromISO(String(input.last_out_utc), { zone: 'utc' });
    if (!lastOut.isValid) {
      notes.push('invalid last_out_utc format for early leave calculation');
      return {
        minutes_early_leave: null,
        flags,
        notes
      };
    }

    const shiftEndLocal = DateTime.fromISO(
      `${input.day}T${fixedShift.end_local}:00`,
      { zone: timezone || 'UTC' }
    );
    if (!shiftEndLocal.isValid) {
      notes.push('invalid shift end time for early leave calculation');
      return {
        minutes_early_leave: null,
        flags,
        notes
      };
    }

    const shiftEndUtc = shiftEndLocal.toUTC();
    if (lastOut < shiftEndUtc) {
      const minutes = Math.round(shiftEndUtc.diff(lastOut, 'minutes').minutes);
      flags.push('LEFT_EARLY');
      notes.push(`early departure detected: ${minutes} minutes before shift end`);
      return {
        minutes_early_leave: minutes,
        flags,
        notes
      };
    }

    return {
      minutes_early_leave: 0,
      flags,
      notes
    };
  } catch (error) {
    notes.push(`early leave calculation failed: ${error.message}`);
    return {
      minutes_early_leave: null,
      flags,
      notes
    };
  }
}

module.exports = { computeMetricsEarlyLeave };
