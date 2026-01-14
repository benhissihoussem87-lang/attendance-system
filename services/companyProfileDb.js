async function getCompanyProfile(db, companyId) {
  const res = await db.query(`
    SELECT company_id, metadata, created_at, updated_at
    FROM company_profile
    WHERE company_id = $1
  `, [companyId]);

  if (res.rows.length === 0) {
    return null;
  }

  return res.rows[0];
}

async function upsertCompanyProfile(db, companyId, metadata) {
  const res = await db.query(`
    INSERT INTO company_profile (company_id, metadata)
    VALUES ($1, $2::jsonb)
    ON CONFLICT (company_id) DO UPDATE
      SET metadata = EXCLUDED.metadata,
          updated_at = now()
    RETURNING company_id, metadata, created_at, updated_at
  `, [companyId, JSON.stringify(metadata || {})]);

  return res.rows[0];
}

module.exports = {
  getCompanyProfile,
  upsertCompanyProfile
};
