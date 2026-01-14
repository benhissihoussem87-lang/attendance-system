const express = require('express');
const router = express.Router();

const db = require('../db');
const {
  listPolicyProfiles,
  createPolicyProfile
} = require('../services/policy/policyProfileProvider');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

router.get('/', async (req, res) => {
  try {
    const companyId = isNonEmptyString(req.query.company_id)
      ? req.query.company_id.trim()
      : 'DEFAULT';
    const rows = await listPolicyProfiles(db, companyId);
    return res.json(rows);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'policy_profiles_list_failed' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { company_id, name, params } = req.body || {};

    if (!isNonEmptyString(company_id)) {
      return res.status(400).json({ error: 'invalid_request', detail: 'company_id is required' });
    }
    if (!isNonEmptyString(name)) {
      return res.status(400).json({ error: 'invalid_request', detail: 'name is required' });
    }
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      return res.status(400).json({ error: 'invalid_request', detail: 'params must be an object' });
    }

    const result = await createPolicyProfile(db, {
      company_id: company_id.trim(),
      name: name.trim(),
      params: params || {}
    });

    return res.status(201).json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'policy_profiles_create_failed' });
  }
});

module.exports = router;
