const express = require('express');
const router = express.Router();

const db = require('../db');
const {
  listDevices,
  getDevice,
  upsertDevice
} = require('../services/devicesDb');

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

router.get('/', async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return res.status(400).json({ error: 'invalid_request', detail: resolved.error });
    }
    const companyId = resolved.value;

    const provider = typeof req.query.provider === 'string' && req.query.provider.length > 0
      ? req.query.provider.trim()
      : null;
    const deviceUid = typeof req.query.device_uid === 'string' && req.query.device_uid.length > 0
      ? req.query.device_uid.trim()
      : null;

    const rows = await listDevices(db, {
      companyId,
      provider,
      deviceUid,
      limit: parseLimit(req.query.limit),
      offset: parseOffset(req.query.offset)
    });

    return res.json({ value: rows, Count: rows.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'devices_fetch_failed' });
  }
});

router.get('/:deviceUid', async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return res.status(400).json({ error: 'invalid_request', detail: resolved.error });
    }
    const companyId = resolved.value;
    const deviceUid = req.params.deviceUid;

    const device = await getDevice(db, companyId, deviceUid);
    if (!device) {
      return res.status(404).json({ error: 'device_not_found' });
    }

    return res.json(device);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'devices_fetch_failed' });
  }
});

router.put('/:deviceUid', async (req, res) => {
  try {
    const body = req.body || {};
    const resolved = resolveCompanyId(req, body);
    if (resolved.error) {
      return res.status(400).json({ error: 'invalid_request', detail: resolved.error });
    }
    const companyId = resolved.value;
    const deviceUid = req.params.deviceUid;

    const exists = await db.query(`
      SELECT 1
      FROM companies
      WHERE company_id = $1
    `, [companyId]);
    if (exists.rows.length === 0) {
      return res.status(400).json({ error: 'invalid_request', detail: 'company_id not found' });
    }

    const saved = await upsertDevice(db, companyId, deviceUid, body);
    return res.json(saved);
  } catch (err) {
    if (err && err.code === 'invalid_request') {
      return res.status(400).json({ error: 'invalid_request', detail: err.detail });
    }
    console.error(err);
    return res.status(500).json({ error: 'devices_save_failed' });
  }
});

module.exports = router;
