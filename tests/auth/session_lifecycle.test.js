const assert = require('assert');
const http = require('http');
const https = require('https');
const { getCompanyId } = require('../contracts/_helpers/auth');
const { SESSION_COOKIE_NAME } = require('../../services/auth/sessionAuth');

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
  const testEmail = `test.session.${Date.now()}@example.com`;
  const testPassword = 'CorrectHorseBatteryStaple1!';

  console.log('Testing session lifecycle against:', baseUrl);

  // 1. missing session returns 401
  const meMissing = await requestRaw({ method: 'GET', url: `${baseUrl}/api/auth/me` });
  assert.strictEqual(meMissing.status, 401, 'missing session must return 401 for /me');

  // 2. invalid session returns 401
  const meInvalid = await requestRaw({
    method: 'GET',
    url: `${baseUrl}/api/auth/me`,
    headers: { 'Cookie': `${SESSION_COOKIE_NAME}=invalid_token_value` }
  });
  assert.strictEqual(meInvalid.status, 401, 'invalid session must return 401 for /me');

  // We need an account to test login. We try bootstrap-admin.
  const bootstrapSecret = process.env.AUTH_BOOTSTRAP_SECRET;
  if (!bootstrapSecret) {
    console.log('BLOCKED: AUTH_BOOTSTRAP_SECRET env var is missing. Cannot create test user.');
    process.exit(1);
  }

  const bootstrapRes = await requestRaw({
    method: 'POST',
    url: `${baseUrl}/api/auth/bootstrap-admin`,
    headers: { 'x-bootstrap-secret': bootstrapSecret },
    body: { company_id: companyId, email: testEmail, password: testPassword }
  });

  if (bootstrapRes.status === 403 && bootstrapRes.body && bootstrapRes.body.details && bootstrapRes.body.details.error === 'bootstrap_disabled') {
     console.log('BLOCKED: bootstrap_disabled. Server must have AUTH_BOOTSTRAP_ADMIN_ENABLED=1 to run this test.');
     process.exit(1);
  }
  
  assert.strictEqual(bootstrapRes.status, 201, `bootstrap must return 201 for a new unique user, got ${bootstrapRes.status}`);

  // 3. valid login creates a session cookie
  const loginRes = await requestRaw({
    method: 'POST',
    url: `${baseUrl}/api/auth/login`,
    body: { email: testEmail, password: testPassword }
  });
  assert.strictEqual(loginRes.status, 200, 'valid login must return 200');
  const setCookie = loginRes.headers['set-cookie'];
  assert.ok(setCookie, 'login must return set-cookie header');
  const cookieString = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  assert.ok(cookieString.includes(`${SESSION_COOKIE_NAME}=`), `cookie must contain ${SESSION_COOKIE_NAME}`);

  const sessionCookieMatch = cookieString.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`));
  assert.ok(sessionCookieMatch, 'must extract session cookie name and value');
  const sessionToken = sessionCookieMatch[1];

  // 4. valid session can access /api/auth/me
  const meValid = await requestRaw({
    method: 'GET',
    url: `${baseUrl}/api/auth/me`,
    headers: { 'Cookie': `${SESSION_COOKIE_NAME}=${sessionToken}` }
  });
  assert.strictEqual(meValid.status, 200, 'valid session must access /me');
  assert.strictEqual(meValid.body.user.email, testEmail, 'session must return correct user');

  // 5. logout revokes the session
  const logoutRes = await requestRaw({
    method: 'POST',
    url: `${baseUrl}/api/auth/logout`,
    headers: { 'Cookie': `${SESSION_COOKIE_NAME}=${sessionToken}` }
  });
  assert.strictEqual(logoutRes.status, 200, 'logout must return 200');
  const logoutCookie = logoutRes.headers['set-cookie'];
  assert.ok(logoutCookie, 'logout must return set-cookie to clear it');
  const logoutCookieStr = Array.isArray(logoutCookie) ? logoutCookie[0] : logoutCookie;
  assert.ok(logoutCookieStr.includes(`${SESSION_COOKIE_NAME}=;`), 'logout must clear session cookie');

  // 6. revoked session returns 401
  const meRevoked = await requestRaw({
    method: 'GET',
    url: `${baseUrl}/api/auth/me`,
    headers: { 'Cookie': `${SESSION_COOKIE_NAME}=${sessionToken}` }
  });
  assert.strictEqual(meRevoked.status, 401, 'revoked session must return 401');

  // Future coverage: expired session
  console.log('INFO: Expired session coverage is not implemented here. Requires direct DB manipulation or time mocking.');

  console.log('PASS: session lifecycle');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
