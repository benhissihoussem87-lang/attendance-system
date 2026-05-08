const assert = require('assert');
const db = require('../../db');
const {
  listDailyAttendanceV1,
  utcWindowForLocalDate
} = require('../../services/attendanceV1Service');

async function run() {
  const recent = await listDailyAttendanceV1(db, {
    companyId: 'DEFAULT',
    startDate: '2026-04-14',
    endDate: '2026-05-07',
    companyTimezone: 'Africa/Tunis',
    includeValidation: false
  });

  const codes = new Set(recent.rows.map(row => row.employee_code));
  assert.ok(codes.has('EMP-K80-001'), 'Amir should appear when K80 user 1 has events');
  assert.ok(codes.has('EMP-K80-003'), 'Houssem should appear when K80 user 3 has events');
  assert.ok(!codes.has('EMP-K80-022-TEST'), 'validation user should be excluded by default');
  assert.ok(!recent.rows.some(row => /^1001_|autoreg_person_|DEDUP_P1_/i.test(row.employee_code || '')), 'fixture employees must not appear');

  const unmappedIds = new Set(recent.unmapped_device_users.map(row => row.device_user_id));
  assert.ok(unmappedIds.has('4'), 'unmapped K80 device user 4 should appear as a warning');
  assert.ok(!unmappedIds.has('22'), 'mapped validation user should not be misreported as unmapped');

  const withValidation = await listDailyAttendanceV1(db, {
    companyId: 'DEFAULT',
    startDate: '2026-04-14',
    endDate: '2026-05-07',
    companyTimezone: 'Africa/Tunis',
    includeValidation: true
  });
  assert.ok(
    withValidation.rows.some(row => row.employee_code === 'EMP-K80-022-TEST'),
    'validation user should appear only when explicitly included'
  );

  const sami = await listDailyAttendanceV1(db, {
    companyId: 'DEFAULT',
    startDate: '2023-06-13',
    endDate: '2023-06-13',
    companyTimezone: 'Africa/Tunis',
    includeValidation: false
  });
  assert.ok(
    sami.rows.some(row => row.employee_code === 'EMP-K80-002'),
    'Sami should appear when K80 user 2 has events in the selected date'
  );

  const tunis = utcWindowForLocalDate('2026-05-07', 'Africa/Tunis');
  assert.strictEqual(tunis.window_start_utc, '2026-05-06T23:00:00.000Z', 'Africa/Tunis local day should start at UTC+1 boundary');
  assert.strictEqual(tunis.window_end_utc, '2026-05-07T23:00:00.000Z', 'Africa/Tunis local day should end at next UTC+1 boundary');

  console.log('PASS: attendance v1 product daily service');
}

run()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.end();
    } catch (_) {}
  });
