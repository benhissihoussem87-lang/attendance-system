async function isNonWorkingDay(db, companyId, workDate) {
  const weekday = new Date(workDate + 'T00:00:00Z').getUTCDay();

  const res = await db.query(`
    SELECT is_working
    FROM company_working_days
    WHERE company_id = $1 AND weekday = $2
  `, [companyId, weekday]);

  if (res.rows.length === 0) {
    return false;
  }

  return res.rows[0].is_working !== true;
}

async function isOnLeave(db, companyId, personId, workDate) {
  const res = await db.query(`
    SELECT 1
    FROM employee_leaves
    WHERE company_id = $1
      AND person_id = $2
      AND $3 BETWEEN start_date AND end_date
    LIMIT 1
  `, [companyId, personId, workDate]);

  return res.rows.length > 0;
}

module.exports = { isNonWorkingDay, isOnLeave };
