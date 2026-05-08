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

function buildRepairBody(companyId, overrides = {}) {
  return {
    company_id: companyId,
    anomaly_type: 'canonical_device_missing_active_device_uid_alias',
    target_device_uid: 'zkteco:sn:UNKNOWN-LIFECYCLE-REPAIR-CONTRACT',
    apply: false,
    ...overrides
  };
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
  const operator = {
    ...operatorHeaders(),
    'x-company-id': companyId
  };
  const viewer = {
    ...viewerHeaders(),
    'x-company-id': companyId
  };

  if (authRequired) {
    const unauth = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/repair`,
      body: buildRepairBody(companyId)
    });
    assert.strictEqual(unauth.status, 401, 'repair endpoint should require auth');
    assertErrorEnvelope(unauth.body);

    const viewerDenied = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/repair`,
      headers: viewer,
      body: buildRepairBody(companyId)
    });
    assert.strictEqual(viewerDenied.status, 403, 'viewer should not be allowed to execute repair endpoint');
    assertErrorEnvelope(viewerDenied.body);
  }

  const mismatch = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/repair`,
    headers: operator,
    body: buildRepairBody('OTHER')
  });
  const expectedMismatchStatus = authRequired ? 403 : 400;
  assert.strictEqual(
    mismatch.status,
    expectedMismatchStatus,
    `company mismatch should return ${expectedMismatchStatus}`
  );
  assertErrorEnvelope(mismatch.body);

  const invalidApply = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/repair`,
    headers: admin,
    body: buildRepairBody(companyId, {
      apply: 'later'
    })
  });
  assert.strictEqual(invalidApply.status, 400, 'invalid apply flag should return 400');
  assertErrorEnvelope(invalidApply.body);

  const unsupported = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/repair`,
    headers: operator,
    body: buildRepairBody(companyId, {
      anomaly_type: 'managed_bridge_missing_active_binding'
    })
  });
  assert.strictEqual(unsupported.status, 400, 'unsupported anomaly type should return 400');
  assertErrorEnvelope(unsupported.body);
  assert.ok(
    unsupported.body
      && unsupported.body.details
      && unsupported.body.details.error === 'lifecycle_repair_unsupported_anomaly_type',
    'unsupported anomaly response should expose lifecycle_repair_unsupported_anomaly_type'
  );
  assert.ok(
    Array.isArray(unsupported.body.details.supported_anomaly_types),
    'unsupported anomaly response should return supported_anomaly_types'
  );
  assert.ok(
    unsupported.body.details.supported_anomaly_types.includes('canonical_device_missing_active_device_uid_alias'),
    'supported_anomaly_types should include canonical_device_missing_active_device_uid_alias'
  );

  const unknownTarget = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/repair`,
    headers: operator,
    body: buildRepairBody(companyId, {
      apply: true
    })
  });
  assert.strictEqual(unknownTarget.status, 404, 'unknown target should return 404');
  assertErrorEnvelope(unknownTarget.body);
  assert.ok(
    unknownTarget.body
      && unknownTarget.body.details
      && unknownTarget.body.details.error === 'device_not_found',
    'unknown target response should expose device_not_found'
  );

  console.log('agent admin lifecycle reconciliation repair contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
