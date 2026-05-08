const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { adminHeaders, operatorHeaders, viewerHeaders, getCompanyId, requireAuth } = require('./_helpers/auth');
require('dotenv').config();
const db = require('../../db');

function requestJson({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: { Accept: 'application/json', ...headers }
    };
    if (payload) {
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try { parsed = JSON.parse(data); } catch (_) { parsed = { raw: data }; }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function baseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
}

function appUrl(pathname, query = {}) {
  const url = new URL(pathname, baseUrl());
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

async function run() {
  const companyId = getCompanyId();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const employeeCode = `empv1-${runId}`;
  const otherCode = `empv1-other-${runId}`;
  const legacyPersonId = `legacy_empv1_${runId}`;
  const legacyEmployeeCode = `legacy-${runId}`;
  const deviceUserId = `du-${runId}`;
  const admin = { ...adminHeaders(), 'x-company-id': companyId };
  const operator = { ...operatorHeaders(), 'x-company-id': companyId };
  const viewer = { ...viewerHeaders(), 'x-company-id': companyId };

  const appEmployeesJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app', 'employees.js'), 'utf8');
  assert.ok(appEmployeesJs.includes('/api/employee-management'), '/app Employees module should use product employee-management API');
  assert.ok(!appEmployeesJs.includes("'/api/employees'") && !appEmployeesJs.includes('"/api/employees"'), '/app Employees module must not use mock /api/employees');

  await db.query(`
    INSERT INTO employees (company_id, person_id, employee_code, full_name, active, metadata)
    VALUES ($1, $2, $3, $4, true, '{}'::jsonb)
    ON CONFLICT (company_id, person_id) DO UPDATE
      SET employee_code = EXCLUDED.employee_code,
          full_name = EXCLUDED.full_name,
          metadata = '{}'::jsonb,
          active = true,
          updated_at = now()
  `, [companyId, legacyPersonId, legacyEmployeeCode, 'Legacy Fixture Employee']);

  const created = await requestJson({
    method: 'POST',
    url: appUrl('/api/employee-management/employees'),
    headers: admin,
    body: {
      company_id: companyId,
      employee_code: employeeCode,
      first_name: 'Employee',
      last_name: 'V1',
      full_name: 'Employee V1',
      site_id: 'default-site',
      job_title: 'Operator',
      notes: 'contract test',
      metadata: {
        test_record: true,
        not_for_client_reports: true
      }
    }
  });
  assert.strictEqual(created.status, 201, 'admin should create employee');
  assert.ok(created.body.person_id, 'created employee should have generated person_id');
  assert.strictEqual(created.body.employee_code, employeeCode);
  assert.strictEqual(created.body.metadata.first_name, 'Employee');
  assert.strictEqual(created.body.metadata.product_managed, true, 'created employee should be product-managed');
  assert.strictEqual(created.body.metadata.source, 'product_ui', 'created employee should be marked product_ui');
  assert.strictEqual(created.body.metadata.employee_v1, true, 'created employee should be marked employee_v1');
  assert.strictEqual(created.body.metadata.test_record, true, 'contract-created employee should be marked test_record');
  assert.strictEqual(created.body.metadata.not_for_client_reports, true, 'contract-created employee should be hidden from client reports');

  const personId = created.body.person_id;

  const viewerList = await requestJson({
    method: 'GET',
    url: appUrl('/api/employee-management/employees', { company_id: companyId, employee_code: employeeCode }),
    headers: viewer
  });
  assert.strictEqual(viewerList.status, 200, 'viewer should list employees');
  assert.ok(Array.isArray(viewerList.body.rows), 'list should return rows');
  assert.ok(!viewerList.body.rows.some(row => row.person_id === personId), 'test-created product employee should not be listed by default');
  assert.ok(!viewerList.body.rows.some(row => row.person_id === legacyPersonId), 'legacy employee should not be listed by default');

  const viewerIncludeValidation = await requestJson({
    method: 'GET',
    url: appUrl('/api/employee-management/employees', { company_id: companyId, include_validation: 'true', employee_code: employeeCode }),
    headers: viewer
  });
  assert.strictEqual(viewerIncludeValidation.status, 403, 'viewer cannot include validation/test employees');

  const adminIncludeValidation = await requestJson({
    method: 'GET',
    url: appUrl('/api/employee-management/employees', { company_id: companyId, include_validation: 'true', employee_code: employeeCode }),
    headers: admin
  });
  assert.strictEqual(adminIncludeValidation.status, 200, 'admin can include validation/test employees');
  assert.ok(adminIncludeValidation.body.rows.some(row => row.person_id === personId), 'admin include_validation should return test-created product employees');

  const defaultLegacyList = await requestJson({
    method: 'GET',
    url: appUrl('/api/employee-management/employees', { company_id: companyId, employee_code: legacyEmployeeCode }),
    headers: viewer
  });
  assert.strictEqual(defaultLegacyList.status, 200, 'default legacy lookup list should be allowed');
  assert.strictEqual(defaultLegacyList.body.rows.length, 0, 'default list should exclude legacy employees with empty metadata');

  const directLegacyGet = await requestJson({
    method: 'GET',
    url: appUrl(`/api/employee-management/employees/${encodeURIComponent(legacyPersonId)}`, { company_id: companyId }),
    headers: viewer
  });
  assert.strictEqual(directLegacyGet.status, 200, 'direct get should preserve legacy access');
  assert.strictEqual(directLegacyGet.body.person_id, legacyPersonId);

  const viewerIncludeLegacy = await requestJson({
    method: 'GET',
    url: appUrl('/api/employee-management/employees', { company_id: companyId, include_legacy: 'true', employee_code: legacyEmployeeCode }),
    headers: viewer
  });
  assert.strictEqual(viewerIncludeLegacy.status, 403, 'viewer cannot include legacy employees');

  const adminIncludeLegacy = await requestJson({
    method: 'GET',
    url: appUrl('/api/employee-management/employees', { company_id: companyId, include_legacy: 'true', employee_code: legacyEmployeeCode }),
    headers: admin
  });
  assert.strictEqual(adminIncludeLegacy.status, 200, 'admin can include legacy employees');
  assert.ok(adminIncludeLegacy.body.rows.some(row => row.person_id === legacyPersonId), 'admin include_legacy should return legacy employees');

  if (requireAuth()) {
    const viewerPatch = await requestJson({
      method: 'PATCH',
      url: appUrl(`/api/employee-management/employees/${encodeURIComponent(personId)}`),
      headers: viewer,
      body: { company_id: companyId, full_name: 'Viewer Mutation' }
    });
    assert.strictEqual(viewerPatch.status, 403, 'viewer cannot mutate employees');

    const operatorPatch = await requestJson({
      method: 'PATCH',
      url: appUrl(`/api/employee-management/employees/${encodeURIComponent(personId)}`),
      headers: operator,
      body: { company_id: companyId, full_name: 'Operator Mutation' }
    });
    assert.strictEqual(operatorPatch.status, 403, 'operator cannot mutate Employees v1');
  }

  const updated = await requestJson({
    method: 'PATCH',
    url: appUrl(`/api/employee-management/employees/${encodeURIComponent(personId)}`),
    headers: admin,
    body: {
      company_id: companyId,
      employee_code: employeeCode,
      first_name: 'Updated',
      last_name: 'Employee',
      full_name: 'Updated Employee',
      active: true,
      notes: 'updated'
    }
  });
  assert.strictEqual(updated.status, 200, 'admin should update employee');
  assert.strictEqual(updated.body.full_name, 'Updated Employee');

  const deactivated = await requestJson({
    method: 'POST',
    url: appUrl(`/api/employee-management/employees/${encodeURIComponent(personId)}/deactivate`),
    headers: admin,
    body: { company_id: companyId }
  });
  assert.strictEqual(deactivated.status, 200, 'admin should deactivate employee');
  assert.strictEqual(deactivated.body.active, false);

  const inactiveMapping = await requestJson({
    method: 'PUT',
    url: appUrl(`/api/employee-management/employees/${encodeURIComponent(personId)}/device-mappings`),
    headers: admin,
    body: { company_id: companyId, provider: 'zkteco', identifier_value: deviceUserId }
  });
  assert.strictEqual(inactiveMapping.status, 409, 'inactive employee mapping should be rejected');

  const reactivated = await requestJson({
    method: 'POST',
    url: appUrl(`/api/employee-management/employees/${encodeURIComponent(personId)}/reactivate`),
    headers: admin,
    body: { company_id: companyId }
  });
  assert.strictEqual(reactivated.status, 200, 'admin should reactivate employee');
  assert.strictEqual(reactivated.body.active, true);

  const mapping = await requestJson({
    method: 'PUT',
    url: appUrl(`/api/employee-management/employees/${encodeURIComponent(personId)}/device-mappings`),
    headers: admin,
    body: { company_id: companyId, provider: 'zkteco', identifier_value: deviceUserId, active: true }
  });
  assert.strictEqual(mapping.status, 200, 'admin should map device user id');
  assert.strictEqual(mapping.body.provider, 'zkteco');
  assert.strictEqual(mapping.body.identifier_type, 'device_user_id');
  assert.strictEqual(mapping.body.identifier_value, deviceUserId);

  const other = await requestJson({
    method: 'POST',
    url: appUrl('/api/employee-management/employees'),
    headers: admin,
    body: {
      company_id: companyId,
      employee_code: otherCode,
      full_name: 'Other Employee',
      metadata: {
        test_record: true,
        not_for_client_reports: true
      }
    }
  });
  assert.strictEqual(other.status, 201, 'admin should create second employee');

  const duplicateMapping = await requestJson({
    method: 'PUT',
    url: appUrl(`/api/employee-management/employees/${encodeURIComponent(other.body.person_id)}/device-mappings`),
    headers: admin,
    body: { company_id: companyId, provider: 'zkteco', identifier_value: deviceUserId, active: true }
  });
  assert.strictEqual(duplicateMapping.status, 409, 'duplicate active device user id should be rejected');

  await db.end();
  console.log('PASS: employee management v1 contract');
}

run().catch(err => {
  console.error(err);
  db.end().finally(() => process.exit(1));
});
