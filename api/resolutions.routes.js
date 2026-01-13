const express = require('express');
const router = express.Router();

const db = require('../db');
const {
  createManualResolution,
  listResolutions
} = require('../services/policy/manualResolutionService');

const ALLOWED_EFFECTIVE_STATUSES = new Set([
  'PRESENT',
  'ABSENT',
  'INCOMPLETE',
  'INVALID',
  'NEEDS_REVIEW',
  'ON_LEAVE',
  'NON_WORKING_DAY',
  'EXCUSED',
  'MANUAL_ADJUSTED'
]);

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime());
}

function isValidUuid(value) {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

router.post('/attendance/:attendance_day_id/resolutions', async (req, res) => {
  const attendanceDayId = req.params.attendance_day_id;
  if (!isValidUuid(attendanceDayId)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'attendance_day_id must be a UUID' });
  }

  const {
    company_id,
    decided_by,
    effective_status,
    reason_code,
    note,
    override,
    action
  } = req.body || {};

  if (!decided_by || String(decided_by).trim().length === 0) {
    return res.status(400).json({ error: 'invalid_request', detail: 'decided_by is required' });
  }

  if (!effective_status || !ALLOWED_EFFECTIVE_STATUSES.has(effective_status)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'effective_status not allowed' });
  }

  try {
    const row = await createManualResolution(db, {
      attendance_day_id: attendanceDayId,
      company_id: company_id || 'DEFAULT',
      decided_by: String(decided_by).trim(),
      action: action || 'MANUAL_RESOLUTION',
      effective_status,
      reason_code,
      note,
      override
    });

    return res.status(201).json(row);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'resolution_create_failed' });
  }
});

router.get('/attendance/:attendance_day_id/resolutions', async (req, res) => {
  const attendanceDayId = req.params.attendance_day_id;
  if (!isValidUuid(attendanceDayId)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'attendance_day_id must be a UUID' });
  }

  try {
    const rows = await listResolutions(db, attendanceDayId);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'resolution_list_failed' });
  }
});

router.get('/attendance/review-queue', async (req, res) => {
  const dateFrom = req.query.date_from;
  const dateTo = req.query.date_to;
  const companyId = req.query.company_id || 'DEFAULT';

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'invalid_request', detail: 'date_from and date_to are required' });
  }
  if (!isValidDateString(dateFrom) || !isValidDateString(dateTo)) {
    return res.status(400).json({ error: 'invalid_request', detail: 'date must be YYYY-MM-DD' });
  }

  try {
    const resRows = await db.query(`
      SELECT
        adr.attendance_day_id,
        ad.person_id,
        ad.work_date,
        ad.status AS computed_status,
        adr.effective_status,
        adr.decided_at,
        adr.decided_by
      FROM attendance_day_resolutions adr
      JOIN attendance_days ad ON ad.id = adr.attendance_day_id
      WHERE adr.is_active = true
        AND adr.effective_status = 'NEEDS_REVIEW'
        AND adr.company_id = $1
        AND ad.work_date BETWEEN $2 AND $3
      ORDER BY ad.work_date DESC
    `, [companyId, dateFrom, dateTo]);

    return res.json(resRows.rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'review_queue_failed' });
  }
});

module.exports = router;
