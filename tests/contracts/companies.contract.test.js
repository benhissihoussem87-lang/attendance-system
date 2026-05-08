const assert = require('assert');
const http = require('http');
const https = require('https');
const {
  adminHeaders,
  viewerHeaders,
  requireAuth,
  getCompanyId
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
    if (body !== undefined) {
      payload = JSON.stringify(body);
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            return reject(new Error(`Expected JSON response from ${url}, got ${data.slice(0, 200)}`));
          }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getBaseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
}

function assertErrorEnvelope(body) {
  assert.ok(body && typeof body === 'object', 'error body is required');
  assert.strictEqual(typeof body.error, 'string');
  assert.strictEqual(typeof body.code, 'string');
  assert.strictEqual(typeof body.message, 'string');
}

async function run() {
  const baseUrl = getBaseUrl();
  const runId = Math.random().toString(16).slice(2, 10);
  const companyId = `CONTRACT-${runId}`.toUpperCase();
  const admin = adminHeaders();
  const viewer = { ...viewerHeaders(), 'x-company-id': getCompanyId() };

  if (requireAuth()) {
    const unauth = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/companies`
    });
    assert.strictEqual(unauth.status, 401, 'company list should require auth');
    assertErrorEnvelope(unauth.body);
  }

  const invalid = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/companies`,
    headers: admin,
    body: {
      company_id: companyId,
      display_name: `Contract Company ${runId}`,
      timezone: 'Not/AZone'
    }
  });
  assert.strictEqual(invalid.status, 400, 'invalid timezone should return 400');
  assertErrorEnvelope(invalid.body);
  assert.strictEqual(invalid.body.details.error, 'timezone_invalid');

  const created = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/companies`,
    headers: admin,
    body: {
      company_id: companyId,
      display_name: `Contract Company ${runId}`,
      country: 'TN',
      timezone: 'Africa/Tunis'
    }
  });
  assert.strictEqual(created.status, 201, 'company create should return 201');
  assert.strictEqual(created.body.company_id, companyId);
  assert.strictEqual(created.body.display_name, `Contract Company ${runId}`);
  assert.strictEqual(created.body.timezone, 'Africa/Tunis');
  assert.strictEqual(created.body.is_active, true);

  const duplicate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/companies`,
    headers: admin,
    body: {
      company_id: companyId,
      display_name: `Contract Company ${runId}`
    }
  });
  assert.strictEqual(duplicate.status, 409, 'duplicate company should return 409');
  assertErrorEnvelope(duplicate.body);
  assert.strictEqual(duplicate.body.details.error, 'company_already_exists');

  const list = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/companies?company_id=${encodeURIComponent(getCompanyId())}`,
    headers: viewer
  });
  assert.strictEqual(list.status, 200, 'company list should return 200');
  assert.ok(Array.isArray(list.body.value), 'company list should return value array');

  console.log('companies contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
