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

  // Target 1: A route in agentAdmin.routes.js that uses `resolveCompanyId`.
  // By sending mismatched company_ids in the header vs the query, `resolveCompanyId`
  // deliberately returns an error object, which triggers `sendError` with a 400.
  // This is a safe GET request.
  const targetUrlAdmin = `${baseUrl}/api/agent-admin/sites?company_id=CompanyA`;

  const res = await requestRaw({
    method: 'GET',
    url: targetUrlAdmin,
    headers: {
      'x-api-key': adminKey,
      'x-company-id': 'CompanyB' // Mismatch triggers 400 validation error
    }
  });

  assert.ok(
    res.status >= 400 && res.status < 500,
    `Expected a 4xx error status from company_id mismatch validation for ${targetUrlAdmin}, got ${res.status}. Data: ${res.data}`
  );

  assert.ok(
    res.json !== null,
    `Expected JSON response for error on ${targetUrlAdmin}, got raw string: ${res.data}`
  );

  const envelope = res.json;
  assert.ok('error' in envelope, `Missing 'error' key in envelope on ${targetUrlAdmin}. Data: ${res.data}`);
  assert.ok('code' in envelope, `Missing 'code' key in envelope on ${targetUrlAdmin}. Data: ${res.data}`);
  assert.ok('message' in envelope, `Missing 'message' key in envelope on ${targetUrlAdmin}. Data: ${res.data}`);

  console.log('PASS: error_envelope_standard.test.js');
}

run().catch(err => {
  console.error('FAIL: error_envelope_standard.test.js', err);
  process.exit(1);
});
