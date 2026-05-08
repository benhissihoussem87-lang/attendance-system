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
  const authRequired = requireAuth();
  const runId = Math.random().toString(16).slice(2, 10);
  const managedDeviceUid = `zkteco:sn:FILTER-MANAGED-${runId}`;
  const candidateDeviceUid = `zkteco:sn:FILTER-CAND-${runId}`;
  const admin = {
    ...adminHeaders(),
    'x-company-id': companyId
  };
  const operator = {
    ...operatorHeaders(),
    'x-company-id': companyId
  };
  const viewer = {
    ...viewerHeaders(),
    'x-company-id': companyId
  };

  if (authRequired) {
    const unauth = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/devices?company_id=${encodeURIComponent(companyId)}&managed_status=managed`
    });
    assert.strictEqual(unauth.status, 401, 'devices list should require auth');
    assertErrorEnvelope(unauth.body);
  }

  const createManaged = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/devices/${encodeURIComponent(managedDeviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_name: `Filter Managed ${runId}`,
      active: true,
      metadata: { ip: '192.168.10.81' }
    }
  });
  assert.strictEqual(createManaged.status, 200, 'managed device setup should return 200');
  assert.strictEqual(createManaged.body.lifecycle_scope, 'ingest_only', 'non-bridge PUT should default to ingest_only scope');

  const remediation = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(managedDeviceUid)}/remediation?company_id=${encodeURIComponent(companyId)}`,
    headers: operator,
    body: {
      company_id: companyId,
      remediation_status: 'needs_field_action',
      note: 'Needs physical unlock',
      owner: 'field-tech'
    }
  });
  assert.strictEqual(remediation.status, 200, 'manual remediation setup should return 200');
  assert.strictEqual(remediation.body.remediation_manual_status, 'needs_field_action');

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
      agent_name: `filters-agent-${runId}`,
      metadata: { run_id: runId }
    }
  });
  assert.strictEqual(bootstrapRes.status, 201, 'agent bootstrap should return 201');
  const agentHeaders = {
    authorization: `Bearer ${bootstrapRes.body.auth_token}`
  };

  const discovery = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent/discovery-reports`,
    headers: agentHeaders,
    body: {
      adapter_id: 'zkteco',
      reported_at: new Date().toISOString(),
      discovered_devices: [
        {
          ip: '192.168.10.82',
          vendor: 'zkteco',
          device_uid: candidateDeviceUid,
          discovery_method: 'contract_filter_discovery',
          confidence: 0.4,
          confirmation_state: 'host_reachable',
          outcome_class: 'heuristic',
          observed_at: new Date().toISOString(),
          raw: {
            source: 'devices_operational_filters_contract'
          }
        }
      ],
      summary: {
        run_id: `discovery-${runId}`
      }
    }
  });
  assert.strictEqual(discovery.status, 201, 'discovery report should return 201');

  const managedFiltered = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices?company_id=${encodeURIComponent(companyId)}&managed_status=managed&device_uid=${encodeURIComponent(managedDeviceUid)}`,
    headers: viewer
  });
  assert.strictEqual(managedFiltered.status, 200, 'managed_status filter should return 200');
  const managedRow = (managedFiltered.body.value || []).find(row => row && row.device_uid === managedDeviceUid);
  assert.ok(managedRow, 'managed_status filter should include managed device');
  assert.strictEqual(managedRow.managed_status, 'managed');

  const candidateFiltered = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices?company_id=${encodeURIComponent(companyId)}&managed_status=candidate&device_uid=${encodeURIComponent(candidateDeviceUid)}`,
    headers: viewer
  });
  assert.strictEqual(candidateFiltered.status, 200, 'candidate managed_status filter should return 200');
  const candidateRow = (candidateFiltered.body.value || []).find(row => row && row.device_uid === candidateDeviceUid);
  assert.ok(candidateRow, 'candidate filter should include discovered candidate');
  assert.strictEqual(candidateRow.managed_status, 'candidate');
  assert.strictEqual(candidateRow.lifecycle_scope, 'bridge_ops', 'discovery candidate should be bridge_ops scoped');

  const ingestOnlyFiltered = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices?company_id=${encodeURIComponent(companyId)}&lifecycle_scope=ingest_only&device_uid=${encodeURIComponent(managedDeviceUid)}`,
    headers: viewer
  });
  assert.strictEqual(ingestOnlyFiltered.status, 200, 'lifecycle_scope ingest_only filter should return 200');
  const ingestOnlyRow = (ingestOnlyFiltered.body.value || []).find(row => row && row.device_uid === managedDeviceUid);
  assert.ok(ingestOnlyRow, 'ingest_only lifecycle_scope filter should include non-bridge device');
  assert.strictEqual(ingestOnlyRow.lifecycle_scope, 'ingest_only');

  const bridgeOpsFiltered = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices?company_id=${encodeURIComponent(companyId)}&lifecycle_scope=bridge_ops&device_uid=${encodeURIComponent(candidateDeviceUid)}`,
    headers: viewer
  });
  assert.strictEqual(bridgeOpsFiltered.status, 200, 'lifecycle_scope bridge_ops filter should return 200');
  const bridgeOpsRow = (bridgeOpsFiltered.body.value || []).find(row => row && row.device_uid === candidateDeviceUid);
  assert.ok(bridgeOpsRow, 'bridge_ops lifecycle_scope filter should include discovered candidate');
  assert.strictEqual(bridgeOpsRow.lifecycle_scope, 'bridge_ops');

  const reachableFiltered = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices?company_id=${encodeURIComponent(companyId)}&manageability_status=reachable&device_uid=${encodeURIComponent(candidateDeviceUid)}`,
    headers: viewer
  });
  assert.strictEqual(reachableFiltered.status, 200, 'manageability_status filter should return 200');
  const reachableRow = (reachableFiltered.body.value || []).find(row => row && row.device_uid === candidateDeviceUid);
  assert.ok(reachableRow, 'manageability filter should include reachable candidate');
  assert.strictEqual(reachableRow.manageability_status, 'reachable');

  const remediationFiltered = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/devices?company_id=${encodeURIComponent(companyId)}&remediation_manual_status=needs_field_action&device_uid=${encodeURIComponent(managedDeviceUid)}`,
    headers: viewer
  });
  assert.strictEqual(remediationFiltered.status, 200, 'remediation_manual_status filter should return 200');
  const remediationRow = (remediationFiltered.body.value || []).find(row => row && row.device_uid === managedDeviceUid);
  assert.ok(remediationRow, 'remediation filter should include remediated device');
  assert.strictEqual(remediationRow.remediation_manual_status, 'needs_field_action');

  console.log('devices operational filters contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
