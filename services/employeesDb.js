function buildListQuery({ companyId, personId, employeeCode, limit, offset }) {
  const whereParts = ['company_id = $1'];
  const params = [companyId];

  if (personId) {
    params.push(personId);
    whereParts.push(`person_id = $${params.length}`);
  }

  if (employeeCode) {
    params.push(employeeCode);
    whereParts.push(`employee_code = $${params.length}`);
  }

  params.push(limit);
  params.push(offset);

  const query = `
    SELECT company_id, person_id, employee_code, full_name, default_rule_set_id,
           active, metadata, created_at, updated_at
    FROM employees
    WHERE ${whereParts.join(' AND ')}
    ORDER BY person_id ASC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
  `;

  return { query, params };
}

async function listEmployees(db, { companyId, personId, employeeCode, limit, offset }) {
  const { query, params } = buildListQuery({ companyId, personId, employeeCode, limit, offset });
  const res = await db.query(query, params);
  return res.rows;
}

async function getEmployee(db, companyId, personId) {
  const res = await db.query(`
    SELECT company_id, person_id, employee_code, full_name, default_rule_set_id,
           active, metadata, created_at, updated_at
    FROM employees
    WHERE company_id = $1 AND person_id = $2
    LIMIT 1
  `, [companyId, personId]);

  return res.rows[0] || null;
}

async function upsertEmployee(db, companyId, personId, payload) {
  const hasEmployeeCode = Object.prototype.hasOwnProperty.call(payload, 'employee_code');
  const hasFullName = Object.prototype.hasOwnProperty.call(payload, 'full_name');
  const hasDefaultRuleSetId = Object.prototype.hasOwnProperty.call(payload, 'default_rule_set_id');
  const hasActive = Object.prototype.hasOwnProperty.call(payload, 'active');
  const hasMetadata = Object.prototype.hasOwnProperty.call(payload, 'metadata');

  const employeeCode = hasEmployeeCode ? payload.employee_code : null;
  const fullName = hasFullName ? payload.full_name : null;
  const defaultRuleSetId = hasDefaultRuleSetId ? payload.default_rule_set_id : null;
  const metadataValue = hasMetadata ? payload.metadata : {};

  const activeValue = (hasActive && payload.active !== null && payload.active !== undefined)
    ? payload.active
    : true;
  const updateActive = hasActive && payload.active !== null && payload.active !== undefined;

  const res = await db.query(`
    INSERT INTO employees (
      company_id, person_id, employee_code, full_name, default_rule_set_id, active, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (company_id, person_id) DO UPDATE
      SET employee_code = CASE WHEN $8 THEN $3 ELSE employees.employee_code END,
          full_name = CASE WHEN $9 THEN $4 ELSE employees.full_name END,
          default_rule_set_id = CASE WHEN $10 THEN $5 ELSE employees.default_rule_set_id END,
          active = CASE WHEN $11 THEN $6 ELSE employees.active END,
          metadata = CASE WHEN $12 THEN $7::jsonb ELSE employees.metadata END,
          updated_at = now()
    RETURNING company_id, person_id, employee_code, full_name, default_rule_set_id,
              active, metadata, created_at, updated_at
  `, [
    companyId,
    personId,
    employeeCode,
    fullName,
    defaultRuleSetId,
    activeValue,
    JSON.stringify(metadataValue || {}),
    hasEmployeeCode,
    hasFullName,
    hasDefaultRuleSetId,
    updateActive,
    hasMetadata
  ]);

  return res.rows[0];
}

module.exports = {
  listEmployees,
  getEmployee,
  upsertEmployee
};
