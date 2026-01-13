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
const { deriveWorkDate } = require('../services/dayBoundary');
const { getUtcWindowForWorkDate } = require('../services/dayBoundaryWindow');
const { getCompanyConfig } = require('../services/companyConfigProvider');
const {
  buildComputationSignature,
  isSignatureCompatible
} = require('../services/cacheSignature');
const {
  ENGINE_VERSION,
  ENGINE_CONTRACT,
  ATTENDANCE_OUTPUT_CONTRACT,
  SYSTEM_VERSION
} = require('../contracts/systemContracts');

const ENABLE_DAY_BOUNDARY_DEBUG = process.env.ENABLE_DAY_BOUNDARY_DEBUG === 'true';
const ENABLE_CACHE_DIAGNOSTIC = process.env.ENABLE_CACHE_DIAGNOSTIC === 'true';
const USE_DERIVED_WORK_DATE = process.env.USE_DERIVED_WORK_DATE === 'true';

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

function buildComputedPayload(data, signature) {
  return {
    status: data.status,
    flags: Array.isArray(data.flags) ? data.flags : [],
    metrics: {
      worked_minutes: data.worked_minutes ?? null,
      late_minutes: data.late_minutes ?? null,
      break_minutes: data.break_minutes ?? null,
      net_worked_minutes: data.net_worked_minutes ?? null
    },
    audit: {
      explanation: data.explanation,
      computation_context: signature
    }
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
    const companyId = employee.company_id || 'DEFAULT';
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
    const onLeave = await isOnLeave(db, personId, date);

    let computedResult = null;
    let computedSource = null;
    let computedExplanation = null;
    let attendanceDayId = null;

    // 1: Try DB cache
    const cached = await db.query(`
      SELECT
        id,
        status,
        first_in_utc AS first_in,
        last_out_utc AS last_out,
        worked_minutes,
        late_minutes,
        explanation
      FROM attendance_days
      WHERE person_id = $1 AND work_date = $2
    `, [personId, date]);

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
        if (process.env.ALLOW_TEST_ENDPOINTS === 'true') {
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
        attendanceDayId = cachedId;
        computedExplanation = explanationOut;
        computedResult = {
          ...cachedData,
          explanation: explanationOut
        };
        computedSource = 'db';
      }
    }

    if (ENABLE_CACHE_DIAGNOSTIC && cached.rows.length > 0) {
      console.log('[cache] FALLTHROUGH: cache row exists but not used');
    }

    if (!computedResult) {
      // 2: Load facts from device_events
      const eventsRes = await db.query(`
        SELECT person_id, event_time_utc, direction
        FROM device_events
        WHERE person_id = $1
          AND event_time_utc >= $2
          AND event_time_utc < $3
        ORDER BY event_time_utc
      `, [personId, windowStartUtc, windowEndUtc]);

      const dayEvents = eventsRes.rows.map(e => ({
        person_id: e.person_id,
        event_time: e.event_time_utc,
        direction: e.direction
      }));

      // 3: Compute with engine (IMPORTANT: before any use of result)
      const result = engine.computeDay({
        person: employee,
        date,
        events: dayEvents,
        ruleSet: ruleSets[employee.rule_set_id]
      });

      computedResult = result;
      computedSource = 'engine';
      computedExplanation = result.explanation;

      // 4: Save result to DB
      const explanationPayload = {
        explanation: result.explanation,
        computation_context: signature
      };
      const inserted = await db.query(`
        INSERT INTO attendance_days
          (person_id, work_date, status, first_in_utc, last_out_utc,
           worked_minutes, late_minutes, explanation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (person_id, work_date)
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
        personId,
        date,
        result.status,
        result.first_in,
        result.last_out,
        result.worked_minutes,
        result.late_minutes,
        JSON.stringify(explanationPayload)
      ]);

      attendanceDayId = inserted.rows[0].id;
    }

    const computed = buildComputedPayload({
      status: computedResult.status,
      flags: computedResult.flags,
      worked_minutes: computedResult.worked_minutes,
      late_minutes: computedResult.late_minutes,
      break_minutes: computedResult.break_minutes,
      net_worked_minutes: computedResult.net_worked_minutes,
      explanation: computedExplanation
    }, signature);

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
        source: 'policy'
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
        source: 'policy'
      };
    } else {
      record = {
        system_version: SYSTEM_VERSION,
        contract: ATTENDANCE_OUTPUT_CONTRACT,
        engine_contract: ENGINE_CONTRACT,
        engine_version: ENGINE_VERSION,
        employee: employee.employee_code,
        ...computedResult,
        explanation: computedExplanation,
        source: computedSource
      };
    }

    record.computed = computed;
    record.effective = {
      status: effective.status,
      state: effective.state,
      source: effective.source,
      profile: effective.profile,
      reasons: effective.reasons
    };

    res.json(finalizeRecords([record], cacheMeta, date, companyConfig, windowMeta));

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'attendance computation failed' });
  }
});

module.exports = router;
