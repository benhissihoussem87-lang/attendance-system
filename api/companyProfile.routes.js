const express = require('express');
const router = express.Router();

const db = require('../db');
const { sendError } = require('./lib/errorEnvelope');
const {
  getCompanyProfile,
  upsertCompanyProfile
} = require('../services/companyProfileDb');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function resolveCompanyId(req, body) {
  const bodyId = body && typeof body.company_id === 'string' ? body.company_id : null;
  const queryId = req.query && typeof req.query.company_id === 'string' ? req.query.company_id : null;
  const headerId = typeof req.get('x-company-id') === 'string' ? req.get('x-company-id') : null;

  if (queryId && headerId && queryId !== headerId) {
    return { error: 'company_id mismatch between query and header' };
  }
  if (bodyId && queryId && bodyId !== queryId) {
    return { error: 'company_id mismatch between body and query' };
  }
  if (bodyId && headerId && bodyId !== headerId) {
    return { error: 'company_id mismatch between body and header' };
  }

  return { value: bodyId || queryId || headerId || 'DEFAULT' };
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

function sendNotFound(res) {
  return sendError(res, {
    status: 404,
    code: 'LOOKUP_NOT_FOUND',
    message: 'Company profile not found',
    details: {
      kind: 'lookup_error',
      error: 'company_profile_not_found'
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

router.get('/', async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendValidationError(res, 'company_id_mismatch', resolved.error);
    }
    const companyId = resolved.value;
    const profile = await getCompanyProfile(db, companyId);
    if (!profile) {
      return sendNotFound(res);
    }
    return res.json(profile);
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

router.put('/', async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, req.body || {});
    if (resolved.error) {
      return sendValidationError(res, 'company_id_mismatch', resolved.error);
    }
    const companyId = resolved.value;
    const metadata = req.body ? req.body.metadata : undefined;
    if (!isPlainObject(metadata)) {
      return sendValidationError(res, 'metadata_invalid', 'metadata must be an object');
    }

    const exists = await db.query(`
      SELECT 1
      FROM companies
      WHERE company_id = $1
    `, [companyId]);
    if (exists.rows.length === 0) {
      return sendValidationError(res, 'company_id_not_found', 'company_id not found');
    }

    const saved = await upsertCompanyProfile(db, companyId, metadata);
    return res.json(saved);
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

module.exports = router;
