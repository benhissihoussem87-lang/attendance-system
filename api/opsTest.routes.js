const express = require('express');
const router = express.Router();

const db = require('../db');

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
          event.device_uid ?? '',
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

module.exports = router;
