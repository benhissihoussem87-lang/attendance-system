const express = require('express');
const router = express.Router();

const db = require('../db');
const {
  listDevices,
  getDevice,
  upsertDevice
} = require('../services/devicesDb');
const { attachManageabilityView } = require('../services/deviceManageability');
const { sendError } = require('./lib/errorEnvelope');
const { requireApiKey, requireRole, enforceCompanyScope } = require('./lib/auth');

function resolveCompanyId(req, body) {
  const bodyId = body && typeof body.company_id === 'string' ? body.company_id : null;
  const queryId = req.query && typeof req.query.company_id === 'string' ? req.query.company_id : null;
  const headerId = typeof req.get('x-company-id') === 'string' ? req.get('x-company-id') : null;

  if (bodyId && ((queryId && bodyId !== queryId) || (headerId && bodyId !== headerId))) {
    return { error: 'company_id mismatch' };
  }

  if (req.ctx && req.ctx.company_id) {
    return { value: req.ctx.company_id };
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

function parseBooleanFlag(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function isUuid(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

router.get('/', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
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
    const deviceUid = typeof req.query.device_uid === 'string' && req.query.device_uid.length > 0
      ? req.query.device_uid.trim()
      : null;
    const siteId = typeof req.query.site_id === 'string' && req.query.site_id.length > 0
      ? req.query.site_id.trim()
      : null;
    if (siteId && !isUuid(siteId)) {
      return sendError(res, {
        status: 400,
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details: {
          kind: 'validation',
          error: 'invalid_request',
          detail: 'site_id must be a valid UUID'
        }
      });
    }
    const managedStatus = typeof req.query.managed_status === 'string' && req.query.managed_status.length > 0
      ? req.query.managed_status.trim()
      : null;
    const manageabilityStatus = typeof req.query.manageability_status === 'string' && req.query.manageability_status.length > 0
      ? req.query.manageability_status.trim()
      : null;
    const remediationManualStatus = typeof req.query.remediation_manual_status === 'string' && req.query.remediation_manual_status.length > 0
      ? req.query.remediation_manual_status.trim()
      : null;
    const lifecycleScope = typeof req.query.lifecycle_scope === 'string' && req.query.lifecycle_scope.length > 0
      ? req.query.lifecycle_scope.trim()
      : null;

    const rows = await listDevices(db, {
      companyId,
      provider,
      deviceUid,
      siteId,
      managedStatus,
      manageabilityStatus,
      remediationManualStatus,
      lifecycleScope,
      productSurface: parseBooleanFlag(req.query.product_surface),
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });

    const value = rows.map(attachManageabilityView);
    return res.json({ value, Count: value.length });
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.get('/:deviceUid', requireApiKey, enforceCompanyScope, requireRole('viewer'), async (req, res) => {
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
    const deviceUid = req.params.deviceUid;

    const device = await getDevice(db, companyId, deviceUid);
    if (!device) {
      return sendError(res, {
        status: 404,
        code: 'LOOKUP_NOT_FOUND',
        message: 'Device not found',
        details: {
          kind: 'lookup_error',
          error: 'device_not_found'
        }
      });
    }

    return res.json(attachManageabilityView(device));
  } catch (err) {
    console.error(err);
    return sendError(res, {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'Server error'
    });
  }
});

router.put('/:deviceUid', requireApiKey, enforceCompanyScope, requireRole('admin'), async (req, res) => {
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
    const deviceUid = req.params.deviceUid;

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

    const saved = await upsertDevice(db, companyId, deviceUid, body);
    return res.json(attachManageabilityView(saved));
  } catch (err) {
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

