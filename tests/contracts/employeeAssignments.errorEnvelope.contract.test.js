const assert = require('assert');
const http = require('http');
const https = require('https');
const { getCompanyId, operatorHeaders, requireAuth } = require('./_helpers/auth');

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

async function run() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();
  const authRequired = requireAuth();
  const authHeaders = operatorHeaders();

  if (authRequired) {
    const unauthRes = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/employee-assignments?company_id=${encodeURIComponent(companyId)}`
    });
    assert.strictEqual(unauthRes.status, 401, 'missing API key should return 401');
    assertErrorEnvelope(unauthRes.body);
    assert.strictEqual(unauthRes.body.code, 'UNAUTHORIZED', 'missing API key code mismatch');
    assert.ok(
      unauthRes.body.details && unauthRes.body.details.kind === 'auth',
      'missing API key details.kind should be auth'
    );
  }

  const mismatchRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employee-assignments?company_id=${encodeURIComponent(companyId)}`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: { company_id: 'OTHER' }
  });

  assert.strictEqual(
    mismatchRes.status,
    authRequired ? 403 : 400,
    `company_id mismatch should return ${authRequired ? 403 : 400}`
  );
  assertErrorEnvelope(mismatchRes.body);
  if (authRequired) {
    assert.strictEqual(mismatchRes.body.code, 'FORBIDDEN', 'forbidden code mismatch');
    assert.ok(
      mismatchRes.body.details && mismatchRes.body.details.kind === 'authz',
      'forbidden details.kind should be authz'
    );
    assert.strictEqual(
      mismatchRes.body.details.error,
      'company_mismatch',
      'forbidden details.error mismatch'
    );
  } else {
    assert.strictEqual(mismatchRes.body.code, 'VALIDATION_ERROR', 'validation code mismatch');
    assert.strictEqual(mismatchRes.body.message, 'Validation failed', 'validation message mismatch');
    assert.ok(
      mismatchRes.body.details && mismatchRes.body.details.kind === 'validation',
      'validation details.kind should be validation'
    );
    assert.strictEqual(
      mismatchRes.body.details.error,
      'company_id_mismatch',
      'validation details.error mismatch'
    );
  }

  const missingPersonRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employee-assignments?company_id=${encodeURIComponent(companyId)}`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: {}
  });

  assert.strictEqual(missingPersonRes.status, 400, 'missing person_id should return 400');
  assertErrorEnvelope(missingPersonRes.body);
  assert.strictEqual(missingPersonRes.body.code, 'VALIDATION_ERROR', 'validation code mismatch');
  assert.strictEqual(missingPersonRes.body.message, 'Validation failed', 'validation message mismatch');
  assert.ok(
    missingPersonRes.body.details && missingPersonRes.body.details.kind === 'validation',
    'validation details.kind should be validation'
  );
  assert.strictEqual(
    missingPersonRes.body.details.error,
    'person_id_required',
    'validation details.error mismatch'
  );

  console.log('employee assignments error envelope contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
