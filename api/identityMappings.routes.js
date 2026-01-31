const express = require('express');
const router = express.Router();

const db = require('../db');
const {
  listIdentityMappings,
  getIdentityMapping,
  upsertIdentityMapping
} = require('../services/identityMappingsDb');
const { sendError } = require('./lib/errorEnvelope');

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function resolveCompanyId(req, body) {
  const bodyId = body && typeof body.company_id === 'string' ? body.company_id : null;
  const queryId = req.query && typeof req.query.company_id === 'string' ? req.query.company_id : null;
  const headerId = typeof req.get('x-company-id') === 'string' ? req.get('x-company-id') : null;

  if (bodyId && ((queryId && bodyId !== queryId) || (headerId && bodyId !== headerId))) {
    return { error: 'company_id mismatch' };
  }

  return { value: queryId || headerId || 'DEFAULT' };
}

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 50;
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

function parseActive(value) {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return null;
}

router.get('/', async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;

    const provider = typeof req.query.provider === 'string' && req.query.provider.length > 0
      ? req.query.provider.trim()
      : null;
    const identifierType = typeof req.query.identifier_type === 'string' && req.query.identifier_type.length > 0
      ? req.query.identifier_type.trim()
      : null;
    const identifierValue = typeof req.query.identifier_value === 'string' && req.query.identifier_value.length > 0
      ? req.query.identifier_value.trim()
      : null;
    const personId = typeof req.query.person_id === 'string' && req.query.person_id.length > 0
      ? req.query.person_id.trim()
      : null;
    const active = typeof req.query.active === 'string' ? parseActive(req.query.active) : null;

    const rows = await listIdentityMappings(db, {
      companyId,
      provider,
      identifierType,
      identifierValue,
      personId,
      active,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });

    return res.json(rows);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/lookup', async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;

    const provider = typeof req.query.provider === 'string' ? req.query.provider.trim() : '';
    const identifierType = typeof req.query.identifier_type === 'string' ? req.query.identifier_type.trim() : '';
    const identifierValue = typeof req.query.identifier_value === 'string' ? req.query.identifier_value.trim() : '';

    if (!provider || !identifierType || !identifierValue) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'provider, identifier_type, identifier_value are required'
        }
      });
    }

    const mapping = await getIdentityMapping(db, companyId, provider, identifierType, identifierValue);
    if (!mapping || mapping.active === false) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Identity mapping not found',
        details: {
          kind: 'lookup_error',
          error: 'identity_mapping_not_found'
        }
      });
    }

    return res.json({
      company_id: mapping.company_id,
      provider: mapping.provider,
      identifier_type: mapping.identifier_type,
      identifier_value: mapping.identifier_value,
      person_id: mapping.person_id
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

router.put('/', async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: resolved.error
        }
      });
    }
    const companyId = resolved.value;

    if (Object.prototype.hasOwnProperty.call(body, 'metadata') && !isPlainObject(body.metadata)) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'metadata must be an object'
        }
      });
    }

    if (Object.prototype.hasOwnProperty.call(body, 'active')
      && body.active !== null
      && typeof body.active !== 'boolean') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'active must be boolean'
        }
      });
    }

    const saved = await upsertIdentityMapping(db, companyId, body);
    return res.json(saved);
  } catch (err) {
    if (err && err.code === 'employee_not_found') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'employee_not_found',
          detail: 'The specified person_id does not exist'
        }
      });
    }
    if (err && err.code === 'conflict_mapped_to_other_person') {
      return sendError(res, {
        status: 409,
        code: 'CONFLICT',
        message: 'Identity mapping conflict',
        details: {
          kind: 'conflict',
          error: 'identifier_already_mapped',
          detail: 'This identifier is already mapped to a different person',
          existing_person_id: err.existing_person_id
        }
      });
    }
    if (err && err.code === 'invalid_request') {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: err.detail
        }
      });
    }
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

module.exports = router;
