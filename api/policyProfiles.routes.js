const express = require('express');
const router = express.Router();

const db = require('../db');
const {
  listPolicyProfiles,
  createPolicyProfile
} = require('../services/policy/policyProfileProvider');
const { requireApiKey, requireRole, enforceCompanyScope } = require('./lib/auth');
const { sendError } = require('./lib/errorEnvelope');

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

function sendInternalError(res) {
  return sendError(res, {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Server error'
  });
}

router.get('/', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const companyId = req.ctx && req.ctx.company_id
      ? req.ctx.company_id
      : (isNonEmptyString(req.query.company_id)
        ? req.query.company_id.trim()
        : 'DEFAULT');
    const rows = await listPolicyProfiles(db, companyId);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

router.post('/', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const { company_id, name, params } = req.body || {};
    const authCompanyId = req.ctx && req.ctx.company_id ? req.ctx.company_id : null;
    const effectiveCompanyId = authCompanyId || (isNonEmptyString(company_id) ? company_id.trim() : '');

    if (!isNonEmptyString(effectiveCompanyId)) {
      return sendValidationError(res, 'company_id_required', 'company_id is required');
    }
    if (!isNonEmptyString(name)) {
      return sendValidationError(res, 'name_required', 'name is required');
    }
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      return sendValidationError(res, 'params_invalid', 'params must be an object');
    }

    const result = await createPolicyProfile(db, {
      company_id: effectiveCompanyId,
      name: name.trim(),
      params: params || {}
    });

    return res.status(201).json(result);
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

module.exports = router;
