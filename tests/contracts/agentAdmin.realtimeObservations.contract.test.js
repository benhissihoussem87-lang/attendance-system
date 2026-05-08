const assert = require('assert');
const http = require('http');
const https = require('https');
require('dotenv').config();
const db = require('../../db');
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

async function createAgent(baseUrl, companyId, runId) {
  const token = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers: { ...adminHeaders(), 'x-company-id': companyId },
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
      agent_name: `rt-agent-${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(agent.status, 201, 'agent bootstrap should return 201');
  return agent.body.agent_id;
}

async function run() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();
  const runId = Math.random().toString(16).slice(2, 10);
  const operator = { ...operatorHeaders(), 'x-company-id': companyId };
  const viewer = { ...viewerHeaders(), 'x-company-id': companyId };
  const deviceUid = `zkteco:sn:RT-${runId}`;
  const agentId = await createAgent(baseUrl, companyId, runId);

  if (requireAuth()) {
    const unauth = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/realtime-observations?company_id=${encodeURIComponent(companyId)}`
    });
    assert.strictEqual(unauth.status, 401, 'RT observations should require auth');
    assertErrorEnvelope(unauth.body);
  }

  const device = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_name: `RT Device ${runId}`,
      metadata: { source: 'contract_test' }
    }
  });
  assert.strictEqual(device.status, 200, 'device fixture should be created');

  const inserted = await db.query(
    `
    INSERT INTO device_realtime_direction_observations (
      company_id, agent_id, device_uid, vendor, observed_at_utc, observed_at_local,
      device_timezone, device_person_id, person_id, rt_state_code,
      rt_state_label_provisional, direction_provisional, confidence, source,
      source_metadata, raw_payload, created_at
    )
    VALUES
      ($1, $2, $3, 'zkteco', now() - interval '2 seconds', '2026-04-30 10:00:00',
       'Africa/Tunis', '22', '22', '00', 'IN', 'IN', 'provisional_high', 'contract_test',
       $4::jsonb, $5::jsonb, date_trunc('milliseconds', now() - interval '2 seconds')),
      ($1, $2, $3, 'zkteco', now() - interval '1 seconds', '2026-04-30 10:00:01',
       'Africa/Tunis', '22', '22', '01', 'OUT', 'OUT', 'provisional_high', 'contract_test',
       $4::jsonb, $5::jsonb, date_trunc('milliseconds', now() - interval '1 seconds'))
    RETURNING id, created_at
    `,
    [
      companyId,
      agentId,
      deviceUid,
      JSON.stringify({
        rt_time_contract_version: 'dual_time_v1',
        rt_time_observed_trust: 'untrusted',
        rt_time_chronology_source: 'server_ingest_clock',
        private_debug: 'should_not_be_required'
      }),
      JSON.stringify({ secret_raw_payload: true })
    ]
  );
  assert.strictEqual(inserted.rows.length, 2, 'fixture insert should create two RT rows');

  const list = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/realtime-observations?company_id=${encodeURIComponent(companyId)}&limit=10`,
    headers: viewer
  });
  assert.strictEqual(list.status, 200, 'RT observation list should return 200');
  assert.ok(Array.isArray(list.body.value), 'RT list should return value array');
  assert.ok(list.body.value.length >= 2, 'RT list should include inserted rows');
  const row = list.body.value.find(item => item.id === inserted.rows[0].id);
  assert.ok(row, 'RT list should include first inserted row');
  assert.strictEqual(row.direction_provisional, 'IN');
  assert.strictEqual(row.source_metadata.rt_time_contract_version, 'dual_time_v1');
  assert.strictEqual(row.source_metadata.rt_time_observed_trust, 'untrusted');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(row, 'raw_payload'), false, 'raw payload should be omitted');

  const after = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/realtime-observations?company_id=${encodeURIComponent(companyId)}&after_created_at=${encodeURIComponent(inserted.rows[0].created_at.toISOString())}&after_id=${encodeURIComponent(inserted.rows[0].id)}&limit=10`,
    headers: viewer
  });
  assert.strictEqual(after.status, 200, 'RT observation cursor list should return 200');
  assert.ok(after.body.value.some(item => item.id === inserted.rows[1].id), 'cursor should include newer row');
  assert.ok(!after.body.value.some(item => item.id === inserted.rows[0].id), 'cursor should exclude cursor row');

  console.log('agent admin realtime observations contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
