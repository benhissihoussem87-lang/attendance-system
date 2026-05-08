function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeBool(value, fallback = true) {
  if (typeof value === 'boolean') {
    return value;
  }
  return fallback;
}

function validateTimezone(timezone) {
  const value = normalizeText(timezone);
  if (!value) {
    return { ok: true, value: null };
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: 'timezone_invalid' };
  }
}

async function listCompanies(db, { companyId, includeInactive = false, limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 200);
  const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const safeCompanyId = normalizeText(companyId);
  const where = [];
  const params = [];

  if (safeCompanyId) {
    params.push(safeCompanyId);
    where.push(`company_id = $${params.length}`);
  }
  if (includeInactive !== true) {
    where.push('is_active = true');
  }
  params.push(safeLimit, safeOffset);

  const res = await db.query(
    `
    SELECT company_id, display_name, country, timezone, is_active, created_at, updated_at
    FROM companies
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY display_name ASC, company_id ASC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
    `,
    params
  );
  return res.rows;
}

async function createCompany(db, payload) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const companyId = normalizeText(body.company_id);
  const displayName = normalizeText(body.display_name);
  const country = normalizeText(body.country) || null;
  const timezone = validateTimezone(body.timezone);
  const isActive = normalizeBool(body.is_active, true);

  if (!companyId) {
    return { error: 'company_id_required' };
  }
  if (!displayName) {
    return { error: 'display_name_required' };
  }
  if (!timezone.ok) {
    return { error: timezone.error };
  }

  const existing = await db.query(
    `
    SELECT company_id, display_name, country, timezone, is_active, created_at, updated_at
    FROM companies
    WHERE company_id = $1
    LIMIT 1
    `,
    [companyId]
  );
  if (existing.rows.length > 0) {
    return {
      error: 'company_already_exists',
      value: existing.rows[0]
    };
  }

  const res = await db.query(
    `
    INSERT INTO companies (company_id, display_name, country, timezone, is_active)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING company_id, display_name, country, timezone, is_active, created_at, updated_at
    `,
    [companyId, displayName, country, timezone.value, isActive]
  );
  return { value: res.rows[0] };
}

module.exports = {
  listCompanies,
  createCompany,
  __test: {
    validateTimezone
  }
};
