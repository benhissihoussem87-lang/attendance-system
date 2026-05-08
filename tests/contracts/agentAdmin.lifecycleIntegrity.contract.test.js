const assert = require('assert');
const http = require('http');
const https = require('https');
const {
  adminHeaders,
  operatorHeaders,
  viewerHeaders,
  getCompanyId,
  requireAuth
} = require('./_helpers/auth');

function requestJson({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: { ...headers }
    };

    let payload = null;
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!options.headers['content-type']) {
        options.headers['content-type'] = 'application/json';
      }
      options.headers['content-length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            return reject(new Error(`Expected JSON response from ${url}, got: ${data.slice(0, 200)}`));
          }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });

    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

function getBaseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
}

function assertErrorEnvelope(body) {
  assert.ok(body && typeof body === 'object', 'error body is required');
  assert.strictEqual(typeof body.error, 'string', 'error.error must be string');
  assert.strictEqual(typeof body.code, 'string', 'error.code must be string');
  assert.strictEqual(typeof body.message, 'string', 'error.message must be string');
}

function assertChecks(rows, expectedNames, severity) {
  assert.ok(Array.isArray(rows), `${severity} checks should be an array`);
  const names = new Set(rows.map(row => row && row.check_name));
  for (const expectedName of expectedNames) {
    assert.ok(names.has(expectedName), `${severity} checks missing ${expectedName}`);
  }
  rows.forEach(row => {
    assert.ok(row && typeof row === 'object', `${severity} check row should be object`);
    assert.strictEqual(typeof row.check_name, 'string', `${severity} check_name should be string`);
    assert.strictEqual(row.severity, severity, `${severity} severity should be explicit`);
    assert.strictEqual(typeof row.description, 'string', `${severity} description should be string`);
    assert.strictEqual(typeof row.issue_count, 'number', `${severity} issue_count should be number`);
  });
}

function assertMigrationStatuses(requiredMigrations) {
  assert.ok(Array.isArray(requiredMigrations), 'required_migrations should be an array');
  const byFilename = new Map(
    requiredMigrations.map(item => [item && item.filename, item])
  );
  const expected = [
    '20260318_device_lifecycle_coherence_phase2_slice21.sql',
    '20260318_device_lifecycle_coherence_phase2_slice25.sql'
  ];
  expected.forEach(filename => {
    assert.ok(byFilename.has(filename), `required_migrations missing ${filename}`);
    const item = byFilename.get(filename);
    assert.ok(item && typeof item === 'object', 'migration item should be object');
    assert.ok(
      item.status === 'applied' || item.status === 'missing',
      `migration status must be applied|missing (got ${item.status})`
    );
    assert.strictEqual(item.scope, 'global', 'migration scope should be explicit/global');
  });
}

function assertDetailsPayload(details, expectedLimit) {
  assert.ok(details && typeof details === 'object', 'details should be object when include_details=true');
  assert.strictEqual(details.detail_limit, expectedLimit, 'details.detail_limit should echo applied limit');
  assert.ok(details.strict && typeof details.strict === 'object', 'details.strict should be object');
  assert.ok(details.advisory && typeof details.advisory === 'object', 'details.advisory should be object');

  const strictKeys = [
    'superseded_without_canonical',
    'canonical_with_superseded_pointer',
    'managed_bridge_missing_active_binding',
    'active_binding_on_non_bridge_or_non_managed_device',
    'canonical_device_missing_active_device_uid_alias',
    'active_alias_points_to_superseded_canonical'
  ];
  strictKeys.forEach(key => {
    assert.ok(Array.isArray(details.strict[key]), `details.strict.${key} should be an array`);
  });

  const advisoryKeys = [
    'ingest_only_with_bridge_evidence_advisory',
    'active_serial_alias_multi_canonical_advisory',
    'active_mac_alias_multi_canonical_advisory'
  ];
  advisoryKeys.forEach(key => {
    assert.ok(Array.isArray(details.advisory[key]), `details.advisory.${key} should be an array`);
  });
}

async function ensureMode(baseUrl) {
  const res = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/ops/test/mode`,
    headers: adminHeaders()
  });
  if (res.status === 404) {
    throw new Error('ALLOW_TEST_ENDPOINTS must be enabled for this contract test');
  }
  assert.strictEqual(res.status, 200, 'mode endpoint should return 200');
}

async function run() {
  const baseUrl = getBaseUrl();
  await ensureMode(baseUrl);

  const companyId = getCompanyId();
  const authRequired = requireAuth();
  const admin = {
    ...adminHeaders(),
    'x-company-id': companyId
  };
  const viewer = {
    ...viewerHeaders(),
    'x-company-id': companyId
  };
  const operator = {
    ...operatorHeaders(),
    'x-company-id': companyId
  };

  if (authRequired) {
    const unauth = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/lifecycle-integrity?company_id=${encodeURIComponent(companyId)}`
    });
    assert.strictEqual(unauth.status, 401, 'lifecycle integrity view should require auth');
    assertErrorEnvelope(unauth.body);

    const viewerAllowed = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/lifecycle-integrity?company_id=${encodeURIComponent(companyId)}`,
      headers: viewer
    });
    assert.strictEqual(viewerAllowed.status, 200, 'viewer should be allowed to view lifecycle integrity');

    const operatorAllowed = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/lifecycle-integrity?company_id=${encodeURIComponent(companyId)}`,
      headers: operator
    });
    assert.strictEqual(operatorAllowed.status, 200, 'operator should be allowed to view lifecycle integrity');
  }

  const mismatch = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/lifecycle-integrity?company_id=OTHER`,
    headers: admin
  });
  assert.strictEqual(
    mismatch.status,
    authRequired ? 403 : 200,
    `tenant mismatch should return ${authRequired ? 403 : 200}`
  );
  if (authRequired) {
    assertErrorEnvelope(mismatch.body);
  }

  const includeDetailsRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/lifecycle-integrity?company_id=${encodeURIComponent(companyId)}&include_details=1&detail_limit=7`,
    headers: viewer
  });
  assert.strictEqual(includeDetailsRes.status, 200, 'lifecycle integrity view should return 200');

  const payload = includeDetailsRes.body;
  assert.ok(payload && typeof payload === 'object', 'response body should be object');
  assert.strictEqual(payload.company_id, companyId, 'response should be company-scoped');
  assert.strictEqual(typeof payload.generated_at, 'string', 'generated_at should be string');
  assertMigrationStatuses(payload.required_migrations);

  assert.ok(Array.isArray(payload.lifecycle_summary), 'lifecycle_summary should be array');
  payload.lifecycle_summary.forEach(row => {
    assert.strictEqual(row.company_id, companyId, 'lifecycle summary should be company-scoped');
    assert.strictEqual(typeof row.lifecycle_scope, 'string', 'lifecycle_scope should be string');
    assert.strictEqual(typeof row.managed_status, 'string', 'managed_status should be string');
    assert.strictEqual(typeof row.identity_status, 'string', 'identity_status should be string');
    assert.strictEqual(typeof row.row_count, 'number', 'row_count should be number');
  });

  assert.ok(payload.checks && typeof payload.checks === 'object', 'checks should be object');
  assertChecks(payload.checks.strict, [
    'superseded_without_canonical',
    'canonical_with_superseded_pointer',
    'managed_bridge_missing_active_binding',
    'active_binding_on_non_bridge_or_non_managed_device',
    'canonical_device_missing_active_device_uid_alias',
    'active_alias_points_to_superseded_canonical'
  ], 'strict');
  assertChecks(payload.checks.advisory, [
    'ingest_only_with_bridge_evidence_advisory',
    'active_serial_alias_multi_canonical_advisory',
    'active_mac_alias_multi_canonical_advisory'
  ], 'advisory');
  assert.strictEqual(typeof payload.strict_issue_count_total, 'number', 'strict_issue_count_total should be number');
  assert.strictEqual(typeof payload.advisory_issue_count_total, 'number', 'advisory_issue_count_total should be number');
  assertDetailsPayload(payload.details, 7);

  const noDetailsRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/lifecycle-integrity?company_id=${encodeURIComponent(companyId)}`,
    headers: viewer
  });
  assert.strictEqual(noDetailsRes.status, 200, 'default lifecycle integrity view should return 200');
  assert.strictEqual(noDetailsRes.body.details, null, 'details should be null unless include_details=true');

  const invalidIncludeDetailsRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/lifecycle-integrity?company_id=${encodeURIComponent(companyId)}&include_details=maybe`,
    headers: admin
  });
  assert.strictEqual(invalidIncludeDetailsRes.status, 400, 'invalid include_details should return 400');
  assertErrorEnvelope(invalidIncludeDetailsRes.body);
  assert.ok(
    invalidIncludeDetailsRes.body.details
      && invalidIncludeDetailsRes.body.details.detail
      && String(invalidIncludeDetailsRes.body.details.detail).includes('include_details'),
    'invalid include_details error should be explicit'
  );

  console.log('agent admin lifecycle-integrity contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
