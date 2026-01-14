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

const USE_DERIVED_WORK_DATE = process.env.USE_DERIVED_WORK_DATE === 'true';

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

function buildComputedPayload(data, computationContext) {
  return {
    status: data.status,
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

router.post('/day', async (req, res) => {
  try {
    const {
      company_id,
      person_id,
      date,
      rule_set_id,
      policy_profile_id
    } = req.body || {};

    if (!person_id) {
      return res.status(400).json({ error: 'invalid_request', detail: 'person_id is required' });
    }
    if (!isValidDateString(date)) {
      return res.status(400).json({ error: 'invalid_request', detail: 'date must be YYYY-MM-DD' });
    }
    if (rule_set_id && !isValidUuid(rule_set_id)) {
      return res.status(400).json({ error: 'invalid_request', detail: 'rule_set_id must be a UUID' });
    }
    if (policy_profile_id && !isValidUuid(policy_profile_id)) {
      return res.status(400).json({ error: 'invalid_request', detail: 'policy_profile_id must be a UUID' });
    }

    const companyId = company_id || 'DEFAULT';
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

    let ruleSetSelection;
    let selectedRuleSet;
    try {
      const resolved = await resolveRuleSet(db, {
        rule_set_id,
        fallbackRuleSet: ruleSets[employees[0].rule_set_id]
      });
      selectedRuleSet = resolved.ruleSet;
      ruleSetSelection = resolved.meta;
    } catch (err) {
      if (err.code === 'RULE_SET_NOT_FOUND') {
        return res.status(400).json({ error: 'invalid_request', detail: 'rule_set_id not found' });
      }
      throw err;
    }

    let policyProfile;
    if (policy_profile_id) {
      const foundProfile = await getPolicyProfileById(db, policy_profile_id);
      if (!foundProfile) {
        return res.status(400).json({ error: 'invalid_request', detail: 'policy_profile_id not found' });
      }
      if (foundProfile.company_id !== companyId) {
        return res.status(400).json({ error: 'invalid_request', detail: 'policy_profile_id does not belong to company' });
      }
      policyProfile = foundProfile;
    } else {
      policyProfile = await getActivePolicyProfile(db, companyId);
    }
    const nonWorkingDay = await isNonWorkingDay(db, companyId, date);
    const onLeave = await isOnLeave(db, person_id, date);

    const eventsRes = await db.query(`
      SELECT person_id, event_time_utc, direction
      FROM device_events
      WHERE person_id = $1
        AND event_time_utc >= $2
        AND event_time_utc < $3
      ORDER BY event_time_utc
    `, [person_id, windowStartUtc, windowEndUtc]);

    const dayEvents = eventsRes.rows.map(e => ({
      person_id: e.person_id,
      event_time: e.event_time_utc,
      direction: e.direction
    }));

    const employee = employees[0];
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

    let record;
    if (nonWorkingDay) {
      record = {
        system_version: SYSTEM_VERSION,
        contract: ATTENDANCE_OUTPUT_CONTRACT,
        engine_contract: ENGINE_CONTRACT,
        engine_version: ENGINE_VERSION,
        employee: employee.employee_code,
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
    } else if (onLeave) {
      record = {
        system_version: SYSTEM_VERSION,
        contract: ATTENDANCE_OUTPUT_CONTRACT,
        engine_contract: ENGINE_CONTRACT,
        engine_version: ENGINE_VERSION,
        employee: employee.employee_code,
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
    } else {
      record = {
        system_version: SYSTEM_VERSION,
        contract: ATTENDANCE_OUTPUT_CONTRACT,
        engine_contract: ENGINE_CONTRACT,
        engine_version: ENGINE_VERSION,
        employee: employee.employee_code,
        ...result,
        source: 'simulation'
      };
    }

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
    return res.status(500).json({ error: 'simulation_failed' });
  }
});

module.exports = router;
