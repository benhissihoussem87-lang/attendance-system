const express = require('express');
const router = express.Router();

const db = require('../db');
const { toBool } = require('../services/envBool');

async function getColumnSet(tableName) {
  const res = await db.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    `,
    [tableName]
  );
  return new Set(res.rows.map(row => row.column_name));
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime());
}

router.post('/reset', async (req, res) => {
  if (!toBool(process.env.ALLOW_TEST_ENDPOINTS)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const {
    company_id,
    company_timezone,
    night_shift_enabled,
    day_start_time,
    person_id,
    date,
    events = []
  } = req.body || {};

  const companyId = company_id || 'DEFAULT';
  const safeCompanyTimezone = company_timezone || 'Africa/Tunis';
  const safeNightShiftEnabled = typeof night_shift_enabled === 'boolean' ? night_shift_enabled : false;
  const safeDayStartTime = day_start_time || '04:00';

  const baseDate = new Date(`${date}T00:00:00.000Z`);
  const baseWeekday = baseDate.getUTCDay();
  const dateMinus1 = new Date(baseDate);
  dateMinus1.setUTCDate(dateMinus1.getUTCDate() - 1);
  const datePlus1 = new Date(baseDate);
  datePlus1.setUTCDate(datePlus1.getUTCDate() + 1);
  const datePlus2 = new Date(baseDate);
  datePlus2.setUTCDate(datePlus2.getUTCDate() + 2);

  try {
    await db.query('BEGIN');

    const configCols = await getColumnSet('company_config');
    if (configCols.size > 0) {
      const tzCol = configCols.has('company_timezone')
        ? 'company_timezone'
        : (configCols.has('timezone') ? 'timezone' : null);
      const insertCols = ['company_id'];
      const insertValues = [companyId];
      const updates = [];

      if (tzCol) {
        insertCols.push(tzCol);
        insertValues.push(safeCompanyTimezone);
        updates.push(`${tzCol} = EXCLUDED.${tzCol}`);
      }
      if (configCols.has('night_shift_enabled')) {
        insertCols.push('night_shift_enabled');
        insertValues.push(safeNightShiftEnabled);
        updates.push('night_shift_enabled = EXCLUDED.night_shift_enabled');
      }
      if (configCols.has('day_start_time')) {
        insertCols.push('day_start_time');
        insertValues.push(safeDayStartTime);
        updates.push('day_start_time = EXCLUDED.day_start_time');
      }
      if (configCols.has('updated_at')) {
        updates.push('updated_at = NOW()');
      }

      const placeholders = insertCols.map((_, index) => `$${index + 1}`).join(', ');
      const updateSql = updates.length > 0
        ? `DO UPDATE SET ${updates.join(', ')}`
        : 'DO NOTHING';

      await db.query(
        `
        INSERT INTO company_config (${insertCols.join(', ')})
        VALUES (${placeholders})
        ON CONFLICT (company_id)
        ${updateSql}
        `,
        insertValues
      );
    }

    await db.query(
      `
      DELETE FROM device_events
      WHERE company_id = $1
        AND person_id = $2
        AND event_time_utc >= $3
        AND event_time_utc < $4
      `,
      [companyId, person_id, dateMinus1.toISOString(), datePlus2.toISOString()]
    );

    for (const event of events) {
      await db.query(
        `
        INSERT INTO device_events
          (company_id, person_id, event_time_utc, direction, vendor, device_uid, raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT ON CONSTRAINT device_events_dedup_company_uk DO NOTHING
        `,
        [
          companyId,
          person_id,
          event.event_time_utc,
          event.direction,
          event.vendor || null,
          event.device_uid && String(event.device_uid).trim()
            ? String(event.device_uid).trim()
            : 'TEST-DEVICE-1',
          event.raw_payload || {}
        ]
      );
    }

    await db.query(
      `
      DELETE FROM attendance_days
      WHERE company_id = $1
        AND person_id = $2
        AND work_date IN ($3, $4, $5)
      `,
      [companyId, person_id, dateMinus1.toISOString().slice(0, 10), date, datePlus1.toISOString().slice(0, 10)]
    );

    await db.query(
      `
      DELETE FROM employee_leaves
      WHERE company_id = $1
        AND person_id = $2
        AND start_date <= $3
        AND end_date >= $4
      `,
      [companyId, person_id, datePlus1.toISOString().slice(0, 10), dateMinus1.toISOString().slice(0, 10)]
    );

    const workingDaysCols = await getColumnSet('company_working_days');
    if (workingDaysCols.size > 0) {
      await db.query(
        `
        DELETE FROM company_working_days
        WHERE company_id = $1
        `,
        [companyId]
      );

      const dayCol = workingDaysCols.has('day_of_week') ? 'day_of_week' : (
        workingDaysCols.has('weekday') ? 'weekday' : null
      );
      const workingCol = workingDaysCols.has('is_working_day') ? 'is_working_day' : (
        workingDaysCols.has('is_working') ? 'is_working' : null
      );

      if (dayCol && workingCol && Array.isArray(req.body.working_days)) {
        for (const entry of req.body.working_days) {
          const dayValue = Number.isInteger(entry?.day_of_week)
            ? entry.day_of_week
            : (Number.isInteger(entry?.weekday) ? entry.weekday : null);
          const isWorking = (entry && Object.prototype.hasOwnProperty.call(entry, 'is_working_day'))
            ? entry.is_working_day
            : entry?.is_working;
          if (!Number.isInteger(dayValue) || typeof isWorking !== 'boolean') {
            continue;
          }
          await db.query(
            `
            INSERT INTO company_working_days (company_id, ${dayCol}, ${workingCol})
            VALUES ($1, $2, $3)
            `,
            [companyId, dayValue, isWorking]
          );
        }
      }
    }

    await db.query('COMMIT');
    return res.json({ status: 'ok' });
  } catch (err) {
    console.error(err);
    try {
      await db.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('RESET FAILED:', rollbackErr);
    }
    res.status(500).json({
      error: 'reset failed',
      detail: err.message,
      code: err.code
    });
  }
});

router.post('/seed-leave', async (req, res) => {
  if (!toBool(process.env.ALLOW_TEST_ENDPOINTS)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const {
    company_id,
    person_id,
    date,
    leave_type,
    affects_attendance
  } = req.body || {};

  if (!person_id || typeof person_id !== 'string' || !person_id.trim()) {
    return res.status(400).json({ error: 'invalid_request', detail: 'person_id is required' });
  }

  if (!isValidDateString(date)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'date must be YYYY-MM-DD' });
  }

  const personId = person_id.trim();
  const leaveType = (typeof leave_type === 'string' && leave_type.trim())
    ? leave_type.trim()
    : 'TEST_LEAVE';
  const affects = (typeof affects_attendance === 'boolean') ? affects_attendance : true;
  const startDate = date;
  const endDate = date;

  try {
    await db.query('BEGIN');

    const companyId = company_id || 'DEFAULT';
    const leavesCols = await getColumnSet('employee_leaves');
    const hasCompanyId = leavesCols.has('company_id');
    const hasAffectsAttendance = leavesCols.has('affects_attendance');

    // Verification: tests\attendance\policy_always_computes.ps1 -> 42703 affects_attendance missing.
    if (hasCompanyId) {
      await db.query(
        `
        DELETE FROM employee_leaves
        WHERE company_id = $1
          AND person_id = $2
          AND $3::date BETWEEN start_date AND end_date
        `,
        [companyId, personId, date]
      );
    } else {
      await db.query(
        `
        DELETE FROM employee_leaves
        WHERE person_id = $1
          AND $2::date BETWEEN start_date AND end_date
        `,
        [personId, date]
      );
    }

    if (hasAffectsAttendance) {
      if (hasCompanyId) {
        await db.query(
          `
          INSERT INTO employee_leaves (company_id, person_id, start_date, end_date, leave_type, affects_attendance)
          VALUES ($1, $2, $3::date, $4::date, $5, $6)
          `,
          [companyId, personId, startDate, endDate, leaveType, affects]
        );
      } else {
        await db.query(
          `
          INSERT INTO employee_leaves (person_id, start_date, end_date, leave_type, affects_attendance)
          VALUES ($1, $2::date, $3::date, $4, $5)
          `,
          [personId, startDate, endDate, leaveType, affects]
        );
      }
    } else if (hasCompanyId) {
      await db.query(
        `
        INSERT INTO employee_leaves (company_id, person_id, start_date, end_date, leave_type)
        VALUES ($1, $2, $3::date, $4::date, $5)
        `,
        [companyId, personId, startDate, endDate, leaveType]
      );
    } else {
      await db.query(
        `
        INSERT INTO employee_leaves (person_id, start_date, end_date, leave_type)
        VALUES ($1, $2::date, $3::date, $4)
        `,
        [personId, startDate, endDate, leaveType]
      );
    }

    await db.query('COMMIT');
    return res.json({
      status: 'ok',
      company_id: companyId,
      person_id: personId,
      start_date: startDate,
      end_date: endDate,
      leave_type: leaveType,
      affects_attendance: affects
    });
  } catch (err) {
    console.error(err);
    try {
      await db.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('SEED LEAVE FAILED:', rollbackErr);
    }
    return res.status(500).json({
      error: 'seed_leave_failed',
      code: err.code,
      detail: err.message
    });
  }
});

router.post('/seed-nonworking', async (req, res) => {
  if (!toBool(process.env.ALLOW_TEST_ENDPOINTS)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const {
    company_id,
    date
  } = req.body || {};

  const companyId = company_id || 'DEFAULT';
  if (!isValidDateString(date)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'date must be YYYY-MM-DD' });
  }

  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();

  try {
    await db.query('BEGIN');

    const workingDaysCols = await getColumnSet('company_working_days');
    const dayCol = workingDaysCols.has('day_of_week') ? 'day_of_week' : (
      workingDaysCols.has('weekday') ? 'weekday' : null
    );
    const workingCol = workingDaysCols.has('is_working_day') ? 'is_working_day' : (
      workingDaysCols.has('is_working') ? 'is_working' : null
    );

    if (!dayCol || !workingCol) {
      throw new Error('company_working_days schema mismatch');
    }

    await db.query(
      `
      DELETE FROM company_working_days
      WHERE company_id = $1 AND ${dayCol} = $2
      `,
      [companyId, weekday]
    );

    await db.query(
      `
      INSERT INTO company_working_days (company_id, ${dayCol}, ${workingCol})
      VALUES ($1,$2,false)
      `,
      [companyId, weekday]
    );

    await db.query('COMMIT');
    return res.json({
      status: 'ok',
      company_id: companyId,
      date,
      weekday,
      is_working: false
    });
  } catch (err) {
    console.error(err);
    try {
      await db.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('SEED NONWORKING FAILED:', rollbackErr);
    }
    return res.status(500).json({ error: 'seed_nonworking_failed' });
  }
});

router.get('/attendance-days/count', async (req, res) => {
  if (!toBool(process.env.ALLOW_TEST_ENDPOINTS)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const companyId = req.query.company_id || 'DEFAULT';
  const personId = req.query.person_id;
  const workDate = req.query.work_date;

  if (!personId || typeof personId !== 'string') {
    return res.status(400).json({ error: 'invalid_request', detail: 'person_id is required' });
  }
  if (!isValidDateString(workDate)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'work_date must be YYYY-MM-DD' });
  }

  try {
    const result = await db.query(`
      SELECT COUNT(*)::int AS n
      FROM attendance_days
      WHERE company_id = $1 AND person_id = $2 AND work_date = $3
    `, [companyId, personId, workDate]);
    return res.json({ count: result.rows[0].n });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'attendance_days_count_failed' });
  }
});

router.get('/mode', (req, res) => {
  if (!toBool(process.env.ALLOW_TEST_ENDPOINTS)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const policy = (process.env.IDENTITY_MAPPING_POLICY || 'all').trim().toLowerCase();

  return res.json({
    allow_test_endpoints: toBool(process.env.ALLOW_TEST_ENDPOINTS),
    use_identity_mappings: toBool(process.env.USE_IDENTITY_MAPPINGS),
    require_identity_mappings: toBool(process.env.REQUIRE_IDENTITY_MAPPINGS),
    identity_mapping_policy: policy,
    use_employees_registry: toBool(process.env.USE_EMPLOYEES_REGISTRY),
    use_employee_assignments: toBool(process.env.USE_EMPLOYEE_ASSIGNMENTS)
  });
});

router.post('/seed-ruleset', async (req, res) => {
  if (!toBool(process.env.ALLOW_TEST_ENDPOINTS)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const {
    name,
    version,
    rules = []
  } = req.body || {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'invalid_request', detail: 'name is required' });
  }
  if (!Number.isInteger(version)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'version must be an integer' });
  }
  if (!Array.isArray(rules)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'rules must be an array' });
  }

  try {
    await db.query('BEGIN');

    const existing = await db.query(`
      SELECT id
      FROM rule_sets
      WHERE name = $1 AND version = $2
      LIMIT 1
    `, [name, version]);

    let ruleSetId = null;
    if (existing.rows.length > 0) {
      ruleSetId = existing.rows[0].id;
      await db.query('DELETE FROM rules WHERE rule_set_id = $1', [ruleSetId]);
    } else {
      const inserted = await db.query(`
        INSERT INTO rule_sets (name, version)
        VALUES ($1, $2)
        RETURNING id
      `, [name, version]);
      ruleSetId = inserted.rows[0].id;
    }

    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      if (!rule || !rule.type) {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: 'invalid_request', detail: 'rule.type is required' });
      }
      const { type, params, ...rest } = rule;
      const payload = params && typeof params === 'object' ? params : rest;
      await db.query(`
        INSERT INTO rules (rule_set_id, type, params, order_index)
        VALUES ($1,$2,$3::jsonb,$4)
      `, [ruleSetId, type, JSON.stringify(payload || {}), i]);
    }

    await db.query('COMMIT');
    return res.json({ rule_set_id: ruleSetId });
  } catch (err) {
    console.error(err);
    try {
      await db.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('SEED RULESET FAILED:', rollbackErr);
    }
    return res.status(500).json({ error: 'seed_ruleset_failed' });
  }
});

module.exports = router;
