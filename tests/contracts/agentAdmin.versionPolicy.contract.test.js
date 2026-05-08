const assert = require('assert');
const http = require('http');
const https = require('https');
const {
  adminHeaders,
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

function assertPolicyEntry(row, { allowNull = false } = {}) {
  if (allowNull && (row === null || row === undefined)) {
    return;
  }
  assert.ok(row && typeof row === 'object', 'policy entry should be object');
  assert.ok(['global', 'company'].includes(row.policy_scope), 'policy_scope should be global|company');
  assert.strictEqual(typeof row.minimum_supported_version, 'string', 'minimum_supported_version should be string');
  assert.ok(row.minimum_supported_version.length > 0, 'minimum_supported_version should be non-empty');
  if (row.target_version !== null && row.target_version !== undefined) {
    assert.strictEqual(typeof row.target_version, 'string', 'target_version should be string when provided');
  }
  assert.ok(['stable', 'beta'].includes(row.rollout_channel), 'rollout_channel should be stable|beta');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'metadata'), 'metadata should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'updated_by_key_id'), 'updated_by_key_id should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'created_at'), 'created_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'updated_at'), 'updated_at should be present');
}

function assertPolicyReadShape(body) {
  assert.ok(body && typeof body === 'object', 'body should be object');
  assert.strictEqual(typeof body.company_id, 'string', 'company_id should be string');
  assertPolicyEntry(body.global_policy);
  assertPolicyEntry(body.company_policy_override, { allowNull: true });
  assertPolicyEntry(body.effective_policy);
  assertPolicyEntry(body.updated_override, { allowNull: true });
  assert.ok(['global', 'company_override'].includes(body.effective_policy.policy_source), 'effective policy source should be explicit');
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

  if (authRequired) {
    const unauth = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/version-policy?company_id=${encodeURIComponent(companyId)}`
    });
    assert.strictEqual(unauth.status, 401, 'version-policy read should require auth');
  }

  const readInitial = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/version-policy?company_id=${encodeURIComponent(companyId)}`,
    headers: viewer
  });
  assert.strictEqual(readInitial.status, 200, 'version-policy read should return 200');
  assertPolicyReadShape(readInitial.body);

  if (authRequired) {
    const viewerWrite = await requestJson({
      method: 'PUT',
      url: `${baseUrl}/api/agent-admin/version-policy?company_id=${encodeURIComponent(companyId)}`,
      headers: viewer,
      body: {
        minimum_supported_version: '1.2.3'
      }
    });
    assert.strictEqual(viewerWrite.status, 403, 'viewer should not update version policy');
  }

  const invalidWrite = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/version-policy?company_id=${encodeURIComponent(companyId)}`,
    headers: admin,
    body: {
      minimum_supported_version: 'bad-version'
    }
  });
  assert.strictEqual(invalidWrite.status, 400, 'invalid semver policy update should return 400');

  const writeRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/version-policy?company_id=${encodeURIComponent(companyId)}`,
    headers: admin,
    body: {
      minimum_supported_version: '1.2.3',
      target_version: '1.4.0',
      rollout_channel: 'stable',
      metadata: {
        source: 'contract_test'
      }
    }
  });
  assert.strictEqual(writeRes.status, 200, 'version policy update should return 200');
  assertPolicyReadShape(writeRes.body);
  assert.ok(writeRes.body.company_policy_override, 'company override should exist after update');
  assert.strictEqual(writeRes.body.effective_policy.policy_source, 'company_override', 'effective policy should use company override');
  assert.strictEqual(writeRes.body.effective_policy.minimum_supported_version, '1.2.3');
  assert.strictEqual(writeRes.body.effective_policy.target_version, '1.4.0');

  const readAfter = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/version-policy?company_id=${encodeURIComponent(companyId)}`,
    headers: viewer
  });
  assert.strictEqual(readAfter.status, 200, 'version policy read after update should return 200');
  assert.strictEqual(readAfter.body.effective_policy.minimum_supported_version, '1.2.3');
  assert.strictEqual(readAfter.body.effective_policy.target_version, '1.4.0');
  assert.strictEqual(readAfter.body.effective_policy.policy_source, 'company_override');

  console.log('agent admin version policy contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
