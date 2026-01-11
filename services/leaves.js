async function isOnLeave(db, personId, date) {
  const res = await db.query(`
    SELECT 1
    FROM employee_leaves
    WHERE person_id = $1
      AND affects_attendance = true
      AND $2 BETWEEN start_date AND end_date
    LIMIT 1
  `, [personId, date]);

  return res.rows.length > 0;
}

module.exports = { isOnLeave };
