const assert = require('assert');
const { validateAgentEnrollmentAttemptResultPayload } = require('../../contracts/agentBridgeContract');

function run() {
  const valid = validateAgentEnrollmentAttemptResultPayload({
    command_id: 'cmd-1',
    enrollment_attempt_id: 'attempt-1',
    run_id: 'run-1',
    device_uid: 'zkteco:sn:BIND-QUEUE-c26a7486',
    started_at: '2026-04-14T10:00:00.000Z',
    completed_at: '2026-04-14T10:00:10.000Z',
    result: {
      attempt_status: 'partial_or_failed',
      status_reason: 'partial_or_failed_without_success_chain',
      protocol_execution_state: 'completed_non_success',
      protocol_session_ref: '1:2',
      evidence_flags: { saw_05df: true },
      evidence_refs: { marker_sequence: ['0x05DF(tx)'] },
      source_metadata: { conservative_evidence_classification: true }
    }
  });
  assert.strictEqual(valid.ok, true);
  assert.strictEqual(valid.value.result.attempt_status, 'partial_or_failed');

  const invalid = validateAgentEnrollmentAttemptResultPayload({
    command_id: 'cmd-1',
    enrollment_attempt_id: 'attempt-1',
    device_uid: 'zkteco:sn:BIND-QUEUE-c26a7486',
    completed_at: '2026-04-14T10:00:10.000Z',
    result: {
      attempt_status: 'successish'
    }
  });
  assert.strictEqual(invalid.ok, false);
}

run();
console.log('ok - agentBridge enrollment result contract');
