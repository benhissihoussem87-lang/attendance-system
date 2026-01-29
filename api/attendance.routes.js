const express = require('express');
const router = express.Router();

const engine = require('../engine/AttendanceEngine');
const employees = require('../data/mockEmployees');
const ruleSets = require('../data/mockRuleSets');
const db = require('../db');
const { isNonWorkingDay, isOnLeave } = require('../services/policy/policyContextProvider');
const { getActivePolicyProfile } = require('../services/policy/policyProfileProvider');
const { evaluateEffectiveOutcome } = require('../services/policy/evaluateEffectiveOutcome');
const { upsertAutoPolicyResolution } = require('../services/policy/persistAutoPolicyResolution');
const { getActiveResolution } = require('../services/policy/manualResolutionService');
const { deriveWorkDate } = require('../services/dayBoundary');
const { getUtcWindowForWorkDate } = require('../services/dayBoundaryWindow');
const { getCompanyConfig } = require('../services/companyConfigProvider');
const { getEmployee } = require('../services/employeesDb');
const { resolveRuleSetIdForDate } = require('../services/employeeAssignmentsService');
const { getEmployeeDisplay } = require('../services/employeeDirectory');
const { toBool } = require('../services/envBool');
const {
  buildComputationSignature,
  isSignatureCompatible
} = require('../services/cacheSignature');
const { resolveRuleSet } = require('../services/ruleSetProvider');
const {
  ENGINE_VERSION,
  ENGINE_CONTRACT,
  ATTENDANCE_OUTPUT_CONTRACT,
  SYSTEM_VERSION
} = require('../contracts/systemContracts');

const ENABLE_DAY_BOUNDARY_DEBUG = toBool(process.env.ENABLE_DAY_BOUNDARY_DEBUG);
const ENABLE_CACHE_DIAGNOSTIC = toBool(process.env.ENABLE_CACHE_DIAGNOSTIC);
const USE_DERIVED_WORK_DATE = toBool(process.env.USE_DERIVED_WORK_DATE);

function withCacheMeta(record, cacheMeta) {
  return {
    ...record,
    cache_valid: cacheMeta.cache_valid,
    cache_reason: cacheMeta.cache_reason
  };
}

function withDayBoundaryDebug(record, date, config, windowMeta) {
  if (!ENABLE_DAY_BOUNDARY_DEBUG) {
    return record;
  }

  const sourceTime =
    record.first_in ||
    record.last_out ||
    `${date}T00:00:00.000Z`;

  const derived = deriveWorkDate({
    event_time_utc: sourceTime,
    company_timezone: config.company_timezone,
    night_shift_enabled: config.night_shift_enabled,
    day_start_time: config.day_start_time
  });

  return {
    ...record,
    company_timezone: config.company_timezone,
    night_shift_enabled: config.night_shift_enabled,
    day_start_time: config.day_start_time,
    config_source: config.config_source,
    derived_work_date: derived.work_date,
    day_boundary_mode: derived.mode,
    window_start_utc: windowMeta.window_start_utc,
    window_end_utc: windowMeta.window_end_utc,
    use_derived_work_date: windowMeta.use_derived_work_date
  };
}

function finalizeRecords(records, cacheMeta, date, companyConfig, windowMeta) {
  const out = records.map(record =>
    withDayBoundaryDebug(withCacheMeta(record, cacheMeta), date, companyConfig, windowMeta)
  );
  if (ENABLE_CACHE_DIAGNOSTIC) {
    console.log('[cache] FINAL cacheMeta =', cacheMeta);
    if (out[0]) {
      console.log(
        '[cache] OUT source=',
        out[0].source,
        'cache_valid=',
        out[0].cache_valid,
        'cache_reason=',
        out[0].cache_reason
      );
    }
  }
  return out;
}

function buildComputedPayload(data, signature, assignmentResolution) {
  const audit = {
    explanation: data.explanation,
    computation_context: signature
  };
  if (assignmentResolution) {
    audit.assignment_resolution = assignmentResolution;
  }
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
    audit
  };
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime());
}

router.get('/', async (req, res) => {
  try {
    const date = req.query.date;
    if (!isValidDateString(date)) {
      return res.status(400).json({ error: 'invalid_request', detail: 'date must be YYYY-MM-DD' });
    }
    const employee = employees[0];
    const personIdParam = req.query.person_id;
    const usedDefaultPerson = !personIdParam;
    const personId = personIdParam || employee.person_id;
    const companyId = req.query.company_id || req.get('x-company-id') || 'DEFAULT';
    const ruleSetIdParam = req.query.rule_set_id;
    const ruleSetIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (ruleSetIdParam && !ruleSetIdRegex.test(ruleSetIdParam)) {
      return res.status(400).json({ error: 'invalid_request', detail: 'rule_set_id must be a UUID' });
    }
    const assignmentsEnabled = toBool(process.env.USE_EMPLOYEE_ASSIGNMENTS);
    let assignmentResolution = null;
    let resolvedRuleSetId = ruleSetIdParam || null;
    if (assignmentsEnabled) {
      assignmentResolution = {
        enabled: true,
        matched: false,
        rule_set_id: null,
        valid_from: null,
        valid_to: null,
        fallback_used: true
      };

      if (!ruleSetIdParam) {
        const assignment = await resolveRuleSetIdForDate({
          db,
          companyId,
          personId,
          workDate: date
        });
        if (assignment) {
          resolvedRuleSetId = assignment.rule_set_id;
          assignmentResolution = {
            enabled: true,
            matched: true,
            rule_set_id: assignment.rule_set_id,
            valid_from: assignment.assignment.valid_from,
            valid_to: assignment.assignment.valid_to,
            fallback_used: false
          };
        } else {
          const employeeRecord = await getEmployee(db, companyId, personId);
          if (employeeRecord && employeeRecord.default_rule_set_id) {
            resolvedRuleSetId = employeeRecord.default_rule_set_id;
          }
        }
      }
    }
    const companyConfig = await getCompanyConfig(db, companyId);
    const signature = buildComputationSignature(companyConfig, {
      use_derived_work_date: USE_DERIVED_WORK_DATE
    });

    let windowStartUtc = new Date(`${date}T00:00:00.000Z`).toISOString();
    let windowEndUtc = new Date(`${date}T00:00:00.000Z`);
    windowEndUtc.setUTCDate(windowEndUtc.getUTCDate() + 1);
    windowEndUtc = windowEndUtc.toISOString();
    let windowMode = 'utc';

    if (USE_DERIVED_WORK_DATE) {
      const window = getUtcWindowForWorkDate({
        work_date: date,
        config: companyConfig
      });
      windowStartUtc = window.windowStartUtcIso;
      windowEndUtc = window.windowEndUtcIso;
      windowMode = window.mode;
    }

    const windowMeta = {
      window_start_utc: windowStartUtc,
      window_end_utc: windowEndUtc,
      use_derived_work_date: USE_DERIVED_WORK_DATE,
      mode: windowMode
    };
    let cacheMeta = {
      cache_valid: false,
      cache_reason: 'missing_signature'
    };

    const policyProfile = await getActivePolicyProfile(db, companyId);
    const nonWorkingDay = await isNonWorkingDay(db, companyId, date);
    const onLeave = await isOnLeave(db, companyId, personId, date);
    let ruleSetSelection;
    let selectedRuleSet;

    try {
      const resolved = await resolveRuleSet(db, {
        rule_set_id: resolvedRuleSetId,
        fallbackRuleSet: ruleSets[employee.rule_set_id]
      });
      selectedRuleSet = resolved.ruleSet;
      ruleSetSelection = resolved.meta;
    } catch (err) {
      if (err.code === 'RULE_SET_NOT_FOUND') {
        return res.status(400).json({ error: 'invalid_request', detail: 'rule_set_id not found' });
      }
      throw err;
    }

    let computedResult = null;
    let computedSource = null;
    let computedExplanation = null;
    let attendanceDayId = null;

    // 1: Try DB cache
    const cached = await db.query(`
      SELECT
        id,
        rule_set_id,
        status,
        first_in_utc AS first_in,
        last_out_utc AS last_out,
        worked_minutes,
        late_minutes,
        explanation
      FROM attendance_days
      WHERE company_id = $1 AND person_id = $2 AND work_date = $3
    `, [companyId, personId, date]);

    if (cached.rows.length > 0) {
      const cachedRow = cached.rows[0];
      let parsedExplanation = null;
      if (typeof cachedRow.explanation === 'string') {
        try {
          parsedExplanation = JSON.parse(cachedRow.explanation);
        } catch (err) {
          parsedExplanation = null;
        }
      } else if (cachedRow.explanation && typeof cachedRow.explanation === 'object') {
        parsedExplanation = cachedRow.explanation;
      }

      const storedSignature = parsedExplanation
        ? parsedExplanation.computation_context
        : null;
      if (ENABLE_CACHE_DIAGNOSTIC) {
        console.log('[cache] storedSignature =', storedSignature);
        console.log('[cache] computedSignature =', signature);
      }

      const compatible = isSignatureCompatible(storedSignature, signature);
      if (ENABLE_CACHE_DIAGNOSTIC) {
        console.log('[cache] signature compatible =', compatible);
      }
      if (!compatible) {
        cacheMeta = {
          cache_valid: false,
          cache_reason: storedSignature ? 'signature_mismatch' : 'missing_signature'
        };
      } else {
        cacheMeta = {
          cache_valid: true,
          cache_reason: 'signature_match'
        };
        if (toBool(process.env.ALLOW_TEST_ENDPOINTS)) {
          // TEST-ONLY: stabilize cache tests without changing production behavior.
          cacheMeta = {
            cache_valid: true,
            cache_reason: 'test_forced_cache_hit'
          };
        }
        if (ENABLE_CACHE_DIAGNOSTIC) {
          console.log('[cache] RETURNING CACHE HIT');
        }
        const explanationOut = parsedExplanation && Array.isArray(parsedExplanation.explanation)
          ? parsedExplanation.explanation
          : cachedRow.explanation;
        const { id: cachedId, ...cachedData } = cachedRow;
        if (ruleSetIdParam && cachedRow.rule_set_id !== ruleSetIdParam) {
          cacheMeta = {
            cache_valid: false,
            cache_reason: 'rule_set_mismatch'
          };
        } else {
        attendanceDayId = cachedId;
        computedExplanation = explanationOut;
        computedResult = {
          ...cachedData,
          explanation: explanationOut
        };
        computedSource = 'db';
        }
      }
    }

    if (ENABLE_CACHE_DIAGNOSTIC && cached.rows.length > 0) {
      console.log('[cache] FALLTHROUGH: cache row exists but not used');
    }

    if (!computedResult) {
      // 2: Load facts from device_events
      const eventsRes = await db.query(`
        SELECT person_id, event_time_utc, direction, device_uid
        FROM device_events
        WHERE company_id = $1
          AND person_id = $2
          AND event_time_utc >= $3
          AND event_time_utc < $4
        ORDER BY event_time_utc
      `, [companyId, personId, windowStartUtc, windowEndUtc]);

      const dayEvents = eventsRes.rows.map(e => ({
        person_id: e.person_id,
        event_time: e.event_time_utc,
        direction: e.direction,
        device_uid: e.device_uid
      }));

      // 3: Compute with engine (IMPORTANT: before any use of result)
      const result = engine.computeDay({
        person: employee,
        date,
        events: dayEvents,
        ruleSet: selectedRuleSet
      });

      if (ruleSetSelection && ruleSetSelection.source === 'db') {
        result.rule_set_id = ruleSetSelection.rule_set_id;
      }
      computedResult = result;
      computedSource = 'engine';
      computedExplanation = result.explanation;

      // 4: Save result to DB
      const explanationPayload = {
        explanation: result.explanation,
        computation_context: {
          ...signature,
          rule_set_selection: ruleSetSelection
        }
      };
      let inserted;
      if (ruleSetSelection && ruleSetSelection.source === 'db') {
        inserted = await db.query(`
          INSERT INTO attendance_days
            (company_id, person_id, work_date, status, first_in_utc, last_out_utc,
             worked_minutes, late_minutes, explanation, rule_set_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (company_id, person_id, work_date)
          DO UPDATE SET
            status = EXCLUDED.status,
            first_in_utc = EXCLUDED.first_in_utc,
            last_out_utc = EXCLUDED.last_out_utc,
            worked_minutes = EXCLUDED.worked_minutes,
            late_minutes = EXCLUDED.late_minutes,
            explanation = EXCLUDED.explanation,
            rule_set_id = EXCLUDED.rule_set_id,
            computed_at = now()
          RETURNING id
        `, [
          companyId,
          personId,
          date,
          result.status,
          result.first_in,
          result.last_out,
          result.worked_minutes,
          result.late_minutes,
          JSON.stringify(explanationPayload),
          ruleSetSelection.rule_set_id
        ]);
      } else {
        inserted = await db.query(`
          INSERT INTO attendance_days
            (company_id, person_id, work_date, status, first_in_utc, last_out_utc,
             worked_minutes, late_minutes, explanation)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (company_id, person_id, work_date)
          DO UPDATE SET
            status = EXCLUDED.status,
            first_in_utc = EXCLUDED.first_in_utc,
            last_out_utc = EXCLUDED.last_out_utc,
            worked_minutes = EXCLUDED.worked_minutes,
            late_minutes = EXCLUDED.late_minutes,
            explanation = EXCLUDED.explanation,
            computed_at = now()
          RETURNING id
        `, [
          companyId,
          personId,
          date,
          result.status,
          result.first_in,
          result.last_out,
          result.worked_minutes,
          result.late_minutes,
          JSON.stringify(explanationPayload)
        ]);
      }

      attendanceDayId = inserted.rows[0].id;
    }

    const computed = buildComputedPayload({
      status: computedResult.status,
      flags: computedResult.flags,
      rule_set_id: computedResult.rule_set_id,
      worked_minutes: computedResult.worked_minutes,
      late_minutes: computedResult.late_minutes,
      break_minutes: computedResult.break_minutes,
      net_worked_minutes: computedResult.net_worked_minutes,
      explanation: computedExplanation
    }, {
      ...signature,
      rule_set_selection: ruleSetSelection
    }, assignmentResolution);

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

    if (attendanceDayId) {
      await upsertAutoPolicyResolution(db, {
        attendance_day_id: attendanceDayId,
        company_id: companyId,
        profile_id: policyProfile.id,
        work_date: date,
        person_id: personId,
        effective
      });
    }

    const activeResolution = attendanceDayId
      ? await getActiveResolution(db, attendanceDayId)
      : null;

    let effectiveOutput = {
      status: effective.status,
      state: effective.state,
      source: effective.source,
      profile: effective.profile,
      reasons: effective.reasons
    };

    if (activeResolution && activeResolution.action !== 'AUTO_POLICY') {
      const resolutionPayload = {
        id: activeResolution.id,
        decided_by: activeResolution.decided_by,
        decided_at: activeResolution.decided_at,
        action: activeResolution.action,
        effective_status: activeResolution.effective_status,
        override: activeResolution.override,
        reason_code: activeResolution.reason_code,
        note: activeResolution.note
      };
      const reasons = Array.isArray(effectiveOutput.reasons)
        ? [...effectiveOutput.reasons]
        : [];
      if (activeResolution.reason_code && !reasons.includes(activeResolution.reason_code)) {
        reasons.push(activeResolution.reason_code);
      }

      effectiveOutput = {
        ...effectiveOutput,
        status: activeResolution.effective_status,
        state: 'APPROVED',
        source: 'MANUAL_RESOLUTION',
        reasons,
        resolution: resolutionPayload
      };
    }

    const display = await getEmployeeDisplay(db, companyId, personId);

    const record = {
      system_version: SYSTEM_VERSION,
      contract: ATTENDANCE_OUTPUT_CONTRACT,
      engine_contract: ENGINE_CONTRACT,
      engine_version: ENGINE_VERSION,
      employee: employee.employee_code,
      ...computedResult,
      explanation: computedExplanation,
      source: computedSource
    };

    record.attendance_day_id = attendanceDayId;
    record.computed = computed;
    record.effective = effectiveOutput;
    if (display) {
      record.employee_code = display.employee_code;
      record.full_name = display.full_name;
    }

    res.json(finalizeRecords([record], cacheMeta, date, companyConfig, windowMeta));

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'attendance computation failed' });
  }
});

module.exports = router;
