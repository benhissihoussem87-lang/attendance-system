const express = require('express');
const router = express.Router();

const engine = require('../engine/AttendanceEngine');
const employees = require('../data/mockEmployees');
const ruleSets = require('../data/mockRuleSets');
const db = require('../db');
const { getCompanyConfig } = require('../services/companyConfigProvider');
const { getUtcWindowForWorkDate } = require('../services/dayBoundaryWindow');
const { buildComputationSignature } = require('../services/cacheSignature');
const { resolveRuleSet } = require('../services/ruleSetProvider');
const {
  getActivePolicyProfile,
  getPolicyProfileById
} = require('../services/policy/policyProfileProvider');
const { evaluateEffectiveOutcome } = require('../services/policy/evaluateEffectiveOutcome');
const { isNonWorkingDay, isOnLeave } = require('../services/policy/policyContextProvider');
const {
  ENGINE_VERSION,
  ENGINE_CONTRACT,
  ATTENDANCE_OUTPUT_CONTRACT,
  SYSTEM_VERSION
} = require('../contracts/systemContracts');
const { toBool } = require('../services/envBool');
const { applyRuleSetOverride } = require('../services/simulateRuleSetOverride');
const { requireApiKey, requireRole, enforceCompanyScope } = require('./lib/auth');
const { sendError } = require('./lib/errorEnvelope');

const USE_DERIVED_WORK_DATE = toBool(process.env.USE_DERIVED_WORK_DATE);

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime());
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sendValidationError(res, error, detail) {
  return sendError(res, {
    status: 400,
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    details: {
      kind: 'validation',
      error,
      detail
    }
  });
}

function sendInternalError(res) {
  return sendError(res, {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Server error'
  });
}

function buildComputedPayload(data, computationContext) {
  return {
    status: data.status,
    reason_code: data.reason_code || null,
    rule_set_id: data.rule_set_id || null,
    flags: Array.isArray(data.flags) ? data.flags : [],
    metrics: {
      worked_minutes: data.worked_minutes ?? null,
      late_minutes: data.late_minutes ?? null,
      break_minutes: data.break_minutes ?? null,
      net_worked_minutes: data.net_worked_minutes ?? null
    },
    audit: {
      explanation: data.explanation,
      computation_context: computationContext
    }
  };
}

function buildSimulationRecord({
  employeeCode,
  result,
  nonWorkingDay,
  onLeave
}) {
  if (nonWorkingDay) {
    return {
      system_version: SYSTEM_VERSION,
      contract: ATTENDANCE_OUTPUT_CONTRACT,
      engine_contract: ENGINE_CONTRACT,
      engine_version: ENGINE_VERSION,
      employee: employeeCode,
      status: 'NON_WORKING_DAY',
      first_in: null,
      last_out: null,
      worked_minutes: 0,
      late_minutes: 0,
      break_minutes: 0,
      net_worked_minutes: 0,
      explanation: ['Non-working day (company policy)'],
      source: 'simulation'
    };
  }

  if (onLeave) {
    return {
      system_version: SYSTEM_VERSION,
      contract: ATTENDANCE_OUTPUT_CONTRACT,
      engine_contract: ENGINE_CONTRACT,
      engine_version: ENGINE_VERSION,
      employee: employeeCode,
      status: 'ON_LEAVE',
      first_in: null,
      last_out: null,
      worked_minutes: 0,
      late_minutes: 0,
      break_minutes: 0,
      net_worked_minutes: 0,
      explanation: ['Employee on leave'],
      source: 'simulation'
    };
  }

  return {
    system_version: SYSTEM_VERSION,
    contract: ATTENDANCE_OUTPUT_CONTRACT,
    engine_contract: ENGINE_CONTRACT,
    engine_version: ENGINE_VERSION,
    employee: employeeCode,
    ...result,
    source: 'simulation'
  };
}

function getEmployeeByPersonId(personId) {
  const match = employees.find(employee => employee.person_id === personId);
  return match || employees[0];
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseDate(value) {
  return new Date(value + 'T00:00:00Z');
}

function formatDate(value) {
  return value.toISOString().slice(0, 10);
}

function enumerateDates(startDate, endDate) {
  const out = [];
  let cursor = parseDate(startDate);
  const end = parseDate(endDate);
  while (cursor <= end) {
    out.push(formatDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function applyPolicyOverride(profile, override) {
  if (!isPlainObject(override)) {
    return profile;
  }
  const existingParams = profile && isPlainObject(profile.params)
    ? profile.params
    : (profile && isPlainObject(profile.rules_json) ? profile.rules_json : {});
  return {
    ...(profile || {}),
    params: { ...existingParams, ...override }
  };
}

router.post('/day', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const {
      company_id,
      person_id,
      date,
      rule_set_id,
      policy_profile_id,
      policy_override,
      rule_set_override
    } = req.body || {};

    if (!person_id) {
      return sendValidationError(res, 'person_id_required', 'person_id is required');
    }
    if (!isValidDateString(date)) {
      return sendValidationError(res, 'date_invalid', 'date must be YYYY-MM-DD');
    }
    if (rule_set_id && !isValidUuid(rule_set_id)) {
      return sendValidationError(res, 'rule_set_id_invalid', 'rule_set_id must be a UUID');
    }
    if (policy_profile_id && !isValidUuid(policy_profile_id)) {
      return sendValidationError(res, 'policy_profile_id_invalid', 'policy_profile_id must be a UUID');
    }
    if (rule_set_override !== undefined && !isPlainObject(rule_set_override)) {
      return sendValidationError(res, 'rule_set_override_invalid', 'rule_set_override must be an object');
    }
    if (rule_set_override && rule_set_override.late_threshold_minutes !== undefined &&
      !isFiniteNonNegativeNumber(rule_set_override.late_threshold_minutes)) {
      return sendValidationError(
        res,
        'late_threshold_minutes_invalid',
        'late_threshold_minutes must be a non-negative number'
      );
    }
    if (policy_override !== undefined && !isPlainObject(policy_override)) {
      return sendValidationError(res, 'policy_override_invalid', 'policy_override must be an object');
    }

    const companyId = (req.ctx && req.ctx.company_id)
      ? req.ctx.company_id
      : (company_id || 'DEFAULT');
    const companyConfig = await getCompanyConfig(db, companyId);
    const signature = buildComputationSignature(companyConfig, {
      use_derived_work_date: USE_DERIVED_WORK_DATE
    });

    let windowStartUtc = new Date(`${date}T00:00:00.000Z`).toISOString();
    let windowEndUtc = new Date(`${date}T00:00:00.000Z`);
    windowEndUtc.setUTCDate(windowEndUtc.getUTCDate() + 1);
    windowEndUtc = windowEndUtc.toISOString();

    if (USE_DERIVED_WORK_DATE) {
      const window = getUtcWindowForWorkDate({
        work_date: date,
        config: companyConfig
      });
      windowStartUtc = window.windowStartUtcIso;
      windowEndUtc = window.windowEndUtcIso;
    }

    const employee = getEmployeeByPersonId(person_id);
    let ruleSetSelection;
    let selectedRuleSet;
    try {
      const resolved = await resolveRuleSet(db, {
        rule_set_id,
        fallbackRuleSet: ruleSets[employee.rule_set_id]
      });
      selectedRuleSet = resolved.ruleSet;
      ruleSetSelection = resolved.meta;
    } catch (err) {
      if (err.code === 'RULE_SET_NOT_FOUND') {
        return sendValidationError(res, 'rule_set_id_not_found', 'rule_set_id not found');
      }
      throw err;
    }

    let effectiveRuleSetOverride = rule_set_override;
    if (!effectiveRuleSetOverride && isPlainObject(policy_override) &&
      policy_override.late_threshold_minutes !== undefined) {
      effectiveRuleSetOverride = {
        late_threshold_minutes: policy_override.late_threshold_minutes
      };
    }
    selectedRuleSet = applyRuleSetOverride(selectedRuleSet, effectiveRuleSetOverride);

    let policyProfile;
    if (policy_profile_id) {
      const foundProfile = await getPolicyProfileById(db, policy_profile_id);
      if (!foundProfile) {
        return sendValidationError(res, 'policy_profile_id_not_found', 'policy_profile_id not found');
      }
      if (foundProfile.company_id !== companyId) {
        return sendValidationError(
          res,
          'policy_profile_id_company_mismatch',
          'policy_profile_id does not belong to company'
        );
      }
      policyProfile = foundProfile;
    } else {
      policyProfile = await getActivePolicyProfile(db, companyId);
    }
    policyProfile = applyPolicyOverride(policyProfile, policy_override);
    const nonWorkingDay = await isNonWorkingDay(db, companyId, date);
    const onLeave = await isOnLeave(db, companyId, person_id, date);

    const eventsRes = await db.query(`
      SELECT person_id, event_time_utc, direction, device_uid
      FROM device_events
      WHERE company_id = $1
        AND person_id = $2
        AND event_time_utc >= $3
        AND event_time_utc < $4
      ORDER BY event_time_utc
    `, [companyId, person_id, windowStartUtc, windowEndUtc]);

    const dayEvents = eventsRes.rows.map(e => ({
      person_id: e.person_id,
      event_time: e.event_time_utc,
      direction: e.direction,
      device_uid: e.device_uid
    }));

    const result = engine.computeDay({
      person: { ...employee, person_id },
      date,
      events: dayEvents,
      ruleSet: selectedRuleSet
    });

    if (ruleSetSelection && ruleSetSelection.source === 'db') {
      result.rule_set_id = ruleSetSelection.rule_set_id;
    }

    const computationContext = {
      ...signature,
      rule_set_selection: ruleSetSelection
    };

    const computed = buildComputedPayload({
      status: result.status,
      reason_code: result.reason_code,
      flags: result.flags,
      rule_set_id: result.rule_set_id,
      worked_minutes: result.worked_minutes,
      late_minutes: result.late_minutes,
      break_minutes: result.break_minutes,
      net_worked_minutes: result.net_worked_minutes,
      explanation: result.explanation
    }, computationContext);

    const effective = evaluateEffectiveOutcome({
      company_id: companyId,
      work_date: date,
      computed,
      context: {
        is_non_working_day: nonWorkingDay,
        is_on_leave: onLeave
      },
      policy_profile: policyProfile
    });

    const record = buildSimulationRecord({
      employeeCode: employee.employee_code,
      result,
      nonWorkingDay,
      onLeave
    });

    record.attendance_day_id = null;
    record.computed = computed;
    record.effective = {
      status: effective.status,
      state: effective.state,
      source: effective.source,
      profile: effective.profile,
      reasons: effective.reasons
    };

    return res.json([record]);
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

router.post('/range', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  try {
    const {
      company_id,
      person_id,
      start_date,
      end_date,
      rule_set_id,
      policy_profile_id,
      policy_override,
      rule_set_override
    } = req.body || {};

    if (!person_id) {
      return sendValidationError(res, 'person_id_required', 'person_id is required');
    }
    if (!isValidDateString(start_date) || !isValidDateString(end_date)) {
      return sendValidationError(res, 'date_invalid', 'start_date and end_date must be YYYY-MM-DD');
    }
    if (rule_set_id && !isValidUuid(rule_set_id)) {
      return sendValidationError(res, 'rule_set_id_invalid', 'rule_set_id must be a UUID');
    }
    if (policy_profile_id && !isValidUuid(policy_profile_id)) {
      return sendValidationError(res, 'policy_profile_id_invalid', 'policy_profile_id must be a UUID');
    }
    if (policy_override !== undefined && !isPlainObject(policy_override)) {
      return sendValidationError(res, 'policy_override_invalid', 'policy_override must be an object');
    }
    if (rule_set_override !== undefined && !isPlainObject(rule_set_override)) {
      return sendValidationError(res, 'rule_set_override_invalid', 'rule_set_override must be an object');
    }
    if (rule_set_override && rule_set_override.late_threshold_minutes !== undefined &&
      !isFiniteNonNegativeNumber(rule_set_override.late_threshold_minutes)) {
      return sendValidationError(
        res,
        'late_threshold_minutes_invalid',
        'late_threshold_minutes must be a non-negative number'
      );
    }

    const startMs = parseDate(start_date).getTime();
    const endMs = parseDate(end_date).getTime();
    if (startMs > endMs) {
      return sendValidationError(res, 'date_range_invalid', 'start_date must be <= end_date');
    }

    const dateList = enumerateDates(start_date, end_date);
    if (dateList.length === 0) {
      return sendValidationError(res, 'date_range_invalid', 'invalid date range');
    }
    if (dateList.length > 62) {
      return sendValidationError(res, 'date_range_too_large', 'date range too large');
    }

    const companyId = (req.ctx && req.ctx.company_id)
      ? req.ctx.company_id
      : (company_id || 'DEFAULT');
    const companyConfig = await getCompanyConfig(db, companyId);
    const signature = buildComputationSignature(companyConfig, {
      use_derived_work_date: USE_DERIVED_WORK_DATE
    });

    const employee = getEmployeeByPersonId(person_id);
    let ruleSetSelection;
    let selectedRuleSet;
    try {
      const resolved = await resolveRuleSet(db, {
        rule_set_id,
        fallbackRuleSet: ruleSets[employee.rule_set_id]
      });
      selectedRuleSet = resolved.ruleSet;
      ruleSetSelection = resolved.meta;
    } catch (err) {
      if (err.code === 'RULE_SET_NOT_FOUND') {
        return sendValidationError(res, 'rule_set_id_not_found', 'rule_set_id not found');
      }
      throw err;
    }

    let policyProfile;
    if (policy_profile_id) {
      const foundProfile = await getPolicyProfileById(db, policy_profile_id);
      if (!foundProfile) {
        return sendValidationError(res, 'policy_profile_id_not_found', 'policy_profile_id not found');
      }
      if (foundProfile.company_id !== companyId) {
        return sendValidationError(
          res,
          'policy_profile_id_company_mismatch',
          'policy_profile_id does not belong to company'
        );
      }
      policyProfile = foundProfile;
    } else {
      policyProfile = await getActivePolicyProfile(db, companyId);
    }
    let effectiveRuleSetOverride = rule_set_override;
    if (!effectiveRuleSetOverride && isPlainObject(policy_override) &&
      policy_override.late_threshold_minutes !== undefined) {
      effectiveRuleSetOverride = {
        late_threshold_minutes: policy_override.late_threshold_minutes
      };
    }
    selectedRuleSet = applyRuleSetOverride(selectedRuleSet, effectiveRuleSetOverride);
    policyProfile = applyPolicyOverride(policyProfile, policy_override);

    const windowByDate = new Map();
    let minWindowStartMs = null;
    let maxWindowEndMs = null;

    for (const workDate of dateList) {
      let windowStartUtc = new Date(`${workDate}T00:00:00.000Z`).toISOString();
      let windowEndUtc = new Date(`${workDate}T00:00:00.000Z`);
      windowEndUtc.setUTCDate(windowEndUtc.getUTCDate() + 1);
      windowEndUtc = windowEndUtc.toISOString();

      if (USE_DERIVED_WORK_DATE) {
        const window = getUtcWindowForWorkDate({
          work_date: workDate,
          config: companyConfig
        });
        windowStartUtc = window.windowStartUtcIso;
        windowEndUtc = window.windowEndUtcIso;
      }

      const windowStartMs = Date.parse(windowStartUtc);
      const windowEndMs = Date.parse(windowEndUtc);
      windowByDate.set(workDate, {
        windowStartUtc,
        windowEndUtc,
        windowStartMs,
        windowEndMs
      });

      if (minWindowStartMs === null || windowStartMs < minWindowStartMs) {
        minWindowStartMs = windowStartMs;
      }
      if (maxWindowEndMs === null || windowEndMs > maxWindowEndMs) {
        maxWindowEndMs = windowEndMs;
      }
    }

    const eventsRes = await db.query(`
      SELECT person_id, event_time_utc, direction, device_uid
      FROM device_events
      WHERE company_id = $1
        AND person_id = $2
        AND event_time_utc >= $3
        AND event_time_utc < $4
      ORDER BY event_time_utc ASC
    `, [companyId, person_id, new Date(minWindowStartMs).toISOString(), new Date(maxWindowEndMs).toISOString()]);

    const allEvents = eventsRes.rows.map(e => ({
      person_id: e.person_id,
      event_time_utc: e.event_time_utc,
      direction: e.direction,
      device_uid: e.device_uid,
      event_time_ms: Date.parse(e.event_time_utc)
    }));

    const records = [];

    for (const workDate of dateList) {
      const window = windowByDate.get(workDate);
      const dayEvents = allEvents
        .filter(e => e.event_time_ms >= window.windowStartMs && e.event_time_ms < window.windowEndMs)
        .map(e => ({
          person_id: e.person_id,
          event_time: e.event_time_utc,
          direction: e.direction,
          device_uid: e.device_uid
        }));

      const result = engine.computeDay({
        person: { ...employee, person_id },
        date: workDate,
        events: dayEvents,
        ruleSet: selectedRuleSet
      });

      if (ruleSetSelection && ruleSetSelection.source === 'db') {
        result.rule_set_id = ruleSetSelection.rule_set_id;
      }

      const computationContext = {
        ...signature,
        rule_set_selection: ruleSetSelection
      };

      const computed = buildComputedPayload({
        status: result.status,
        reason_code: result.reason_code,
        flags: result.flags,
        rule_set_id: result.rule_set_id,
        worked_minutes: result.worked_minutes,
        late_minutes: result.late_minutes,
        break_minutes: result.break_minutes,
        net_worked_minutes: result.net_worked_minutes,
        explanation: result.explanation
      }, computationContext);

      const nonWorkingDay = await isNonWorkingDay(db, companyId, workDate);
      const onLeave = await isOnLeave(db, companyId, person_id, workDate);

      const effective = evaluateEffectiveOutcome({
        company_id: companyId,
        work_date: workDate,
        computed,
        context: {
          is_non_working_day: nonWorkingDay,
          is_on_leave: onLeave
        },
        policy_profile: policyProfile
      });

      const record = buildSimulationRecord({
        employeeCode: employee.employee_code,
        result,
        nonWorkingDay,
        onLeave
      });

      record.person_id = person_id;
      record.work_date = workDate;
      record.attendance_day_id = null;
      record.computed = computed;
      record.effective = {
        status: effective.status,
        state: effective.state,
        source: effective.source,
        profile: effective.profile,
        reasons: effective.reasons
      };

      records.push(record);
    }

    return res.json(records);
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

module.exports = router;
