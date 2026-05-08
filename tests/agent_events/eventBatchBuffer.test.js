const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  countPendingBatches,
  peekNextBatch,
  enqueueBatch,
  dequeueBatch,
  markHeadBatchAttemptStarted,
  markHeadBatchAttemptFailed
} = require('../../agent/lib/eventBatchBuffer');

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-buffer-'));
  const file = path.join(dir, 'queue.json');
  try {
    assert.strictEqual(countPendingBatches(file), 0, 'empty file should have zero pending');

    const enqueue1 = enqueueBatch(file, {
      command_id: 'c1',
      payload: { events: [1] }
    }, 10);
    assert.strictEqual(enqueue1.ok, true);
    assert.strictEqual(enqueue1.count, 1);
    assert.strictEqual(countPendingBatches(file), 1);
    assert.strictEqual(peekNextBatch(file).command_id, 'c1');
    assert.strictEqual(typeof peekNextBatch(file).delivery_id, 'string', 'delivery_id should be normalized on enqueue');

    const enqueue2 = enqueueBatch(file, {
      command_id: 'c2',
      payload: { events: [2] }
    }, 10);
    assert.strictEqual(enqueue2.ok, true);
    assert.strictEqual(countPendingBatches(file), 2);

    const started = markHeadBatchAttemptStarted(file, '2026-03-26T10:00:00Z');
    assert.ok(started, 'head attempt start should return batch');
    assert.strictEqual(started.delivery_attempt_count, 1);
    assert.strictEqual(started.last_attempt_status, 'submitting');
    assert.strictEqual(started.payload.delivery_attempt, 1);

    const failed = markHeadBatchAttemptFailed(file, {
      attemptedAtIso: '2026-03-26T10:00:05Z',
      httpStatus: 503,
      error: 'upstream_unavailable',
      nextRetryAtIso: '2026-03-26T10:00:15Z'
    });
    assert.ok(failed, 'head attempt failure should return batch');
    assert.strictEqual(failed.last_attempt_status, 'submit_failed');
    assert.strictEqual(failed.last_attempt_http_status, 503);
    assert.strictEqual(failed.last_attempt_error, 'upstream_unavailable');
    assert.strictEqual(failed.next_retry_at, '2026-03-26T10:00:15.000Z');

    const first = dequeueBatch(file);
    assert.strictEqual(first.command_id, 'c1');
    assert.strictEqual(countPendingBatches(file), 1);
    assert.strictEqual(peekNextBatch(file).command_id, 'c2');

    dequeueBatch(file);
    assert.strictEqual(countPendingBatches(file), 0);
    assert.strictEqual(dequeueBatch(file), null, 'dequeue on empty should return null');

    enqueueBatch(file, { command_id: 'c3', payload: {} }, 1);
    const overflow = enqueueBatch(file, { command_id: 'c4', payload: {} }, 1);
    assert.strictEqual(overflow.ok, false, 'buffer overflow should be explicit');
    assert.strictEqual(overflow.error, 'buffer_full');
    assert.strictEqual(countPendingBatches(file), 1, 'overflow must not silently drop existing batch');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('agent event batch buffer tests passed');
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { run };
