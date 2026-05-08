const assert = require('assert');
const { applyRuleSetOverride } = require('../../services/simulateRuleSetOverride');

function run() {
  const original = {
    params: {
      minutes: 30,
      unrelated: true
    },
    rules: [
      { type: 'BREAK_DEDUCT', minutes: 30 },
      { type: 'LATE_THRESHOLD', grace_minutes: 5, late_after_minutes: 5 },
      { type: 'STATUS_BY_LATE' }
    ]
  };

  const overridden = applyRuleSetOverride(original, { late_threshold_minutes: 15 });

  assert.strictEqual(
    overridden.rules[0].minutes,
    30,
    'override must not mutate BREAK_DEDUCT.minutes'
  );
  assert.strictEqual(
    overridden.params.minutes,
    30,
    'override must not mutate unrelated top-level params.minutes'
  );

  const lateRule = overridden.rules[1];
  assert.strictEqual(lateRule.grace_minutes, 15, 'late threshold grace should be overridden');
  assert.strictEqual(lateRule.late_after_minutes, 15, 'late threshold late_after should be overridden');
  assert.strictEqual(lateRule.threshold_minutes, 15, 'late threshold_minutes should be populated');
  assert.strictEqual(lateRule.threshold, 15, 'late threshold alias should be populated');

  const nested = {
    rules: [
      {
        type: 'CUSTOM_RULE',
        params: {
          timeout_minutes: 9
        }
      }
    ]
  };
  const nestedOverridden = applyRuleSetOverride(nested, { late_threshold_minutes: 12 });
  assert.strictEqual(
    nestedOverridden.rules[0].params.timeout_minutes,
    9,
    'override must not mutate unrelated nested params'
  );

  console.log('simulate rule_set_override scope tests passed');
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

