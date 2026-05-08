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

async function run() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();
  const authRequired = requireAuth();
  const opHeaders = operatorHeaders();
  const viewHeaders = viewerHeaders();
  const runId = Math.random().toString(16).slice(2, 10);
  const deviceUid = `zkteco:sn:REM-${runId}`;

  const createDevice = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers: opHeaders,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_name: `Remediation Device ${runId}`,
      active: true,
      metadata: { source: 'contract_test' }
    }
  });
  assert.strictEqual(createDevice.status, 200, 'device setup should return 200');

  if (authRequired) {
    const unauth = await requestJson({
      method: 'PUT',
      url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/remediation?company_id=${encodeURIComponent(companyId)}`,
      body: {
        company_id: companyId,
        remediation_status: 'needs_field_action'
      }
    });
    assert.strictEqual(unauth.status, 401, 'remediation endpoint should require auth');
    assertErrorEnvelope(unauth.body);

    const viewerForbidden = await requestJson({
      method: 'PUT',
      url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/remediation?company_id=${encodeURIComponent(companyId)}`,
      headers: viewHeaders,
      body: {
        company_id: companyId,
        remediation_status: 'needs_field_action'
      }
    });
    assert.strictEqual(viewerForbidden.status, 403, 'viewer should not mutate remediation state');
    assertErrorEnvelope(viewerForbidden.body);
  }

  const mismatch = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/remediation?company_id=${encodeURIComponent(companyId)}`,
    headers: opHeaders,
    body: {
      company_id: 'OTHER',
      remediation_status: 'needs_field_action'
    }
  });
  assert.strictEqual(
    mismatch.status,
    authRequired ? 403 : 400,
    `tenant mismatch should return ${authRequired ? 403 : 400}`
  );
  assertErrorEnvelope(mismatch.body);

  const setManual = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/remediation?company_id=${encodeURIComponent(companyId)}`,
    headers: opHeaders,
    body: {
      company_id: companyId,
      remediation_status: 'needs_field_action',
      note: 'Device requires onsite unlock',
      owner: 'field-tech'
    }
  });
  assert.strictEqual(setManual.status, 200, 'set remediation should return 200');
  assert.strictEqual(setManual.body.remediation_manual_status, 'needs_field_action');
  assert.strictEqual(setManual.body.remediation_manual_owner, 'field-tech');
  assert.ok(setManual.body.manageability, 'response should expose manageability view');
  assert.strictEqual(setManual.body.manageability.effective_status, 'needs_field_action');

  const clearManual = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/remediation?company_id=${encodeURIComponent(companyId)}`,
    headers: opHeaders,
    body: {
      company_id: companyId,
      remediation_status: null
    }
  });
  assert.strictEqual(clearManual.status, 200, 'clear remediation should return 200');
  assert.strictEqual(clearManual.body.remediation_manual_status, null, 'manual remediation status should clear');
  assert.ok(clearManual.body.manageability, 'response should expose manageability view after clear');
  assert.notStrictEqual(
    clearManual.body.manageability.effective_status,
    'needs_field_action',
    'effective status should no longer be manual remediation state after clear'
  );

  console.log('agent admin device remediation error envelope contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
