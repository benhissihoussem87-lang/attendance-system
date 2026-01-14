module.exports = {
  default: {
    name: 'default-fixed-06-16',
    version: 1,
    rules: [
      { type: 'FIXED_SHIFT', start: '06:00', end: '16:00' },
      { type: 'LATE_THRESHOLD', grace_minutes: 5, late_after_minutes: 5 },
      { type: 'WORK_MINUTES_COMPUTE' },
      { type: 'LATE_MINUTES_COMPUTE' },
      { type: 'STATUS_BY_LATE' },
      { type: 'STATUS_FALLBACK', status: 'ABSENT' }
    ]
  }
};
