const assert = require('assert');
const http = require('http');
const https = require('https');
const { adminHeaders, getCompanyId } = require('./_helpers/auth');

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
        return resolve({ status: res.statusCode, body: parsed });
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

async function ensureMode(baseUrl, headers) {
  const res = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/ops/test/mode`,
    headers
  });
  if (res.status === 404) {
    throw new Error('ALLOW_TEST_ENDPOINTS must be enabled for this contract test');
  }
  assert.strictEqual(res.status, 200, 'mode endpoint should return 200');
}

async function createAgent(baseUrl, headers, companyId, runId, suffix) {
  const tokenRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers,
    body: {
      company_id: companyId,
      ttl_minutes: 20,
      metadata: { run_id: runId, purpose: `binding-queue-${suffix}` }
    }
  });
  assert.strictEqual(tokenRes.status, 201, 'provisioning token create should return 201');

  const bootstrapRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: tokenRes.body.provisioning_token,
      agent_name: `binding-queue-agent-${suffix}-${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'agent bootstrap should return 201');
  assert.ok(bootstrapRes.body && bootstrapRes.body.agent_id, 'bootstrap response should include agent_id');
  return bootstrapRes.body.agent_id;
}

async function queuePull(baseUrl, headers, companyId, agentId, deviceUid) {
  return requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(agentId)}/commands/pull-device-events`,
    headers,
    body: {
      company_id: companyId,
      device_uid: deviceUid,
      options: {
        host: '192.168.20.11',
        lookback_minutes: 60,
        safety_window_minutes: 5,
        max_events: 200
      }
    }
  });
}

async function bindAgent(baseUrl, headers, companyId, deviceUid, agentId, reason) {
  return requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/managing-agent-binding`,
    headers,
    body: {
      company_id: companyId,
      agent_id: agentId,
      reason
    }
  });
}

async function run() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();
  const runId = Math.random().toString(16).slice(2, 10);
  const headers = {
    ...adminHeaders(),
    'x-company-id': companyId
  };

  await ensureMode(baseUrl, headers);

  const agentA = await createAgent(baseUrl, headers, companyId, runId, 'a');
  const agentB = await createAgent(baseUrl, headers, companyId, runId, 'b');
  const deviceUid = `zkteco:sn:BIND-QUEUE-${runId}`;

  const createDevice = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_name: `Binding Queue Device ${runId}`,
      active: true,
      metadata: {
        ip: '192.168.20.11'
      }
    }
  });
  assert.strictEqual(createDevice.status, 200, 'device upsert should return 200');
  assert.strictEqual(createDevice.body.managed_status, 'managed', 'device should be managed for queue eligibility checks');

  const queueWithoutBinding = await queuePull(baseUrl, headers, companyId, agentA, deviceUid);
  assert.strictEqual(queueWithoutBinding.status, 409, 'queue should fail when no managing-agent binding exists');
  assert.strictEqual(
    queueWithoutBinding.body && queueWithoutBinding.body.details && queueWithoutBinding.body.details.error,
    'device_managing_agent_binding_missing',
    'missing binding queue error should be explicit'
  );

  const firstBind = await bindAgent(baseUrl, headers, companyId, deviceUid, agentA, 'contract_first_bind');
  assert.strictEqual(firstBind.status, 200, 'first managing-agent bind should return 200');
  assert.strictEqual(firstBind.body.binding_action, 'bound', 'first bind should return bound action');
  assert.strictEqual(firstBind.body.canonical_device_uid, deviceUid, 'binding should target canonical device uid');
  assert.strictEqual(firstBind.body.binding.agent_id, agentA, 'binding payload should reference the active managing agent');

  const idempotentBind = await bindAgent(baseUrl, headers, companyId, deviceUid, agentA, 'contract_idempotent_bind');
  assert.strictEqual(idempotentBind.status, 200, 'idempotent bind should return 200');
  assert.strictEqual(idempotentBind.body.binding_action, 'noop', 'idempotent bind should not create duplicate active bindings');

  const queueWrongAgent = await queuePull(baseUrl, headers, companyId, agentB, deviceUid);
  assert.strictEqual(queueWrongAgent.status, 409, 'queue should fail when requested agent differs from active managing binding');
  assert.strictEqual(
    queueWrongAgent.body && queueWrongAgent.body.details && queueWrongAgent.body.details.error,
    'device_managing_agent_binding_conflict',
    'binding conflict queue error should be explicit'
  );
  assert.strictEqual(
    queueWrongAgent.body.details.bound_agent_id,
    agentA,
    'binding conflict should expose currently bound managing agent'
  );
  assert.strictEqual(
    queueWrongAgent.body.details.requested_agent_id,
    agentB,
    'binding conflict should expose requested agent id'
  );

  const rebind = await bindAgent(baseUrl, headers, companyId, deviceUid, agentB, 'contract_rebind');
  assert.strictEqual(rebind.status, 200, 'rebind should return 200');
  assert.strictEqual(rebind.body.binding_action, 'rebound', 'rebind should return rebound action');
  assert.strictEqual(rebind.body.previous_agent_id, agentA, 'rebind should expose previous active managing agent');
  assert.strictEqual(rebind.body.binding.agent_id, agentB, 'rebind should activate requested managing agent');

  const queueAfterRebind = await queuePull(baseUrl, headers, companyId, agentB, deviceUid);
  assert.strictEqual(queueAfterRebind.status, 201, 'queue should succeed once requested agent owns active binding');
  assert.strictEqual(queueAfterRebind.body.command_type, 'PULL_DEVICE_EVENTS');
  assert.strictEqual(queueAfterRebind.body.command_payload.device_uid, deviceUid);

  console.log('agent admin managing binding + queue enforcement contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
