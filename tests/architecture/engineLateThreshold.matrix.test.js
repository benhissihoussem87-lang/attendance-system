const engine = require('../../engine/AttendanceEngine');

const person = { person_id: 'EMP001' };
const date = '2025-01-01';

function compute(ruleSet, events) {
  return engine.computeDay({
    person,
    date,
    events,
    ruleSet
  });
}

describe('Attendance engine late-calculation truth matrix', () => {
  const fixedRuleSet = {
    rules: [
      { type: 'FIXED_SHIFT', start: '08:00', end: '17:00' },
      { type: 'LATE_THRESHOLD', grace_minutes: 5, late_after_minutes: 5 },
      { type: 'WORK_MINUTES_COMPUTE' },
      { type: 'LATE_MINUTES_COMPUTE' },
      { type: 'STATUS_BY_LATE' },
      { type: 'STATUS_FALLBACK', status: 'ABSENT' }
    ]
  };

  test('exact threshold is on time (08:05 with threshold 5)', () => {
    const result = compute(fixedRuleSet, [
      { event_time: '2025-01-01T08:05:00Z', direction: 'IN' },
      { event_time: '2025-01-01T17:00:00Z', direction: 'OUT' }
    ]);
    expect(result.status).toBe('PRESENT');
    expect(result.late_minutes).toBe(0);
    expect(result.flags || []).not.toContain('LATE');
  });

  test('one minute above threshold is late by one minute', () => {
    const result = compute(fixedRuleSet, [
      { event_time: '2025-01-01T08:06:00Z', direction: 'IN' },
      { event_time: '2025-01-01T17:00:00Z', direction: 'OUT' }
    ]);
    expect(result.status).toBe('PRESENT');
    expect(result.late_minutes).toBe(1);
    expect(result.flags).toEqual(expect.arrayContaining(['LATE']));
  });

  test('one minute below threshold is on time', () => {
    const result = compute(fixedRuleSet, [
      { event_time: '2025-01-01T08:04:00Z', direction: 'IN' },
      { event_time: '2025-01-01T17:00:00Z', direction: 'OUT' }
    ]);
    expect(result.status).toBe('PRESENT');
    expect(result.late_minutes).toBe(0);
    expect(result.flags || []).not.toContain('LATE');
  });

  test('early arrival never produces late minutes', () => {
    const result = compute(fixedRuleSet, [
      { event_time: '2025-01-01T07:45:00Z', direction: 'IN' },
      { event_time: '2025-01-01T17:00:00Z', direction: 'OUT' }
    ]);
    expect(result.status).toBe('PRESENT');
    expect(result.late_minutes).toBe(0);
    expect(result.flags || []).not.toContain('LATE');
  });

  test('incomplete day still carries LATE flag when arrival exceeded threshold', () => {
    const result = compute(fixedRuleSet, [
      { event_time: '2025-01-01T08:10:00Z', direction: 'IN' }
    ]);
    expect(result.status).toBe('INCOMPLETE');
    expect(result.flags).toEqual(expect.arrayContaining(['MISSING_OUT', 'LATE']));
    expect(result.late_minutes).toBe(5);
  });

  test('first event OUT is INVALID with FIRST_EVENT_OUT', () => {
    const result = compute(fixedRuleSet, [
      { event_time: '2025-01-01T08:30:00Z', direction: 'OUT' },
      { event_time: '2025-01-01T17:00:00Z', direction: 'IN' }
    ]);
    expect(result.status).toBe('INVALID');
    expect(result.flags).toEqual(expect.arrayContaining(['FIRST_EVENT_OUT']));
  });

  test('duplicate IN sequence is INVALID with non-alternating flags', () => {
    const result = compute(fixedRuleSet, [
      { event_time: '2025-01-01T08:00:00Z', direction: 'IN' },
      { event_time: '2025-01-01T08:05:00Z', direction: 'IN' },
      { event_time: '2025-01-01T17:00:00Z', direction: 'OUT' }
    ]);
    expect(result.status).toBe('INVALID');
    expect(result.flags).toEqual(expect.arrayContaining([
      'NON_ALTERNATING_SEQUENCE',
      'MULTIPLE_SAME_DIRECTION'
    ]));
  });

  test('no events produces ABSENT with NO_EVENTS', () => {
    const result = compute(fixedRuleSet, []);
    expect(result.status).toBe('ABSENT');
    expect(result.flags).toEqual(expect.arrayContaining(['NO_EVENTS']));
    expect(result.late_minutes).toBe(0);
  });

  test('flex shift late anchor uses window_start', () => {
    const flexRuleSet = {
      rules: [
        { type: 'FLEX_SHIFT', window_start: '09:00', window_end: '18:00', required_work_minutes: 480 },
        { type: 'LATE_THRESHOLD', grace_minutes: 15, late_after_minutes: 15 },
        { type: 'WORK_MINUTES_COMPUTE' },
        { type: 'LATE_MINUTES_COMPUTE' },
        { type: 'STATUS_BY_LATE' },
        { type: 'STATUS_FALLBACK', status: 'ABSENT' }
      ]
    };

    const onBoundary = compute(flexRuleSet, [
      { event_time: '2025-01-01T09:15:00Z', direction: 'IN' },
      { event_time: '2025-01-01T18:00:00Z', direction: 'OUT' }
    ]);
    expect(onBoundary.status).toBe('PRESENT');
    expect(onBoundary.late_minutes).toBe(0);
    expect(onBoundary.flags || []).not.toContain('LATE');

    const aboveBoundary = compute(flexRuleSet, [
      { event_time: '2025-01-01T09:16:00Z', direction: 'IN' },
      { event_time: '2025-01-01T18:00:00Z', direction: 'OUT' }
    ]);
    expect(aboveBoundary.status).toBe('PRESENT');
    expect(aboveBoundary.late_minutes).toBe(1);
    expect(aboveBoundary.flags).toEqual(expect.arrayContaining(['LATE']));
  });
});
