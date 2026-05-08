const assert = require('assert');
const { validateEnrollmentAttemptStartPayload } = require('../../contracts/k80EnrollmentOrchestrationContract');

function run() {
  {
    const result = validateEnrollmentAttemptStartPayload({
      person_id: '42',
      selected_finger: 'left-index',
      preflight_decision_id: '8a8e4b52-33ab-4e31-8f23-cde58e9cc07d',
      inventory_scope: 'zk_k80',
      source_note: 'operator run'
    });
    assert.strictEqual(result.ok, true, 'valid payload should pass');
    assert.strictEqual(result.value.inventory_scope, 'zk_k80');
    assert.strictEqual(result.value.selected_finger, 'LEFT-INDEX');
  }

  {
    const result = validateEnrollmentAttemptStartPayload({
      person_id: '',
      selected_finger: 'LEFT-INDEX',
      preflight_decision_id: 'x',
      inventory_scope: 'zk_k80'
    });
    assert.strictEqual(result.ok, false, 'missing person should fail');
  }

  {
    const result = validateEnrollmentAttemptStartPayload({
      person_id: '7',
      selected_finger: 'LEFT-INDEX',
      preflight_decision_id: 'x',
      inventory_scope: 'hikvision'
    });
    assert.strictEqual(result.ok, false, 'non-k80 scope should fail');
  }
}

try {
  run();
  console.log('ok - k80EnrollmentOrchestrationContract');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
