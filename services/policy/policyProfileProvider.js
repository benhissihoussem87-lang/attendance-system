async function getActivePolicyProfile(db, companyId) {
  const res = await db.query(`
    SELECT id, name, version, params
    FROM policy_profiles
    WHERE company_id = $1
    ORDER BY version DESC, name ASC
    LIMIT 1
  `, [companyId]);

  if (res.rows.length === 0) {
    return {
      id: null,
      code: 'default-v1',
      version: 1,
      rules_json: {}
    };
  }

  const row = res.rows[0];
  return {
    id: row.id,
    code: row.name,
    version: row.version,
    rules_json: row.params || {}
  };
}

async function getPolicyProfileById(db, id) {
  const res = await db.query(`
    SELECT id, company_id, name, version, params, created_at
    FROM policy_profiles
    WHERE id = $1
    LIMIT 1
  `, [id]);

  return res.rows[0] || null;
}

async function listPolicyProfiles(db, companyId) {
  const res = await db.query(`
    SELECT id, company_id, name, version, params, created_at
    FROM policy_profiles
    WHERE company_id = $1
    ORDER BY name ASC, version DESC
  `, [companyId]);

  return res.rows;
}

async function createPolicyProfile(db, { company_id, name, params }) {
  const payload = {
    company_id,
    name,
    params: params || {}
  };

  const insertOnce = async () => {
    await db.query('BEGIN');
    try {
      const versionRes = await db.query(`
        SELECT COALESCE(MAX(version), 0) + 1 AS next_version
        FROM policy_profiles
        WHERE company_id = $1 AND name = $2
      `, [payload.company_id, payload.name]);
      const nextVersion = Number(versionRes.rows[0].next_version) || 1;

      const insertRes = await db.query(`
        INSERT INTO policy_profiles (company_id, name, version, params)
        VALUES ($1, $2, $3, $4)
        RETURNING id, company_id, name, version, params, created_at
      `, [payload.company_id, payload.name, nextVersion, payload.params]);

      await db.query('COMMIT');
      return insertRes.rows[0];
    } catch (err) {
      try {
        await db.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('CREATE POLICY PROFILE ROLLBACK FAILED:', rollbackErr);
      }
      throw err;
    }
  };

  try {
    return await insertOnce();
  } catch (err) {
    if (err && err.code === '23505') {
      return await insertOnce();
    }
    throw err;
  }
}

module.exports = {
  getActivePolicyProfile,
  getPolicyProfileById,
  listPolicyProfiles,
  createPolicyProfile
};
