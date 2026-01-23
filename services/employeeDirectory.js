async function getEmployeeDisplay(db, companyId, personId) {
  if (process.env.USE_EMPLOYEES_REGISTRY !== '1') {
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
