function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function setLateThresholdOnObject(obj, value) {
  if (!isPlainObject(obj)) {
    return;
  }
  obj.late_threshold_minutes = value;
  obj.lateThresholdMinutes = value;
  obj.threshold_minutes = value;
  obj.thresholdMinutes = value;
  obj.threshold = value;
  obj.grace_minutes = value;
  obj.graceMinutes = value;
  obj.grace_period_minutes = value;
  obj.gracePeriodMinutes = value;
  obj.late_after_minutes = value;
  obj.lateAfterMinutes = value;
}

function hasLateThresholdShape(obj) {
  if (!isPlainObject(obj)) {
    return false;
  }
  const keys = [
    'late_threshold_minutes',
    'lateThresholdMinutes',
    'threshold_minutes',
    'thresholdMinutes',
    'threshold',
    'grace_minutes',
    'graceMinutes',
    'grace_period_minutes',
    'gracePeriodMinutes',
    'late_after_minutes',
    'lateAfterMinutes'
  ];
  return keys.some(key => Object.prototype.hasOwnProperty.call(obj, key));
}

function patchLateThresholdRecursive(node, value) {
  if (Array.isArray(node)) {
    node.forEach(item => patchLateThresholdRecursive(item, value));
    return;
  }
  if (!isPlainObject(node)) {
    return;
  }

  const code = node.code || node.rule_code || node.type;
  if (code === 'LATE_THRESHOLD') {
    if (!isPlainObject(node.params)) {
      node.params = {};
    }
    setLateThresholdOnObject(node.params, value);
    setLateThresholdOnObject(node, value);
    if (isPlainObject(node.config)) {
      setLateThresholdOnObject(node.config, value);
    }
  } else {
    if (isPlainObject(node.params) && hasLateThresholdShape(node.params)) {
      setLateThresholdOnObject(node.params, value);
    }
    if (isPlainObject(node.config) && hasLateThresholdShape(node.config)) {
      setLateThresholdOnObject(node.config, value);
    }
  }

  Object.keys(node).forEach(key => {
    patchLateThresholdRecursive(node[key], value);
  });
}

function applyRuleSetOverride(ruleSet, override) {
  if (!override || !isPlainObject(override)) {
    return ruleSet;
  }

  const cloned = JSON.parse(JSON.stringify(ruleSet || {}));
  if (isFiniteNonNegativeNumber(override.late_threshold_minutes)) {
    const value = override.late_threshold_minutes;
    patchLateThresholdRecursive(cloned, value);
  }

  return cloned;
}

module.exports = {
  applyRuleSetOverride,
  _internal: {
    isPlainObject,
    isFiniteNonNegativeNumber,
    setLateThresholdOnObject,
    hasLateThresholdShape,
    patchLateThresholdRecursive
  }
};

