/**
 * Vendor adapter: generic_punchlog
 *
 * Assumptions:
 * - employee_id is the identity identifier (person_id).
 * - timestamp is already UTC (ISO or "YYYY-MM-DD HH:MM:SS").
 * - event is IN/OUT when present; otherwise direction is null with an audit note.
 * - device_serial is required to build device_uid.
 */

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
    case 'employeeid':
    case 'employeeno':
    case 'empid':
    case 'userid':
    case 'user':
      return 'employee_id';
    case 'timestamp':
    case 'datetime':
    case 'time':
    case 'eventtime':
    case 'eventtimeutc':
      return 'timestamp';
    case 'event':
    case 'status':
    case 'direction':
      return 'event';
    case 'deviceserial':
    case 'sn':
    case 'deviceid':
    case 'device':
      return 'device_serial';
    default:
      return name;
  }
}

function isIsoDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value);
}

function isLegacyDateTime(value) {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
}

function parseUtcDate(value) {
  if (isLegacyDateTime(value)) {
    const normalized = value.replace(' ', 'T') + 'Z';
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (isIsoDateTime(value)) {
    let normalized = value;
    if (!/[Z+-]\d{2}:\d{2}$/.test(value)) {
      normalized = value + 'Z';
    }
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function buildRowError(rowNumber, code, message) {
  return { row_number: rowNumber, code, message };
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
      vendor: 'generic_punchlog'
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
  if (headerMap.employee_id === undefined) {
    missing.push('employee_id');
  }
  if (headerMap.timestamp === undefined) {
    missing.push('timestamp');
  }
  if (headerMap.device_serial === undefined) {
    missing.push('device_serial');
  }

  if (missing.length > 0) {
    const message = 'Missing required column(s): ' + missing.join(', ');
    result.errors.push(buildRowError(0, 'MISSING_REQUIRED_COLUMN', message));
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

    const employeeId = getValue('employee_id');
    const timestampRaw = getValue('timestamp');
    const eventRaw = getValue('event');
    const serialRaw = getValue('device_serial');

    const rowErrors = [];
    if (!employeeId) {
      rowErrors.push({
        code: 'MISSING_EMPLOYEE_ID',
        message: 'employee_id is required to map person_id'
      });
    }

    const parsedTime = timestampRaw ? parseUtcDate(timestampRaw) : null;
    if (!timestampRaw) {
      rowErrors.push({
        code: 'MISSING_TIMESTAMP',
        message: 'timestamp is required'
      });
    } else if (!parsedTime) {
      rowErrors.push({
        code: 'INVALID_TIMESTAMP',
        message: 'timestamp must be ISO or YYYY-MM-DD HH:MM:SS'
      });
    }

    if (!serialRaw) {
      rowErrors.push({
        code: 'MISSING_DEVICE_SERIAL',
        message: 'device_serial is required to build device_uid'
      });
    }

    const row = {
      row_number: rowNumber,
      valid: rowErrors.length === 0
    };

    if (row.valid) {
      const direction = eventRaw ? eventRaw.trim().toUpperCase() : null;
      const directionMapped = direction === 'IN' || direction === 'OUT' ? direction : null;
      const mappingAudit = {
        direction_raw: eventRaw || '',
        direction_mapped: directionMapped,
        device_uid_source: 'device_serial',
        pin_source: 'employee_id'
      };
      if (!directionMapped) {
        mappingAudit.note = 'direction_missing';
      }

      const originalRow = {};
      headerCells.forEach((header, idx) => {
        originalRow[header] = idx < cells.length ? cells[idx] : '';
      });

      row.data = {
        person_id: employeeId,
        event_time_utc: parsedTime.toISOString(),
        direction: directionMapped,
        device_uid: `generic_punchlog:${serialRaw}`,
        vendor: 'generic_punchlog',
        raw_payload: {
          original_row: originalRow,
          mapping_audit: mappingAudit,
          identity: {
            provider: 'generic_punchlog',
            identifier_type: 'person_id',
            identifier_value: employeeId
          }
        }
      };
      result.valid_rows += 1;
    } else {
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
  const personId = typeof rowData.person_id === 'string' ? rowData.person_id.trim() : '';
  return {
    provider: 'generic_punchlog',
    identifier_type: 'person_id',
    identifier_value: personId
  };
}

module.exports = {
  id: 'generic_punchlog',
  parseCsv,
  identityExtraction
};

