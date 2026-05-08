const assert = require('assert');
const http = require('http');
const https = require('https');
const { adminHeaders, getCompanyId, operatorHeaders } = require('./_helpers/auth');

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
  const runId = Math.random().toString(16).slice(2, 10);
  const personId = `identity_contract_${runId}`;
  const identifierValue = `ZK-${runId}`;

  const employeeBody = {
    full_name: `Identity Contract ${runId}`,
    employee_code: `EMP-${runId}`,
    active: true,
    metadata: {}
  };

  const employeeRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(personId)}?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: employeeBody
  });
  assert.strictEqual(employeeRes.status, 200, 'employee PUT should return 200');

  const mappingBody = {
    provider: 'zkteco',
    identifier_type: 'pin',
    identifier_value: identifierValue,
    person_id: personId,
    active: true,
    metadata: {}
  };

  const mappingRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body: mappingBody
  });
  assert.strictEqual(mappingRes.status, 200, 'identity mapping PUT should return 200');

  const lookupRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/identity-mappings/lookup?company_id=${encodeURIComponent(companyId)}&provider=zkteco&identifier_type=pin&identifier_value=${encodeURIComponent(identifierValue)}`
  });
  assert.strictEqual(lookupRes.status, 200, 'identity mapping lookup should return 200');
  assert.ok(lookupRes.body && typeof lookupRes.body === 'object', 'lookup should return a body');
  assert.strictEqual(lookupRes.body.person_id, personId, 'lookup should return matching person_id');

  const missingParamsRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/identity-mappings/lookup?company_id=${encodeURIComponent(companyId)}`
  });
  assert.strictEqual(missingParamsRes.status, 400, 'missing params should return 400');
  assertErrorEnvelope(missingParamsRes.body);
  assert.strictEqual(missingParamsRes.body.code, 'VALIDATION_ERROR', 'missing params code mismatch');
  assert.ok(
    missingParamsRes.body.details && missingParamsRes.body.details.kind === 'validation',
    'missing params details.kind should be validation'
  );

  const missingValue = `ZK-UNKNOWN-${runId}`;
  const missingRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/identity-mappings/lookup?company_id=${encodeURIComponent(companyId)}&provider=zkteco&identifier_type=pin&identifier_value=${encodeURIComponent(missingValue)}`
  });
  assert.strictEqual(missingRes.status, 404, 'missing lookup should return 404');
  assertErrorEnvelope(missingRes.body);
  assert.strictEqual(missingRes.body.code, 'LOOKUP_NOT_FOUND', 'missing lookup code mismatch');
  assert.ok(
    missingRes.body.details && missingRes.body.details.kind === 'lookup_error',
    'missing lookup details.kind should be lookup_error'
  );

  console.log('identity mappings lookup contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
