function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeLower(value) {
  const trimmed = normalizeText(value);
  return trimmed ? trimmed.toLowerCase() : '';
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  return null;
}

function buildListQuery({
  companyId,
  provider,
  identifierType,
  identifierValue,
  personId,
  active,
  limit,
  offset
}) {
  const whereParts = ['company_id = $1'];
  const params = [companyId];

  if (provider) {
    params.push(provider);
    whereParts.push(`provider = $${params.length}`);
  }
  if (identifierType) {
    params.push(identifierType);
    whereParts.push(`identifier_type = $${params.length}`);
  }
  if (identifierValue) {
    params.push(identifierValue);
    whereParts.push(`identifier_value = $${params.length}`);
  }
  if (personId) {
    params.push(personId);
    whereParts.push(`person_id = $${params.length}`);
  }
  if (active !== null && active !== undefined) {
    params.push(active);
    whereParts.push(`active = $${params.length}`);
  }

  params.push(limit);
  params.push(offset);

  const query = `
    SELECT company_id, provider, identifier_type, identifier_value, person_id,
           active, metadata, created_at, updated_at
    FROM identity_mappings
    WHERE ${whereParts.join(' AND ')}
    ORDER BY provider ASC, identifier_type ASC, identifier_value ASC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
  `;

  return { query, params };
}

async function listIdentityMappings(db, {
  companyId,
  provider,
  identifierType,
  identifierValue,
  personId,
  active,
  limit,
  offset
}) {
  const normalizedProvider = normalizeLower(provider);
  const normalizedIdentifierType = normalizeLower(identifierType);
  const normalizedIdentifierValue = normalizeText(identifierValue);
  const normalizedPersonId = normalizeText(personId);
  const { query, params } = buildListQuery({
    companyId,
    provider: normalizedProvider || null,
    identifierType: normalizedIdentifierType || null,
    identifierValue: normalizedIdentifierValue || null,
    personId: normalizedPersonId || null,
    active,
    limit,
    offset
  });
  const res = await db.query(query, params);
  return res.rows;
}

async function getIdentityMapping(db, companyId, provider, identifierType, identifierValue) {
  const normalizedProvider = normalizeLower(provider);
  const normalizedIdentifierType = normalizeLower(identifierType);
  const normalizedIdentifierValue = normalizeText(identifierValue);
  const res = await db.query(`
    SELECT company_id, provider, identifier_type, identifier_value, person_id,
           active, metadata, created_at, updated_at
    FROM identity_mappings
    WHERE company_id = $1 AND provider = $2 AND identifier_type = $3 AND identifier_value = $4
    LIMIT 1
  `, [companyId, normalizedProvider, normalizedIdentifierType, normalizedIdentifierValue]);

  return res.rows[0] || null;
}

async function upsertIdentityMapping(db, companyId, payload) {
  const provider = normalizeLower(payload.provider);
  const identifierType = normalizeLower(payload.identifier_type);
  const identifierValue = normalizeText(payload.identifier_value);
  const personId = normalizeText(payload.person_id);

  if (!provider) {
    throw { code: 'invalid_request', detail: 'provider is required' };
  }
  if (!identifierType) {
    throw { code: 'invalid_request', detail: 'identifier_type is required' };
  }
  if (!identifierValue) {
    throw { code: 'invalid_request', detail: 'identifier_value is required' };
  }
  if (!personId) {
    throw { code: 'invalid_request', detail: 'person_id is required' };
  }

  const hasMetadata = Object.prototype.hasOwnProperty.call(payload, 'metadata');
  const hasActive = Object.prototype.hasOwnProperty.call(payload, 'active');
  const metadataValue = hasMetadata ? payload.metadata : {};
  const activeValue = hasActive ? normalizeBoolean(payload.active) : null;

  await db.query('BEGIN');
  try {
    const employeeExists = await db.query(`
      SELECT 1
      FROM employees
      WHERE company_id = $1 AND person_id = $2
    `, [companyId, personId]);
    if (employeeExists.rows.length === 0) {
      throw { code: 'employee_not_found' };
    }

    const existing = await db.query(`
      SELECT person_id
      FROM identity_mappings
      WHERE company_id = $1 AND provider = $2 AND identifier_type = $3 AND identifier_value = $4
      LIMIT 1
    `, [companyId, provider, identifierType, identifierValue]);

    if (existing.rows.length > 0) {
      const existingPersonId = existing.rows[0].person_id;
      if (existingPersonId !== personId) {
        throw {
          code: 'conflict_mapped_to_other_person',
          existing_person_id: existingPersonId
        };
      }

      const updated = await db.query(`
        UPDATE identity_mappings
        SET metadata = CASE WHEN $5 THEN $1::jsonb ELSE metadata END,
            active = CASE WHEN $6 THEN $2 ELSE active END,
            updated_at = now()
        WHERE company_id = $3 AND provider = $4 AND identifier_type = $7 AND identifier_value = $8
        RETURNING company_id, provider, identifier_type, identifier_value, person_id,
                  active, metadata, created_at, updated_at
      `, [
        JSON.stringify(metadataValue || {}),
        activeValue,
        companyId,
        provider,
        hasMetadata,
        hasActive && activeValue !== null,
        identifierType,
        identifierValue
      ]);

      await db.query('COMMIT');
      return updated.rows[0];
    }

    const inserted = await db.query(`
      INSERT INTO identity_mappings (
        company_id, provider, identifier_type, identifier_value, person_id, active, metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      RETURNING company_id, provider, identifier_type, identifier_value, person_id,
                active, metadata, created_at, updated_at
    `, [
      companyId,
      provider,
      identifierType,
      identifierValue,
      personId,
      hasActive && activeValue !== null ? activeValue : true,
      JSON.stringify(metadataValue || {})
    ]);

    await db.query('COMMIT');
    return inserted.rows[0];
  } catch (err) {
    try {
      await db.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('IDENTITY MAPPING UPSERT ROLLBACK FAILED:', rollbackErr);
    }
    throw err;
  }
}

module.exports = {
  listIdentityMappings,
  getIdentityMapping,
  upsertIdentityMapping
};
