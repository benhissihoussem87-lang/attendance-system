const express = require('express');
const router = express.Router();

const db = require('../db');
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

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(parsed.getTime());
}

function isValidUuid(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(value);
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

function sendConflictError(res, error, detail) {
  return sendError(res, {
    status: 409,
    code: 'CONFLICT',
    message: 'Conflict',
    details: {
      kind: 'conflict',
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

router.get('/', async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return sendValidationError(res, 'company_id_mismatch', resolved.error);
    }
    const companyId = resolved.value;
    const personId = typeof req.query.person_id === 'string' && req.query.person_id.trim()
      ? req.query.person_id.trim()
      : null;
    const limit = parseLimit(req.query.limit);
    const offset = parseOffset(req.query.offset);

    const params = [companyId];
    const whereParts = ['company_id = $1'];
    if (personId) {
      params.push(personId);
      whereParts.push(`person_id = $${params.length}`);
    }
    params.push(limit);
    params.push(offset);

    const result = await db.query(`
      SELECT company_id, person_id, rule_set_id, valid_from, valid_to, metadata, created_at
      FROM employee_assignments
      WHERE ${whereParts.join(' AND ')}
      ORDER BY person_id ASC, valid_from DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `, params);

    return res.json(result.rows);
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

router.put('/', async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return sendValidationError(res, 'company_id_mismatch', resolved.error);
    }
    const companyId = resolved.value;

    const personId = typeof body.person_id === 'string' ? body.person_id.trim() : '';
    const ruleSetId = typeof body.rule_set_id === 'string' ? body.rule_set_id.trim() : '';
    const validFrom = typeof body.valid_from === 'string' ? body.valid_from.trim() : '';
    const validTo = typeof body.valid_to === 'string' ? body.valid_to.trim() : null;

    if (!personId) {
      return sendValidationError(res, 'person_id_required', 'person_id is required');
    }
    if (!ruleSetId || !isValidUuid(ruleSetId)) {
      return sendValidationError(res, 'rule_set_id_invalid', 'rule_set_id must be a valid UUID');
    }
    if (!validFrom || !isValidDateString(validFrom)) {
      return sendValidationError(res, 'valid_from_invalid', 'valid_from must be YYYY-MM-DD');
    }
    if (validTo && !isValidDateString(validTo)) {
      return sendValidationError(res, 'valid_to_invalid', 'valid_to must be YYYY-MM-DD');
    }
    if (validTo && new Date(validTo) < new Date(validFrom)) {
      return sendValidationError(res, 'valid_to_range_invalid', 'valid_to must be >= valid_from');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'metadata') && !isPlainObject(body.metadata)) {
      return sendValidationError(res, 'metadata_invalid', 'metadata must be an object');
    }

    const overlap = await db.query(`
      SELECT 1
      FROM employee_assignments
      WHERE company_id = $1
        AND person_id = $2
        AND valid_from <> $3::date
        AND NOT (
          (valid_to IS NOT NULL AND valid_to < $3::date)
          OR ($4::date IS NOT NULL AND valid_from > $4::date)
        )
      LIMIT 1
    `, [companyId, personId, validFrom, validTo]);

    if (overlap.rows.length > 0) {
      return sendConflictError(
        res,
        'assignment_range_overlap',
        'assignment range overlaps existing assignment'
      );
    }

    const saved = await db.query(`
      INSERT INTO employee_assignments (
        company_id, person_id, rule_set_id, valid_from, valid_to, metadata
      )
      VALUES ($1, $2, $3, $4::date, $5::date, $6::jsonb)
      ON CONFLICT (company_id, person_id, valid_from) DO UPDATE
        SET rule_set_id = EXCLUDED.rule_set_id,
            valid_to = EXCLUDED.valid_to,
            metadata = EXCLUDED.metadata
      RETURNING company_id, person_id, rule_set_id, valid_from, valid_to, metadata, created_at
    `, [
      companyId,
      personId,
      ruleSetId,
      validFrom,
      validTo,
      JSON.stringify(body.metadata || {})
    ]);

    return res.json(saved.rows[0]);
  } catch (err) {
    console.error(err);
    return sendInternalError(res);
  }
});

module.exports = router;
