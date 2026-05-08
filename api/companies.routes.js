const express = require('express');
const router = express.Router();

const db = require('../db');
const { requireApiKey, requireRole, enforceCompanyScope } = require('./lib/auth');
const { sendError } = require('./lib/errorEnvelope');
const { listCompanies, createCompany } = require('../services/companiesDb');

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 100;
  }
  return Math.min(parsed, 200);
}

function parseOffset(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

router.get('/', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const scopedCompanyId = req.ctx && req.ctx.company_id
      ? req.ctx.company_id
      : (typeof req.query.company_id === 'string' ? req.query.company_id : null);
    const rows = await listCompanies(db, {
      companyId: scopedCompanyId,
      includeInactive: parseBool(req.query.include_inactive, false),
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    return res.json({
      value: rows,
      count: rows.length
    });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.post('/', requireApiKey, requireRole('admin'), async (req, res) => {
  try {
    const result = await createCompany(db, req.body || {});
    if (result.error) {
      const isConflict = result.error === 'company_already_exists';
      return sendError(res, {
        status: isConflict ? 409 : 400,
        code: isConflict ? 'CONFLICT' : 'VALIDATION_ERROR',
        message: isConflict ? 'Conflict' : 'Validation failed',
        details: {
          kind: isConflict ? 'conflict' : 'validation',
          error: result.error,
          ...(result.value ? { existing: result.value } : {})
        }
      });
    }
    return res.status(201).json(result.value);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

module.exports = router;
