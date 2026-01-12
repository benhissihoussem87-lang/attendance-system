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
  switch (name) {
    case 'event_time':
    case 'event_time_utc':
    case 'timestamp':
    case 'time':
      return 'event_time';
    case 'person':
    case 'person_id':
    case 'employee':
    case 'employee_id':
      return 'person_id';
    case 'direction':
    case 'status':
    case 'io':
      return 'direction';
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

function maybeAssign(target, key, value) {
  if (value !== '') {
    target[key] = value;
  }
}

const zktecoAdapter = require('../adapters/vendors/zkteco');

function validateDeviceEventsCsv(csvText, options = {}) {
  const result = {
    total_rows: 0,
    valid_rows: 0,
    invalid_rows: 0,
    rows: [],
    errors: [],
    meta: {
      detected_delimiter: undefined,
      raw_headers: [],
      normalized_headers: []
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

  const required = ['person_id', 'event_time', 'direction'];
  const missing = required.filter(col => headerMap[col] === undefined);
  if (missing.length > 0) {
    const message = 'Missing required column(s): ' + missing.join(', ');
    result.errors.push(buildRowError(0, 'MISSING_REQUIRED_COLUMN', message));
    return result;
  }

  const optional = [
    'device_uid',
    'vendor',
    'card_number',
    'employee_code',
    'raw_payload'
  ];

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

    const personId = getValue('person_id');
    const eventTime = getValue('event_time');
    const directionRaw = getValue('direction');
    const direction = directionRaw ? directionRaw.toUpperCase() : '';

    const rowErrors = [];

    if (!personId) {
      rowErrors.push({ code: 'EMPTY_PERSON_ID', message: 'person_id is required' });
    }

    if (!parseUtcDate(eventTime)) {
      rowErrors.push({ code: 'INVALID_EVENT_TIME', message: 'event_time is invalid' });
    }

    if (direction !== 'IN' && direction !== 'OUT') {
      rowErrors.push({ code: 'INVALID_DIRECTION', message: 'direction must be IN or OUT' });
    }

    const rowData = {
      person_id: personId,
      event_time: eventTime,
      direction
    };

    optional.forEach(name => {
      if (headerMap[name] !== undefined) {
        maybeAssign(rowData, name, getValue(name));
      }
    });

    const row = {
      row_number: rowNumber,
      valid: rowErrors.length === 0
    };

    if (row.valid) {
      row.data = rowData;
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

function parseDeviceEventsCsv(csvText, options = {}) {
  const vendor = options.vendor ? String(options.vendor).toLowerCase() : null;
  if (vendor === 'zkteco') {
    return zktecoAdapter.parseCsv(csvText, options);
  }
  return validateDeviceEventsCsv(csvText, options);
}

module.exports = { validateDeviceEventsCsv, parseDeviceEventsCsv };
