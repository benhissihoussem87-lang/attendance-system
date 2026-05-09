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
  const viewerKey = process.env.AUTH_VIEWER_KEY;

  if (!viewerKey) {
    throw new Error('AUTH_VIEWER_KEY environment variable must be set explicitly for this test.');
  }

  const res = await requestRaw({
    method: 'POST',
    url: `${baseUrl}/api/simulate/day`,
    headers: {
      'x-api-key': viewerKey
    },
    body: {
      work_date: '2026-01-01'
    }
  });

  assert.strictEqual(
    res.status,
    403,
    `Expected exactly 403 Forbidden for operator route with viewer key, got ${res.status}. Body: ${res.data}. If 401, authentication failed, not role enforcement.`
  );

  console.log('PASS: operator_role_enforcement.test.js');
}

run().catch(err => {
  console.error('FAIL: operator_role_enforcement.test.js', err);
  process.exit(1);
});
