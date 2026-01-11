const TimelineBuilder = require('./TimelineBuilder');

module.exports = {
  build(person, date, events, ruleSet) {
    return {
      person,
      date,
      events,
      ruleSet,
      workday: {
        start_utc: null,
        end_utc: null
      },
      schedule: {
        type: null,
        expected_start_utc: null,
        expected_end_utc: null,
        window_start_utc: null,
        window_end_utc: null,
        required_work_minutes: null
      },
      thresholds: {
        late_after_minutes: null,
        grace_minutes: null
      },
      timeline: TimelineBuilder.build(events),
      metrics: {
        late_minutes: 0,
        worked_minutes: 0,
        break_minutes: 0,
        net_worked_minutes: 0
      },
      decision: {
        status: 'UNKNOWN'
      },
      explanation: [],
      result: null,
      invalid: null
    };
  }
};
