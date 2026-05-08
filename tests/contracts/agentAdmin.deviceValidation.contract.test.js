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
        purpose: 'manual_validation_contract'
      }
    }
  });
  assert.strictEqual(tokenRes.status, 201, 'provisioning token create should return 201');

  const bootstrapRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: tokenRes.body.provisioning_token,
      agent_name: `validation-agent-${runId}`,
      metadata: {
        run_id: runId
      }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'agent bootstrap should return 201');
  assert.ok(bootstrapRes.body && bootstrapRes.body.agent_id, 'bootstrap should include agent_id');
  assert.ok(bootstrapRes.body && bootstrapRes.body.auth_token, 'bootstrap should include auth_token');

  return {
    agentId: bootstrapRes.body.agent_id,
    authHeader: {
      authorization: `Bearer ${bootstrapRes.body.auth_token}`
    }
  };
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

  const { agentId, authHeader } = await bootstrapAgent(baseUrl, companyId, operator, runId);

  const manualCreate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      identity: {
        serial_number: `VAL-${runId}`
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
  assert.strictEqual(manualCreate.status, 201, 'manual candidate create should return 201');
  const canonicalDeviceUid = manualCreate.body.device_uid;
  assert.ok(canonicalDeviceUid, 'manual onboarding response should include canonical device uid');

  if (requireAuth()) {
    const unauth = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(canonicalDeviceUid)}/validate`,
      body: {
        company_id: companyId,
        agent_id: agentId
      }
    });
    assert.strictEqual(unauth.status, 401, 'manual validation queue should require auth');
    assertErrorEnvelope(unauth.body);

    const viewerForbidden = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(canonicalDeviceUid)}/validate`,
      headers: viewer,
      body: {
        company_id: companyId,
        agent_id: agentId
      }
    });
    assert.strictEqual(viewerForbidden.status, 403, 'viewer should not queue manual validation');
    assertErrorEnvelope(viewerForbidden.body);
  }

  const beforeRecent = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-events/recent?company_id=${encodeURIComponent(companyId)}&device_uid=${encodeURIComponent(canonicalDeviceUid)}&limit=20`,
    headers: operator
  });
  assert.strictEqual(beforeRecent.status, 200, 'recent events list should return 200 before validation');
  const beforeRows = Array.isArray(beforeRecent.body.value) ? beforeRecent.body.value : [];
  const beforeCount = beforeRows.length;

  const queueValidation = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(canonicalDeviceUid)}/validate`,
    headers: operator,
    body: {
      company_id: companyId,
      agent_id: agentId,
      options: {
        timeout_ms: 1800,
        max_packets: 256
      },
      correlation_id: `validation-${runId}-1`
    }
  });
  assert.strictEqual(queueValidation.status, 202, 'manual validation queue should return 202');
  assert.strictEqual(queueValidation.body.canonical_device_uid, canonicalDeviceUid);
  assert.strictEqual(queueValidation.body.validation_status, 'queued');
  assert.strictEqual(queueValidation.body.onboarding_state, 'candidate_configured');
  assert.ok(queueValidation.body.command && queueValidation.body.command.id, 'queued response should include command');
  assert.strictEqual(queueValidation.body.command.command_type, 'VALIDATE_DEVICE_CANDIDATE');

  const firstCommand = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: authHeader,
    body: {}
  });
  assert.strictEqual(firstCommand.status, 200, 'agent command poll should return 200');
  assert.ok(firstCommand.body && firstCommand.body.command, 'queued validation command should be delivered');
  assert.strictEqual(firstCommand.body.command.type, 'VALIDATE_DEVICE_CANDIDATE');
  assert.strictEqual(firstCommand.body.command.payload.device_uid, canonicalDeviceUid);

  const inProgressRead = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_uid: canonicalDeviceUid
    }
  });
  assert.strictEqual(inProgressRead.status, 200, 'manual onboarding read-after-poll should return 200');
  assert.strictEqual(inProgressRead.body.validation_status, 'in_progress');

  const submitSuccess = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-validations/result`,
    headers: authHeader,
    body: {
      command_id: firstCommand.body.command.id,
      run_id: `validation-${runId}-run1`,
      device_uid: canonicalDeviceUid,
      started_at: new Date(Date.now() - 2000).toISOString(),
      completed_at: new Date().toISOString(),
      result: {
        success: true,
        reason_code: 'validation_succeeded',
        evidence: {
          transport: 'tcp',
          handshake_proved: true
        }
      }
    }
  });
  assert.strictEqual(submitSuccess.status, 201, 'agent validation result submit should return 201');
  assert.strictEqual(submitSuccess.body.status, 'ok');
  assert.strictEqual(submitSuccess.body.command_status, 'acknowledged');
  assert.strictEqual(submitSuccess.body.validation_status, 'succeeded');
  assert.strictEqual(submitSuccess.body.onboarding_state, 'validation_succeeded');
  assert.strictEqual(submitSuccess.body.result.success, true);

  const queueValidation2 = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(canonicalDeviceUid)}/validate`,
    headers: operator,
    body: {
      company_id: companyId,
      agent_id: agentId,
      correlation_id: `validation-${runId}-2`
    }
  });
  assert.strictEqual(queueValidation2.status, 202, 'second validation queue should return 202');
  assert.strictEqual(queueValidation2.body.validation_status, 'queued');

  const secondCommand = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: authHeader,
    body: {}
  });
  assert.strictEqual(secondCommand.status, 200, 'second agent command poll should return 200');
  assert.ok(secondCommand.body && secondCommand.body.command, 'second validation command should be delivered');
  assert.strictEqual(secondCommand.body.command.type, 'VALIDATE_DEVICE_CANDIDATE');

  const submitFailure = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-validations/result`,
    headers: authHeader,
    body: {
      command_id: secondCommand.body.command.id,
      run_id: `validation-${runId}-run2`,
      device_uid: canonicalDeviceUid,
      started_at: new Date(Date.now() - 3000).toISOString(),
      completed_at: new Date().toISOString(),
      result: {
        success: false,
        reason_code: 'auth_stage_failed',
        evidence: {
          failure_stage: 'auth'
        }
      }
    }
  });
  assert.strictEqual(submitFailure.status, 201, 'failed validation result submit should return 201');
  assert.strictEqual(submitFailure.body.status, 'ok');
  assert.strictEqual(submitFailure.body.validation_status, 'failed');
  assert.strictEqual(submitFailure.body.validation_reason_code, 'auth_stage_failed');
  assert.strictEqual(submitFailure.body.onboarding_state, 'validation_failed');
  assert.strictEqual(submitFailure.body.result.success, false);

  if (requireAuth()) {
    const unauthResultSubmit = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent/device-validations/result`,
      body: {
        command_id: secondCommand.body.command.id,
        device_uid: canonicalDeviceUid,
        completed_at: new Date().toISOString(),
        result: {
          success: true
        }
      }
    });
    assert.strictEqual(unauthResultSubmit.status, 401, 'agent validation result submit should require bearer auth');
    assertErrorEnvelope(unauthResultSubmit.body);
  }

  const afterRecent = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-events/recent?company_id=${encodeURIComponent(companyId)}&device_uid=${encodeURIComponent(canonicalDeviceUid)}&limit=20`,
    headers: operator
  });
  assert.strictEqual(afterRecent.status, 200, 'recent events list should return 200 after validation');
  const afterRows = Array.isArray(afterRecent.body.value) ? afterRecent.body.value : [];
  assert.strictEqual(
    afterRows.length,
    beforeCount,
    'manual validation flow should not create device_events rows'
  );

  console.log('agent admin manual device validation contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
