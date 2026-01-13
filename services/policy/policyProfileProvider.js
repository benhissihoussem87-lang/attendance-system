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

module.exports = { getActivePolicyProfile };
