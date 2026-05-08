const assert = require('assert');
const http = require('http');
const https = require('https');
const { adminHeaders, getCompanyId, operatorHeaders, toBool } = require('./_helpers/auth');

function requestJson({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: { ...operatorHeaders(), ...headers }
    };

    let payload = null;
    if (body !== undefined && body !== null) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!options.headers['content-type']) {
        options.headers['content-type'] = typeof body === 'string'
          ? 'text/plain'
          : 'application/json';
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

function ensureString(value, label) {
  assert.strictEqual(typeof value, 'string', `${label} must be string`);
}

function assertErrorEnvelope(body) {
  assert.ok(body && typeof body === 'object', 'error body is required');
  ensureString(body.error, 'error.error');
  ensureString(body.code, 'error.code');
  ensureString(body.message, 'error.message');
}

async function fetchMode(baseUrl) {
  const res = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/ops/test/mode`,
    headers: adminHeaders()
  });
  if (res.status === 404) {
    throw new Error('ALLOW_TEST_ENDPOINTS is not enabled; /api/ops/test/mode returned 404');
  }
  assert.strictEqual(res.status, 200, 'mode endpoint should return 200');
  const mode = res.body;
  assert.ok(mode, 'mode response body is required');
  assert.strictEqual(typeof mode.allow_test_endpoints, 'boolean', 'mode.allow_test_endpoints must be boolean');
  return mode;
}

async function run() {
  const baseUrl = getBaseUrl();
  const mode = await fetchMode(baseUrl);
  if (!mode.allow_test_endpoints) {
    throw new Error('ALLOW_TEST_ENDPOINTS must be enabled for contract tests');
  }

  const companyId = getCompanyId();
  const requireAuth = toBool(process.env.REQUIRE_AUTH);
  const runId = Math.random().toString(16).slice(2, 10);

  // Test 1: PUT / with company_id mismatch (body vs query)
  const putMismatchRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: {
      'content-type': 'application/json'
    },
    body: {
      company_id: 'OTHER',
      provider: 'test',
      identifier_type: 'pin',
      identifier_value: `test_mismatch_${runId}`,
      person_id: `person_mismatch_${runId}`
    }
  });
  assert.strictEqual(
    putMismatchRes.status,
    requireAuth ? 403 : 400,
    `PUT / with company_id mismatch should return ${requireAuth ? 403 : 400}`
  );
  assertErrorEnvelope(putMismatchRes.body);
  if (requireAuth) {
    assert.strictEqual(putMismatchRes.body.code, 'FORBIDDEN', 'PUT company_id mismatch should have code FORBIDDEN');
    assert.ok(
      putMismatchRes.body.details && putMismatchRes.body.details.kind === 'authz',
      'PUT company_id mismatch details.kind should be authz'
    );
    assert.strictEqual(
      putMismatchRes.body.details.error,
      'company_mismatch',
      'PUT company_id mismatch details.error should be company_mismatch'
    );
  } else {
    assert.strictEqual(
      putMismatchRes.body.code,
      'VALIDATION_ERROR',
      'PUT company_id mismatch should have code VALIDATION_ERROR'
    );
    assert.ok(
      putMismatchRes.body.details && putMismatchRes.body.details.kind === 'validation',
      'PUT company_id mismatch details.kind should be validation'
    );
  }

  // Test 2: PUT / with invalid metadata (not an object)
  const putInvalidMetadataRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: {
      provider: 'test',
      identifier_type: 'pin',
      identifier_value: `test_${runId}`,
      person_id: `person_${runId}`,
      metadata: 'invalid_metadata'
    }
  });
  assert.strictEqual(putInvalidMetadataRes.status, 400, 'PUT / with invalid metadata should return 400');
  assertErrorEnvelope(putInvalidMetadataRes.body);
  assert.strictEqual(putInvalidMetadataRes.body.code, 'VALIDATION_ERROR', 'invalid metadata should have code VALIDATION_ERROR');

  // Test 3: PUT / with invalid active (not a boolean)
  const putInvalidActiveRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: {
      provider: 'test',
      identifier_type: 'pin',
      identifier_value: `test_active_${runId}`,
      person_id: `person_active_${runId}`,
      active: 'not_a_boolean'
    }
  });
  assert.strictEqual(putInvalidActiveRes.status, 400, 'PUT / with invalid active should return 400');
  assertErrorEnvelope(putInvalidActiveRes.body);
  assert.strictEqual(putInvalidActiveRes.body.code, 'VALIDATION_ERROR', 'invalid active should have code VALIDATION_ERROR');

  // Test 4: PUT / with non-existent employee
  const putMissingEmployeeRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: {
      provider: 'test',
      identifier_type: 'pin',
      identifier_value: `test_missing_${runId}`,
      person_id: `nonexistent_employee_${runId}`
    }
  });
  assert.strictEqual(putMissingEmployeeRes.status, 400, 'PUT / with non-existent employee should return 400');
  assertErrorEnvelope(putMissingEmployeeRes.body);
  assert.strictEqual(putMissingEmployeeRes.body.code, 'VALIDATION_ERROR', 'missing employee should have code VALIDATION_ERROR');

  // Test 5: PUT / conflict - create employee first, then mapping, then try to map same identifier to different person
  const employee1Id = `emp_conflict_1_${runId}`;
  const employee2Id = `emp_conflict_2_${runId}`;
  const conflictIdentifier = `conflict_id_${runId}`;

  // Create first employee
  const emp1Res = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(employee1Id)}?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: {
      full_name: 'Employee 1',
      employee_code: `EMP1_${runId}`,
      active: true
    }
  });
  assert.strictEqual(emp1Res.status, 200, 'employee 1 creation should succeed');

  // Create second employee
  const emp2Res = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(employee2Id)}?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: {
      full_name: 'Employee 2',
      employee_code: `EMP2_${runId}`,
      active: true
    }
  });
  assert.strictEqual(emp2Res.status, 200, 'employee 2 creation should succeed');

  // Map identifier to employee 1
  const mapping1Res = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: {
      provider: 'test',
      identifier_type: 'pin',
      identifier_value: conflictIdentifier,
      person_id: employee1Id,
      active: true
    }
  });
  assert.strictEqual(mapping1Res.status, 200, 'first mapping should succeed');

  // Try to map same identifier to employee 2 - should fail with CONFLICT
  const conflictRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: {
      provider: 'test',
      identifier_type: 'pin',
      identifier_value: conflictIdentifier,
      person_id: employee2Id,
      active: true
    }
  });
  assert.strictEqual(conflictRes.status, 409, 'mapping conflict should return 409');
  assertErrorEnvelope(conflictRes.body);
  assert.strictEqual(conflictRes.body.code, 'CONFLICT', 'mapping conflict should have code CONFLICT');
  assert.strictEqual(conflictRes.body.details.existing_person_id, employee1Id, 'conflict should return existing person_id');

  console.log('identity mappings error envelope contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
