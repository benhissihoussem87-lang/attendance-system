const DEFAULT_SOURCE_TIMEZONE = process.env.ANVIZ_SOURCE_TIMEZONE || 'Africa/Tunis';

function detectDelimiter(line) {
  const candidates = ['\t', ',', ';'];
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

function normalizeHeaderKey(name) {
  return normalizeHeaderName(name).replace(/\s+/g, '').replace(/_/g, '');
}

function mapHeaderAlias(name) {
  switch (normalizeHeaderKey(name)) {
    case 'number':
    case 'pin':
    case 'empid':
    case 'employeeid':
    case 'userid':
      return 'pin';
    case 'attendancetime':
    case 'time':
    case 'datetime':
    case 'timestamp':
      return 'attendance_time';
    case 'devicenumber':
    case 'device':
    case 'sn':
    case 'serial':
      return 'device_number';
    case 'attendancestatus':
    case 'status':
    case 'event':
      return 'attendance_status';
    case 'workcode':
      return 'work_code';
    case 'verificationmode':
    case 'verifymode':
      return 'verification_mode';
    default:
      return normalizeHeaderName(name);
  }
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

function mapStatus(rawStatus) {
  const value = String(rawStatus || '').trim().toUpperCase();
  if (value === 'IN' || value === 'OUT') {
    return value;
  }
  if (value === 'I') {
    return 'IN';
  }
  if (value === 'O') {
    return 'OUT';
  }
  return null;
}

function buildRowError(rowNumber, code, message) {
  return { row_number: rowNumber, code, message };
}

function parseDeviceUid(deviceNumberRaw) {
  const deviceNumber = String(deviceNumberRaw || '').trim();
  if (deviceNumber) {
    return {
      deviceUid: `anviz:${deviceNumber}`,
      source: 'device_number',
      fallback: false
    };
  }
  return {
    deviceUid: 'anviz:TEST-DEVICE-1',
    source: 'fallback',
    fallback: true
  };
}

function looksLikeHeaderless(cells) {
  if (!cells || cells.length < 4) {
    return false;
  }
  const first = String(cells[0] || '').trim();
  const second = String(cells[1] || '').trim();
  const third = String(cells[2] || '').trim();
  return /^\d+$/.test(first) && parseLocalDateTime(second) !== null && /^\d+$/.test(third);
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
      vendor: 'anviz'
    }
  };

  if (typeof csvText !== 'string') {
    return result;
  }

  const lines = csvText.split(/\r\n|\n|\r/).filter(line => line.trim() !== '');
  if (lines.length === 0) {
    return result;
  }

  const delimiter = options.delimiter || detectDelimiter(lines[0]) || '\t';
  const firstCells = parseCsvLine(lines[0], delimiter);
  if (firstCells.length > 0) {
    firstCells[0] = stripBom(firstCells[0]);
  }
  result.meta.detected_delimiter = delimiter;

  const headerless = looksLikeHeaderless(firstCells);
  const headerCells = headerless ? [] : firstCells;
  result.meta.raw_headers = headerCells.slice();

  const headerMap = {};
  headerCells.forEach((cell, index) => {
    const name = mapHeaderAlias(cell);
    result.meta.normalized_headers.push(name);
    if (name && headerMap[name] === undefined) {
      headerMap[name] = index;
    }
  });

  const missing = [];
  if (!headerless) {
    if (headerMap.pin === undefined) {
      missing.push('pin');
    }
    if (headerMap.attendance_time === undefined) {
      missing.push('attendance_time');
    }
    if (headerMap.attendance_status === undefined) {
      missing.push('attendance_status');
    }
  }

  if (missing.length > 0) {
    const message = 'Missing required column(s): ' + missing.join(', ');
    result.errors.push(buildRowError(0, 'MISSING_REQUIRED_COLUMN', message));
    return result;
  }

  const sourceTimezone = options.source_timezone || DEFAULT_SOURCE_TIMEZONE;
  if (!isValidTimeZone(sourceTimezone)) {
    result.errors.push(buildRowError(
      0,
      'INVALID_SOURCE_TIMEZONE',
      `Invalid source timezone: ${sourceTimezone}`
    ));
    return result;
  }

  const startIndex = headerless ? 0 : 1;

  for (let i = startIndex; i < lines.length; i += 1) {
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

    const recordIdRaw = headerless ? String(cells[0] || '').trim() : '';
    const attendanceTimeRaw = headerless ? String(cells[1] || '').trim() : getValue('attendance_time');
    const pin = headerless ? String(cells[2] || '').trim() : getValue('pin');
    const statusRaw = headerless ? String(cells[3] || '').trim() : getValue('attendance_status');
    const deviceNumberRaw = headerless ? String(cells[4] || '').trim() : getValue('device_number');
    const verificationModeRaw = headerless ? String(cells[5] || '').trim() : getValue('verification_mode');
    const workCodeRaw = headerless ? '' : getValue('work_code');

    const rowErrors = [];
    if (!pin) {
      rowErrors.push({
        code: 'MISSING_PIN',
        message: 'Number/pin is required to map person_id'
      });
    }

    const components = attendanceTimeRaw ? parseLocalDateTime(attendanceTimeRaw) : null;
    if (!attendanceTimeRaw) {
      rowErrors.push({
        code: 'MISSING_ATTENDANCE_TIME',
        message: 'Attendance Time is required'
      });
    } else if (!components) {
      rowErrors.push({
        code: 'INVALID_ATTENDANCE_TIME',
        message: 'Attendance Time must be local datetime (YYYY-MM-DD HH:MM:SS)'
      });
    }

    const direction = mapStatus(statusRaw);
    if (!statusRaw) {
      rowErrors.push({
        code: 'MISSING_STATUS',
        message: 'Attendance Status is required'
      });
    } else if (!direction) {
      rowErrors.push({
        code: 'UNKNOWN_STATUS',
        message: `Attendance Status '${statusRaw}' is not recognized`
      });
    }

    const { deviceUid, source: deviceUidSource, fallback: deviceUidFallback } = parseDeviceUid(deviceNumberRaw);

    const row = {
      row_number: rowNumber,
      valid: rowErrors.length === 0
    };

    if (row.valid) {
      const utcDate = zonedTimeToUtc(components, sourceTimezone);
      if (Number.isNaN(utcDate.getTime())) {
        row.valid = false;
        rowErrors.push({
          code: 'INVALID_ATTENDANCE_TIME',
          message: 'Failed to interpret Attendance Time in source timezone'
        });
      } else {
        const originalRow = {};
        if (headerless) {
          originalRow.record_id = recordIdRaw;
          originalRow.local_datetime = attendanceTimeRaw;
          originalRow.pin = pin;
          originalRow.status = statusRaw;
          originalRow.device_number = deviceNumberRaw;
          originalRow.method = verificationModeRaw;
        } else {
          headerCells.forEach((header, idx) => {
            originalRow[header] = idx < cells.length ? cells[idx] : '';
          });
        }

        row.data = {
          person_id: pin,
          event_time: utcDate.toISOString(),
          direction,
          device_uid: deviceUid,
          vendor: 'anviz',
          raw_payload: {
            original_row: originalRow,
            source_timezone: sourceTimezone,
            mapping_audit: {
              provider: 'anviz',
              identifier_type: 'pin',
              identifier_value: pin,
              record_id: recordIdRaw,
              method: verificationModeRaw,
              status_raw: statusRaw,
              status_mapped: direction,
              device_uid_source: deviceUidSource,
              device_uid_fallback: deviceUidFallback
            }
          }
        };

        if (workCodeRaw) {
          row.data.raw_payload.work_code = workCodeRaw;
        }
        if (verificationModeRaw) {
          row.data.raw_payload.verification_mode = verificationModeRaw;
        }

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

function identityExtraction(rowData = {}) {
  const pin = typeof rowData.person_id === 'string' ? rowData.person_id.trim() : '';
  return {
    provider: 'anviz',
    identifier_type: 'pin',
    identifier_value: pin
  };
}

module.exports = {
  id: 'anviz',
  parseCsv,
  identityExtraction
};
