const assert = require('assert');
const http = require('http');

function requestRaw({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? null : JSON.stringify(body);
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      headers: { ...headers }
    };
    if (payload) {
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          if (data) json = JSON.parse(data);
        } catch (e) {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
  const adminKey = process.env.AUTH_ADMIN_KEY;

  if (!adminKey) {
    throw new Error('AUTH_ADMIN_KEY environment variable must be set explicitly for this test.');
  }

  const mismatchCompanyId = 'MISMATCH_COMPANY_' + Date.now();

  const targetUrl = `${baseUrl}/api/devices?company_id=${mismatchCompanyId}&limit=1`;

  const res = await requestRaw({
    method: 'GET',
    url: targetUrl,
    headers: {
      'x-api-key': adminKey
    }
  });

  assert.strictEqual(
    res.status,
    403,
    `Expected exactly 403 Forbidden for mismatched company_id, got ${res.status}. Body: ${res.data}. If 401, it means authentication failed rather than tenant isolation.`
  );

  console.log('PASS: admin_tenant_isolation.test.js');
}

run().catch(err => {
  console.error('FAIL: admin_tenant_isolation.test.js', err);
  process.exit(1);
});
