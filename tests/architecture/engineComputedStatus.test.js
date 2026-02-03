const engine = require('../../engine/AttendanceEngine');

describe('Attendance engine computed status semantics', () => {
  const ruleSet = {
    rules: [
      { type: 'FIXED_SHIFT', start: '08:00', end: '17:00' },
      { type: 'LATE_THRESHOLD', grace_minutes: 5 },
      { type: 'LATE_MINUTES_COMPUTE' },
      { type: 'STATUS_BY_LATE' }
    ]
  };

  const person = { person_id: 'EMP001' };
  const date = '2025-01-01';

  test('computed status stays within the allowed enum', () => {
    const result = engine.computeDay({
      person,
      date,
      events: [
        { event_time: '2025-01-01T08:10:00Z', direction: 'IN' },
        { event_time: '2025-01-01T17:00:00Z', direction: 'OUT' }
      ],
      ruleSet
    });

    const allowed = new Set(['PRESENT', 'ABSENT', 'INCOMPLETE', 'INVALID']);
    expect(allowed.has(result.status)).toBe(true);
  });

  test('late arrivals remain PRESENT with LATE flag and minutes', () => {
    const result = engine.computeDay({
      person,
      date,
      events: [
        { event_time: '2025-01-01T08:10:00Z', direction: 'IN' },
        { event_time: '2025-01-01T17:00:00Z', direction: 'OUT' }
      ],
      ruleSet
    });

    expect(result.status).toBe('PRESENT');
    expect(result.late_minutes).toBeGreaterThan(0);
    expect(result.flags).toEqual(expect.arrayContaining(['LATE']));
  });
});
