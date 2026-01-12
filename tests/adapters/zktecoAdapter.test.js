const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zktecoAdapter = require('../../adapters/vendors/zkteco');

function loadFixture(name) {
  const fixturePath = path.join(__dirname, '..', 'fixtures', name);
  return fs.readFileSync(fixturePath, 'utf8');
}

function testParseCsv() {
  const csvText = loadFixture('zkteco_checkinout.csv');
  const result = zktecoAdapter.parseCsv(csvText, {
    source_timezone: 'UTC',
    checktype_map: {
      0: 'IN',
      1: 'OUT'
    }
  });

  assert.strictEqual(result.total_rows, 3);
  assert.strictEqual(result.valid_rows, 2);
  assert.strictEqual(result.invalid_rows, 1);
  assert.strictEqual(result.errors.length > 0, true);

  const validRows = result.rows.filter(row => row.valid);
  assert.strictEqual(validRows.length, 2);

  const first = validRows[0].data;
  assert.strictEqual(first.person_id, 'EMP001');
  assert.strictEqual(first.direction, 'IN');
  assert.strictEqual(first.device_uid, 'zkteco:SN-123');
  assert.strictEqual(first.vendor, 'zkteco');
  assert.strictEqual(first.event_time_utc, '2026-01-07T08:00:00.000Z');
  assert.strictEqual(first.raw_payload.source_timezone, 'UTC');
  assert.strictEqual(first.raw_payload.original_checktime_string, '2026-01-07 08:00:00');
  assert.strictEqual(first.raw_payload.mapping_audit.device_uid_fallback, false);

  const second = validRows[1].data;
  assert.strictEqual(second.person_id, 'EMP002');
  assert.strictEqual(second.direction, 'OUT');
  assert.strictEqual(second.device_uid, 'zkteco:machine:7');
  assert.strictEqual(second.raw_payload.mapping_audit.device_uid_fallback, true);
}

function testUnknownChecktypeInvalid() {
  const csvText = loadFixture('zkteco_checkinout.csv');
  const result = zktecoAdapter.parseCsv(csvText, {
    source_timezone: 'UTC',
    checktype_map: { 0: 'IN' }
  });

  assert.strictEqual(result.invalid_rows, 2);
  const unknownError = result.errors.find(err => err.code === 'UNKNOWN_CHECKTYPE');
  assert.strictEqual(Boolean(unknownError), true);
}

function run() {
  testParseCsv();
  testUnknownChecktypeInvalid();
  console.log('zktecoAdapter tests passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
