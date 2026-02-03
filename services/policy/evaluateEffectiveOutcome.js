function pickProfile(input) {
  if (input && input.policy_profile) {
    const profile = input.policy_profile;
    return {
      id: profile.id ?? null,
      code: profile.code ?? profile.name ?? 'default-v1',
      version: profile.version ?? 1
    };
  }

  return {
    id: null,
    code: 'default-v1',
    version: 1
  };
}

function evaluateEffectiveOutcome(input) {
  const profile = pickProfile(input);
  const computedStatus = input && input.computed ? input.computed.status : null;
  const context = input && input.context ? input.context : {};
  const isNonWorkingDay = context.is_non_working_day === true;
  const isOnLeave = context.is_on_leave === true;
  const reasons = [];

  if (isNonWorkingDay) {
    reasons.push('NON_WORKING_DAY');
    return {
      status: 'NON_WORKING_DAY',
      state: 'AUTO_APPLIED',
      source: 'AUTO_POLICY',
      profile,
      reasons
    };
  }

  if (isOnLeave) {
    reasons.push('ON_LEAVE');
    return {
      status: 'ON_LEAVE',
      state: 'AUTO_APPLIED',
      source: 'AUTO_POLICY',
      profile,
      reasons
    };
  }

  if (computedStatus === 'INVALID' || computedStatus === 'INCOMPLETE') {
    reasons.push('COMPUTED_' + computedStatus);
    return {
      status: 'NEEDS_REVIEW',
      state: 'NEEDS_REVIEW',
      source: 'AUTO_POLICY',
      profile,
      reasons
    };
  }

  if (computedStatus === 'PRESENT' || computedStatus === 'ABSENT') {
    return {
      status: computedStatus,
      state: 'AUTO_APPLIED',
      source: 'AUTO_POLICY',
      profile,
      reasons
    };
  }

  reasons.push('COMPUTED_UNKNOWN');
  return {
    status: 'NEEDS_REVIEW',
    state: 'NEEDS_REVIEW',
    source: 'AUTO_POLICY',
    profile,
    reasons
  };
}

module.exports = { evaluateEffectiveOutcome };
