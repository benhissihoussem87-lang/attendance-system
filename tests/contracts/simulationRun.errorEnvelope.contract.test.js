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
  const personId = `simulation-run-${Math.random().toString(16).slice(2, 10)}`;

  const validBody = {
    company_id: companyId,
    person_id: personId,
    start_date: '2026-01-01',
    end_date: '2026-01-02'
  };

  if (authRequired) {
    const unauthRes = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/simulation/run`,
      headers: { 'content-type': 'application/json' },
      body: validBody
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
      url: `${baseUrl}/api/simulation/run`,
      headers: { ...readOnlyHeaders, 'content-type': 'application/json' },
      body: validBody
    });
    assert.strictEqual(viewerRes.status, 403, 'viewer API key should return 403 for simulation run write');
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
      url: `${baseUrl}/api/simulation/run`,
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: {
        ...validBody,
        company_id: 'OTHER'
      }
    });
    assert.strictEqual(mismatchRes.status, 403, 'cross-tenant request should return 403');
    assertErrorEnvelope(mismatchRes.body);
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
  }

  const successRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/simulation/run`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: validBody
  });

  assert.strictEqual(successRes.status, 200, 'simulation run should return 200');
  assert.ok(successRes.body && typeof successRes.body === 'object', 'simulation run response body is required');
  assert.ok(successRes.body.summary && typeof successRes.body.summary === 'object', 'summary is required');
  assert.strictEqual(typeof successRes.body.summary.days_total, 'number', 'summary.days_total should be number');
  assert.ok(Array.isArray(successRes.body.details), 'details should be an array');
  assert.strictEqual(successRes.body.legacy_surface, true, 'legacy_surface should be true');
  assert.strictEqual(
    successRes.body.bounded_mode,
    'baseline_delta_only',
    'bounded_mode mismatch'
  );
  assert.ok(Array.isArray(successRes.body.limitations), 'limitations should be array');

  const unsupportedRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/simulation/run`,
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: {
      ...validBody,
      policy_override: { late_threshold_minutes: 15 }
    }
  });
  assert.strictEqual(unsupportedRes.status, 400, 'unsupported legacy fields should return 400');
  assertErrorEnvelope(unsupportedRes.body);
  assert.strictEqual(unsupportedRes.body.code, 'VALIDATION_ERROR', 'unsupported fields code mismatch');
  assert.ok(
    unsupportedRes.body.details && unsupportedRes.body.details.kind === 'validation',
    'unsupported fields details.kind should be validation'
  );
  assert.strictEqual(
    unsupportedRes.body.details.error,
    'legacy_surface_unsupported_fields',
    'unsupported fields details.error mismatch'
  );

  console.log('simulation run error envelope contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
