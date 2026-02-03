async function isOnLeave(db, companyId, personId, date) {
  const res = await db.query(`
    SELECT 1
    FROM employee_leaves
    WHERE company_id = $1
      AND person_id = $2
      AND affects_attendance = true
      AND $3 BETWEEN start_date AND end_date
    LIMIT 1
  `, [companyId, personId, date]);

  return res.rows.length > 0;
}

module.exports = { isOnLeave };
