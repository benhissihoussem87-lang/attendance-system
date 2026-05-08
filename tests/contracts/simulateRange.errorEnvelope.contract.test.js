const assert = require('assert');
const http = require('http');
const https = require('https');
const { getCompanyId, operatorHeaders, requireAuth, viewerHeaders } = require('./_helpers/auth');

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
  const readOnlyHeaders = viewerHeaders();

  if (authRequired) {
    const unauthRes = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/simulate/range`,
      headers: { 'content-type': 'application/json' },
      body: {
        company_id: companyId,
        person_id: 'p1',
        start_date: '2026-01-01',
        end_date: '2026-01-02'
      }
    });

    assert.strictEqual(unauthRes.status, 401, 'missing API key should return 401');
    assertErrorEnvelope(unauthRes.body);
    assert.strictEqual(unauthRes.body.code, 'UNAUTHORIZED', 'missing API key code mismatch');
    assert.ok(
      unauthRes.body.details && unauthRes.body.details.kind === 'auth',
      'missing API key details.kind should be auth'
    );

    const viewerRes = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/simulate/range`,
      headers: { ...readOnlyHeaders, 'content-type': 'application/json' },
      body: {
        company_id: companyId,
        person_id: 'p1',
        start_date: '2026-01-01',
        end_date: '2026-01-02'
      }
    });
    assert.strictEqual(viewerRes.status, 403, 'viewer API key should return 403 for simulate range write');
    assertErrorEnvelope(viewerRes.body);
    assert.strictEqual(viewerRes.body.code, 'FORBIDDEN', 'viewer forbidden code mismatch');
    assert.ok(
      viewerRes.body.details && viewerRes.body.details.kind === 'authz',
      'viewer forbidden details.kind should be authz'
    );
    assert.strictEqual(
      viewerRes.body.details.error,
      'insufficient_role',
      'viewer forbidden details.error mismatch'
    );

    const mismatchRes = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/simulate/range`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: {
        company_id: 'OTHER',
        person_id: 'p1',
        start_date: '2026-01-01',
        end_date: '2026-01-02'
      }
    });

    assert.strictEqual(mismatchRes.status, 403, 'cross-tenant request should return 403');
    assertErrorEnvelope(mismatchRes.body);
    assert.strictEqual(mismatchRes.body.code, 'FORBIDDEN', 'forbidden code mismatch');
    assert.ok(
      mismatchRes.body.details && mismatchRes.body.details.kind === 'authz',
      'forbidden details.kind should be authz'
    );
    assert.strictEqual(mismatchRes.body.details.error, 'company_mismatch', 'forbidden details.error mismatch');
  }

  // Test 1: missing person_id
  const res1 = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/simulate/range`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: {
      company_id: companyId,
      start_date: '2026-01-01',
      end_date: '2026-01-02'
    }
  });

  assert.strictEqual(res1.status, 400, 'missing person_id should return 400');
  assertErrorEnvelope(res1.body);
  assert.strictEqual(res1.body.code, 'VALIDATION_ERROR', 'missing person_id code mismatch');
  assert.strictEqual(res1.body.message, 'Validation failed', 'missing person_id message mismatch');
  assert.ok(
    res1.body.details && res1.body.details.kind === 'validation',
    'missing person_id details.kind should be validation'
  );
  assert.strictEqual(
    res1.body.details.error,
    'person_id_required',
    'missing person_id details.error mismatch'
  );

  // Test 2: invalid date format
  const res2 = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/simulate/range`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: {
      company_id: companyId,
      person_id: 'test',
      start_date: 'not-a-date',
      end_date: '2026-01-02'
    }
  });

  assert.strictEqual(res2.status, 400, 'invalid date should return 400');
  assertErrorEnvelope(res2.body);
  assert.strictEqual(res2.body.code, 'VALIDATION_ERROR', 'invalid date code mismatch');
  assert.ok(
    res2.body.details && res2.body.details.kind === 'validation',
    'invalid date details.kind should be validation'
  );

  console.log('simulate range error envelope contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
