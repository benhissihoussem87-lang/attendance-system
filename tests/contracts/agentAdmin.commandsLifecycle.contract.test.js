const assert = require('assert');
const http = require('http');
const https = require('https');
const {
  adminHeaders,
  getCompanyId,
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

function delay(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function findCommand(rows, commandId) {
  return (rows || []).find(row => row && row.id === commandId) || null;
}

function assertLifecycleShape(row) {
  assert.ok(row && typeof row === 'object', 'command entry should be object');
  assert.strictEqual(typeof row.id, 'string');
  assert.strictEqual(typeof row.command_type, 'string');
  assert.strictEqual(typeof row.status, 'string');
  assert.strictEqual(typeof row.created_at, 'string');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'sent_at'), 'sent_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'acknowledged_at'), 'acknowledged_at should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'failure_reason'), 'failure_reason should be present');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'result_payload'), 'result_payload should be present');
}

async function run() {
  const baseUrl = getBaseUrl();
  await ensureMode(baseUrl);

  const companyId = getCompanyId();
  const authRequired = requireAuth();
  const runId = Math.random().toString(16).slice(2, 10);
  const deviceUid = `zkteco:sn:PH3-${runId}`;
  const admin = {
    ...adminHeaders(),
    'x-company-id': companyId
  };
  const viewer = {
    ...viewerHeaders(),
    'x-company-id': companyId
  };

  if (authRequired) {
    const unauthList = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/commands?company_id=${encodeURIComponent(companyId)}`
    });
    assert.strictEqual(unauthList.status, 401, 'commands listing should require auth');
    assertErrorEnvelope(unauthList.body);

    const viewerList = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/commands?company_id=${encodeURIComponent(companyId)}`,
      headers: viewer
    });
    assert.strictEqual(viewerList.status, 200, 'viewer should be allowed to list command lifecycle');
  }

  const mismatch = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/commands?company_id=OTHER`,
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
      agent_name: `phase3-agent-${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'agent bootstrap should return 201');
  const agentHeaders = {
    authorization: `Bearer ${bootstrapRes.body.auth_token}`
  };

  const deviceRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers: admin,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_name: `Phase3 Device ${runId}`,
      active: true,
      metadata: { ip: '192.168.10.60' }
    }
  });
  assert.strictEqual(deviceRes.status, 200, 'device setup should return 200');

  const staleQueue = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/pull-device-events`,
    headers: admin,
    body: {
      company_id: companyId,
      device_uid: deviceUid,
      options: {
        host: '192.168.10.60',
        lookback_minutes: 120,
        safety_window_minutes: 5,
        max_events: 100,
        device_timezone: 'Africa/Tunis',
        command_ttl_seconds: 30,
        sent_stale_seconds: 1
      }
    }
  });
  assert.strictEqual(staleQueue.status, 201, 'initial stale candidate command should queue');

  const staleSent = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: agentHeaders,
    body: {}
  });
  assert.strictEqual(staleSent.status, 200, 'agent poll should return 200 for stale scenario');
  assert.ok(staleSent.body && staleSent.body.command, 'stale scenario should receive command');
  const staleCommandId = staleSent.body.command.id;

  await delay(1200);
  const listAfterStale = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/commands?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}`,
    headers: admin
  });
  assert.strictEqual(listAfterStale.status, 200, 'command listing should return 200');
  assert.ok(Array.isArray(listAfterStale.body.value), 'command list should return array');
  const staleEntry = findCommand(listAfterStale.body.value, staleCommandId);
  assert.ok(staleEntry, 'stale command should be visible in listing');
  assertLifecycleShape(staleEntry);
  assert.strictEqual(staleEntry.status, 'failed', 'stale sent command should reconcile to failed');
  assert.strictEqual(staleEntry.failure_reason, 'sent_timeout', 'stale sent command should expose timeout reason');

  const retryQueue = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/pull-device-events`,
    headers: admin,
    body: {
      company_id: companyId,
      device_uid: deviceUid,
      options: {
        host: '192.168.10.60',
        lookback_minutes: 120,
        safety_window_minutes: 5,
        max_events: 100,
        device_timezone: 'Africa/Tunis',
        command_ttl_seconds: 60,
        sent_stale_seconds: 60
      }
    }
  });
  assert.strictEqual(retryQueue.status, 201, 'retry queue should be allowed after stale command terminal resolution');

  const retrySent = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: agentHeaders,
    body: {}
  });
  assert.strictEqual(retrySent.status, 200, 'retry poll should return 200');
  assert.ok(retrySent.body && retrySent.body.command, 'retry command should be delivered');
  const retryCommandId = retrySent.body.command.id;

  const successfulBatch = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-events/batch`,
    headers: agentHeaders,
    body: {
      command_id: retryCommandId,
      run_id: `phase3-run-${runId}`,
      device_uid: deviceUid,
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:00:00Z',
      pull_completed_at: '2026-03-06T10:00:10Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: null,
        has_more: false
      },
      summary: {
        pull_ok: true
      },
      events: []
    }
  });
  assert.strictEqual(successfulBatch.status, 201, 'successful retry batch should be accepted');
  assert.strictEqual(successfulBatch.body.batch_status, 'accepted', 'retry batch should be accepted');

  const listAck = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/commands?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}&status=acknowledged`,
    headers: admin
  });
  assert.strictEqual(listAck.status, 200, 'acknowledged listing should return 200');
  const ackEntry = findCommand(listAck.body.value, retryCommandId);
  assert.ok(ackEntry, 'retry command should appear as acknowledged after delayed success');
  assert.strictEqual(ackEntry.status, 'acknowledged');
  assert.ok(ackEntry.acknowledged_at, 'acknowledged command should include timestamp');

  const expiringQueue = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/pull-device-events`,
    headers: admin,
    body: {
      company_id: companyId,
      device_uid: deviceUid,
      options: {
        host: '192.168.10.60',
        lookback_minutes: 120,
        safety_window_minutes: 5,
        max_events: 100,
        device_timezone: 'Africa/Tunis',
        command_ttl_seconds: 1,
        sent_stale_seconds: 60
      }
    }
  });
  assert.strictEqual(expiringQueue.status, 201, 'expiring command should queue');
  const expiringCommandId = expiringQueue.body.id;

  await delay(1200);
  const postExpiryPoll = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: agentHeaders,
    body: {}
  });
  assert.strictEqual(postExpiryPoll.status, 200, 'poll after queued expiry should return 200');
  assert.strictEqual(postExpiryPoll.body.command, null, 'expired queued command must be excluded from /commands/next');

  const listExpired = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/commands?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}&status=expired`,
    headers: admin
  });
  assert.strictEqual(listExpired.status, 200, 'expired listing should return 200');
  const expiredEntry = findCommand(listExpired.body.value, expiringCommandId);
  assert.ok(expiredEntry, 'expired command should be visible');
  assertLifecycleShape(expiredEntry);
  assert.strictEqual(expiredEntry.status, 'expired');
  assert.strictEqual(expiredEntry.failure_reason, 'command_expired');

  console.log('agent admin commands lifecycle contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };

