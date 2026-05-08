const assert = require('assert');
const http = require('http');
const https = require('https');
const { adminHeaders, operatorHeaders, viewerHeaders, getCompanyId, requireAuth } = require('../contracts/_helpers/auth');

function requestRaw({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: { ...headers }
    };
    if (payload) {
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try { parsed = JSON.parse(data); } catch (_) { parsed = { raw: data }; }
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
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

async function run() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();

  const app = await requestRaw({ method: 'GET', url: `${baseUrl}/app/` });
  assert.ok([302, 301].includes(app.status), '/app should redirect unauthenticated browsers');
  assert.ok(String(app.headers.location || '').includes('/login'), '/app should redirect to login');

  const me = await requestRaw({ method: 'GET', url: `${baseUrl}/api/auth/me` });
  assert.strictEqual(me.status, 401, '/api/auth/me should reject missing session');

  if (requireAuth()) {
    const viewerStart = await requestRaw({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/devices/missing/monitoring-sessions`,
      headers: { ...viewerHeaders(), 'x-company-id': companyId },
      body: { company_id: companyId }
    });
    assert.strictEqual(viewerStart.status, 403, 'viewer cannot connect/disconnect monitoring');

    const operatorCompany = await requestRaw({
      method: 'POST',
      url: `${baseUrl}/api/companies`,
      headers: { ...operatorHeaders(), 'x-company-id': companyId },
      body: { company_id: `auth-v1-${Date.now()}`, display_name: 'Auth v1', timezone: 'Africa/Tunis' }
    });
    assert.strictEqual(operatorCompany.status, 403, 'operator cannot mutate Settings company data');

    const operatorPull = await requestRaw({
      method: 'POST',
      url: `${baseUrl}/api/agent-admin/agents/missing/commands/pull-device-events`,
      headers: { ...operatorHeaders(), 'x-company-id': companyId },
      body: { company_id: companyId, device_uid: 'missing', options: {} }
    });
    assert.notStrictEqual(operatorPull.status, 403, 'operator role should pass sync role gate');

    const adminCompany = await requestRaw({
      method: 'POST',
      url: `${baseUrl}/api/companies`,
      headers: { ...adminHeaders(), 'x-company-id': companyId },
      body: { company_id: `auth-v1-${Date.now()}`, display_name: 'Auth v1', timezone: 'Africa/Tunis' }
    });
    assert.notStrictEqual(adminCompany.status, 403, 'admin should pass Settings mutation role gate');
  }

  console.log('PASS: auth v1 route protection');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
