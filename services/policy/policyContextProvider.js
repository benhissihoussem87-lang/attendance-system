async function isNonWorkingDay(db, companyId, workDate) {
  const weekday = new Date(workDate + 'T00:00:00Z').getUTCDay();

  const queryByColumns = async (dayColumn, workingColumn) => db.query(`
    SELECT ${workingColumn} AS is_working
    FROM company_working_days
    WHERE company_id = $1 AND ${dayColumn} = $2
  `, [companyId, weekday]);

  let res;
  try {
    res = await queryByColumns('day_of_week', 'is_working_day');
  } catch (err) {
    if (!err || err.code !== '42703') {
      throw err;
    }
    try {
      res = await queryByColumns('day_of_week', 'is_working');
    } catch (err2) {
      if (!err2 || err2.code !== '42703') {
        throw err2;
      }
      try {
        res = await queryByColumns('weekday', 'is_working_day');
      } catch (err3) {
        if (!err3 || err3.code !== '42703') {
          throw err3;
        }
        res = await queryByColumns('weekday', 'is_working');
      }
    }
  }

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
