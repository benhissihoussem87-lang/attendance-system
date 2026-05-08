'use strict';

const MIN_VALID_UTC_MS = Date.UTC(2000, 0, 1, 0, 0, 0);
const MAX_VALID_UTC_MS = Date.UTC(2035, 0, 1, 0, 0, 0);
const DEFAULT_MAX_HEADER_BYTES = 32;
const DEFAULT_MAX_MALFORMED_SAMPLES = 12;

const CANDIDATE_RECORD_SIZES = [16, 24, 32, 40];

const CANDIDATE_LAYOUTS = [
  {
    id: 'k80_len4_ascii24_ts27_status26_verify25',
    record_size: 40,
    user: { kind: 'ascii', offset: 2, length: 24 },
    timestamp_offset: 27,
    status_offset: 26,
    verify_offset: 25,
    direction_offset: 31,
    direction_basis: 'k80_full_history_direction_state',
    preferred_when: 'k80_len4_u32_payload_size'
  },
  {
    id: 'u32_ts_status_verify',
    record_size: 16,
    user: { kind: 'u32le', offset: 0 },
    timestamp_offset: 4,
    status_offset: 8,
    verify_offset: 9
  },
  {
    id: 'ascii9_ts_status_verify',
    record_size: 16,
    user: { kind: 'ascii', offset: 0, length: 9 },
    timestamp_offset: 9,
    status_offset: 13,
    verify_offset: 14
  },
  {
    id: 'uid2_ascii9_verify_status_ts',
    record_size: 16,
    user: { kind: 'ascii', offset: 2, length: 9 },
    timestamp_offset: 12,
    status_offset: 11,
    verify_offset: 10
  },
  {
    id: 'uid2_ascii9_status_verify_ts',
    record_size: 16,
    user: { kind: 'ascii', offset: 2, length: 9 },
    timestamp_offset: 12,
    status_offset: 10,
    verify_offset: 11
  },
  {
    id: 'ascii9_pad24_ts_status_verify',
    record_size: 24,
    user: { kind: 'ascii', offset: 0, length: 9 },
    timestamp_offset: 12,
    status_offset: 16,
    verify_offset: 17
  },
  {
    id: 'uid2_ascii9_pad24_verify_status_ts',
    record_size: 24,
    user: { kind: 'ascii', offset: 2, length: 9 },
    timestamp_offset: 12,
    status_offset: 11,
    verify_offset: 10
  },
  {
    id: 'ascii9_pad32_ts_status_verify',
    record_size: 32,
    user: { kind: 'ascii', offset: 0, length: 9 },
    timestamp_offset: 12,
    status_offset: 16,
    verify_offset: 17
  },
  {
    id: 'ascii24_ts28_verify_status',
    record_size: 40,
    user: { kind: 'ascii', offset: 2, length: 24 },
    timestamp_offset: 28,
    status_offset: 27,
    verify_offset: 26
  },
  {
    id: 'ascii24_ts28_status_verify',
    record_size: 40,
    user: { kind: 'ascii', offset: 2, length: 24 },
    timestamp_offset: 28,
    status_offset: 26,
    verify_offset: 27
  },
  {
    id: 'ascii24_ts32_status_verify',
    record_size: 40,
    user: { kind: 'ascii', offset: 2, length: 24 },
    timestamp_offset: 32,
    status_offset: 36,
    verify_offset: 37
  }
];

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLocalDateTime(parts) {
  return `${String(parts.year).padStart(4, '0')}-${pad2(parts.month)}-${pad2(parts.day)} `
    + `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

function toTimestampResult(parts, method, raw) {
  const utcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  if (Number.isNaN(utcMs)) {
    return null;
  }
  if (utcMs < MIN_VALID_UTC_MS || utcMs >= MAX_VALID_UTC_MS) {
    return null;
  }
  const utcDate = new Date(utcMs);
  if (utcDate.getUTCFullYear() !== parts.year
    || (utcDate.getUTCMonth() + 1) !== parts.month
    || utcDate.getUTCDate() !== parts.day
    || utcDate.getUTCHours() !== parts.hour
    || utcDate.getUTCMinutes() !== parts.minute
    || utcDate.getUTCSeconds() !== parts.second) {
    return null;
  }
  return {
    ...parts,
    raw,
    method,
    local_date_time: formatLocalDateTime(parts),
    iso_utc_assumed: utcDate.toISOString(),
    utc_ms: utcMs
  };
}

function decodeZkTimestampPacked(value) {
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  let cursor = value;
  const second = cursor % 60;
  cursor = Math.floor(cursor / 60);
  const minute = cursor % 60;
  cursor = Math.floor(cursor / 60);
  const hour = cursor % 24;
  cursor = Math.floor(cursor / 24);
  const day = (cursor % 31) + 1;
  cursor = Math.floor(cursor / 31);
  const month = (cursor % 12) + 1;
  const year = Math.floor(cursor / 12) + 2000;
  return toTimestampResult(
    { year, month, day, hour, minute, second },
    'packed_31day',
    value
  );
}

function decodeZkTimestampEpoch(value) {
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  const utcMs = MIN_VALID_UTC_MS + (value * 1000);
  if (!Number.isFinite(utcMs)) {
    return null;
  }
  if (utcMs < MIN_VALID_UTC_MS || utcMs >= MAX_VALID_UTC_MS) {
    return null;
  }
  const utcDate = new Date(utcMs);
  return toTimestampResult(
    {
      year: utcDate.getUTCFullYear(),
      month: utcDate.getUTCMonth() + 1,
      day: utcDate.getUTCDate(),
      hour: utcDate.getUTCHours(),
      minute: utcDate.getUTCMinutes(),
      second: utcDate.getUTCSeconds()
    },
    'epoch_2000',
    value
  );
}

function decodeZkTimestamp(value) {
  const packed = decodeZkTimestampPacked(value);
  if (packed) {
    return packed;
  }
  return decodeZkTimestampEpoch(value);
}

function sanitizeAsciiId(raw) {
  const normalized = normalizeText(String(raw || '').replace(/\x00/g, ''));
  if (!normalized) {
    return '';
  }
  const safe = normalized.replace(/[^A-Za-z0-9_.\-/:]/g, '');
  if (!safe) {
    return '';
  }
  if (!/[A-Za-z0-9]/.test(safe)) {
    return '';
  }
  return safe.slice(0, 32);
}

function readUserId(record, userSpec) {
  if (!Buffer.isBuffer(record) || !isPlainObject(userSpec)) {
    return '';
  }
  if (userSpec.kind === 'u32le') {
    if (!Number.isInteger(userSpec.offset) || userSpec.offset < 0 || (userSpec.offset + 4) > record.length) {
      return '';
    }
    const value = record.readUInt32LE(userSpec.offset);
    if (!Number.isInteger(value) || value <= 0 || value > 99999999) {
      return '';
    }
    return String(value);
  }
  if (userSpec.kind === 'ascii') {
    if (!Number.isInteger(userSpec.offset) || !Number.isInteger(userSpec.length)) {
      return '';
    }
    if (userSpec.offset < 0 || userSpec.length <= 0 || (userSpec.offset + userSpec.length) > record.length) {
      return '';
    }
    const field = record.subarray(userSpec.offset, userSpec.offset + userSpec.length).toString('latin1');
    return sanitizeAsciiId(field);
  }
  return '';
}

function readByte(record, offset) {
  if (!Buffer.isBuffer(record) || !Number.isInteger(offset) || offset < 0 || offset >= record.length) {
    return null;
  }
  return record.readUInt8(offset);
}

function isK80LengthPrefixed40BytePayload(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 44) {
    return false;
  }
  const declaredLength = payload.readUInt32LE(0);
  return declaredLength === (payload.length - 4) && (declaredLength % 40) === 0;
}

function mapK80FullHistoryDirectionState(value) {
  switch (value) {
    case 0x00:
    case 0x04:
      return 'IN';
    case 0x01:
    case 0x05:
      return 'OUT';
    default:
      return null;
  }
}

function decodeAttendanceRecord(record, layout, statusMap, absoluteOffset, recordIndex) {
  if (!Buffer.isBuffer(record) || !isPlainObject(layout)) {
    return { ok: false, reason: 'record_not_buffer' };
  }

  const reasons = [];
  const userId = readUserId(record, layout.user);
  if (!userId) {
    reasons.push('user_id_invalid');
  }

  let timestampRaw = null;
  let timestamp = null;
  if (!Number.isInteger(layout.timestamp_offset)
    || layout.timestamp_offset < 0
    || (layout.timestamp_offset + 4) > record.length) {
    reasons.push('timestamp_offset_invalid');
  } else {
    timestampRaw = record.readUInt32LE(layout.timestamp_offset);
    timestamp = decodeZkTimestamp(timestampRaw);
    if (!timestamp) {
      reasons.push('timestamp_invalid');
    }
  }

  const statusCode = readByte(record, layout.status_offset);
  const verifyMode = readByte(record, layout.verify_offset);
  if (!Number.isInteger(statusCode) || statusCode < 0 || statusCode > 15) {
    reasons.push('status_out_of_range');
  }
  if (Number.isInteger(verifyMode) && (verifyMode < 0 || verifyMode > 31)) {
    reasons.push('verify_out_of_range');
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      reason: reasons.join(','),
      record_index: recordIndex,
      record_offset: absoluteOffset,
      record_hex: record.toString('hex')
    };
  }

  const mappedDirection = Object.prototype.hasOwnProperty.call(statusMap, String(statusCode))
    ? statusMap[String(statusCode)]
    : null;
  const directionStateCode = readByte(record, layout.direction_offset);
  const layoutDirection = Number.isInteger(directionStateCode)
    ? mapK80FullHistoryDirectionState(directionStateCode)
    : null;
  const finalDirection = layoutDirection || mappedDirection || null;

  return {
    ok: true,
    record: {
      person: userId,
      user_id: userId,
      event_time_local: timestamp.local_date_time,
      timestamp_local: timestamp.local_date_time,
      timestamp_iso_utc_assumed: timestamp.iso_utc_assumed,
      timestamp_decoder: timestamp.method,
      timestamp_raw: timestampRaw,
      direction: finalDirection,
      verify_state: String(statusCode),
      verify_method: Number.isInteger(verifyMode) ? String(verifyMode) : null,
      status_code: statusCode,
      verify_mode: verifyMode,
      direction_state_code: Number.isInteger(directionStateCode) ? directionStateCode : null,
      direction_basis: layoutDirection ? layout.direction_basis : 'attendance_status_map',
      direction_basis_field: layoutDirection ? 'direction_state_code' : 'status_code',
      parser: `binary_${layout.record_size}_${layout.id}`,
      record_index: recordIndex,
      record_offset: absoluteOffset
    }
  };
}

function scoreCandidate({
  recordsTotal,
  recordsDecoded,
  mappedEvents,
  malformedRecords,
  trailingBytes,
  payloadHeaderBytes,
  uniqueUsers
}) {
  if (!recordsTotal || recordsTotal <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const decodeRatio = recordsDecoded / recordsTotal;
  let score = 0;
  score += recordsDecoded * 100;
  score += mappedEvents * 20;
  score -= malformedRecords * 28;
  score -= trailingBytes * 9;
  score -= payloadHeaderBytes * 0.25;
  if (trailingBytes === 0) {
    score += 20;
  }
  if (decodeRatio >= 0.8) {
    score += 40;
  }
  if (decodeRatio >= 0.95) {
    score += 20;
  }
  if (uniqueUsers >= 2) {
    score += 10;
  }
  return score;
}

function decodeCandidate(payload, layout, payloadHeaderBytes, statusMap, maxMalformedSamples) {
  const usable = payload.subarray(payloadHeaderBytes);
  const recordsTotal = Math.floor(usable.length / layout.record_size);
  const trailingBytes = usable.length % layout.record_size;
  const preferredLayoutMatch = layout.preferred_when === 'k80_len4_u32_payload_size'
    && payloadHeaderBytes === 4
    && isK80LengthPrefixed40BytePayload(payload);
  const records = [];
  const malformedSamples = [];
  let malformedRecords = 0;
  let mappedEvents = 0;
  const users = new Set();

  for (let index = 0; index < recordsTotal; index += 1) {
    const offset = index * layout.record_size;
    const slice = usable.subarray(offset, offset + layout.record_size);
    const decoded = decodeAttendanceRecord(
      slice,
      layout,
      statusMap,
      payloadHeaderBytes + offset,
      index
    );
    if (!decoded.ok) {
      malformedRecords += 1;
      if (malformedSamples.length < maxMalformedSamples) {
        malformedSamples.push(decoded);
      }
      continue;
    }
    records.push(decoded.record);
    users.add(decoded.record.user_id);
    if (decoded.record.direction === 'IN' || decoded.record.direction === 'OUT') {
      mappedEvents += 1;
    }
  }

  const recordsDecoded = records.length;
  let score = scoreCandidate({
    recordsTotal,
    recordsDecoded,
    mappedEvents,
    malformedRecords,
    trailingBytes,
    payloadHeaderBytes,
    uniqueUsers: users.size
  });
  if (preferredLayoutMatch) {
    score += 250;
  }

  return {
    score,
    layout_id: layout.id,
    record_size: layout.record_size,
    payload_header_bytes: payloadHeaderBytes,
    records_total: recordsTotal,
    records_decoded: recordsDecoded,
    mapped_events: mappedEvents,
    malformed_records: malformedRecords,
    trailing_bytes: trailingBytes,
    preferred_layout_match: preferredLayoutMatch,
    records,
    malformed_samples: malformedSamples
  };
}

function parseBinaryAttendancePayload(payload, options = {}) {
  const statusMap = isPlainObject(options.statusMap) ? options.statusMap : {};
  const maxHeaderBytes = Number.isInteger(options.maxHeaderBytes)
    ? Math.max(0, options.maxHeaderBytes)
    : DEFAULT_MAX_HEADER_BYTES;
  const maxMalformedSamples = Number.isInteger(options.maxMalformedSamples)
    ? Math.max(1, options.maxMalformedSamples)
    : DEFAULT_MAX_MALFORMED_SAMPLES;

  if (!Buffer.isBuffer(payload) || payload.length === 0) {
    return {
      events: [],
      records: [],
      diagnostics: {
        payload_bytes: Buffer.isBuffer(payload) ? payload.length : 0,
        candidate_record_sizes: CANDIDATE_RECORD_SIZES,
        record_size_used: null,
        layout_id: null,
        payload_header_bytes: 0,
        records_total: 0,
        records_decoded: 0,
        malformed_records: 0,
        malformed_samples: [],
        candidate_scores: []
      }
    };
  }

  const candidates = [];
  const headerUpperBound = Math.min(maxHeaderBytes, Math.max(0, payload.length - 1));
  for (const layout of CANDIDATE_LAYOUTS) {
    if (!CANDIDATE_RECORD_SIZES.includes(layout.record_size)) {
      continue;
    }
    for (let header = 0; header <= headerUpperBound; header += 1) {
      const available = payload.length - header;
      if (available < layout.record_size) {
        continue;
      }
      const trailing = available % layout.record_size;
      if (trailing > Math.max(4, Math.floor(layout.record_size * 0.35))) {
        continue;
      }
      const candidate = decodeCandidate(
        payload,
        layout,
        header,
        statusMap,
        maxMalformedSamples
      );
      if (candidate.records_total <= 0) {
        continue;
      }
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    return {
      events: [],
      records: [],
      diagnostics: {
        payload_bytes: payload.length,
        candidate_record_sizes: CANDIDATE_RECORD_SIZES,
        record_size_used: null,
        layout_id: null,
        payload_header_bytes: 0,
        records_total: 0,
        records_decoded: 0,
        malformed_records: 0,
        malformed_samples: [],
        candidate_scores: []
      }
    };
  }

  const sorted = candidates.slice().sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.records_decoded !== a.records_decoded) {
      return b.records_decoded - a.records_decoded;
    }
    if (a.malformed_records !== b.malformed_records) {
      return a.malformed_records - b.malformed_records;
    }
    return a.payload_header_bytes - b.payload_header_bytes;
  });

  const best = sorted[0];
  const events = best.records.filter(record => record.direction === 'IN' || record.direction === 'OUT');
  return {
    events,
    records: best.records,
    diagnostics: {
      payload_bytes: payload.length,
      candidate_record_sizes: CANDIDATE_RECORD_SIZES,
      record_size_used: best.record_size,
      layout_id: best.layout_id,
      payload_header_bytes: best.payload_header_bytes,
      records_total: best.records_total,
      records_decoded: best.records_decoded,
      mapped_events: best.mapped_events,
      malformed_records: best.malformed_records,
      malformed_samples: best.malformed_samples,
      trailing_bytes: best.trailing_bytes,
      candidate_scores: sorted.slice(0, 10).map(item => ({
        layout_id: item.layout_id,
        record_size: item.record_size,
        payload_header_bytes: item.payload_header_bytes,
        records_total: item.records_total,
        records_decoded: item.records_decoded,
        mapped_events: item.mapped_events,
      malformed_records: item.malformed_records,
      trailing_bytes: item.trailing_bytes,
      preferred_layout_match: item.preferred_layout_match,
      score: item.score
    }))
    }
  };
}

function defaultStatusMap() {
  return {
    '0': 'IN',
    '1': 'OUT',
    '2': 'IN',
    '3': 'OUT',
    '4': 'IN',
    '5': 'OUT'
  };
}

module.exports = {
  decodeZkTimestamp,
  parseBinaryAttendancePayload,
  decodeAttendanceRecord,
  defaultStatusMap
};
