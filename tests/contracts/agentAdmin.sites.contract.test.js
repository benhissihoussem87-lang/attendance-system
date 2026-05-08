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

async function run() {
  const baseUrl = getBaseUrl();
  await ensureMode(baseUrl);
  const companyId = getCompanyId();
  const runId = Math.random().toString(16).slice(2, 10);
  const admin = { ...adminHeaders(), 'x-company-id': companyId };
  const operator = { ...operatorHeaders(), 'x-company-id': companyId };
  const viewer = { ...viewerHeaders(), 'x-company-id': companyId };

  if (requireAuth()) {
    const unauthCreate = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/sites`,
      body: {
        company_id: companyId,
        site_name: 'Unauthorized Create'
      }
    });
    assert.strictEqual(unauthCreate.status, 401, 'site create should require auth');
    assertErrorEnvelope(unauthCreate.body);
  }

  const created = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/sites`,
    headers: operator,
    body: {
      company_id: companyId,
      site_name: `HQ ${runId}`,
      metadata: {
        purpose: 'contract_test'
      }
    }
  });
  assert.strictEqual(created.status, 201, 'site create should return 201');
  assert.ok(created.body && created.body.site_id, 'site create should return site_id');
  assert.strictEqual(created.body.company_id, companyId, 'site create should return company_id');
  assert.strictEqual(created.body.status, 'active', 'site create should default status active');
  assert.ok(created.body.site_key, 'site create should return site_key');

  const listRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/sites?company_id=${encodeURIComponent(companyId)}&status=active`,
    headers: viewer
  });
  assert.strictEqual(listRes.status, 200, 'site list should return 200');
  assert.ok(Array.isArray(listRes.body.value), 'site list value should be array');
  const listed = listRes.body.value.find(row => row.site_id === created.body.site_id);
  assert.ok(listed, 'site list should include created site');

  const getRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/sites/${encodeURIComponent(created.body.site_id)}?company_id=${encodeURIComponent(companyId)}`,
    headers: viewer
  });
  assert.strictEqual(getRes.status, 200, 'site get should return 200');
  assert.strictEqual(getRes.body.site_id, created.body.site_id, 'site get should return requested site');

  const updated = await requestJson({
    method: 'PATCH',
    url: `${baseUrl}/api/agent-admin/sites/${encodeURIComponent(created.body.site_id)}`,
    headers: operator,
    body: {
      company_id: companyId,
      status: 'inactive',
      metadata: {
        purpose: 'contract_test',
        updated: true
      }
    }
  });
  assert.strictEqual(updated.status, 200, 'site patch should return 200');
  assert.strictEqual(updated.body.status, 'inactive', 'site patch should update status');
  assert.strictEqual(updated.body.metadata.updated, true, 'site patch should update metadata');

  const tokenRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers: admin,
    body: {
      ttl_minutes: 15,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(tokenRes.status, 201, 'provisioning token should return 201');

  const bootstrapRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: tokenRes.body.provisioning_token,
      agent_name: `site-agent-${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'bootstrap should return 201');

  const assignAgent = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/site`,
    headers: operator,
    body: {
      company_id: companyId,
      site_id: created.body.site_id
    }
  });
  assert.strictEqual(assignAgent.status, 200, 'agent site assignment should return 200');
  assert.strictEqual(assignAgent.body.site_id, created.body.site_id, 'agent assignment should set site_id');

  const agentsRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/agents?company_id=${encodeURIComponent(companyId)}&limit=100`,
    headers: viewer
  });
  assert.strictEqual(agentsRes.status, 200, 'agents list should return 200');
  const assignedAgent = agentsRes.body.value.find(row => row.id === bootstrapRes.body.agent_id);
  assert.ok(assignedAgent, 'assigned agent should be present');
  assert.strictEqual(assignedAgent.site_id, created.body.site_id, 'agents list should expose site_id');

  const deviceUid = `zkteco:sn:SITE-${runId}`;
  const createDevice = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_name: `Site Device ${runId}`,
      metadata: {
        source: 'contract_test'
      }
    }
  });
  assert.strictEqual(createDevice.status, 200, 'device fixture create should return 200');

  const assignDevice = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/site`,
    headers: operator,
    body: {
      company_id: companyId,
      site_id: created.body.site_id
    }
  });
  assert.strictEqual(assignDevice.status, 200, 'device site assignment should return 200');
  assert.strictEqual(assignDevice.body.site_id, created.body.site_id, 'device assignment should set site_id');
  assert.strictEqual(assignDevice.body.canonical_device_uid, deviceUid, 'device assignment should expose canonical uid');

  const deviceGet = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers: viewer
  });
  assert.strictEqual(deviceGet.status, 200, 'device get should return 200');
  assert.strictEqual(deviceGet.body.site_id, created.body.site_id, 'device get should expose site_id');
  assert.strictEqual(deviceGet.body.site_key, created.body.site_key, 'device get should expose site_key');
  assert.strictEqual(deviceGet.body.site_name, created.body.site_name, 'device get should expose site_name');

  console.log('agent admin sites contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
