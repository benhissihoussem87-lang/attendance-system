const assert = require('assert');
const http = require('http');
const https = require('https');
const { adminHeaders, getCompanyId, requireAuth } = require('./_helpers/auth');

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

function buildRunScopedMac(runId) {
  const normalized = String(runId || '')
    .toLowerCase()
    .replace(/[^a-f0-9]/g, '')
    .padEnd(6, '0')
    .slice(0, 6);
  return `aa:bb:cc:${normalized.slice(0, 2)}:${normalized.slice(2, 4)}:${normalized.slice(4, 6)}`;
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
  const agentName = `bridge-agent-${runId}`;
  const headers = {
    ...adminHeaders(),
    'x-company-id': companyId
  };

  const noAuthHeartbeat = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/heartbeat`,
    body: {}
  });
  assert.strictEqual(noAuthHeartbeat.status, 401, 'agent heartbeat should require bearer token');

  const tokenRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/provisioning-tokens`,
    headers,
    body: {
      ttl_minutes: 20,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(tokenRes.status, 201, 'provisioning token create should return 201');
  assert.ok(tokenRes.body && tokenRes.body.provisioning_token, 'provisioning token response must include token');

  const bootstrapRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/bootstrap`,
    body: {
      provisioning_token: tokenRes.body.provisioning_token,
      agent_name: agentName,
      metadata: {
        run_id: runId,
        platform: 'contract-test'
      }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'agent bootstrap should return 201');
  assert.ok(bootstrapRes.body && bootstrapRes.body.auth_token, 'bootstrap must return auth_token');
  assert.ok(bootstrapRes.body.active_runtime_identity_id, 'bootstrap must return active_runtime_identity_id');
  assert.strictEqual(bootstrapRes.body.identity_status, 'active', 'bootstrap identity_status should be active');
  assert.ok(bootstrapRes.body.runtime_identity_issued_at, 'bootstrap should return runtime_identity_issued_at');
  const agentAuthHeader = {
    authorization: `Bearer ${bootstrapRes.body.auth_token}`
  };

  const heartbeatRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/heartbeat`,
    headers: agentAuthHeader,
    body: {
      ping: true
    }
  });
  assert.strictEqual(heartbeatRes.status, 200, 'agent heartbeat should return 200');

  const queueRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/scan-subnet`,
    headers,
    body: {
      subnet_targets: ['192.168.10.0/30'],
      options: {
        adapter: 'zkteco',
        timeout_ms: 500,
        max_hosts: 4
      }
    }
  });
  assert.strictEqual(queueRes.status, 201, 'queue scan command should return 201');
  assert.ok(queueRes.body && queueRes.body.id, 'queued command should have id');

  const mismatchQueueRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/agents/${encodeURIComponent(bootstrapRes.body.agent_id)}/commands/scan-subnet?company_id=OTHER`,
    headers,
    body: {
      subnet_targets: ['192.168.10.0/30']
    }
  });
  const expectedMismatchQueueStatus = requireAuth() ? 403 : 404;
  assert.strictEqual(mismatchQueueRes.status, expectedMismatchQueueStatus, 'company scope mismatch behavior should match auth mode');

  const nextCommandRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/commands/next`,
    headers: agentAuthHeader,
    body: {}
  });
  assert.strictEqual(nextCommandRes.status, 200, 'fetch command should return 200');
  assert.ok(nextCommandRes.body && nextCommandRes.body.command, 'agent should receive command');
  assert.strictEqual(nextCommandRes.body.command.type, 'SCAN_SUBNET', 'command type should be SCAN_SUBNET');

  const serial = `BRIDGE-${runId}`;
  const deviceUid = `zkteco:sn:${serial}`;
  const deviceMac = buildRunScopedMac(runId);
  const reportRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/discovery-reports`,
    headers: agentAuthHeader,
    body: {
      command_id: nextCommandRes.body.command.id,
      adapter_id: 'zkteco',
      subnet_targets: ['192.168.10.0/30'],
      reported_at: new Date().toISOString(),
      discovered_devices: [
        {
          ip: '192.168.10.12',
          mac: deviceMac,
          vendor: 'zkteco',
          model: 'MB560',
          serial_number: serial,
          device_uid: deviceUid,
          discovery_method: 'contract_test',
          confidence: 0.91,
          observed_at: new Date().toISOString(),
          raw: {
            test: true
          }
        }
      ]
    }
  });
  assert.strictEqual(reportRes.status, 201, 'discovery report should return 201');

  const candidatesRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/discovered-devices?company_id=${encodeURIComponent(companyId)}&limit=100`,
    headers
  });
  assert.strictEqual(candidatesRes.status, 200, 'candidate list should return 200');
  assert.ok(candidatesRes.body && Array.isArray(candidatesRes.body.value), 'candidate list should return array');
  const candidate = candidatesRes.body.value.find(row => {
    const uid = typeof row.device_uid === 'string' ? row.device_uid.toLowerCase() : '';
    if (uid === deviceUid.toLowerCase()) {
      return true;
    }
    const metadata = row.discovery_metadata && typeof row.discovery_metadata === 'object'
      ? row.discovery_metadata
      : {};
    const sn = typeof metadata.serial_number === 'string' ? metadata.serial_number.toUpperCase() : '';
    return sn === serial.toUpperCase();
  });
  assert.ok(candidate, 'discovered device should be listed as candidate');
  assert.strictEqual(candidate.managed_status, 'candidate', 'device should start as candidate');
  assert.strictEqual(candidate.manageability_status, 'protocol_reachable', 'candidate should expose non-proof manageability state');
  assert.strictEqual(candidate.manageability_reason, 'discovery_protocol_reachable', 'candidate should expose discovery reason');
  assert.ok(candidate.manageability && typeof candidate.manageability === 'object', 'candidate should expose normalized manageability view');
  assert.strictEqual(candidate.manageability.effective_status, 'protocol_reachable', 'effective status should match system status when no manual remediation');

  const mismatchCandidates = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/discovered-devices?company_id=OTHER&limit=10`,
    headers
  });
  const expectedMismatchCandidatesStatus = requireAuth() ? 403 : 200;
  assert.strictEqual(mismatchCandidates.status, expectedMismatchCandidatesStatus, 'candidate listing tenant scope should match auth mode');

  const claimRes = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/discovered-devices/${encodeURIComponent(candidate.device_uid)}/claim`,
    headers,
    body: {
      company_id: companyId,
      device_name: `Claimed ${runId}`,
      metadata: {
        claimed_by_test: true
      }
    }
  });
  assert.strictEqual(claimRes.status, 200, 'claim should return 200');
  assert.strictEqual(claimRes.body.managed_status, 'managed', 'claimed device should be managed');

  const devicesGet = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices/${encodeURIComponent(candidate.device_uid)}?company_id=${encodeURIComponent(companyId)}`,
    headers
  });
  assert.strictEqual(devicesGet.status, 200, 'claimed device should be in devices registry');
  assert.strictEqual(devicesGet.body.managed_status, 'managed', 'registry row should be managed');
  assert.strictEqual(devicesGet.body.manageability_status, 'protocol_reachable', 'registry row should expose manageability status');
  assert.ok(devicesGet.body.manageability && typeof devicesGet.body.manageability === 'object', 'registry row should expose normalized manageability view');

  console.log('agent bridge foundation contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
