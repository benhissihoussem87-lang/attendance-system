const assert = require('assert');

const engineModule = require('../../engine/deriveDayStatus');
const serviceModule = require('../../services/rules/deriveDayStatus');

function run() {
  assert.strictEqual(typeof engineModule.deriveDayStatus, 'function', 'engine deriveDayStatus export must be a function');
  assert.strictEqual(typeof serviceModule.deriveDayStatus, 'function', 'services deriveDayStatus export must be a function');
  assert.strictEqual(
    serviceModule.deriveDayStatus,
    engineModule.deriveDayStatus,
    'services/rules/deriveDayStatus must re-export engine/deriveDayStatus'
  );

  const sampleInput = {
    events: [],
    first_in_utc: null,
    last_out_utc: null
  };
  assert.deepStrictEqual(
    serviceModule.deriveDayStatus(sampleInput),
    engineModule.deriveDayStatus(sampleInput),
    'service and engine deriveDayStatus outputs must match'
  );

  console.log('deriveDayStatus single source contract tests passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
