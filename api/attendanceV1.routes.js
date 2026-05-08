const express = require('express');
const db = require('../db');
const { listDailyAttendanceV1 } = require('../services/attendanceV1Service');
const { requireApiKey, requireRole, enforceCompanyScope } = require('./lib/auth');
const { sendError } = require('./lib/errorEnvelope');

const router = express.Router();

function text(value) {
  return value == null ? '' : String(value);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isAdmin(req) {
  return req.ctx && req.ctx.role === 'admin';
}

function parseIncludeValidation(req) {
  const requested = ['1', 'true', 'yes', 'on'].includes(text(req.query.include_validation).trim().toLowerCase());
  return requested && isAdmin(req);
}

async function getCompanyTimezone(companyId) {
  const res = await db.query(`
    SELECT timezone
    FROM companies
    WHERE company_id = $1
    LIMIT 1
  `, [companyId]);
  return res.rows[0] && res.rows[0].timezone ? res.rows[0].timezone : 'UTC';
}

function validationError(res, detail) {
  return sendError(res, {
    status: 400,
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    details: {
      kind: 'validation',
      error: detail
    }
  });
}

router.get('/daily', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const companyId = req.ctx && req.ctx.company_id ? req.ctx.company_id : text(req.query.company_id || 'DEFAULT');
    const startDate = text(req.query.start_date || req.query.date || todayIso()).trim();
    const endDate = text(req.query.end_date || startDate).trim();
    const siteId = text(req.query.site_id).trim() || null;
    const personId = text(req.query.person_id).trim() || null;
    const includeValidationRequested = ['1', 'true', 'yes', 'on'].includes(text(req.query.include_validation).trim().toLowerCase());
    if (includeValidationRequested && !isAdmin(req)) {
      return sendError(res, {
        status: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
        details: {
          kind: 'authz',
          error: 'include_validation_requires_admin'
        },
        error: 'forbidden'
      });
    }

    const companyTimezone = await getCompanyTimezone(companyId);
    const result = await listDailyAttendanceV1(db, {
      companyId,
      startDate,
      endDate,
      siteId,
      personId,
      includeValidation: parseIncludeValidation(req),
      companyTimezone,
      limit: req.query.limit
    });
    return res.json(result);
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return validationError(res, err.detail || 'invalid_request');
    }
    if (err && err.code === 'not_found') {
      return sendError(res, {
        status: 404,
        code: 'NOT_FOUND',
        message: 'Not found',
        details: {
          kind: 'not_found',
          error: err.detail || 'not_found'
        },
        error: 'not_found'
      });
    }
    console.error('Attendance v1 daily failed:', err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

module.exports = router;
