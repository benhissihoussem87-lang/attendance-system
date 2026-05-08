const assert = require('assert');
const http = require('http');
const https = require('https');
const { adminHeaders, viewerHeaders, getCompanyId, requireAuth } = require('./_helpers/auth');

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
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function getBaseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
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
  const runId = Math.random().toString(16).slice(2, 10);
  const admin = {
    ...adminHeaders(),
    'x-company-id': companyId
  };
  const viewer = {
    ...viewerHeaders(),
    'x-company-id': companyId
  };

  const tokenRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers: admin,
    body: {
      ttl_minutes: 20,
      metadata: { run_id: runId, purpose: 'runtime_identity_contract' }
    }
  });
  assert.strictEqual(tokenRes.status, 201, 'provisioning token create should return 201');

  const bootstrapRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: tokenRes.body.provisioning_token,
      agent_name: `runtime-agent-${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'bootstrap should return 201');
  assert.ok(bootstrapRes.body && bootstrapRes.body.auth_token, 'bootstrap should return auth_token');
  assert.ok(bootstrapRes.body.active_runtime_identity_id, 'bootstrap should return active_runtime_identity_id');
  assert.strictEqual(bootstrapRes.body.identity_status, 'active', 'bootstrap identity_status should be active');

  const agentId = bootstrapRes.body.agent_id;
  const firstToken = bootstrapRes.body.auth_token;
  const firstIdentityId = bootstrapRes.body.active_runtime_identity_id;
  const firstCredentialVersion = Number.isInteger(bootstrapRes.body.credential_version)
    ? bootstrapRes.body.credential_version
    : 1;

  const readRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(agentId)}/runtime-identity?company_id=${encodeURIComponent(companyId)}&history_limit=5`,
    headers: viewer
  });
  assert.strictEqual(readRes.status, 200, 'runtime identity read should return 200');
  assert.strictEqual(readRes.body.agent_id, agentId, 'read should be scoped to agent');
  assert.strictEqual(readRes.body.identity_status, 'active', 'agent identity should be active after bootstrap');
  assert.strictEqual(readRes.body.active_runtime_identity_id, firstIdentityId, 'active identity should match bootstrap');
  assert.ok(Array.isArray(readRes.body.runtime_identity_history), 'runtime identity history should be an array');

  const oldHeartbeatBeforeRotate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/heartbeat`,
    headers: {
      authorization: `Bearer ${firstToken}`
    },
    body: { ping: true }
  });
  assert.strictEqual(oldHeartbeatBeforeRotate.status, 200, 'heartbeat should work before identity rotation');

  const reissueRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(agentId)}/runtime-identity/reissue`,
    headers: admin,
    body: {
      company_id: companyId,
      reason: 'contract_reissue_check',
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(reissueRes.status, 201, 'runtime identity reissue should return 201');
  assert.ok(reissueRes.body && reissueRes.body.auth_token, 'reissue should return auth_token');
  assert.ok(reissueRes.body.active_runtime_identity_id, 'reissue should return new active runtime identity id');
  assert.notStrictEqual(reissueRes.body.active_runtime_identity_id, firstIdentityId, 'reissue should replace identity id');
  assert.ok(
    Number.isInteger(reissueRes.body.credential_version)
      && reissueRes.body.credential_version >= firstCredentialVersion + 1,
    'reissue should increment credential_version'
  );

  const secondToken = reissueRes.body.auth_token;
  const secondIdentityId = reissueRes.body.active_runtime_identity_id;

  const oldHeartbeatAfterRotate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/heartbeat`,
    headers: {
      authorization: `Bearer ${firstToken}`
    },
    body: { ping: true }
  });
  assert.strictEqual(oldHeartbeatAfterRotate.status, 401, 'old token should be rejected after reissue');

  const newHeartbeatAfterRotate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/heartbeat`,
    headers: {
      authorization: `Bearer ${secondToken}`
    },
    body: { ping: true }
  });
  assert.strictEqual(newHeartbeatAfterRotate.status, 200, 'new token should authenticate after reissue');

  const revokeRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(agentId)}/runtime-identity/revoke`,
    headers: admin,
    body: {
      company_id: companyId,
      reason: 'contract_revoke_check',
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(revokeRes.status, 200, 'runtime identity revoke should return 200');
  assert.strictEqual(
    revokeRes.body.revoked_runtime_identity_id,
    secondIdentityId,
    'revoke should target current active identity'
  );
  assert.strictEqual(revokeRes.body.identity_status, 'revoked', 'agent identity_status should be revoked');

  const newHeartbeatAfterRevoke = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/heartbeat`,
    headers: {
      authorization: `Bearer ${secondToken}`
    },
    body: { ping: true }
  });
  assert.strictEqual(newHeartbeatAfterRevoke.status, 401, 'token should be rejected after revoke');

  const readAfterRevokeRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(agentId)}/runtime-identity?company_id=${encodeURIComponent(companyId)}&history_limit=5`,
    headers: viewer
  });
  assert.strictEqual(readAfterRevokeRes.status, 200, 'runtime identity read after revoke should return 200');
  assert.strictEqual(readAfterRevokeRes.body.identity_status, 'revoked', 'read model should show revoked identity_status');
  assert.strictEqual(readAfterRevokeRes.body.active_runtime_identity_id, null, 'active runtime identity should be cleared after revoke');
  assert.ok(
    Array.isArray(readAfterRevokeRes.body.runtime_identity_history)
      && readAfterRevokeRes.body.runtime_identity_history.some(item => {
        return item && item.identity_id === secondIdentityId && item.status === 'revoked';
      }),
    'history should include revoked identity'
  );

  const mismatchRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(agentId)}/runtime-identity?company_id=OTHER`,
    headers: admin
  });
  assert.strictEqual(
    mismatchRes.status,
    requireAuth() ? 403 : 404,
    `runtime identity tenant mismatch should return ${requireAuth() ? 403 : 404}`
  );

  console.log('agent admin runtime identity contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
