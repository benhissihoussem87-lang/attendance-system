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

  const res = await requestRaw({
    method: 'POST',
    url: `${baseUrl}/api/agent/heartbeat`,
    headers: {
      'x-agent-id': 'invalid-id',
      'x-agent-signature': 'invalid-signature',
      'x-agent-timestamp': Date.now().toString()
    },
    body: {
      agent_id: 'invalid-id',
      status: 'active'
    }
  });

  assert.strictEqual(
    res.status,
    401,
    `Expected exactly 401 Unauthorized for invalid agent signature, got ${res.status}. Body: ${res.data}`
  );

  const envelope = res.json;
  assert.ok(envelope !== null, `Expected JSON response, got raw string: ${res.data}`);
  assert.ok('error' in envelope, `Missing 'error' property in response envelope. Data: ${res.data}`);
  assert.ok('code' in envelope, `Missing 'code' property in response envelope. Data: ${res.data}`);
  assert.ok('message' in envelope, `Missing 'message' property in response envelope. Data: ${res.data}`);

  console.log('PASS: agent_auth_isolation.test.js');
}

run().catch(err => {
  console.error('FAIL: agent_auth_isolation.test.js', err);
  process.exit(1);
});
