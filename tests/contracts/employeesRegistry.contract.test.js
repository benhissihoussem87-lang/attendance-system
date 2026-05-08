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
  const personId = `employee_contract_${runId}`;
  const body = {
    full_name: `Employee Contract ${runId}`,
    employee_code: `EMP-${runId}`,
    active: true,
    metadata: {}
  };

  const putRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(personId)}?company_id=${encodeURIComponent(companyId)}`,
    headers: { 'content-type': 'application/json' },
    body
  });
  assert.strictEqual(putRes.status, 200, 'employee PUT should return 200');
  assert.ok(putRes.body && typeof putRes.body === 'object', 'employee PUT should return a body');
  assert.strictEqual(putRes.body.person_id, personId, 'employee PUT should return matching person_id');

  const getRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(personId)}?company_id=${encodeURIComponent(companyId)}`
  });
  assert.strictEqual(getRes.status, 200, 'employee GET should return 200');
  assert.ok(getRes.body && typeof getRes.body === 'object', 'employee GET should return a body');
  assert.strictEqual(getRes.body.person_id, personId, 'employee GET should return matching person_id');

  const listRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/employees-registry?company_id=${encodeURIComponent(companyId)}&person_id=${encodeURIComponent(personId)}&limit=50&offset=0`
  });
  assert.strictEqual(listRes.status, 200, 'employee list GET should return 200');
  assert.ok(Array.isArray(listRes.body), 'employee list should return an array');
  assert.ok(
    listRes.body.some(row => row && row.person_id === personId),
    'employee list should include the inserted person_id'
  );

  console.log('employees registry contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
