const DEFAULT_SOURCE_TIMEZONE = process.env.VENDOR_SOURCE_TIMEZONE || 'Africa/Tunis';

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

function normalizeHeaderKey(name) {
  return normalizeHeaderName(name).replace(/\s+/g, '').replace(/_/g, '');
}

function buildHeaderMapper(aliases) {
  const aliasToCanonical = new Map();
  Object.keys(aliases).forEach(canonical => {
    const keys = aliases[canonical] || [];
    keys.forEach(key => {
      aliasToCanonical.set(normalizeHeaderKey(key), canonical);
    });
    aliasToCanonical.set(normalizeHeaderKey(canonical), canonical);
  });
  return aliasToCanonical;
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

function mapDirection(rawValue) {
  const normalized = String(rawValue || '').trim().toUpperCase();
  if (normalized === 'IN' || normalized === 'OUT') {
    return normalized;
  }
  if (normalized === 'I') {
    return 'IN';
  }
  if (normalized === 'O') {
    return 'OUT';
  }
  return null;
}

function createSimplePinCsvAdapter(config) {
  const vendorId = config.id;
  const headerAliases = config.headerAliases;
  const headerMapper = buildHeaderMapper(headerAliases);

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
        vendor: vendorId
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
      const mapped = headerMapper.get(normalizeHeaderKey(cell)) || normalizeHeaderName(cell);
      result.meta.normalized_headers.push(mapped);
      if (mapped && headerMap[mapped] === undefined) {
        headerMap[mapped] = index;
      }
    });

    const missing = [];
    if (headerMap.pin === undefined) {
      missing.push('pin');
    }
    if (headerMap.event_time === undefined) {
      missing.push('event_time');
    }
    if (headerMap.direction === undefined) {
      missing.push('direction');
    }
    if (headerMap.device_serial === undefined) {
      missing.push('device_serial');
    }

    if (missing.length > 0) {
      const message = 'Missing required column(s): ' + missing.join(', ');
      result.errors.push(buildRowError(0, 'MISSING_REQUIRED_COLUMN', message));
      return result;
    }

    const sourceTimezone = options.source_timezone || DEFAULT_SOURCE_TIMEZONE;

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

      const pin = getValue('pin');
      const eventTimeRaw = getValue('event_time');
      const directionRaw = getValue('direction');
      const serialRaw = getValue('device_serial');

      const rowErrors = [];
      if (!pin) {
        rowErrors.push({
          code: 'MISSING_PIN',
          message: 'pin is required to map person_id'
        });
      }

      if (!eventTimeRaw) {
        rowErrors.push({
          code: 'MISSING_EVENT_TIME',
          message: 'event_time is required'
        });
      } else if (!parseUtcDate(eventTimeRaw)) {
        rowErrors.push({
          code: 'INVALID_EVENT_TIME',
          message: 'event_time must be ISO or YYYY-MM-DD HH:MM:SS'
        });
      }

      const direction = mapDirection(directionRaw);
      if (!direction) {
        rowErrors.push({
          code: 'INVALID_DIRECTION',
          message: 'direction must be IN/OUT or I/O'
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
        const originalRow = {};
        headerCells.forEach((header, idx) => {
          originalRow[header] = idx < cells.length ? cells[idx] : '';
        });

        row.data = {
          person_id: pin,
          event_time: eventTimeRaw,
          direction,
          device_uid: `${vendorId}:${serialRaw}`,
          vendor: vendorId,
          raw_payload: {
            original_row: originalRow,
            source_timezone: sourceTimezone,
            mapping_audit: {
              provider: vendorId,
              identifier_type: 'pin',
              identifier_value: pin,
              direction_raw: directionRaw,
              direction_mapped: direction,
              device_uid_source: 'device_serial'
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
    const pin = typeof rowData.person_id === 'string' ? rowData.person_id.trim() : '';
    return {
      provider: vendorId,
      identifier_type: 'pin',
      identifier_value: pin
    };
  }

  return {
    id: vendorId,
    parseCsv,
    identityExtraction,
    headerAliases
  };
}

module.exports = { createSimplePinCsvAdapter };

