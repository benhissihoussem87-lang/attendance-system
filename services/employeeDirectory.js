const { toBool } = require('./envBool');

async function getEmployeeDisplay(db, companyId, personId) {
  if (!toBool(process.env.USE_EMPLOYEES_REGISTRY)) {
    return null;
  }

  const res = await db.query(`
    SELECT employee_code, full_name
    FROM employees
    WHERE company_id = $1 AND person_id = $2
    LIMIT 1
  `, [companyId, personId]);

  return res.rows[0] || null;
}

module.exports = { getEmployeeDisplay };
