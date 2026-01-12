const DEFAULT_SOURCE_TIMEZONE = process.env.ZKTECO_SOURCE_TIMEZONE || 'Africa/Tunis';

function detectDelimiter(line) {
  const candidates = [',', ';', '\t'];
  const counts = candidates.map(delim => countDelimiter(line, delim));
  let bestIndex = 0;
  for (let i = 1; i < counts.length; i += 1) {
    if (counts[i] > counts[bestIndex]) {
      bestIndex = i;
    }
  }
  return candidates[bestIndex];
}

function countDelimiter(line, delimiter) {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      count += 1;
    }
  }
  return count;
}

function parseCsvLine(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
}

function stripBom(value) {
  if (!value) {
    return value;
  }
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

function normalizeHeaderName(name) {
  return stripBom(String(name || '')).trim().toLowerCase();
}

function mapHeaderAlias(name) {
  const normalized = name.replace(/\s+/g, '').replace(/_/g, '');
  switch (normalized) {
    case 'userid':
      return 'userid';
    case 'badgenumber':
    case 'badgenum':
    case 'badgenumberid':
    case 'badgenumbercode':
      return 'badgenumber';
    case 'checktime':
      return 'checktime';
    case 'checktype':
      return 'checktype';
    case 'verifycode':
      return 'verifycode';
    case 'sensorid':
      return 'sensorid';
    case 'memoinfo':
      return 'memoinfo';
    case 'workcode':
      return 'workcode';
    case 'sn':
      return 'sn';
    case 'userextfmt':
      return 'userextfmt';
    case 'maskflag':
      return 'mask_flag';
    case 'temperature':
      return 'temperature';
    case 'machinenumber':
      return 'machinenumber';
    default:
      return name;
  }
}

function buildRowError(rowNumber, code, message) {
  return { row_number: rowNumber, code, message };
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

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch (err) {
    return false;
  }
}

function parseCheckTypeMap(rawMap) {
  if (!rawMap || typeof rawMap !== 'object') {
    return {};
  }
  const normalized = {};
  Object.keys(rawMap).forEach(key => {
    const mapKey = String(key).trim();
    const mapValue = String(rawMap[key]).trim().toUpperCase();
    if (mapKey && (mapValue === 'IN' || mapValue === 'OUT')) {
      normalized[mapKey] = mapValue;
    }
  });
  return normalized;
}

function getCheckTypeMap(options) {
  if (options && options.checktype_map) {
    return parseCheckTypeMap(options.checktype_map);
  }
  if (options && options.checkTypeMap) {
    return parseCheckTypeMap(options.checkTypeMap);
  }
  if (process.env.ZKTECO_CHECKTYPE_MAP) {
    try {
      return parseCheckTypeMap(JSON.parse(process.env.ZKTECO_CHECKTYPE_MAP));
    } catch (err) {
      return {};
    }
  }
  return {};
}

function mapRowToCanonical(row, context = {}) {
  if (!row || typeof row !== 'object') {
    throw new Error('Row must be an object');
  }

  const sourceTimezone = context.source_timezone || DEFAULT_SOURCE_TIMEZONE;
  const checkTypeMap = getCheckTypeMap(context);

  const badgeNumber = String(row.badgenumber || '').trim();
  const checkTimeRaw = String(row.checktime || '').trim();
  const checkTypeRaw = String(row.checktype || '').trim();
  const snRaw = String(row.sn || '').trim();
  const machineNumberRaw = String(row.machinenumber || '').trim();

  if (!badgeNumber) {
    throw new Error('Badgenumber is required to map person_id');
  }

  const components = parseLocalDateTime(checkTimeRaw);
  if (!components) {
    throw new Error('CHECKTIME must be local datetime (YYYY-MM-DD HH:MM:SS)');
  }

  const direction = checkTypeMap[checkTypeRaw];
  if (!direction) {
    throw new Error(`CHECKTYPE '${checkTypeRaw}' has no configured mapping`);
  }

  let deviceUid = null;
  let deviceUidSource = null;
  let deviceUidFallback = false;
  if (snRaw) {
    deviceUid = `zkteco:${snRaw}`;
    deviceUidSource = 'sn';
  } else if (machineNumberRaw) {
    deviceUid = `zkteco:machine:${machineNumberRaw}`;
    deviceUidSource = 'machine_number';
    deviceUidFallback = true;
  } else {
    throw new Error('sn or MachineNumber is required to build device_uid');
  }

  if (!isValidTimeZone(sourceTimezone)) {
    throw new Error(`Invalid source timezone: ${sourceTimezone}`);
  }

  const utcDate = zonedTimeToUtc(components, sourceTimezone);
  if (Number.isNaN(utcDate.getTime())) {
    throw new Error('Failed to interpret CHECKTIME in source timezone');
  }

  const rawPayload = {
    original_row: { ...row },
    source_table: 'CHECKINOUT',
    source_timezone: sourceTimezone,
    original_checktime_string: checkTimeRaw,
    mapping_audit: {
      checktype_raw: checkTypeRaw,
      checktype_mapped: direction,
      device_uid_source: deviceUidSource,
      device_uid_fallback: deviceUidFallback
    }
  };

  return {
    person_id: badgeNumber,
    event_time_utc: utcDate.toISOString(),
    direction,
    device_uid: deviceUid,
    vendor: 'zkteco',
    raw_payload: rawPayload
  };
}

function parseCsv(csvText, options = {}) {
  const result = {
    total_rows: 0,
    valid_rows: 0,
    invalid_rows: 0,
    rows: [],
    errors: [],
    meta: {
      detected_delimiter: undefined,
      raw_headers: [],
      normalized_headers: [],
      vendor: 'zkteco'
    }
  };

  if (typeof csvText !== 'string') {
    return result;
  }

  const lines = csvText.split(/\r\n|\n|\r/).filter(line => line.trim() !== '');
  if (lines.length === 0) {
    return result;
  }

  const delimiter = options.delimiter || detectDelimiter(lines[0]) || ',';
  const headerCells = parseCsvLine(lines[0], delimiter);
  if (headerCells.length > 0) {
    headerCells[0] = stripBom(headerCells[0]);
  }
  result.meta.detected_delimiter = delimiter;
  result.meta.raw_headers = headerCells.slice();

  const headerMap = {};
  headerCells.forEach((cell, index) => {
    const normalized = normalizeHeaderName(cell);
    const name = mapHeaderAlias(normalized);
    result.meta.normalized_headers.push(name);
    if (name && headerMap[name] === undefined) {
      headerMap[name] = index;
    }
  });

  const missing = [];
  ['badgenumber', 'checktime', 'checktype'].forEach(col => {
    if (headerMap[col] === undefined) {
      missing.push(col);
    }
  });
  const hasSn = headerMap.sn !== undefined;
  const hasMachineNumber = headerMap.machinenumber !== undefined;
  if (!hasSn && !hasMachineNumber) {
    missing.push('sn or MachineNumber');
  }

  if (missing.length > 0) {
    const message = 'Missing required column(s): ' + missing.join(', ');
    result.errors.push(buildRowError(0, 'MISSING_REQUIRED_COLUMN', message));
    return result;
  }

  const checkTypeMap = getCheckTypeMap(options);
  const sourceTimezone = options.source_timezone || DEFAULT_SOURCE_TIMEZONE;
  if (!isValidTimeZone(sourceTimezone)) {
    result.errors.push(buildRowError(
      0,
      'INVALID_SOURCE_TIMEZONE',
      `Invalid source timezone: ${sourceTimezone}`
    ));
    return result;
  }

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const rowNumber = i + 1;
    const cells = parseCsvLine(line, delimiter);
    const getValue = name => {
      const index = headerMap[name];
      if (index === undefined || index >= cells.length) {
        return '';
      }
      return String(cells[index]).trim();
    };

    const rowErrors = [];
    const badgeNumber = getValue('badgenumber');
    const checkTimeRaw = getValue('checktime');
    const checkTypeRaw = getValue('checktype');
    const snRaw = getValue('sn');
    const machineNumberRaw = getValue('machinenumber');

    if (!badgeNumber) {
      rowErrors.push({
        code: 'MISSING_BADGENUMBER',
        message: 'Badgenumber is required to map person_id'
      });
    }

    const components = checkTimeRaw ? parseLocalDateTime(checkTimeRaw) : null;
    if (!checkTimeRaw) {
      rowErrors.push({
        code: 'MISSING_CHECKTIME',
        message: 'CHECKTIME is required'
      });
    } else if (!components) {
      rowErrors.push({
        code: 'INVALID_CHECKTIME',
        message: 'CHECKTIME must be local datetime (YYYY-MM-DD HH:MM:SS)'
      });
    }

    if (!checkTypeRaw) {
      rowErrors.push({
        code: 'MISSING_CHECKTYPE',
        message: 'CHECKTYPE is required'
      });
    } else if (!checkTypeMap[checkTypeRaw]) {
      rowErrors.push({
        code: 'UNKNOWN_CHECKTYPE',
        message: `CHECKTYPE '${checkTypeRaw}' has no configured mapping`
      });
    }

    let deviceUid = null;
    let deviceUidSource = null;
    let deviceUidFallback = false;
    if (snRaw) {
      deviceUid = `zkteco:${snRaw}`;
      deviceUidSource = 'sn';
    } else if (machineNumberRaw) {
      deviceUid = `zkteco:machine:${machineNumberRaw}`;
      deviceUidSource = 'machine_number';
      deviceUidFallback = true;
    } else {
      rowErrors.push({
        code: 'MISSING_DEVICE_UID',
        message: 'sn or MachineNumber is required to build device_uid'
      });
    }

    const row = {
      row_number: rowNumber,
      valid: rowErrors.length === 0
    };

    if (row.valid) {
      const utcDate = zonedTimeToUtc(components, sourceTimezone);
      if (Number.isNaN(utcDate.getTime())) {
        row.valid = false;
        rowErrors.push({
          code: 'INVALID_CHECKTIME',
          message: 'Failed to interpret CHECKTIME in source timezone'
        });
      } else {
        const originalRow = {};
        headerCells.forEach((header, idx) => {
          originalRow[header] = idx < cells.length ? cells[idx] : '';
        });

        row.data = {
          person_id: badgeNumber,
          event_time_utc: utcDate.toISOString(),
          direction: checkTypeMap[checkTypeRaw],
          device_uid: deviceUid,
          vendor: 'zkteco',
          raw_payload: {
            original_row: originalRow,
            source_table: 'CHECKINOUT',
            source_timezone: sourceTimezone,
            original_checktime_string: checkTimeRaw,
            mapping_audit: {
              checktype_raw: checkTypeRaw,
              checktype_mapped: checkTypeMap[checkTypeRaw],
              device_uid_source: deviceUidSource,
              device_uid_fallback: deviceUidFallback
            }
          }
        };
        result.valid_rows += 1;
      }
    }

    if (!row.valid) {
      row.errors = rowErrors;
      rowErrors.forEach(err => {
        result.errors.push(buildRowError(rowNumber, err.code, err.message));
      });
      result.invalid_rows += 1;
    }

    result.total_rows += 1;
    result.rows.push(row);
  }

  return result;
}

const zktecoAdapter = {
  id: 'zkteco',
  parseCsv,
  mapRowToCanonical
};

module.exports = zktecoAdapter;
