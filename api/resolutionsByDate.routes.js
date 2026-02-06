const express = require('express');
const router = express.Router();

const db = require('../db');
const {
  createManualResolution,
  listResolutions
} = require('../services/policy/manualResolutionService');
const { emitAuditEvent } = require('../services/auditLogger');
const { requireApiKey, requireRole, enforceCompanyScope } = require('./lib/auth');
const { sendError } = require('./lib/errorEnvelope');

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime());
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

function sendNotFound(res, detail) {
  return sendError(res, {
    status: 404,
    code: 'LOOKUP_NOT_FOUND',
    message: 'Attendance day not found',
    details: {
      kind: 'lookup_error',
      error: 'attendance_day_not_found',
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

router.post('/', requireApiKey, enforceCompanyScope, requireRole('operator'), async (req, res) => {
  const {
    company_id,
    person_id,
    date,
    decided_by,
    effective_status,
    reason_code,
    note,
    override
  } = req.body || {};
  const effectiveCompanyId = (req.ctx && req.ctx.company_id)
    ? req.ctx.company_id
    : (company_id || '');

  if (!isNonEmptyString(effectiveCompanyId)) {
    return sendValidationError(res, 'company_id_required', 'company_id is required');
  }
  if (!isNonEmptyString(person_id)) {
    return sendValidationError(res, 'person_id_required', 'person_id is required');
  }
  if (!isNonEmptyString(decided_by)) {
    return sendValidationError(res, 'decided_by_required', 'decided_by is required');
  }
  if (!isNonEmptyString(effective_status)) {
    return sendValidationError(res, 'effective_status_required', 'effective_status is required');
  }
  if (!isValidDateString(date)) {
    return sendValidationError(res, 'date_invalid', 'date must be YYYY-MM-DD');
  }
  if (override !== undefined && (override === null || typeof override !== 'object' || Array.isArray(override))) {
    return sendValidationError(res, 'override_invalid', 'override must be an object');
  }

  try {
    const attendanceDayRes = await db.query(`
      SELECT id
      FROM attendance_days
      WHERE company_id = $1 AND person_id = $2 AND work_date = $3
      LIMIT 1
    `, [effectiveCompanyId.trim(), person_id.trim(), date]);

    if (attendanceDayRes.rows.length === 0) {
      return sendNotFound(res, 'Call /api/attendance first to compute the day.');
    }

    const row = await createManualResolution(db, {
      attendance_day_id: attendanceDayRes.rows[0].id,
      company_id: effectiveCompanyId.trim(),
      decided_by: decided_by.trim(),
      action: 'OVERRIDE_EFFECTIVE',
      effective_status: effective_status.trim(),
      reason_code,
      note,
      override: override || {}
    });

    emitAuditEvent({
      actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
      company_id: effectiveCompanyId.trim(),
      role: req.ctx ? req.ctx.role : null,
      action: 'resolutions.manual.create',
      target: req.originalUrl || req.path,
      metadata: {
        attendance_day_id: attendanceDayRes.rows[0].id,
        person_id: person_id.trim(),
        effective_status: effective_status.trim(),
        action: 'OVERRIDE_EFFECTIVE'
      }
    });
    return res.status(201).json({ value: row });
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

router.get('/', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  const companyId = (req.ctx && req.ctx.company_id)
    ? req.ctx.company_id
    : (isNonEmptyString(req.query.company_id)
      ? req.query.company_id.trim()
      : 'DEFAULT');
  const personId = req.query.person_id;
  const date = req.query.date;

  if (!isNonEmptyString(personId)) {
    return sendValidationError(res, 'person_id_required', 'person_id is required');
  }
  if (!isValidDateString(date)) {
    return sendValidationError(res, 'date_invalid', 'date must be YYYY-MM-DD');
  }

  try {
    const attendanceDayRes = await db.query(`
      SELECT id
      FROM attendance_days
      WHERE company_id = $1 AND person_id = $2 AND work_date = $3
      LIMIT 1
    `, [companyId, personId.trim(), date]);

    if (attendanceDayRes.rows.length === 0) {
      return sendNotFound(res, 'Call /api/attendance first to compute the day.');
    }

    const rows = await listResolutions(db, attendanceDayRes.rows[0].id);
    return res.json({ value: rows });
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

module.exports = router;
