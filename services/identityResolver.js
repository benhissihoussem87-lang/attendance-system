function normalizeLower(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.toLowerCase() : '';
}

async function resolvePersonIdForIdentifier(db, {
  companyId,
  provider,
  identifierType,
  identifierValue,
  requireMappings
}) {
  const useMappings = process.env.USE_IDENTITY_MAPPINGS === '1';
  const requireMappingsEnv = process.env.REQUIRE_IDENTITY_MAPPINGS === '1';
  const requireMappingsEffective = (typeof requireMappings === 'boolean')
    ? requireMappings
    : requireMappingsEnv;

  const providerValue = normalizeLower(provider);
  const typeValue = normalizeLower(identifierType);
  const value = typeof identifierValue === 'string' ? identifierValue.trim() : '';

  if (!useMappings) {
    return {
      person_id: value || identifierValue,
      applied: false,
      reason: 'disabled'
    };
  }

  if (!providerValue || !typeValue || !value) {
    if (requireMappingsEffective) {
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
    if (requireMappingsEffective) {
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
