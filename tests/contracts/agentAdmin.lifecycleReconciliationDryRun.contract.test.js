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

function assertStrictCategories(categories) {
  assert.ok(Array.isArray(categories), 'strict_categories should be array');
  const expected = new Set([
    'superseded_without_canonical',
    'canonical_with_superseded_pointer',
    'managed_bridge_missing_active_binding',
    'active_binding_on_non_bridge_or_non_managed_device',
    'canonical_device_missing_active_device_uid_alias',
    'active_alias_points_to_superseded_canonical'
  ]);

  for (const row of categories) {
    assert.ok(row && typeof row === 'object', 'strict category row should be object');
    assert.strictEqual(typeof row.anomaly_type, 'string', 'anomaly_type should be string');
    assert.ok(expected.has(row.anomaly_type), `unexpected strict anomaly_type ${row.anomaly_type}`);
    expected.delete(row.anomaly_type);
    assert.strictEqual(typeof row.issue_count, 'number', 'issue_count should be number');
    assert.strictEqual(typeof row.detail_rows_included, 'number', 'detail_rows_included should be number');
    assert.strictEqual(typeof row.description, 'string', 'description should be string');
  }

  assert.strictEqual(expected.size, 0, `missing strict categories: ${Array.from(expected).join(', ')}`);
}

function assertFindingShape(finding) {
  assert.ok(finding && typeof finding === 'object', 'finding should be object');
  assert.ok(finding.anomaly_detected && typeof finding.anomaly_detected === 'object', 'anomaly_detected should be object');
  assert.strictEqual(finding.anomaly_detected.severity, 'strict', 'dry-run findings must stay strict-only');
  assert.strictEqual(typeof finding.anomaly_detected.anomaly_type, 'string', 'anomaly_type should be string');
  assert.strictEqual(typeof finding.anomaly_detected.description, 'string', 'description should be string');
  assert.ok(finding.anomaly_detected.evidence && typeof finding.anomaly_detected.evidence === 'object', 'evidence should be object');

  assert.ok(finding.proposed_repair_action && typeof finding.proposed_repair_action === 'object', 'proposed_repair_action should be object');
  assert.strictEqual(typeof finding.proposed_repair_action.action_type, 'string', 'action_type should be string');
  assert.strictEqual(finding.proposed_repair_action.action_mode, 'dry_run_only', 'proposed action must be dry_run_only');
  assert.ok(
    finding.proposed_repair_action.candidate_parameters && typeof finding.proposed_repair_action.candidate_parameters === 'object',
    'candidate_parameters should be object'
  );
  assert.ok(['high', 'medium', 'low'].includes(finding.confidence), 'confidence should be high|medium|low');
  assert.ok(
    ['safe_auto', 'needs_review', 'manual_required'].includes(finding.safety_level),
    'safety_level should be safe_auto|needs_review|manual_required'
  );
  assert.strictEqual(finding.write_mode, 'dry_run_only', 'write_mode must be dry_run_only');
}

async function run() {
  const baseUrl = getBaseUrl();
  await ensureMode(baseUrl);

  const companyId = getCompanyId();
  const authRequired = requireAuth();
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
      url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/dry-run?company_id=${encodeURIComponent(companyId)}`
    });
    assert.strictEqual(unauth.status, 401, 'dry-run reconciliation view should require auth');
    assertErrorEnvelope(unauth.body);

    const viewerAllowed = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/dry-run?company_id=${encodeURIComponent(companyId)}`,
      headers: viewer
    });
    assert.strictEqual(viewerAllowed.status, 200, 'viewer should be allowed dry-run reconciliation access');

    const operatorAllowed = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/dry-run?company_id=${encodeURIComponent(companyId)}`,
      headers: operator
    });
    assert.strictEqual(operatorAllowed.status, 200, 'operator should be allowed dry-run reconciliation access');
  }

  const mismatch = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/dry-run?company_id=OTHER`,
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

  const res = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/agent-admin/lifecycle-reconciliation/dry-run?company_id=${encodeURIComponent(companyId)}&detail_limit=9`,
    headers: viewer
  });
  assert.strictEqual(res.status, 200, 'dry-run reconciliation should return 200');
  const body = res.body;
  assert.ok(body && typeof body === 'object', 'response body should be object');
  assert.strictEqual(body.company_id, companyId, 'response should be company-scoped');
  assert.strictEqual(typeof body.generated_at, 'string', 'generated_at should be string');
  assert.strictEqual(body.mode, 'dry_run', 'mode should be dry_run');
  assert.strictEqual(body.strict_only, true, 'strict_only should stay true');
  assert.strictEqual(body.detail_limit, 9, 'detail_limit should echo applied value');
  assert.strictEqual(typeof body.strict_issue_count_total, 'number', 'strict_issue_count_total should be number');
  assert.strictEqual(typeof body.findings_count, 'number', 'findings_count should be number');
  assertStrictCategories(body.strict_categories);
  assert.ok(Array.isArray(body.findings), 'findings should be array');
  assert.strictEqual(body.findings.length, body.findings_count, 'findings_count should match findings length');
  body.findings.forEach(assertFindingShape);
  assert.ok(Array.isArray(body.notes), 'notes should be an array');
  assert.ok(body.notes.some(note => String(note).toLowerCase().includes('dry-run')), 'notes should explicitly mention dry-run mode');

  console.log('agent admin lifecycle reconciliation dry-run contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
