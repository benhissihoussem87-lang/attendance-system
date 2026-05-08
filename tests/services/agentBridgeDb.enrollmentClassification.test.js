const assert = require('assert');
process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'attendance';
const { __test } = require('../../services/agentBridgeDb');

function run() {
  const downgraded = __test.classifyEnrollmentAttemptResultConservative({
    requestedStatus: 'success',
    requestedReason: '',
    evidenceFlags: {
      saw_05df: true,
      saw_05dd_after_05df: false
    }
  });
  assert.strictEqual(downgraded.final_status, 'partial_or_failed');
  assert.strictEqual(downgraded.status_reason, 'success_chain_missing');

  const success = __test.classifyEnrollmentAttemptResultConservative({
    requestedStatus: 'success',
    requestedReason: null,
    evidenceFlags: {
      saw_05df: true,
      saw_05dd_after_05df: true
    }
  });
  assert.strictEqual(success.final_status, 'success');
  assert.strictEqual(success.status_reason, 'success_chain_observed');

  const cancelled = __test.classifyEnrollmentAttemptResultConservative({
    requestedStatus: 'cancelled',
    requestedReason: '',
    evidenceFlags: {
      saw_05df: false,
      saw_05dd_after_05df: false
    }
  });
  assert.strictEqual(cancelled.final_status, 'cancelled');
  assert.strictEqual(cancelled.status_reason, 'cancelled_without_success_chain');
}

run();
console.log('ok - agentBridgeDb enrollment classification');
