const assert = require('assert');
const http = require('http');
const https = require('https');
const { adminHeaders, getCompanyId, requireAuth, viewerHeaders } = require('./_helpers/auth');

function requestJson({ method, url, headers = {} }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers
    };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try { parsed = JSON.parse(data); } catch (_) { parsed = { raw: data }; }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function baseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
}

async function run() {
  const companyId = getCompanyId();
  const unauth = await requestJson({
    method: 'GET',
    url: `${baseUrl()}/api/attendance-v1/daily?start_date=2026-05-07&end_date=2026-05-07`
  });
  if (requireAuth()) {
    assert.strictEqual(unauth.status, 401, 'Attendance v1 should reject missing credentials');
  }

  const viewer = await requestJson({
    method: 'GET',
    url: `${baseUrl()}/api/attendance-v1/daily?start_date=2026-04-14&end_date=2026-05-07&company_id=${encodeURIComponent(companyId)}`,
    headers: { ...viewerHeaders(), 'x-company-id': companyId }
  });
  assert.strictEqual(viewer.status, 200, 'viewer should read Attendance v1');
  const rows = Array.isArray(viewer.body && viewer.body.rows) ? viewer.body.rows : [];
  assert.ok(rows.some(row => row.employee_code === 'EMP-K80-001'), 'Amir should appear');
  assert.ok(rows.some(row => row.employee_code === 'EMP-K80-003'), 'Houssem should appear');
  assert.ok(!rows.some(row => row.employee_code === 'EMP-K80-022-TEST'), 'validation user excluded by default');

  const viewerInclude = await requestJson({
    method: 'GET',
    url: `${baseUrl()}/api/attendance-v1/daily?start_date=2026-04-14&end_date=2026-05-07&include_validation=true&company_id=${encodeURIComponent(companyId)}`,
    headers: { ...viewerHeaders(), 'x-company-id': companyId }
  });
  assert.strictEqual(viewerInclude.status, 403, 'viewer cannot include validation users');

  const adminInclude = await requestJson({
    method: 'GET',
    url: `${baseUrl()}/api/attendance-v1/daily?start_date=2026-04-14&end_date=2026-05-07&include_validation=true&company_id=${encodeURIComponent(companyId)}`,
    headers: { ...adminHeaders(), 'x-company-id': companyId }
  });
  assert.strictEqual(adminInclude.status, 200, 'admin can include validation users');
  assert.ok(
    adminInclude.body.rows.some(row => row.employee_code === 'EMP-K80-022-TEST'),
    'admin include_validation should include Test User'
  );

  console.log('PASS: attendance v1 product contract');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
