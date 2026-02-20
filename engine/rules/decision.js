const { deriveDayStatus } = require('../deriveDayStatus');

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

function isLateByThreshold(ctx) {
  const rawLate = typeof ctx.metrics.raw_late_minutes === 'number'
    ? ctx.metrics.raw_late_minutes
    : ctx.metrics.late_minutes;
  const threshold = typeof ctx.thresholds.late_threshold_minutes === 'number'
    ? ctx.thresholds.late_threshold_minutes
    : 0;
  return rawLate > threshold;
}

function addUnique(list, value) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function validateEventSequence(events) {
  const flags = [];
  const notes = [];
  if (!Array.isArray(events) || events.length === 0) {
    return { flags, notes };
  }

  const firstDirection = events[0] ? events[0].direction : null;
  if (firstDirection === 'OUT') {
    addUnique(flags, 'FIRST_EVENT_OUT');
    notes.push('first event direction is OUT');
  }

  for (let index = 1; index < events.length; index += 1) {
    const previousDirection = events[index - 1] ? events[index - 1].direction : null;
    const direction = events[index] ? events[index].direction : null;
    if ((direction === 'IN' || direction === 'OUT') && direction === previousDirection) {
      addUnique(flags, 'NON_ALTERNATING_SEQUENCE');
      addUnique(flags, 'MULTIPLE_SAME_DIRECTION');
      notes.push('repeated direction at index ' + index);
    }
  }

  return { flags, notes };
}

module.exports = function decideStatus(ctx) {
  if (ctx.invalid) {
    ctx.decision.reason_code = 'INVALID_CONTEXT';
    ctx.result = ctx.invalid;
    return;
  }

  const rules = ctx.ruleSet?.rules || [];

  const firstIn = ctx.timeline.inEvent ? ctx.timeline.inEvent.event_time : null;
  const lastOut = ctx.timeline.outEvent ? ctx.timeline.outEvent.event_time : null;
  const sequenceValidation = validateEventSequence(ctx.events || []);
  if (sequenceValidation.flags.length > 0) {
    ctx.decision.status = 'INVALID';
    ctx.decision.reason_code = sequenceValidation.flags[0];
    sequenceValidation.flags.forEach(flag => addFlag(ctx, flag));
    sequenceValidation.notes.forEach(note => {
      ctx.explanation.push('Sequence validation: ' + note);
    });
    ctx.explanation.push('Sequence validation: invalid event sequence -> INVALID');
    ctx.result = buildResult(ctx);
    return;
  }

  const derived = deriveDayStatus({
    events: ctx.events || [],
    first_in_utc: firstIn,
    last_out_utc: lastOut
  });

  if (derived.status === 'ABSENT') {
    ctx.decision.status = 'ABSENT';
    ctx.decision.reason_code = 'NO_EVENTS';
    addFlag(ctx, 'NO_EVENTS');
    ctx.explanation.push('Derived completeness: no events -> ABSENT');
    ctx.result = buildResult(ctx);
    return;
  }

  if (derived.status === 'INCOMPLETE') {
    ctx.decision.status = 'INCOMPLETE';
    ctx.decision.reason_code = derived.flags[0];
    addFlag(ctx, derived.flags[0]);
    if (isLateByThreshold(ctx)) {
      addFlag(ctx, 'LATE');
    }
    ctx.explanation.push('Derived completeness: incomplete day -> INCOMPLETE');
    ctx.result = buildResult(ctx);
    return;
  }

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];

    if (rule.type === 'STATUS_BY_LATE') {
      if (isLateByThreshold(ctx)) {
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
