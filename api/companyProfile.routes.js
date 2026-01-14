const express = require('express');
const router = express.Router();

const db = require('../db');
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

router.get('/', async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, null);
    if (resolved.error) {
      return res.status(400).json({ error: 'invalid_request', detail: resolved.error });
    }
    const companyId = resolved.value;
    const profile = await getCompanyProfile(db, companyId);
    if (!profile) {
      return res.status(404).json({ error: 'company_profile_not_found' });
    }
    return res.json(profile);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'company_profile_fetch_failed' });
  }
});

router.put('/', async (req, res) => {
  try {
    const resolved = resolveCompanyId(req, req.body || {});
    if (resolved.error) {
      return res.status(400).json({ error: 'invalid_request', detail: resolved.error });
    }
    const companyId = resolved.value;
    const metadata = req.body ? req.body.metadata : undefined;
    if (!isPlainObject(metadata)) {
      return res.status(400).json({ error: 'invalid_request', detail: 'metadata must be an object' });
    }

    const exists = await db.query(`
      SELECT 1
      FROM companies
      WHERE company_id = $1
    `, [companyId]);
    if (exists.rows.length === 0) {
      return res.status(400).json({ error: 'invalid_request', detail: 'company_id not found' });
    }

    const saved = await upsertCompanyProfile(db, companyId, metadata);
    return res.json(saved);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'company_profile_save_failed' });
  }
});

module.exports = router;
