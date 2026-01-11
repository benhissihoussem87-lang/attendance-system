async function isWorkingDay(db, companyId, date) {
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();

  const res = await db.query(`
    SELECT is_working
    FROM company_working_days
    WHERE company_id = $1 AND weekday = $2
  `, [companyId, weekday]);

  if (res.rows.length === 0) {
    return true;
  }

  return res.rows[0].is_working === true;
}

module.exports = { isWorkingDay };
