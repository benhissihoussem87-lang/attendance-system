async function getCompanyConfigFromDb(db, companyId) {
  const result = await db.query(
    `
    SELECT company_id, company_timezone, night_shift_enabled, day_start_time
    FROM company_config
    WHERE company_id = $1
    `,
    [companyId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

module.exports = { getCompanyConfigFromDb };
