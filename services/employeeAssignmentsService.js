async function resolveRuleSetIdForDate({ db, companyId, personId, workDate }) {
  const res = await db.query(`
    SELECT rule_set_id, valid_from, valid_to
    FROM employee_assignments
    WHERE company_id = $1
      AND person_id = $2
      AND valid_from <= $3::date
      AND (valid_to IS NULL OR valid_to >= $3::date)
    ORDER BY valid_from DESC
    LIMIT 1
  `, [companyId, personId, workDate]);

  if (res.rows.length === 0) {
    return null;
  }

  const row = res.rows[0];
  return {
    rule_set_id: row.rule_set_id,
    assignment: {
      valid_from: row.valid_from,
      valid_to: row.valid_to
    }
  };
}

module.exports = { resolveRuleSetIdForDate };
