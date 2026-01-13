function invalidResult(message) {
  return {
    status: 'INVALID',
    first_in: null,
    last_out: null,
    worked_minutes: 0,
    late_minutes: 0,
    flags: [],
    explanation: ['Decision: ' + message]
  };
}

function buildResult(ctx) {
  const flags = Array.isArray(ctx.decision.flags) ? ctx.decision.flags : [];
  return {
    status: ctx.decision.status,
    reason_code: ctx.decision.reason_code,
    first_in: ctx.timeline.inEvent?.event_time || null,
    last_out: ctx.timeline.outEvent?.event_time || null,
    worked_minutes: ctx.metrics.worked_minutes,
    late_minutes: ctx.metrics.late_minutes,
    break_minutes: ctx.metrics.break_minutes,
    net_worked_minutes: ctx.metrics.net_worked_minutes,
    flags,
    explanation: ctx.explanation
  };
}

function firstStatusRuleType(rules) {
  const statusTypes = new Set([
    'STATUS_BY_LATE',
    'STATUS_BY_WORKED_MINUTES',
    'STATUS_FALLBACK'
  ]);

  const rule = rules.find(item => statusTypes.has(item.type));
  return rule ? rule.type : 'UNKNOWN_STATUS_RULE';
}

function addFlag(ctx, flag) {
  if (!Array.isArray(ctx.decision.flags)) {
    ctx.decision.flags = [];
  }
  if (!ctx.decision.flags.includes(flag)) {
    ctx.decision.flags.push(flag);
  }
}

module.exports = function decideStatus(ctx) {
  if (ctx.invalid) {
    ctx.decision.reason_code = 'INVALID_CONTEXT';
    ctx.result = ctx.invalid;
    return;
  }

  const rules = ctx.ruleSet?.rules || [];

  if (!ctx.timeline.inEvent) {
    const ruleType = firstStatusRuleType(rules);
    ctx.decision.status = 'ABSENT';
    ctx.decision.reason_code = 'NO_EVENTS';
    ctx.explanation.push(ruleType + ': no arrival event -> ABSENT');
    ctx.result = buildResult(ctx);
    return;
  }

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];

    if (rule.type === 'STATUS_BY_LATE') {
      if (ctx.metrics.late_minutes > 0) {
        ctx.decision.status = 'PRESENT';
        ctx.decision.reason_code = 'LATE_ARRIVAL';
        addFlag(ctx, 'LATE');
        ctx.explanation.push('STATUS_BY_LATE rule applied at index ' + index + ': late -> PRESENT (flagged LATE)');
      } else {
        ctx.decision.status = 'PRESENT';
        ctx.decision.reason_code = 'ON_TIME';
        ctx.explanation.push('STATUS_BY_LATE rule applied at index ' + index + ': on time -> PRESENT');
      }
      ctx.result = buildResult(ctx);
      return;
    }

    if (rule.type === 'STATUS_BY_WORKED_MINUTES') {
      const requiredMinutes = rule.min_work_minutes ?? ctx.schedule.required_work_minutes;
      const workedForDecision = ctx.metrics.net_worked_minutes ?? ctx.metrics.worked_minutes;
      if (requiredMinutes === null || requiredMinutes === undefined) {
        ctx.decision.reason_code = 'INVALID_CONTEXT';
        ctx.result = invalidResult('STATUS_BY_WORKED_MINUTES missing required work minutes');
        return;
      }

      if (workedForDecision >= requiredMinutes) {
        ctx.decision.status = rule.status;
        ctx.decision.reason_code = 'WORK_MINUTES_OK';
        ctx.explanation.push('STATUS_BY_WORKED_MINUTES rule applied at index ' + index + ': worked >= ' + requiredMinutes + ' -> ' + rule.status);
        ctx.result = buildResult(ctx);
        return;
      }
    }

    if (rule.type === 'STATUS_FALLBACK') {
      ctx.decision.status = rule.status;
      ctx.decision.reason_code = 'FALLBACK';
      ctx.explanation.push('STATUS_FALLBACK rule applied at index ' + index + ' -> ' + rule.status);
      ctx.result = buildResult(ctx);
      return;
    }
  }

  ctx.decision.reason_code = 'INVALID_CONTEXT';
  ctx.result = invalidResult('No status rule produced a decision');
};
