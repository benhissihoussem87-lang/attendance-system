const SUPPORTED_RULE_TYPES = new Set([
  'FIXED_SHIFT',
  'FLEX_SHIFT',
  'LATE_THRESHOLD',
  'WORK_MINUTES_COMPUTE',
  'LATE_MINUTES_COMPUTE',
  'STATUS_BY_LATE',
  'STATUS_BY_WORKED_MINUTES',
  'STATUS_FALLBACK'
]);
const ALLOWED_STATUSES = new Set([
  'PRESENT',
  'ABSENT',
  'INCOMPLETE',
  'INVALID'
]);

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function invalidResult(issues) {
  return {
    status: 'INVALID',
    first_in: null,
    last_out: null,
    worked_minutes: 0,
    late_minutes: 0,
    flags: [],
    explanation: issues.map(issue => 'RuleSetValidator: ' + issue)
  };
}

function collectTypes(rules) {
  return rules.map(rule => rule.type);
}

function findRule(rules, type) {
  return rules.find(rule => rule.type === type) || null;
}

module.exports = {
  validate(ruleSet) {
    const issues = [];

    if (!ruleSet || !Array.isArray(ruleSet.rules)) {
      issues.push('Rule set must include a rules array');
      return { valid: false, result: invalidResult(issues) };
    }

    const rules = ruleSet.rules;
    const types = collectTypes(rules);

    rules.forEach((rule, index) => {
      if (!rule || !rule.type) {
        issues.push('Rule at index ' + index + ' is missing type');
        return;
      }

      if (!SUPPORTED_RULE_TYPES.has(rule.type)) {
        issues.push('Unsupported rule type: ' + rule.type);
        return;
      }

      if (rule.type === 'FIXED_SHIFT') {
        if (!rule.start || !rule.end) {
          issues.push('FIXED_SHIFT requires start and end');
        }
      }

      if (rule.type === 'FLEX_SHIFT') {
        if (!rule.window_start || !rule.window_end) {
          issues.push('FLEX_SHIFT requires window_start and window_end');
        }
        if (!isNumber(rule.required_work_minutes)) {
          issues.push('FLEX_SHIFT requires required_work_minutes');
        }
      }

      if (rule.type === 'LATE_THRESHOLD') {
        if (!isNumber(rule.grace_minutes) && !isNumber(rule.late_after_minutes)) {
          issues.push('LATE_THRESHOLD requires grace_minutes or late_after_minutes');
        }
      }

      if (rule.type === 'STATUS_FALLBACK') {
        if (!rule.status) {
          issues.push('STATUS_FALLBACK requires status');
        } else if (!ALLOWED_STATUSES.has(rule.status)) {
          issues.push('STATUS_FALLBACK status must be one of PRESENT, ABSENT, INCOMPLETE, INVALID');
        }
      }

      if (rule.type === 'STATUS_BY_WORKED_MINUTES') {
        if (!rule.status) {
          issues.push('STATUS_BY_WORKED_MINUTES requires status');
        } else if (!ALLOWED_STATUSES.has(rule.status)) {
          issues.push('STATUS_BY_WORKED_MINUTES status must be one of PRESENT, ABSENT, INCOMPLETE, INVALID');
        }
        if (rule.min_work_minutes !== undefined && !isNumber(rule.min_work_minutes)) {
          issues.push('STATUS_BY_WORKED_MINUTES min_work_minutes must be a number');
        }
      }
    });

    const hasSchedule = types.includes('FIXED_SHIFT') || types.includes('FLEX_SHIFT');
    if (!hasSchedule) {
      issues.push('Missing schedule rule (FIXED_SHIFT or FLEX_SHIFT)');
    }

    const hasStatusRule = types.includes('STATUS_BY_LATE') ||
      types.includes('STATUS_BY_WORKED_MINUTES') ||
      types.includes('STATUS_FALLBACK');

    if (!hasStatusRule) {
      issues.push('Missing status rule (STATUS_BY_LATE, STATUS_BY_WORKED_MINUTES, or STATUS_FALLBACK)');
    }

    if (types.includes('LATE_MINUTES_COMPUTE') && !types.includes('LATE_THRESHOLD')) {
      issues.push('LATE_MINUTES_COMPUTE requires LATE_THRESHOLD');
    }

    if (types.includes('STATUS_BY_LATE')) {
      if (!types.includes('LATE_MINUTES_COMPUTE')) {
        issues.push('STATUS_BY_LATE requires LATE_MINUTES_COMPUTE');
      }
      if (!types.includes('LATE_THRESHOLD')) {
        issues.push('STATUS_BY_LATE requires LATE_THRESHOLD');
      }
    }

    if (types.includes('STATUS_BY_WORKED_MINUTES') && !types.includes('WORK_MINUTES_COMPUTE')) {
      issues.push('STATUS_BY_WORKED_MINUTES requires WORK_MINUTES_COMPUTE');
    }

    if (types.includes('STATUS_BY_WORKED_MINUTES')) {
      const flexShift = findRule(rules, 'FLEX_SHIFT');
      const hasRequiredFromFlex = flexShift && isNumber(flexShift.required_work_minutes);
      const hasRequiredInRule = rules.some(rule =>
        rule.type === 'STATUS_BY_WORKED_MINUTES' && isNumber(rule.min_work_minutes)
      );

      if (!hasRequiredFromFlex && !hasRequiredInRule) {
        issues.push('STATUS_BY_WORKED_MINUTES requires min_work_minutes or FLEX_SHIFT required_work_minutes');
      }
    }

    if (issues.length > 0) {
      return { valid: false, result: invalidResult(issues) };
    }

    return { valid: true };
  }
};
