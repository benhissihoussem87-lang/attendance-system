const assert = require('assert');
const { buildErrorIntelligence } = require('../../services/csvErrorIntelligence');
const { validateDeviceEventsCsv } = require('../../services/deviceEventsCsvValidator');
const zktecoAdapter = require('../../adapters/vendors/zkteco');

function testAggregationNoMutation() {
  const validationResult = {
    total_rows: 3,
    valid_rows: 1,
    invalid_rows: 2,
    errors: [
      { row_number: 2, code: 'MISSING_DEVICE_UID', message: 'missing device' },
      { row_number: 3, code: 'MISSING_DEVICE_UID', message: 'missing device' },
      { row_number: 3, code: 'UNKNOWN_CHECKTYPE', message: 'unknown checktype' }
    ]
  };

  const snapshot = JSON.stringify(validationResult);
  const intelligence = buildErrorIntelligence(validationResult);

  assert.strictEqual(JSON.stringify(validationResult), snapshot);
  assert.strictEqual(intelligence.summary.total_rows, 3);
  assert.strictEqual(intelligence.error_buckets.MISSING_DEVICE_UID.count, 2);
  assert.strictEqual(intelligence.error_buckets.UNKNOWN_CHECKTYPE.count, 1);
  assert.strictEqual(intelligence.recommendations.length, 2);
}

function testGenericCsvCompatibility() {
  const csv = [
    'person_id,event_time,direction',
    ',2026-01-07 08:00:00,IN'
  ].join('\n');
  const validation = validateDeviceEventsCsv(csv);
  const intelligence = buildErrorIntelligence(validation);

  assert.strictEqual(intelligence.summary.invalid_rows, 1);
  assert.strictEqual(Boolean(intelligence.error_buckets.EMPTY_PERSON_ID), true);
}

function testZktecoCsvCompatibility() {
  const csv = [
    'USERID,CHECKTIME,CHECKTYPE,VERIFYCODE,SENSORID,Memoinfo,WorkCode,sn,UserExtFmt,mask_flag,temperature,Badgenumber',
    '1,2026-01-07 08:00:00,9,0,1,,0,SN-123,,0,36.5,EMP001'
  ].join('\n');
  const validation = zktecoAdapter.parseCsv(csv, {
    source_timezone: 'UTC',
    checktype_map: { 0: 'IN' }
  });
  const intelligence = buildErrorIntelligence(validation);

  assert.strictEqual(intelligence.summary.invalid_rows, 1);
  assert.strictEqual(Boolean(intelligence.error_buckets.UNKNOWN_CHECKTYPE), true);
}

function run() {
  testAggregationNoMutation();
  testGenericCsvCompatibility();
  testZktecoCsvCompatibility();
  console.log('csvErrorIntelligence tests passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
