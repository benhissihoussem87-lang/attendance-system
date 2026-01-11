const assert = require('assert');
const { mapAndValidateEvents } = require('../../services/deviceEventIngestor');

function expectOk(result, count) {
  assert.strictEqual(result.badRows.length, 0);
  assert.strictEqual(result.okRows.length, count);
}

function expectBad(result, count) {
  assert.strictEqual(result.badRows.length, count);
}

function testGenericMapping() {
  const input = {
    person_id: ' p1 ',
    event_time_utc: '2026-01-08T06:00:00.000Z',
    direction: 'in',
    device_uid: '  dev-1 ',
    vendor: 'generic',
    raw_payload: { source: 'test' }
  };
  const result = mapAndValidateEvents({ vendor: 'generic', rows: [input] });
  expectOk(result, 1);
  const row = result.okRows[0];
  assert.strictEqual(row.person_id, 'p1');
  assert.strictEqual(row.direction, 'IN');
  assert.strictEqual(row.device_uid, 'dev-1');
  assert.strictEqual(row.event_time_utc, new Date(input.event_time_utc).toISOString());
}

function testInvalidDate() {
  const input = {
    person_id: 'p1',
    event_time_utc: 'not-a-date',
    direction: 'IN',
    device_uid: '',
    vendor: null,
    raw_payload: {}
  };
  const result = mapAndValidateEvents({ vendor: null, rows: [input] });
  expectBad(result, 1);
  assert.strictEqual(result.okRows.length, 0);
  assert.strictEqual(result.badRows[0].errors[0].field, 'event_time_utc');
}

function testMixedRows() {
  const rows = [
    {
      person_id: 'p1',
      event_time_utc: '2026-01-08T06:00:00.000Z',
      direction: 'OUT',
      device_uid: '',
      vendor: null,
      raw_payload: {}
    },
    {
      person_id: '',
      event_time_utc: '2026-01-08T07:00:00.000Z',
      direction: 'IN',
      device_uid: 'dev-2',
      vendor: null,
      raw_payload: {}
    }
  ];
  const result = mapAndValidateEvents({ vendor: null, rows });
  assert.strictEqual(result.okRows.length, 1);
  expectBad(result, 1);
}

function run() {
  testGenericMapping();
  testInvalidDate();
  testMixedRows();
  console.log('deviceEventIngestor tests passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
