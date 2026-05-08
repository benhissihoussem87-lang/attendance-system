const express = require('express');
const crypto = require('crypto');

const db = require('../db');
const { listEmployees, getEmployee, upsertEmployee } = require('../services/employeesDb');
const { listIdentityMappings, upsertIdentityMapping } = require('../services/identityMappingsDb');
const { emitAuditEvent } = require('../services/auditLogger');
const { requireApiKey, requireRole, enforceCompanyScope } = require('./lib/auth');
const { sendError } = require('./lib/errorEnvelope');

const router = express.Router();

function text(value) {
  return value == null ? '' : String(value);
}

function trim(value) {
  return text(value).trim();
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function parseLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 500);
}

function parseOffset(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return parsed;
}

function normalizeBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function resolveCompanyId(req, body) {
  if (req.ctx && req.ctx.company_id) {
    return { value: req.ctx.company_id };
  }
  const bodyId = body && typeof body.company_id === 'string' ? body.company_id : null;
  const queryId = req.query && typeof req.query.company_id === 'string' ? req.query.company_id : null;
  const headerId = typeof req.get('x-company-id') === 'string' ? req.get('x-company-id') : null;
  if (bodyId && ((queryId && bodyId !== queryId) || (headerId && bodyId !== headerId))) {
    return { error: 'company_id mismatch' };
  }
  return { value: queryId || headerId || 'DEFAULT' };
}

function validationError(res, detail, error = 'invalid_request') {
  return sendError(res, {
    status: 400,
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    details: { kind: 'validation', error, detail }
  });
}

function notFound(res, detail, error = 'employee_not_found') {
  return sendError(res, {
    status: 404,
    code: 'LOOKUP_NOT_FOUND',
    message: 'Not found',
    details: { kind: 'lookup_error', error, detail }
  });
}

function conflict(res, detail, extra = {}) {
  return sendError(res, {
    status: 409,
    code: 'CONFLICT',
    message: 'Conflict',
    details: { kind: 'conflict', error: extra.error || 'conflict', detail, ...extra }
  });
}

async function ensureCompanyExists(companyId) {
  const res = await db.query('SELECT 1 FROM companies WHERE company_id = $1 LIMIT 1', [companyId]);
  return res.rows.length > 0;
}

function buildPersonId(employeeCode) {
  const safeCode = trim(employeeCode).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'employee';
  return `emp_${safeCode}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeEmployeePayload(body, existing = null, options = {}) {
  const metadata = existing && isPlainObject(existing.metadata) ? { ...existing.metadata } : {};
  const incomingMetadata = isPlainObject(body.metadata) ? body.metadata : {};
  Object.assign(metadata, incomingMetadata);

  const firstName = Object.prototype.hasOwnProperty.call(body, 'first_name') ? trim(body.first_name) : trim(metadata.first_name);
  const lastName = Object.prototype.hasOwnProperty.call(body, 'last_name') ? trim(body.last_name) : trim(metadata.last_name);
  const siteId = Object.prototype.hasOwnProperty.call(body, 'site_id') ? trim(body.site_id) : trim(metadata.site_id);
  const jobTitle = Object.prototype.hasOwnProperty.call(body, 'job_title') ? trim(body.job_title) : trim(metadata.job_title || metadata.poste);
  const notes = Object.prototype.hasOwnProperty.call(body, 'notes') ? trim(body.notes) : trim(metadata.notes);

  const fullName = trim(body.full_name) || [firstName, lastName].filter(Boolean).join(' ').trim();
  const employeeCode = Object.prototype.hasOwnProperty.call(body, 'employee_code')
    ? trim(body.employee_code)
    : trim(existing && existing.employee_code);

  if (options.requireEmployeeCode && !employeeCode) {
    return { error: 'employee_code is required' };
  }
  if (!fullName) {
    return { error: 'full_name or first_name/last_name is required' };
  }

  metadata.first_name = firstName;
  metadata.last_name = lastName;
  metadata.site_id = siteId;
  metadata.job_title = jobTitle;
  metadata.notes = notes;
  metadata.employee_v1 = true;
  if (options.productManaged) {
    metadata.product_managed = true;
    metadata.source = metadata.source || 'product_ui';
  }

  return {
    value: {
      employee_code: employeeCode,
      full_name: fullName,
      active: normalizeBoolean(body.active, existing ? existing.active !== false : true),
      metadata
    }
  };
}

function serializeEmployee(row, mappings = []) {
  const metadata = isPlainObject(row.metadata) ? row.metadata : {};
  return {
    company_id: row.company_id,
    person_id: row.person_id,
    employee_code: row.employee_code,
    full_name: row.full_name,
    active: row.active !== false,
    metadata,
    first_name: trim(metadata.first_name),
    last_name: trim(metadata.last_name),
    site_id: trim(metadata.site_id),
    job_title: trim(metadata.job_title || metadata.poste),
    notes: trim(metadata.notes),
    device_mappings: mappings,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

async function mappingsByPerson(companyId, personIds) {
  if (!personIds.length) return new Map();
  const mappings = await listIdentityMappings(db, {
    companyId,
    provider: null,
    identifierType: null,
    identifierValue: null,
    personId: null,
    active: null,
    productSurface: true,
    limit: 1000,
    offset: 0
  });
  const wanted = new Set(personIds);
  const map = new Map();
  mappings.forEach(row => {
    if (!wanted.has(row.person_id)) return;
    if (!map.has(row.person_id)) map.set(row.person_id, []);
    map.get(row.person_id).push(row);
  });
  return map;
}

async function loadEmployeeWithMappings(companyId, personId) {
  const employee = await getEmployee(db, companyId, personId);
  if (!employee) return null;
  const mappings = await listIdentityMappings(db, {
    companyId,
    provider: null,
    identifierType: null,
    identifierValue: null,
    personId,
    active: null,
    limit: 500,
    offset: 0
  });
  return serializeEmployee(employee, mappings);
}

function audit(req, companyId, action, metadata) {
  emitAuditEvent({
    actor_key_id: req.ctx ? req.ctx.key_id_or_prefix : null,
    company_id: companyId,
    role: req.ctx ? req.ctx.role : null,
    action,
    target: req.originalUrl || req.path,
    metadata
  });
}

router.get('/employees', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) return validationError(res, resolved.error);
    const companyId = resolved.value;
    const includeLegacy = trim(req.query.include_legacy).toLowerCase() === 'true';
    const includeValidation = trim(req.query.include_validation).toLowerCase() === 'true';
    if (includeLegacy && (!req.ctx || req.ctx.role !== 'admin')) {
      return sendError(res, {
        status: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
        details: { kind: 'authz', error: 'admin_required_for_legacy_employees' },
        error: 'forbidden'
      });
    }
    if (includeValidation && (!req.ctx || req.ctx.role !== 'admin')) {
      return sendError(res, {
        status: 403,
        code: 'FORBIDDEN',
        message: 'Forbidden',
        details: { kind: 'authz', error: 'admin_required_for_validation_employees' },
        error: 'forbidden'
      });
    }
    const employees = await listEmployees(db, {
      companyId,
      personId: null,
      employeeCode: trim(req.query.employee_code) || null,
      productManagedOnly: !includeLegacy,
      includeValidation,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    const byPerson = await mappingsByPerson(companyId, employees.map(row => row.person_id));
    return res.json({
      rows: employees.map(row => serializeEmployee(row, byPerson.get(row.person_id) || []))
    });
  } catch (err) {
    console.error(err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.get('/employees/:personId', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) return validationError(res, resolved.error);
    const employee = await loadEmployeeWithMappings(resolved.value, req.params.personId);
    if (!employee) return notFound(res, 'Employee not found');
    return res.json(employee);
  } catch (err) {
    console.error(err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.post('/employees', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) return validationError(res, resolved.error);
    const companyId = resolved.value;
    if (!(await ensureCompanyExists(companyId))) return validationError(res, 'company_id not found', 'company_id_not_found');

    const normalized = normalizeEmployeePayload(body, null, { requireEmployeeCode: true, productManaged: true });
    if (normalized.error) return validationError(res, normalized.error);
    const personId = trim(body.person_id) || buildPersonId(normalized.value.employee_code);
    const existing = await getEmployee(db, companyId, personId);
    if (existing) return conflict(res, 'person_id already exists', { error: 'employee_already_exists' });

    const saved = await upsertEmployee(db, companyId, personId, normalized.value);
    audit(req, companyId, 'employee_management.employee.create', { person_id: saved.person_id, employee_code: saved.employee_code });
    const response = await loadEmployeeWithMappings(companyId, saved.person_id);
    return res.status(201).json(response);
  } catch (err) {
    if (err && err.code === '23505') return conflict(res, 'employee_code already exists', { error: 'employee_code_conflict' });
    console.error(err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.patch('/employees/:personId', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) return validationError(res, resolved.error);
    const companyId = resolved.value;
    const existing = await getEmployee(db, companyId, req.params.personId);
    if (!existing) return notFound(res, 'Employee not found');
    const normalized = normalizeEmployeePayload(body, existing, { requireEmployeeCode: true, productManaged: true });
    if (normalized.error) return validationError(res, normalized.error);
    const saved = await upsertEmployee(db, companyId, req.params.personId, normalized.value);
    audit(req, companyId, 'employee_management.employee.update', { person_id: saved.person_id, employee_code: saved.employee_code, active: saved.active });
    const response = await loadEmployeeWithMappings(companyId, saved.person_id);
    return res.json(response);
  } catch (err) {
    if (err && err.code === '23505') return conflict(res, 'employee_code already exists', { error: 'employee_code_conflict' });
    console.error(err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.post('/employees/:personId/deactivate', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, req.body || {});
    if (resolved.error) return validationError(res, resolved.error);
    const existing = await getEmployee(db, resolved.value, req.params.personId);
    if (!existing) return notFound(res, 'Employee not found');
    await upsertEmployee(db, resolved.value, req.params.personId, { active: false });
    audit(req, resolved.value, 'employee_management.employee.deactivate', { person_id: req.params.personId });
    return res.json(await loadEmployeeWithMappings(resolved.value, req.params.personId));
  } catch (err) {
    console.error(err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.post('/employees/:personId/reactivate', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, req.body || {});
    if (resolved.error) return validationError(res, resolved.error);
    const existing = await getEmployee(db, resolved.value, req.params.personId);
    if (!existing) return notFound(res, 'Employee not found');
    await upsertEmployee(db, resolved.value, req.params.personId, { active: true });
    audit(req, resolved.value, 'employee_management.employee.reactivate', { person_id: req.params.personId });
    return res.json(await loadEmployeeWithMappings(resolved.value, req.params.personId));
  } catch (err) {
    console.error(err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.get('/employees/:personId/device-mappings', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) return validationError(res, resolved.error);
    const employee = await getEmployee(db, resolved.value, req.params.personId);
    if (!employee) return notFound(res, 'Employee not found');
    const mappings = await listIdentityMappings(db, {
      companyId: resolved.value,
      provider: null,
      identifierType: null,
      identifierValue: null,
      personId: req.params.personId,
      active: null,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });
    return res.json({ rows: mappings });
  } catch (err) {
    console.error(err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.put('/employees/:personId/device-mappings', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) return validationError(res, resolved.error);
    const companyId = resolved.value;
    const employee = await getEmployee(db, companyId, req.params.personId);
    if (!employee) return notFound(res, 'Employee not found');
    if (employee.active === false) return conflict(res, 'Cannot map a device user to an inactive employee', { error: 'employee_inactive' });

    const provider = trim(body.provider) || 'zkteco';
    const identifierType = trim(body.identifier_type) || 'device_user_id';
    const identifierValue = trim(body.identifier_value || body.device_user_id);
    if (!identifierValue) return validationError(res, 'device user id is required');

    const metadata = isPlainObject(body.metadata) ? { ...body.metadata } : {};
    metadata.source = metadata.source || 'employee_management_v1';
    const saved = await upsertIdentityMapping(db, companyId, {
      provider,
      identifier_type: identifierType,
      identifier_value: identifierValue,
      person_id: req.params.personId,
      active: normalizeBoolean(body.active, true),
      metadata
    });
    audit(req, companyId, 'employee_management.device_mapping.upsert', {
      person_id: saved.person_id,
      provider: saved.provider,
      identifier_type: saved.identifier_type,
      identifier_value: saved.identifier_value,
      active: saved.active
    });
    return res.json(saved);
  } catch (err) {
    if (err && err.code === 'employee_not_found') return notFound(res, 'Employee not found');
    if (err && err.code === 'conflict_mapped_to_other_person') {
      return conflict(res, 'This device user id is already mapped to another employee', {
        error: 'identifier_already_mapped',
        existing_person_id: err.existing_person_id
      });
    }
    if (err && err.code === 'invalid_request') return validationError(res, err.detail || 'invalid request');
    console.error(err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

module.exports = router;
