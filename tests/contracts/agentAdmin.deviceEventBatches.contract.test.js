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

function assertBatchEntryShape(row) {
  assert.ok(row && typeof row === 'object', 'batch entry should be object');
  assert.strictEqual(typeof row.id, 'string', 'id should be string');
  assert.strictEqual(typeof row.company_id, 'string', 'company_id should be string');
  assert.strictEqual(typeof row.agent_id, 'string', 'agent_id should be string');
  assert.strictEqual(typeof row.device_uid, 'string', 'device_uid should be string');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'command_id'), 'command_id should be present');
  assert.strictEqual(typeof row.status, 'string', 'status should be string');
  assert.ok(Object.prototype.hasOwnProperty.call(row, 'failure_reason'), 'failure_reason should be present');
  assert.strictEqual(typeof row.inserted_count, 'number', 'inserted_count should be number');
  assert.strictEqual(typeof row.deduped_count, 'number', 'deduped_count should be number');
  assert.strictEqual(typeof row.rejected_count, 'number', 'rejected_count should be number');
  assert.strictEqual(typeof row.pull_completed_at, 'string', 'pull_completed_at should be string');
  assert.strictEqual(typeof row.created_at, 'string', 'created_at should be string');
  assert.strictEqual(typeof row.rejection_sample_count, 'number', 'rejection_sample_count should be number');
  assert.ok(Array.isArray(row.rejection_samples), 'rejection_samples should be array');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(row, 'payload'),
    false,
    'payload must not be exposed on diagnostics endpoint'
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(row, 'rt_diagnostics_summary'),
    'rt_diagnostics_summary should be present'
  );
  assert.ok(
    row.rt_diagnostics_summary === null || typeof row.rt_diagnostics_summary === 'object',
    'rt_diagnostics_summary should be null or object'
  );
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
  const deviceUid = `zkteco:sn:OPS-BATCH-${runId}`;
  const missingPin = `PIN-OPS-MISSING-${runId}`;
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
      url: `${baseUrl}/api/agent-admin/device-event-batches?company_id=${encodeURIComponent(companyId)}`
    });
    assert.strictEqual(unauth.status, 401, 'batch diagnostics listing should require auth');
    assertErrorEnvelope(unauth.body);

    const viewerAllowed = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/device-event-batches?company_id=${encodeURIComponent(companyId)}`,
      headers: viewer
    });
    assert.strictEqual(viewerAllowed.status, 200, 'viewer should be allowed to list batch diagnostics');

    const operatorAllowed = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/device-event-batches?company_id=${encodeURIComponent(companyId)}`,
      headers: operator
    });
    assert.strictEqual(operatorAllowed.status, 200, 'operator should be allowed to list batch diagnostics');
  }

  const mismatch = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-event-batches?company_id=OTHER`,
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
      agent_name: `ops-batch-agent-${runId}`,
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
      device_name: `Ops Batch Device ${runId}`,
      active: true,
      metadata: { ip: '192.168.10.70' }
    }
  });
  assert.strictEqual(deviceRes.status, 200, 'device setup should return 200');

  const queueRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/pull-device-events`,
    headers: admin,
    body: {
      company_id: companyId,
      device_uid: deviceUid,
      options: {
        host: '192.168.10.70',
        lookback_minutes: 120,
        safety_window_minutes: 5,
        max_events: 100,
        device_timezone: 'Africa/Tunis'
      }
    }
  });
  assert.strictEqual(queueRes.status, 201, 'pull command queue should return 201');

  const nextRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: agentHeaders,
    body: {}
  });
  assert.strictEqual(nextRes.status, 200, 'agent command poll should return 200');
  assert.ok(nextRes.body && nextRes.body.command, 'agent should receive command');

  const rejectedBatchRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/device-events/batch`,
    headers: agentHeaders,
    body: {
      command_id: nextRes.body.command.id,
      run_id: `ops-batch-run-${runId}`,
      device_uid: deviceUid,
      vendor: 'zkteco',
      ingest_method: 'agent_pull',
      device_timezone: 'Africa/Tunis',
      pull_started_at: '2026-03-06T10:00:00Z',
      pull_completed_at: '2026-03-06T10:01:00Z',
      cursor: {
        requested_since_utc: '2026-03-06T09:00:00Z',
        latest_event_time_utc: '2026-03-06T10:00:30Z',
        has_more: false
      },
      summary: {
        pull_ok: true
      },
      events: [
        {
          device_person_id: missingPin,
          event_time_local: '2026-03-06 11:00:30',
          event_time_utc: '2026-03-06T10:00:30Z',
          direction: 'IN',
          raw: {
            source: 'ops_batch_contract'
          }
        }
      ]
    }
  });
  assert.strictEqual(rejectedBatchRes.status, 201, 'batch submit should return 201');
  assert.strictEqual(rejectedBatchRes.body.batch_status, 'rejected', 'missing mapping should reject batch');

  const rejectedList = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-event-batches?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}&status=rejected&limit=50`,
    headers: viewer
  });
  assert.strictEqual(rejectedList.status, 200, 'rejected diagnostics list should return 200');
  assert.ok(Array.isArray(rejectedList.body.value), 'diagnostics response should include value array');
  const row = rejectedList.body.value.find(item => item && item.command_id === nextRes.body.command.id);
  assert.ok(row, 'diagnostics list should include the rejected batch row');
  assertBatchEntryShape(row);
  assert.strictEqual(row.status, 'rejected');
  assert.strictEqual(row.failure_reason, 'identity_mapping_missing');
  assert.ok(row.rejected_count >= 1, 'rejected row should expose rejected_count');
  assert.ok(row.rejection_sample_count >= 1, 'rejected row should expose rejection sample count');
  assert.ok(row.rejection_samples.length >= 1, 'rejected row should include rejection sample summary');
  assert.strictEqual(row.rejection_samples[0].code, 'identity_mapping_missing');

  const futureWindow = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/device-event-batches?company_id=${encodeURIComponent(companyId)}&agent_id=${encodeURIComponent(bootstrapRes.body.agent_id)}&device_uid=${encodeURIComponent(deviceUid)}&created_from=2999-01-01T00:00:00Z`,
    headers: admin
  });
  assert.strictEqual(futureWindow.status, 200, 'time-window filter should return 200');
  const rowInFutureWindow = futureWindow.body.value.find(item => item && item.command_id === nextRes.body.command.id);
  assert.strictEqual(rowInFutureWindow, undefined, 'future created_from should filter out current row');

  console.log('agent admin device-event-batches contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
