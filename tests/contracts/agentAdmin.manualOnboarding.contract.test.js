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
  const runId = Math.random().toString(16).slice(2, 10);
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
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
      body: {
        company_id: companyId,
        provider: 'zkteco'
      }
    });
    assert.strictEqual(unauth.status, 401, 'manual onboarding should require auth');
    assertErrorEnvelope(unauth.body);

    const viewerForbidden = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
      headers: viewer,
      body: {
        company_id: companyId,
        provider: 'zkteco'
      }
    });
    assert.strictEqual(viewerForbidden.status, 403, 'viewer should not upsert manual onboarding candidate');
    assertErrorEnvelope(viewerForbidden.body);
  }

  const invalidPayload = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      connection: {
        host: '192.168.22.201'
      }
    }
  });
  assert.strictEqual(invalidPayload.status, 400, 'provider is required');
  assertErrorEnvelope(invalidPayload.body);
  assert.strictEqual(invalidPayload.body.details.error, 'invalid_request');

  const completeCreate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_name: `K80 Manual ${runId}`,
      identity: {
        serial_number: `B1-${runId}`
      },
      connection: {
        host: '192.168.22.201',
        port: 4370,
        communication_key: 1234,
        device_number: 1,
        transport: 'tcp',
        attlog_sequence: 'zktime_k80'
      },
      site_context: {
        site_label: 'HQ Main'
      }
    }
  });
  assert.strictEqual(completeCreate.status, 201, 'manual onboarding create should return 201');
  assert.strictEqual(completeCreate.body.company_id, companyId);
  assert.ok(
    String(completeCreate.body.device_uid || '').startsWith('zkteco:sn:'),
    'manual onboarding should derive canonical serial-based device uid'
  );
  assert.strictEqual(completeCreate.body.provider, 'zkteco');
  assert.strictEqual(completeCreate.body.managed_status, 'candidate');
  assert.strictEqual(completeCreate.body.lifecycle_scope, 'bridge_ops');
  assert.strictEqual(completeCreate.body.configuration_status, 'complete');
  assert.deepStrictEqual(completeCreate.body.missing_required_fields, []);
  assert.strictEqual(completeCreate.body.ready_for_validation, true);
  assert.strictEqual(completeCreate.body.validation_status, 'never_run');
  assert.strictEqual(completeCreate.body.validation_reason_code, null);
  assert.strictEqual(completeCreate.body.onboarding_state, 'candidate_configured');

  const completeUpdate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_uid: completeCreate.body.device_uid,
      operator_notes: {
        label: 'field-note',
        notes: 'updated during contract test'
      }
    }
  });
  assert.strictEqual(completeUpdate.status, 200, 'manual onboarding update should return 200');
  assert.strictEqual(completeUpdate.body.device_uid, completeCreate.body.device_uid);
  assert.strictEqual(completeUpdate.body.managed_status, 'candidate');
  assert.strictEqual(completeUpdate.body.lifecycle_scope, 'bridge_ops');
  assert.strictEqual(completeUpdate.body.configuration_status, 'complete');
  assert.strictEqual(completeUpdate.body.ready_for_validation, true);
  assert.strictEqual(completeUpdate.body.validation_status, 'never_run');
  assert.strictEqual(completeUpdate.body.onboarding_state, 'candidate_configured');

  const incompleteDeviceUid = `zkteco:manual:B1-INCOMPLETE-${runId}`;
  const incompleteCreate = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_uid: incompleteDeviceUid
    }
  });
  assert.strictEqual(incompleteCreate.status, 201, 'incomplete manual candidate create should return 201');
  assert.strictEqual(incompleteCreate.body.device_uid, incompleteDeviceUid);
  assert.strictEqual(incompleteCreate.body.configuration_status, 'incomplete');
  assert.strictEqual(incompleteCreate.body.ready_for_validation, false);
  assert.strictEqual(incompleteCreate.body.validation_status, 'never_run');
  assert.strictEqual(incompleteCreate.body.onboarding_state, 'candidate_unconfigured');
  const missing = new Set(incompleteCreate.body.missing_required_fields || []);
  [
    'connection.host',
    'connection.port',
    'connection.communication_key',
    'connection.device_number',
    'connection.transport',
    'connection.attlog_sequence'
  ].forEach(key => {
    assert.ok(missing.has(key), `incomplete response should include missing required field ${key}`);
  });

  const managedConflictUid = `zkteco:sn:B1-CONFLICT-${runId}`;
  const createManaged = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/devices/${encodeURIComponent(managedConflictUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_name: `Managed Conflict ${runId}`,
      active: true,
      metadata: {
        ip: '192.168.22.211'
      }
    }
  });
  assert.strictEqual(createManaged.status, 200, 'managed conflict fixture should be created via /api/devices');
  assert.strictEqual(createManaged.body.managed_status, 'managed');

  const managedConflict = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/agent-admin/devices/manual-onboarding`,
    headers: operator,
    body: {
      company_id: companyId,
      provider: 'zkteco',
      device_uid: managedConflictUid
    }
  });
  assert.strictEqual(managedConflict.status, 409, 'manual onboarding should reject existing managed row');
  assertErrorEnvelope(managedConflict.body);
  assert.strictEqual(
    managedConflict.body && managedConflict.body.details && managedConflict.body.details.error,
    'device_not_candidate',
    'conflict should expose deterministic device_not_candidate error'
  );

  console.log('agent admin manual onboarding contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
