const express = require('express');
const router = express.Router();

const db = require('../db');

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime());
}

router.post('/reset', async (req, res) => {
  if (process.env.ALLOW_TEST_ENDPOINTS !== 'true') {
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

    await db.query(
      `
      INSERT INTO company_config
        (company_id, company_timezone, night_shift_enabled, day_start_time)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (company_id)
      DO UPDATE SET
        company_timezone = EXCLUDED.company_timezone,
        night_shift_enabled = EXCLUDED.night_shift_enabled,
        day_start_time = EXCLUDED.day_start_time,
        updated_at = NOW()
      `,
      [company_id, safeCompanyTimezone, safeNightShiftEnabled, safeDayStartTime]
    );

    await db.query(
      `
      DELETE FROM device_events
      WHERE person_id = $1
        AND event_time_utc >= $2
        AND event_time_utc < $3
      `,
      [person_id, dateMinus1.toISOString(), datePlus2.toISOString()]
    );

    for (const event of events) {
      await db.query(
        `
        INSERT INTO device_events
          (person_id, event_time_utc, direction, vendor, device_uid, raw_payload)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT ON CONSTRAINT ux_device_events_dedup DO NOTHING
        `,
        [
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
      WHERE person_id = $1 AND work_date IN ($2, $3, $4)
      `,
      [person_id, dateMinus1.toISOString().slice(0, 10), date, datePlus1.toISOString().slice(0, 10)]
    );

    await db.query(
      `
      DELETE FROM employee_leaves
      WHERE person_id = $1
        AND start_date <= $2
        AND end_date >= $3
      `,
      [person_id, datePlus1.toISOString().slice(0, 10), dateMinus1.toISOString().slice(0, 10)]
    );

    await db.query(
      `
      DELETE FROM company_working_days
      WHERE company_id = $1 AND weekday = $2
      `,
      [company_id, baseWeekday]
    );

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
  if (process.env.ALLOW_TEST_ENDPOINTS !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }

  const {
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

  const leaveType = (typeof leave_type === 'string' && leave_type.trim())
    ? leave_type.trim()
    : 'TEST_LEAVE';
  const affects = (typeof affects_attendance === 'boolean') ? affects_attendance : true;
  const startDate = date;
  const endDate = date;

  try {
    await db.query('BEGIN');

    await db.query(
      `
      DELETE FROM employee_leaves
      WHERE person_id = $1 AND $2::date BETWEEN start_date AND end_date
      `,
      [person_id, date]
    );

    await db.query(
      `
      INSERT INTO employee_leaves (person_id, start_date, end_date, leave_type, affects_attendance)
      VALUES ($1, $2::date, $3::date, $4, $5)
      `,
      [person_id, startDate, endDate, leaveType, affects]
    );

    await db.query('COMMIT');
    return res.json({
      status: 'ok',
      person_id: person_id.trim(),
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
  if (process.env.ALLOW_TEST_ENDPOINTS !== 'true') {
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

    await db.query(
      `
      DELETE FROM company_working_days
      WHERE company_id = $1 AND weekday = $2
      `,
      [companyId, weekday]
    );

    await db.query(
      `
      INSERT INTO company_working_days (company_id, weekday, is_working)
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
  if (process.env.ALLOW_TEST_ENDPOINTS !== 'true') {
    return res.status(404).json({ error: 'Not found' });
  }

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
      WHERE person_id = $1 AND work_date = $2
    `, [personId, workDate]);
    return res.json({ count: result.rows[0].n });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'attendance_days_count_failed' });
  }
});

router.post('/seed-ruleset', async (req, res) => {
  if (process.env.ALLOW_TEST_ENDPOINTS !== 'true') {
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
