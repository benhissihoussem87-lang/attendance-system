function toUtcDate(date, time) {
  return new Date(date + 'T' + time + ':00Z');
}

module.exports = function applyScheduleRules(ctx) {
  const rules = ctx.ruleSet?.rules || [];

  rules.forEach((rule, index) => {
    if (rule.type === 'FIXED_SHIFT') {
      ctx.schedule.type = 'FIXED_SHIFT';
      ctx.schedule.expected_start_utc = toUtcDate(ctx.date, rule.start);
      ctx.schedule.expected_end_utc = toUtcDate(ctx.date, rule.end);
      ctx.schedule.window_start_utc = null;
      ctx.schedule.window_end_utc = null;
      ctx.schedule.required_work_minutes = null;
      ctx.explanation.push('FIXED_SHIFT rule applied at index ' + index);
    }

    if (rule.type === 'FLEX_SHIFT') {
      ctx.schedule.type = 'FLEX_SHIFT';
      ctx.schedule.expected_start_utc = null;
      ctx.schedule.expected_end_utc = null;
      ctx.schedule.window_start_utc = toUtcDate(ctx.date, rule.window_start);
      ctx.schedule.window_end_utc = toUtcDate(ctx.date, rule.window_end);
      ctx.schedule.required_work_minutes = rule.required_work_minutes;
      ctx.explanation.push('FLEX_SHIFT rule applied at index ' + index);
    }
  });
};
