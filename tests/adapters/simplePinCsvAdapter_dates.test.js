const assert = require('assert');
const { __test_parseUtcDate } = require('../../adapters/vendors/shared/simplePinCsvAdapter');

function iso(value) {
  const parsed = __test_parseUtcDate(value);
  assert.ok(parsed instanceof Date);
  return parsed.toISOString();
}

function run() {
  assert.strictEqual(
    iso('2026-01-13 08:15:00'),
    '2026-01-13T08:15:00.000Z'
  );

  assert.strictEqual(
    iso('2026-01-13T08:15:00'),
    '2026-01-13T08:15:00.000Z'
  );

  assert.strictEqual(
    iso('2026-01-13T08:15:00Z'),
    '2026-01-13T08:15:00.000Z'
  );

  assert.strictEqual(
    iso('2026-01-13T08:15:00+01:00'),
    '2026-01-13T07:15:00.000Z'
  );

  assert.strictEqual(
    iso('13/01/2026 08:15:00'),
    '2026-01-13T08:15:00.000Z'
  );

  assert.strictEqual(
    iso('01/13/2026 08:15:00'),
    '2026-01-13T08:15:00.000Z'
  );

  assert.strictEqual(
    iso('02/03/2026 04:05:06'),
    '2026-03-02T04:05:06.000Z'
  );

  assert.strictEqual(__test_parseUtcDate('2026/01/13 08:15:00'), null);

  console.log('simplePinCsvAdapter date parsing tests passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
