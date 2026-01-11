function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseWorkDate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function parseDayStartTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2])
  };
}

function addDays(components, days) {
  const date = new Date(Date.UTC(components.year, components.month - 1, components.day));
  date.setUTCDate(date.getUTCDate() + days);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function getTimeZoneOffset(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const parts = formatter.formatToParts(date);
  const values = {};
  parts.forEach(part => {
    values[part.type] = part.value;
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

function zonedTimeToUtc(components, timeZone) {
  const utcDate = new Date(Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    components.second || 0,
    components.millisecond || 0
  ));
  const offsetMinutes = getTimeZoneOffset(utcDate, timeZone);
  return new Date(utcDate.getTime() - offsetMinutes * 60000);
}

function getUtcWindowForWorkDate({ work_date, config }) {
  const dateParts = parseWorkDate(work_date);
  if (!dateParts) {
    throw new Error('Invalid work_date');
  }

  const mode = config.night_shift_enabled ? 'anchored' : 'calendar';
  const startTime = config.night_shift_enabled
    ? parseDayStartTime(config.day_start_time)
    : { hour: 0, minute: 0 };

  if (!startTime) {
    throw new Error('Invalid day_start_time');
  }

  const startComponents = {
    year: dateParts.year,
    month: dateParts.month,
    day: dateParts.day,
    hour: startTime.hour,
    minute: startTime.minute,
    second: 0,
    millisecond: 0
  };
  const endDate = addDays(dateParts, 1);
  const endComponents = {
    year: endDate.year,
    month: endDate.month,
    day: endDate.day,
    hour: startTime.hour,
    minute: startTime.minute,
    second: 0,
    millisecond: 0
  };

  const windowStartUtc = zonedTimeToUtc(startComponents, config.company_timezone);
  const windowEndUtc = zonedTimeToUtc(endComponents, config.company_timezone);

  return {
    windowStartUtcIso: windowStartUtc.toISOString(),
    windowEndUtcIso: windowEndUtc.toISOString(),
    mode
  };
}

module.exports = { getUtcWindowForWorkDate };
