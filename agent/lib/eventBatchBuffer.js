const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, batches: [] };
  }
  const batches = Array.isArray(value.batches)
    ? value.batches.map(batch => normalizeQueuedBatch(batch))
    : [];
  return {
    version: 1,
    batches
  };
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeIsoOrNull(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function parseNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function createBufferId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function normalizeQueuedBatch(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
  const payload = source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
    ? source.payload
    : {};

  const payloadDeliveryId = normalizeText(payload.delivery_id);
  const sourceDeliveryId = normalizeText(source.delivery_id);
  const deliveryId = sourceDeliveryId || payloadDeliveryId || createBufferId();

  const bufferedAt = normalizeIsoOrNull(source.buffered_at)
    || normalizeIsoOrNull(source.ts)
    || new Date().toISOString();
  const attemptCount = parseNonNegativeInt(
    source.delivery_attempt_count,
    parseNonNegativeInt(payload.delivery_attempt, 0)
  );

  return {
    ...source,
    delivery_id: deliveryId,
    buffered_at: bufferedAt,
    delivery_attempt_count: attemptCount,
    last_attempt_at: normalizeIsoOrNull(source.last_attempt_at),
    last_attempt_status: normalizeText(source.last_attempt_status) || null,
    last_attempt_http_status: Number.isInteger(source.last_attempt_http_status)
      ? source.last_attempt_http_status
      : null,
    last_attempt_error: normalizeText(source.last_attempt_error) || null,
    next_retry_at: normalizeIsoOrNull(source.next_retry_at),
    payload: {
      ...payload,
      delivery_id: deliveryId,
      delivery_attempt: attemptCount
    }
  };
}

function readBufferState(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { version: 1, batches: [] };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return { version: 1, batches: [] };
    }
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    return { version: 1, batches: [] };
  }
}

function writeBufferState(filePath, state) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(normalizeState(state), null, 2), 'utf8');
}

function countPendingBatches(filePath) {
  const state = readBufferState(filePath);
  return state.batches.length;
}

function peekNextBatch(filePath) {
  const state = readBufferState(filePath);
  return state.batches[0] ? normalizeQueuedBatch(state.batches[0]) : null;
}

function enqueueBatch(filePath, batch, maxBatches = 200) {
  const state = readBufferState(filePath);
  if (state.batches.length >= maxBatches) {
    return {
      ok: false,
      error: 'buffer_full',
      count: state.batches.length
    };
  }
  state.batches.push(normalizeQueuedBatch(batch));
  writeBufferState(filePath, state);
  return {
    ok: true,
    count: state.batches.length
  };
}

function dequeueBatch(filePath) {
  const state = readBufferState(filePath);
  if (state.batches.length === 0) {
    return null;
  }
  const head = normalizeQueuedBatch(state.batches.shift());
  writeBufferState(filePath, state);
  return head;
}

function updateHeadBatch(filePath, updater) {
  const state = readBufferState(filePath);
  if (state.batches.length === 0) {
    return null;
  }
  const head = normalizeQueuedBatch(state.batches[0]);
  const next = typeof updater === 'function'
    ? updater({ ...head }) || head
    : head;
  state.batches[0] = normalizeQueuedBatch(next);
  writeBufferState(filePath, state);
  return state.batches[0];
}

function markHeadBatchAttemptStarted(filePath, attemptedAtIso = null) {
  const attemptedAt = normalizeIsoOrNull(attemptedAtIso) || new Date().toISOString();
  return updateHeadBatch(filePath, head => {
    const attempts = parseNonNegativeInt(head.delivery_attempt_count, 0) + 1;
    return {
      ...head,
      delivery_attempt_count: attempts,
      last_attempt_at: attemptedAt,
      last_attempt_status: 'submitting',
      last_attempt_http_status: null,
      last_attempt_error: null,
      next_retry_at: null,
      payload: {
        ...(head.payload && typeof head.payload === 'object' ? head.payload : {}),
        delivery_id: normalizeText(head.delivery_id) || normalizeText(head.payload && head.payload.delivery_id) || createBufferId(),
        delivery_attempt: attempts
      }
    };
  });
}

function markHeadBatchAttemptFailed(filePath, {
  attemptedAtIso = null,
  httpStatus = null,
  error = null,
  nextRetryAtIso = null
} = {}) {
  const attemptedAt = normalizeIsoOrNull(attemptedAtIso) || new Date().toISOString();
  const nextRetryAt = normalizeIsoOrNull(nextRetryAtIso);
  return updateHeadBatch(filePath, head => ({
    ...head,
    last_attempt_at: attemptedAt,
    last_attempt_status: 'submit_failed',
    last_attempt_http_status: Number.isInteger(httpStatus) ? httpStatus : null,
    last_attempt_error: normalizeText(error) || null,
    next_retry_at: nextRetryAt
  }));
}

function deferHeadBatch(filePath, {
  attemptedAtIso = null,
  httpStatus = null,
  error = null,
  nextRetryAtIso = null,
  deferredReason = null
} = {}) {
  const state = readBufferState(filePath);
  if (state.batches.length === 0) {
    return null;
  }
  const attemptedAt = normalizeIsoOrNull(attemptedAtIso) || new Date().toISOString();
  const nextRetryAt = normalizeIsoOrNull(nextRetryAtIso);
  const head = normalizeQueuedBatch(state.batches.shift());
  const deferred = normalizeQueuedBatch({
    ...head,
    last_attempt_at: attemptedAt,
    last_attempt_status: 'submit_deferred',
    last_attempt_http_status: Number.isInteger(httpStatus) ? httpStatus : null,
    last_attempt_error: normalizeText(error) || null,
    next_retry_at: nextRetryAt,
    defer_reason: normalizeText(deferredReason) || null
  });
  state.batches.push(deferred);
  writeBufferState(filePath, state);
  return deferred;
}

module.exports = {
  countPendingBatches,
  peekNextBatch,
  enqueueBatch,
  dequeueBatch,
  markHeadBatchAttemptStarted,
  markHeadBatchAttemptFailed,
  deferHeadBatch,
  __test: {
    readBufferState,
    writeBufferState,
    normalizeQueuedBatch
  }
};
