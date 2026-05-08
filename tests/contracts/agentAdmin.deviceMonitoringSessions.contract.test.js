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
    if (body !== undefined) {
      payload = JSON.stringify(body);
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try {
            parsed = JSON.parse(data);
          } catch (err) {
            return reject(new Error(`Expected JSON response from ${url}, got ${data.slice(0, 200)}`));
          }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getBaseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
}

function assertErrorEnvelope(body) {
  assert.ok(body && typeof body === 'object', 'error body is required');
  assert.strictEqual(typeof body.error, 'string');
  assert.strictEqual(typeof body.code, 'string');
  assert.strictEqual(typeof body.message, 'string');
}

async function run() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();
  const runId = Math.random().toString(16).slice(2, 10);
  const admin = { ...adminHeaders(), 'x-company-id': companyId };
  const operator = { ...operatorHeaders(), 'x-company-id': companyId };
  const viewer = { ...viewerHeaders(), 'x-company-id': companyId };

  if (requireAuth()) {
    const unauth = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/devices/missing/monitoring-sessions`,
      body: { company_id: companyId }
    });
    assert.strictEqual(unauth.status, 401, 'monitoring start should require auth');
    assertErrorEnvelope(unauth.body);

    const viewerStart = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/devices/missing/monitoring-sessions`,
      headers: viewer,
      body: { company_id: companyId }
    });
    assert.strictEqual(viewerStart.status, 403, 'viewer should not start monitoring lease');
    assertErrorEnvelope(viewerStart.body);
  }

  const missing = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(`missing-${runId}`)}/monitoring-sessions`,
    headers: operator,
    body: { company_id: companyId }
  });
  assert.strictEqual(missing.status, 404, 'missing device should return 404');
  assertErrorEnvelope(missing.body);

  const token = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers: admin,
    body: {
      company_id: companyId,
      ttl_minutes: 15,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(token.status, 201, 'token create should return 201');

  const agent = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: token.body.provisioning_token,
      agent_name: `monitor-agent-${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(agent.status, 201, 'agent bootstrap should return 201');

  const onboard = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      identity: { serial_number: `MON-${runId}` },
      connection: {
        host: '192.168.22.201',
        port: 4370,
        communication_key: 1234,
        device_number: 1,
        transport: 'tcp',
        attlog_sequence: 'zktime_k80'
      }
    }
  });
  assert.strictEqual(onboard.status, 201, 'manual onboarding should create candidate');
  const deviceUid = onboard.body.device_uid;

  const unboundStart = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/monitoring-sessions`,
    headers: operator,
    body: { company_id: companyId }
  });
  assert.strictEqual(unboundStart.status, 409, 'candidate/unbound device should not start monitoring');
  assertErrorEnvelope(unboundStart.body);

  const claim = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/discovered-devices/${encodeURIComponent(deviceUid)}/claim`,
    headers: operator,
    body: { company_id: companyId }
  });
  assert.strictEqual(claim.status, 200, 'claim should return 200');

  const bind = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/managing-agent-binding`,
    headers: operator,
    body: {
      company_id: companyId,
      agent_id: agent.body.agent_id
    }
  });
  assert.strictEqual(bind.status, 200, 'binding should return 200');

  const start = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/monitoring-sessions`,
    headers: operator,
    body: {
      company_id: companyId,
      rt_enabled: true,
      lease_ttl_seconds: 120
    }
  });
  assert.strictEqual(start.status, 201, 'monitoring start should create lease');
  assert.ok(start.body.id, 'monitoring lease should return id');
  assert.strictEqual(start.body.company_id, companyId);
  assert.strictEqual(start.body.device_uid, deviceUid);
  assert.strictEqual(start.body.agent_id, agent.body.agent_id);
  assert.strictEqual(start.body.monitoring_control_plane_only, false);
  assert.strictEqual(start.body.agent_runtime_command_wired, true);
  assert.ok(start.body.start_command_id, 'monitoring start should queue runtime command');

  const reused = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/monitoring-sessions`,
    headers: operator,
    body: { company_id: companyId }
  });
  assert.strictEqual(reused.status, 200, 'second start should reuse lease');
  assert.strictEqual(reused.body.id, start.body.id);
  assert.strictEqual(reused.body.reused, true);
  assert.strictEqual(reused.body.start_command_id, start.body.start_command_id);

  const polledStart = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: { authorization: `Bearer ${agent.body.auth_token}` },
    body: {}
  });
  assert.strictEqual(polledStart.status, 200, 'agent should poll monitoring start command');
  assert.ok(polledStart.body.command, 'start command should be returned to agent');
  assert.strictEqual(polledStart.body.command.id, start.body.start_command_id);
  assert.strictEqual(polledStart.body.command.type, 'START_DEVICE_MONITORING');
  assert.strictEqual(polledStart.body.command.payload.monitoring_session_id, start.body.id);
  assert.strictEqual(polledStart.body.command.payload.device_uid, deviceUid);

  const startResult = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/monitoring-command-results`,
    headers: { authorization: `Bearer ${agent.body.auth_token}` },
    body: {
      command_id: start.body.start_command_id,
      monitoring_session_id: start.body.id,
      device_uid: deviceUid,
      ok: true,
      runtime_monitoring_state: 'active',
      rt_subscriber_started: true,
      rt_subscriber_already_running: false,
      diagnostics: { contract_test: true }
    }
  });
  assert.strictEqual(startResult.status, 200, 'start result should be accepted');
  assert.strictEqual(startResult.body.status, 'active');

  const get = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-monitoring-sessions/${encodeURIComponent(start.body.id)}?company_id=${encodeURIComponent(companyId)}`,
    headers: viewer
  });
  assert.strictEqual(get.status, 200, 'monitoring session get should return 200');
  assert.strictEqual(get.body.id, start.body.id);
  assert.strictEqual(get.body.status, 'active');

  const current = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/monitoring-sessions/current?company_id=${encodeURIComponent(companyId)}`,
    headers: viewer
  });
  assert.strictEqual(current.status, 200, 'current monitoring session get should return 200');
  assert.strictEqual(current.body.id, start.body.id);
  assert.strictEqual(current.body.status, 'active');
  assert.strictEqual(current.body.active_lease, true);

  const stopped = await requestJson({
    method: 'DELETE',
    url: `${baseUrl}/api/agent-admin/device-monitoring-sessions/${encodeURIComponent(start.body.id)}`,
    headers: operator,
    body: {
      company_id: companyId,
      stop_reason: 'contract_test'
    }
  });
  assert.strictEqual(stopped.status, 200, 'monitoring stop should return 200');
  assert.strictEqual(stopped.body.status, 'stopping');
  assert.strictEqual(stopped.body.stop_reason, 'contract_test');
  assert.strictEqual(stopped.body.agent_runtime_command_wired, true);
  assert.ok(stopped.body.stop_command_id, 'monitoring stop should queue runtime command');

  const polledStop = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: { authorization: `Bearer ${agent.body.auth_token}` },
    body: {}
  });
  assert.strictEqual(polledStop.status, 200, 'agent should poll monitoring stop command');
  assert.ok(polledStop.body.command, 'stop command should be returned to agent');
  assert.strictEqual(polledStop.body.command.id, stopped.body.stop_command_id);
  assert.strictEqual(polledStop.body.command.type, 'STOP_DEVICE_MONITORING');
  assert.strictEqual(polledStop.body.command.payload.monitoring_session_id, start.body.id);

  const stopResult = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/monitoring-command-results`,
    headers: { authorization: `Bearer ${agent.body.auth_token}` },
    body: {
      command_id: stopped.body.stop_command_id,
      monitoring_session_id: start.body.id,
      device_uid: deviceUid,
      ok: true,
      runtime_monitoring_state: 'stopped',
      rt_subscriber_stopped: true,
      stop_reason: 'contract_test',
      diagnostics: { contract_test: true }
    }
  });
  assert.strictEqual(stopResult.status, 200, 'stop result should be accepted');
  assert.strictEqual(stopResult.body.status, 'stopped');

  console.log('agent admin device monitoring sessions contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
