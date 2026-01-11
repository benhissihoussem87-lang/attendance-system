const ENABLE_DAY_BOUNDARY_DEBUG =
  process.env.ENABLE_DAY_BOUNDARY_DEBUG === 'true';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatDateParts(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getLocalParts(date, timeZone) {
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

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
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

function subtractLocalDay(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  date.setUTCDate(date.getUTCDate() - 1);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}

function deriveWorkDate({
  event_time_utc,
  company_timezone,
  night_shift_enabled,
  day_start_time
}) {
  const mode = night_shift_enabled ? 'anchored' : 'calendar';
  const date = event_time_utc instanceof Date
    ? event_time_utc
    : new Date(event_time_utc);

  if (Number.isNaN(date.getTime())) {
    if (ENABLE_DAY_BOUNDARY_DEBUG) {
      throw new Error('Invalid event_time_utc');
    }
    return { work_date: '', mode };
  }

  const localParts = getLocalParts(date, company_timezone);

  if (!night_shift_enabled) {
    return {
      work_date: formatDateParts(localParts),
      mode
    };
  }

  const start = parseDayStartTime(day_start_time);
  if (!start) {
    if (ENABLE_DAY_BOUNDARY_DEBUG) {
      throw new Error('Invalid day_start_time');
    }
    return {
      work_date: formatDateParts(localParts),
      mode
    };
  }

  const localMinutes = localParts.hour * 60 + localParts.minute;
  const startMinutes = start.hour * 60 + start.minute;
  if (localMinutes < startMinutes) {
    const previous = subtractLocalDay(localParts);
    return {
      work_date: formatDateParts(previous),
      mode
    };
  }

  return {
    work_date: formatDateParts(localParts),
    mode
  };
}

module.exports = { deriveWorkDate };
