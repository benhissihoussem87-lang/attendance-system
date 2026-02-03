async function loadRuleSetById(db, ruleSetId) {
  const setRes = await db.query(`
    SELECT id, name, version
    FROM rule_sets
    WHERE id = $1
  `, [ruleSetId]);

  if (setRes.rows.length === 0) {
    return null;
  }

  const ruleSet = setRes.rows[0];
  const rulesRes = await db.query(`
    SELECT type, params, order_index
    FROM rules
    WHERE rule_set_id = $1
    ORDER BY order_index ASC
  `, [ruleSetId]);

  const rules = rulesRes.rows.map(row => ({
    type: row.type,
    ...(row.params || {})
  }));

  return {
    id: ruleSet.id,
    name: ruleSet.name,
    version: ruleSet.version,
    rules
  };
}

module.exports = { loadRuleSetById };
