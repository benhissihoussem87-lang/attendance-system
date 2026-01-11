const ENABLE_CSV_TIME_INTERPRETATION =
  process.env.ENABLE_CSV_TIME_INTERPRETATION === 'true';

function hasTimezone(value) {
  return /[Zz]|[+-]\d{2}:\d{2}$/.test(value);
}

function parseLocalDateTime(value) {
  const match = String(value).match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  );
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
    millisecond: Number((match[7] || '0').padEnd(3, '0'))
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
    components.second,
    components.millisecond
  ));
  const offsetMinutes = getTimeZoneOffset(utcDate, timeZone);
  return new Date(utcDate.getTime() - offsetMinutes * 60000);
}

function interpretEventTime({ event_time_raw, company_timezone }) {
  if (!ENABLE_CSV_TIME_INTERPRETATION) {
    return { event_time_utc: event_time_raw, time_audit: null };
  }

  if (!event_time_raw) {
    const err = new Error('Missing event_time value');
    err.code = 'TIME_INTERPRETATION_FAILED';
    throw err;
  }

  const rawValue = String(event_time_raw).trim();
  if (hasTimezone(rawValue)) {
    const parsed = new Date(rawValue);
    if (Number.isNaN(parsed.getTime())) {
      const err = new Error('Invalid event_time with timezone');
      err.code = 'TIME_INTERPRETATION_FAILED';
      throw err;
    }
    return {
      event_time_utc: parsed.toISOString(),
      time_audit: {
        original_value: rawValue,
        source_timezone: 'embedded',
        timezone_inferred: false
      }
    };
  }

  const components = parseLocalDateTime(rawValue);
  if (!components) {
    const err = new Error('Invalid event_time format');
    err.code = 'TIME_INTERPRETATION_FAILED';
    throw err;
  }

  const utcDate = zonedTimeToUtc(components, company_timezone);
  if (Number.isNaN(utcDate.getTime())) {
    const err = new Error('Failed to interpret event_time');
    err.code = 'TIME_INTERPRETATION_FAILED';
    throw err;
  }

  return {
    event_time_utc: utcDate.toISOString(),
    time_audit: {
      original_value: rawValue,
      source_timezone: company_timezone,
      timezone_inferred: true
    }
  };
}

function isTimeInterpretationEnabled() {
  return ENABLE_CSV_TIME_INTERPRETATION;
}

module.exports = {
  interpretEventTime,
  isTimeInterpretationEnabled
};
