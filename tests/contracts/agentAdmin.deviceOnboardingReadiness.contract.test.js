const assert = require('assert');
const http = require('http');
const https = require('https');
const {
  getCompanyId,
  operatorHeaders,
  viewerHeaders,
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

function assertErrorEnvelope(body) {
  assert.ok(body && typeof body === 'object', 'error body is required');
  assert.strictEqual(typeof body.error, 'string', 'error.error must be string');
  assert.strictEqual(typeof body.code, 'string', 'error.code must be string');
  assert.strictEqual(typeof body.message, 'string', 'error.message must be string');
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

async function bootstrapAgent(baseUrl, companyId, headers, runId) {
  const tokenRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers,
    body: {
      company_id: companyId,
      ttl_minutes: 20,
      metadata: {
        run_id: runId,
        purpose: 'device_onboarding_readiness_contract'
      }
    }
  });
  assert.strictEqual(tokenRes.status, 201, 'provisioning token create should return 201');

  const bootstrapRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: tokenRes.body.provisioning_token,
      agent_name: `readiness-agent-${runId}`,
      metadata: {
        run_id: runId
      }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'agent bootstrap should return 201');

  return {
    agentId: bootstrapRes.body.agent_id,
    authHeader: {
      authorization: `Bearer ${bootstrapRes.body.auth_token}`
    }
  };
}

async function readOnboardingReadiness({ baseUrl, companyId, deviceUid, headers }) {
  const res = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/onboarding-readiness?company_id=${encodeURIComponent(companyId)}`,
    headers
  });
  assert.strictEqual(res.status, 200, 'readiness endpoint should return 200');
  assert.strictEqual(res.body.company_id, companyId);
  assert.strictEqual(res.body.canonical_device_uid, deviceUid);
  assert.ok(res.body.reported_state && typeof res.body.reported_state === 'object', 'readiness should include reported_state');
  assert.ok(Object.prototype.hasOwnProperty.call(res.body.reported_state, 'status'), 'reported_state.status should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(res.body.reported_state, 'reported_stale'), 'reported_state.reported_stale should be present');
  return res.body;
}

async function queueAndSubmitValidation({
  baseUrl,
  companyId,
  deviceUid,
  agentId,
  operatorHeadersValue,
  authHeader,
  runId,
  suffix,
  success,
  reasonCode
}) {
  const queue = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/validate`,
    headers: operatorHeadersValue,
    body: {
      company_id: companyId,
      agent_id: agentId,
      correlation_id: `readiness-${runId}-${suffix}`
    }
  });
  assert.strictEqual(queue.status, 202, 'validation queue should return 202');
  assert.strictEqual(queue.body.command.command_type, 'VALIDATE_DEVICE_CANDIDATE');

  const next = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: authHeader,
    body: {}
  });
  assert.strictEqual(next.status, 200, 'agent command poll should return 200');
  assert.ok(next.body && next.body.command, 'validation command should be delivered');
  assert.strictEqual(next.body.command.type, 'VALIDATE_DEVICE_CANDIDATE');

  const submit = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-validations/result`,
    headers: authHeader,
    body: {
      command_id: next.body.command.id,
      run_id: `readiness-${runId}-${suffix}`,
      device_uid: deviceUid,
      started_at: new Date(Date.now() - 3000).toISOString(),
      completed_at: new Date().toISOString(),
      result: {
        success,
        reason_code: reasonCode,
        evidence: success
          ? { transport: 'tcp', handshake_proved: true }
          : { failure_stage: 'auth' }
      }
    }
  });
  assert.strictEqual(submit.status, 201, 'validation result submit should return 201');
  assert.strictEqual(submit.body.result.success, success);
}

async function run() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();
  const runId = Math.random().toString(16).slice(2, 10);
  const operator = {
    ...operatorHeaders(),
    'x-company-id': companyId
  };
  const viewer = {
    ...viewerHeaders(),
    'x-company-id': companyId
  };

  await ensureMode(baseUrl, operator);

  if (requireAuth()) {
    const unauth = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(`zkteco:sn:READINESS-${runId}`)}/onboarding-readiness?company_id=${encodeURIComponent(companyId)}`
    });
    assert.strictEqual(unauth.status, 401, 'readiness endpoint should require auth');
    assertErrorEnvelope(unauth.body);
  }

  const { agentId, authHeader } = await bootstrapAgent(baseUrl, companyId, operator, runId);

  const incompleteUid = `zkteco:manual:READINESS-INCOMPLETE-${runId}`;
  const incompleteCreate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_uid: incompleteUid
    }
  });
  assert.strictEqual(incompleteCreate.status, 201, 'incomplete candidate create should return 201');
  const incompleteReadiness = await readOnboardingReadiness({
    baseUrl,
    companyId,
    deviceUid: incompleteUid,
    headers: operator
  });
  assert.strictEqual(incompleteReadiness.readiness_status, 'candidate_incomplete_configuration');
  assert.strictEqual(incompleteReadiness.onboarding_state, 'candidate_unconfigured');
  assert.strictEqual(incompleteReadiness.ready_for_validation, false);
  assert.strictEqual(incompleteReadiness.reported_state.status, 'unknown');
  assert.strictEqual(incompleteReadiness.reported_state.reason, 'reported_state_missing');

  const completeCreate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      identity: {
        serial_number: `READINESS-${runId}`
      },
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
  assert.strictEqual(completeCreate.status, 201, 'complete candidate create should return 201');
  const canonicalDeviceUid = completeCreate.body.device_uid;

  const configuredReadiness = await readOnboardingReadiness({
    baseUrl,
    companyId,
    deviceUid: canonicalDeviceUid,
    headers: operator
  });
  assert.strictEqual(configuredReadiness.readiness_status, 'candidate_ready_for_validation');
  assert.strictEqual(configuredReadiness.onboarding_state, 'candidate_configured');
  assert.strictEqual(configuredReadiness.ready_for_validation, true);
  assert.strictEqual(configuredReadiness.reported_state.status, 'unknown');

  await queueAndSubmitValidation({
    baseUrl,
    companyId,
    deviceUid: canonicalDeviceUid,
    agentId,
    operatorHeadersValue: operator,
    authHeader,
    runId,
    suffix: 'fail',
    success: false,
    reasonCode: 'auth_stage_failed'
  });

  const failedReadiness = await readOnboardingReadiness({
    baseUrl,
    companyId,
    deviceUid: canonicalDeviceUid,
    headers: operator
  });
  assert.strictEqual(failedReadiness.readiness_status, 'validation_failed');
  assert.strictEqual(failedReadiness.onboarding_state, 'validation_failed');
  assert.strictEqual(failedReadiness.validation_reason_code, 'auth_stage_failed');
  assert.strictEqual(failedReadiness.reported_state.last_validation_status, 'failed');
  assert.strictEqual(failedReadiness.reported_state.last_validation_reason, 'auth_stage_failed');

  await queueAndSubmitValidation({
    baseUrl,
    companyId,
    deviceUid: canonicalDeviceUid,
    agentId,
    operatorHeadersValue: operator,
    authHeader,
    runId,
    suffix: 'ok',
    success: true,
    reasonCode: 'validation_succeeded'
  });

  const succeededReadiness = await readOnboardingReadiness({
    baseUrl,
    companyId,
    deviceUid: canonicalDeviceUid,
    headers: operator
  });
  assert.strictEqual(succeededReadiness.readiness_status, 'validation_succeeded');
  assert.strictEqual(succeededReadiness.onboarding_state, 'validation_succeeded');
  assert.strictEqual(succeededReadiness.reported_state.last_validation_status, 'succeeded');

  const claim = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/discovered-devices/${encodeURIComponent(canonicalDeviceUid)}/claim`,
    headers: operator,
    body: {
      company_id: companyId
    }
  });
  assert.strictEqual(claim.status, 200, 'claim should return 200');

  const managedUnboundReadiness = await readOnboardingReadiness({
    baseUrl,
    companyId,
    deviceUid: canonicalDeviceUid,
    headers: operator
  });
  assert.strictEqual(managedUnboundReadiness.readiness_status, 'managed_unbound');
  assert.strictEqual(managedUnboundReadiness.onboarding_state, 'managed_unbound');
  assert.strictEqual(managedUnboundReadiness.managed_status, 'managed');

  const bind = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(canonicalDeviceUid)}/managing-agent-binding`,
    headers: operator,
    body: {
      company_id: companyId,
      agent_id: agentId
    }
  });
  assert.strictEqual(bind.status, 200, 'bind should return 200');

  const heartbeat = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/heartbeat`,
    headers: authHeader,
    body: {
      metadata: {
        source: 'readiness_contract'
      }
    }
  });
  assert.strictEqual(heartbeat.status, 200, 'heartbeat should return 200');

  const managedReady = await readOnboardingReadiness({
    baseUrl,
    companyId,
    deviceUid: canonicalDeviceUid,
    headers: operator
  });
  assert.strictEqual(managedReady.readiness_status, 'managed_pull_ready');
  assert.strictEqual(managedReady.onboarding_state, 'managed_pull_ready');
  assert.ok(managedReady.active_binding, 'managed pull-ready should include active binding');
  assert.strictEqual(managedReady.active_binding.agent_id, agentId);
  assert.ok(managedReady.managing_agent, 'managed pull-ready should include managing agent');
  assert.strictEqual(managedReady.managing_agent.id, agentId);
  assert.strictEqual(managedReady.managing_agent.is_online_now, true);
  assert.ok(['healthy', 'degraded', 'blocked', 'offline', 'unknown'].includes(managedReady.reported_state.status));

  if (requireAuth()) {
    const viewerForbidden = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(canonicalDeviceUid)}/validate`,
      headers: viewer,
      body: {
        company_id: companyId,
        agent_id: agentId
      }
    });
    assert.strictEqual(viewerForbidden.status, 403, 'viewer should not queue validation');
    assertErrorEnvelope(viewerForbidden.body);
  }

  console.log('agent admin device onboarding readiness contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
