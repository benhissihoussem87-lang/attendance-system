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

  // This test probes the currently running server instance.
  // It expects the instance to be booted with ALLOW_TEST_ENDPOINTS=false (production config).
  // Under this mode, the expected behavior is that test endpoints drop the request
  // with a 404 or 403 to prevent exposure of destructive functions.

  const resetRes = await requestRaw({
    method: 'POST',
    url: `${baseUrl}/api/ops/test/reset`,
    headers: {}
  });

  assert.ok(
    resetRes.status === 404 || resetRes.status === 403,
    `Expected 404 or 403 for /api/ops/test/reset in production mode, got ${resetRes.status}. Body: ${resetRes.data}`
  );

  const modeRes = await requestRaw({
    method: 'GET',
    url: `${baseUrl}/api/ops/test/mode`,
    headers: {}
  });

  assert.ok(
    modeRes.status === 404 || modeRes.status === 403,
    `Expected 404 or 403 for /api/ops/test/mode in production mode, got ${modeRes.status}. Body: ${modeRes.data}`
  );

  console.log('PASS: ops_test_exposure.test.js');
}

run().catch(err => {
  console.error('FAIL: ops_test_exposure.test.js', err);
  process.exit(1);
});
