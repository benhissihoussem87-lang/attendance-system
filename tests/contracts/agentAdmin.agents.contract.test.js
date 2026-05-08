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

function assertAgentEntryShape(row) {
  assert.ok(row && typeof row === 'object', 'agent entry should be object');
  assert.strictEqual(typeof row.id, 'string', 'id should be string');
  assert.strictEqual(typeof row.agent_name, 'string', 'agent_name should be string');
  assert.strictEqual(typeof row.status, 'string', 'status should be string');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'identity_status'), 'identity_status should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'active_runtime_identity_id'), 'active_runtime_identity_id should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'runtime_identity_status'), 'runtime_identity_status should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'runtime_identity_issued_at'), 'runtime_identity_issued_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'runtime_identity_revoked_at'), 'runtime_identity_revoked_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'last_seen_at'), 'last_seen_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'last_heartbeat_at'), 'last_heartbeat_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_id'), 'site_id should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_key'), 'site_key should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_name'), 'site_name should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_status'), 'site_status should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_active_lease_id'), 'site_active_lease_id should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_active_agent_id'), 'site_active_agent_id should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_active_leased_at'), 'site_active_leased_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'is_site_active_runtime'), 'is_site_active_runtime should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_runtime_reporting_agent_id'), 'site_runtime_reporting_agent_id should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_runtime_health_status'), 'site_runtime_health_status should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_runtime_health_reason'), 'site_runtime_health_reason should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_runtime_reported_at'), 'site_runtime_reported_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_runtime_last_heartbeat_at'), 'site_runtime_last_heartbeat_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_runtime_last_poll_at'), 'site_runtime_last_poll_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'site_runtime_reported_stale'), 'site_runtime_reported_stale should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'agent_reported_version'), 'agent_reported_version should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'agent_reported_rollout_channel'), 'agent_reported_rollout_channel should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'agent_version_reported_at'), 'agent_version_reported_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'version_support_status'), 'version_support_status should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'version_support_level'), 'version_support_level should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'version_support_reason'), 'version_support_reason should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'version_reported_stale'), 'version_reported_stale should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'version_stale_after_minutes'), 'version_stale_after_minutes should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'minimum_supported_version'), 'minimum_supported_version should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'target_version'), 'target_version should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'policy_rollout_channel'), 'policy_rollout_channel should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'version_policy_source'), 'version_policy_source should be present');
  assert.strictEqual(typeof row.created_at, 'string', 'created_at should be string');

  const keys = Object.keys(row).sort();
  const expected = [
    'active_runtime_identity_id',
    'agent_name',
    'agent_reported_rollout_channel',
    'agent_reported_version',
    'agent_version_reported_at',
    'created_at',
    'id',
    'identity_status',
    'is_site_active_runtime',
    'last_heartbeat_at',
    'last_seen_at',
    'minimum_supported_version',
    'policy_rollout_channel',
    'runtime_identity_issued_at',
    'runtime_identity_revoked_at',
    'runtime_identity_status',
    'site_active_agent_id',
    'site_active_lease_id',
    'site_active_leased_at',
    'site_id',
    'site_key',
    'site_name',
    'site_runtime_health_reason',
    'site_runtime_health_status',
    'site_runtime_last_heartbeat_at',
    'site_runtime_last_poll_at',
    'site_runtime_reported_at',
    'site_runtime_reported_stale',
    'site_runtime_reporting_agent_id',
    'site_status',
    'status',
    'target_version',
    'version_policy_source',
    'version_reported_stale',
    'version_stale_after_minutes',
    'version_support_level',
    'version_support_reason',
    'version_support_status'
  ];
  assert.deepStrictEqual(keys, expected, 'agent entry should expose only operational fields');
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
  const runId = Math.random().toString(16).slice(2, 10);
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
      url: `${baseUrl}/api/agent-admin/agents?company_id=${encodeURIComponent(companyId)}`
    });
    assert.strictEqual(unauth.status, 401, 'agents listing should require auth');
    assertErrorEnvelope(unauth.body);

    const viewerAllowed = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/agents?company_id=${encodeURIComponent(companyId)}`,
      headers: viewer
    });
    assert.strictEqual(viewerAllowed.status, 200, 'viewer should be allowed to list agents');

    const operatorAllowed = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/agents?company_id=${encodeURIComponent(companyId)}`,
      headers: operator
    });
    assert.strictEqual(operatorAllowed.status, 200, 'operator should be allowed to list agents');
  }

  const mismatch = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/agents?company_id=OTHER`,
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

  const tokenRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers: admin,
    body: {
      ttl_minutes: 20,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(tokenRes.status, 201, 'provisioning token create should return 201');

  const bootstrapRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: tokenRes.body.provisioning_token,
      agent_name: `ops-agent-${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'agent bootstrap should return 201');

  const listRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/agents?company_id=${encodeURIComponent(companyId)}&status=active&limit=100`,
    headers: viewer
  });
  assert.strictEqual(listRes.status, 200, 'agents listing should return 200');
  assert.ok(listRes.body && Array.isArray(listRes.body.value), 'agents listing should return value array');
  const created = listRes.body.value.find(row => row && row.id === bootstrapRes.body.agent_id);
  assert.ok(created, 'listing should include newly bootstrapped agent');
  assertAgentEntryShape(created);

  const seenFuture = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/agents?company_id=${encodeURIComponent(companyId)}&seen_since=2999-01-01T00:00:00Z`,
    headers: admin
  });
  assert.strictEqual(seenFuture.status, 200, 'seen_since filter should return 200');
  assert.ok(Array.isArray(seenFuture.body.value), 'seen_since response should include value array');
  const shouldBeFilteredOut = seenFuture.body.value.find(row => row && row.id === bootstrapRes.body.agent_id);
  assert.strictEqual(shouldBeFilteredOut, undefined, 'future seen_since should filter out current agent');

  console.log('agent admin agents contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
