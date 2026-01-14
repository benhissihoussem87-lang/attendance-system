const { loadRuleSetById } = require('./ruleSetsDb');

async function resolveRuleSet(db, { rule_set_id, fallbackRuleSet }) {
  if (!rule_set_id) {
    return {
      ruleSet: fallbackRuleSet,
      meta: {
        source: 'default',
        rule_set_id: null,
        name: fallbackRuleSet ? fallbackRuleSet.name : null,
        version: fallbackRuleSet ? fallbackRuleSet.version : null
      }
    };
  }

  const ruleSet = await loadRuleSetById(db, rule_set_id);
  if (!ruleSet) {
    const err = new Error('rule_set_id not found');
    err.code = 'RULE_SET_NOT_FOUND';
    throw err;
  }

  return {
    ruleSet,
    meta: {
      source: 'db',
      rule_set_id: ruleSet.id,
      name: ruleSet.name,
      version: ruleSet.version
    }
  };
}

module.exports = { resolveRuleSet };
