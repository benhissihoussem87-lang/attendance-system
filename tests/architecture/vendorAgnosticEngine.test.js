const assert = require('assert');
const { computeAttendanceDay } = require('../../services/attendanceEngine');

function buildCanonicalEvent(overrides = {}) {
  return {
    person_id: 'EMP001',
    event_time_utc: '2025-09-01T08:00:00Z',
    direction: 'IN',
    vendor: 'any',
    device_uid: 'DEVICE-1',
    raw_payload: {},
    ...overrides
  };
}

function testVendorAgnosticBehavior() {
  const baseEvents = [
    buildCanonicalEvent({ direction: 'IN', event_time_utc: '2025-09-01T08:00:00Z' }),
    buildCanonicalEvent({ direction: 'OUT', event_time_utc: '2025-09-01T17:00:00Z' })
  ];

  const vendorAEvents = baseEvents.map(e => ({ ...e, vendor: 'zkteco' }));
  const vendorBEvents = baseEvents.map(e => ({ ...e, vendor: 'suprema' }));

  const day = '2025-09-01';

  const resultA = computeAttendanceDay({
    person_id: 'EMP001',
    day,
    events: vendorAEvents
  });

  const resultB = computeAttendanceDay({
    person_id: 'EMP001',
    day,
    events: vendorBEvents
  });

  assert.deepStrictEqual(
    resultA,
    resultB,
    'Attendance engine must be vendor-agnostic'
  );
}

function run() {
  testVendorAgnosticBehavior();
  console.log('vendor-agnostic engine test passed');
}

if (require.main === module) {
  run();
}

module.exports = { run };
