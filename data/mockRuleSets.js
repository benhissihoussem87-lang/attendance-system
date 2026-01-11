module.exports = {
  rs_office_v1: {
    name: 'Office Standard',
    rules: [
      {
        type: 'FIXED_SHIFT',
        start: '08:00',
        end: '16:00'
      },
      {
        type: 'LATE_THRESHOLD',
        grace_minutes: 0,
        late_after_minutes: 5
      },
      {
        type: 'WORK_MINUTES_COMPUTE'
      },
      {
        type: 'LATE_MINUTES_COMPUTE'
      },
      {
        type: 'STATUS_BY_LATE'
      },
      {
        type: 'STATUS_FALLBACK',
        status: 'ABSENT'
      }
    ]
  }
};
