function invalidResult(message) {
  return {
    status: 'INVALID',
    first_in: null,
    last_out: null,
    worked_minutes: 0,
    late_minutes: 0,
    explanation: ['Metrics: ' + message]
  };
}

function getStartForLate(ctx) {
  if (ctx.schedule.expected_start_utc) {
    return ctx.schedule.expected_start_utc;
  }

  if (ctx.schedule.window_start_utc) {
    return ctx.schedule.window_start_utc;
  }

  return null;
}

module.exports = function computeMetrics(ctx) {
  const rules = ctx.ruleSet?.rules || [];

  rules.forEach((rule, index) => {
    if (rule.type === 'LATE_THRESHOLD') {
      ctx.thresholds.late_after_minutes = rule.late_after_minutes ?? null;
      ctx.thresholds.grace_minutes = rule.grace_minutes ?? null;
      ctx.explanation.push('LATE_THRESHOLD rule applied at index ' + index);
    }

    if (rule.type === 'WORK_MINUTES_COMPUTE') {
      const inEvent = ctx.timeline.inEvent;
      const outEvent = ctx.timeline.outEvent;

      if (!inEvent || !outEvent) {
        ctx.metrics.worked_minutes = 0;
      } else {
        const arrivalTime = new Date(inEvent.event_time);
        const departureTime = new Date(outEvent.event_time);
        const workedMs = Math.max(0, departureTime - arrivalTime);
        ctx.metrics.worked_minutes = Math.floor(workedMs / 60000);
      }

      ctx.explanation.push('WORK_MINUTES_COMPUTE rule applied at index ' + index);
    }

    if (rule.type === 'LATE_MINUTES_COMPUTE') {
      const inEvent = ctx.timeline.inEvent;

      if (!inEvent) {
        ctx.metrics.late_minutes = 0;
        ctx.explanation.push('LATE_MINUTES_COMPUTE rule applied at index ' + index);
        return;
      }

      const start = getStartForLate(ctx);
      if (!start) {
        ctx.invalid = invalidResult('Missing schedule start for late calculation');
        return;
      }

      const lateAfter = ctx.thresholds.late_after_minutes;
      const grace = ctx.thresholds.grace_minutes;

      if (lateAfter === null && grace === null) {
        ctx.invalid = invalidResult('Missing LATE_THRESHOLD for late calculation');
        return;
      }

      const thresholdMinutes = lateAfter !== null ? lateAfter : grace;
      const thresholdTime = new Date(start.getTime() + thresholdMinutes * 60000);
      const arrivalTime = new Date(inEvent.event_time);
      const lateMs = Math.max(0, arrivalTime - thresholdTime);
      ctx.metrics.late_minutes = Math.floor(lateMs / 60000);
      ctx.explanation.push('LATE_MINUTES_COMPUTE rule applied at index ' + index);
    }

    if (rule.type === 'BREAK_DEDUCT') {
      const minutes = Number(rule.minutes);
      ctx.metrics.break_minutes = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
      ctx.explanation.push('BREAK_DEDUCT rule applied at index ' + index + ': -' + ctx.metrics.break_minutes + ' minutes');
    }
  });

  ctx.metrics.net_worked_minutes = Math.max(0, ctx.metrics.worked_minutes - ctx.metrics.break_minutes);
};
