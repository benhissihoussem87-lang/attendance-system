const express = require('express');
const router = express.Router();

const db = require('../db');
const {
  listEmployees,
  getEmployee,
  upsertEmployee
} = require('../services/employeesDb');
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

function isValidUuid(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
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

    const personId = typeof req.query.person_id === 'string' && req.query.person_id.length > 0
      ? req.query.person_id
      : null;
    const employeeCode = typeof req.query.employee_code === 'string' && req.query.employee_code.length > 0
      ? req.query.employee_code
      : null;

    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const rows = await listEmployees(db, {
      companyId,
      personId,
      employeeCode,
      limit,
      offset
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

router.get('/:personId', async (req, res) => {
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
    const personId = req.params.personId;

    const employee = await getEmployee(db, companyId, personId);
    if (!employee) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Employee not found',
        details: {
          kind: 'lookup_error',
          error: 'employee_not_found'
        }
      });
    }

    return res.json(employee);
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.put('/:personId', async (req, res) => {
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
    const personId = req.params.personId;

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

    if (Object.prototype.hasOwnProperty.call(body, 'default_rule_set_id')
      && body.default_rule_set_id !== null
      && !isValidUuid(body.default_rule_set_id)) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'default_rule_set_id must be a valid UUID'
        }
      });
    }

    const exists = await db.query(`
      SELECT 1
      FROM companies
      WHERE company_id = $1
    `, [companyId]);
    if (exists.rows.length === 0) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'company_id_not_found',
          detail: 'company_id not found'
        }
      });
    }

    const saved = await upsertEmployee(db, companyId, personId, body);
    return res.json(saved);
  } catch (err) {
    if (err && err.code === '23505') {
      return sendError(res, {
        status: 409,
        code: 'CONFLICT',
        message: 'Conflict',
        details: {
          kind: 'conflict',
          error: 'employee_code_conflict',
          detail: 'employee_code already exists'
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
