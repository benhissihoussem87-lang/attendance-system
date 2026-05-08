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

async function bootstrapAgent({ baseUrl, provisioningToken, agentName, runId }) {
  const res = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: provisioningToken,
      agent_name: agentName,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(res.status, 201, 'agent bootstrap should return 201');
  assert.ok(res.body && res.body.agent_id, 'agent bootstrap should return agent_id');
  return res.body;
}

async function createProvisioningToken({ baseUrl, adminHeadersValue, runId, suffix }) {
  const res = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers: adminHeadersValue,
    body: {
      ttl_minutes: 20,
      metadata: { run_id: runId, suffix }
    }
  });
  assert.strictEqual(res.status, 201, 'provisioning token create should return 201');
  assert.ok(res.body && res.body.provisioning_token, 'provisioning token should be returned');
  return res.body.provisioning_token;
}

async function run() {
  const baseUrl = getBaseUrl();
  await ensureMode(baseUrl);
  const companyId = getCompanyId();
  const runId = Math.random().toString(16).slice(2, 10);
  const admin = { ...adminHeaders(), 'x-company-id': companyId };
  const operator = { ...operatorHeaders(), 'x-company-id': companyId };
  const viewer = { ...viewerHeaders(), 'x-company-id': companyId };

  if (requireAuth()) {
    const unauth = await requestJson({
      method: 'PUT',
      url: `${baseUrl}/api/agent-admin/sites/00000000-0000-4000-8000-000000000000/active-agent`,
      body: {
        company_id: companyId,
        agent_id: null
      }
    });
    assert.strictEqual(unauth.status, 401, 'active lease set should require auth');
    assertErrorEnvelope(unauth.body);
  }

  const createdSite = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/sites`,
    headers: operator,
    body: {
      company_id: companyId,
      site_name: `Lease Site ${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(createdSite.status, 201, 'site create should return 201');
  const siteId = createdSite.body.site_id;

  const provisioningTokenA = await createProvisioningToken({
    baseUrl,
    adminHeadersValue: admin,
    runId,
    suffix: 'a'
  });
  const provisioningTokenB = await createProvisioningToken({
    baseUrl,
    adminHeadersValue: admin,
    runId,
    suffix: 'b'
  });
  const agent1 = await bootstrapAgent({
    baseUrl,
    provisioningToken: provisioningTokenA,
    agentName: `lease-agent-a-${runId}`,
    runId
  });
  const agent2 = await bootstrapAgent({
    baseUrl,
    provisioningToken: provisioningTokenB,
    agentName: `lease-agent-b-${runId}`,
    runId
  });

  const assignA = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/sites/${encodeURIComponent(siteId)}/active-agent`,
    headers: operator,
    body: {
      company_id: companyId,
      agent_id: agent1.agent_id
    }
  });
  assert.strictEqual(assignA.status, 200, 'first active-agent assignment should return 200');
  assert.strictEqual(assignA.body.action, 'assigned', 'first active-agent assignment should be assigned');
  assert.strictEqual(assignA.body.active_lease.agent_id, agent1.agent_id, 'active lease should target agent1');

  const getActiveA = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/sites/${encodeURIComponent(siteId)}/active-agent?company_id=${encodeURIComponent(companyId)}`,
    headers: viewer
  });
  assert.strictEqual(getActiveA.status, 200, 'active-agent read should return 200');
  assert.ok(getActiveA.body.active_lease, 'active-agent read should include active_lease');
  assert.strictEqual(getActiveA.body.active_lease.agent_id, agent1.agent_id, 'active lease read should match agent1');

  const reassignSame = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/sites/${encodeURIComponent(siteId)}/active-agent`,
    headers: operator,
    body: {
      company_id: companyId,
      agent_id: agent1.agent_id
    }
  });
  assert.strictEqual(reassignSame.status, 200, 'idempotent active assignment should return 200');
  assert.strictEqual(reassignSame.body.action, 'no_change', 'same agent reassignment should be no_change');

  const assignB = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/sites/${encodeURIComponent(siteId)}/active-agent`,
    headers: operator,
    body: {
      company_id: companyId,
      agent_id: agent2.agent_id,
      metadata: {
        reason: 'operator_switch'
      }
    }
  });
  assert.strictEqual(assignB.status, 200, 'reassignment should return 200');
  assert.strictEqual(assignB.body.action, 'reassigned', 'second assignment should be reassigned');
  assert.strictEqual(assignB.body.active_lease.agent_id, agent2.agent_id, 'active lease should move to agent2');
  assert.ok(assignB.body.previous_active_lease, 'reassignment should include previous active lease');
  assert.strictEqual(assignB.body.previous_active_lease.status, 'superseded', 'previous lease should be superseded');

  const history = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/sites/${encodeURIComponent(siteId)}/active-agent/history?company_id=${encodeURIComponent(companyId)}&limit=10`,
    headers: viewer
  });
  assert.strictEqual(history.status, 200, 'active-agent history should return 200');
  assert.ok(Array.isArray(history.body.value), 'active-agent history should return value array');
  assert.ok(history.body.value.length >= 2, 'active-agent history should include multiple rows after reassignment');
  const activeLeaseRows = history.body.value.filter(row => row.status === 'active');
  assert.strictEqual(activeLeaseRows.length, 1, 'history should contain only one active lease row');
  assert.strictEqual(activeLeaseRows[0].agent_id, agent2.agent_id, 'only active lease row should target agent2');

  const release = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/sites/${encodeURIComponent(siteId)}/active-agent`,
    headers: operator,
    body: {
      company_id: companyId,
      agent_id: null,
      metadata: {
        reason: 'maintenance'
      }
    }
  });
  assert.strictEqual(release.status, 200, 'active-agent release should return 200');
  assert.strictEqual(release.body.action, 'released', 'release should report released');
  assert.strictEqual(release.body.active_lease, null, 'release should clear active lease');

  const getAfterRelease = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/sites/${encodeURIComponent(siteId)}/active-agent?company_id=${encodeURIComponent(companyId)}`,
    headers: viewer
  });
  assert.strictEqual(getAfterRelease.status, 200, 'active-agent read after release should return 200');
  assert.strictEqual(getAfterRelease.body.active_lease, null, 'active-agent read after release should return null lease');

  console.log('agent admin site active lease contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
