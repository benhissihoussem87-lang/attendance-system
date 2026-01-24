async function resolvePersonIdForIdentifier(db, {
  companyId,
  provider,
  identifierType,
  identifierValue
}) {
  const useMappings = process.env.USE_IDENTITY_MAPPINGS === '1';
  const requireMappings = process.env.REQUIRE_IDENTITY_MAPPINGS === '1';

  const providerValue = typeof provider === 'string' ? provider.trim() : '';
  const typeValue = typeof identifierType === 'string' ? identifierType.trim() : '';
  const value = typeof identifierValue === 'string' ? identifierValue.trim() : '';

  if (!useMappings) {
    return {
      person_id: value || identifierValue,
      applied: false,
      reason: 'disabled'
    };
  }

  if (!providerValue || !typeValue || !value) {
    if (requireMappings) {
      return { error: 'identity_mapping_missing' };
    }
    return {
      person_id: value || identifierValue,
      applied: false,
      reason: 'missing'
    };
  }

  const res = await db.query(`
    SELECT person_id
    FROM identity_mappings
    WHERE company_id = $1
      AND provider = $2
      AND identifier_type = $3
      AND identifier_value = $4
      AND active = true
    LIMIT 1
  `, [companyId, providerValue, typeValue, value]);

  if (res.rows.length === 0) {
    if (requireMappings) {
      return { error: 'identity_mapping_missing' };
    }
    return {
      person_id: value,
      applied: false,
      reason: 'missing'
    };
  }

  return {
    person_id: res.rows[0].person_id,
    applied: true,
    reason: 'mapped'
  };
}

module.exports = { resolvePersonIdForIdentifier };
