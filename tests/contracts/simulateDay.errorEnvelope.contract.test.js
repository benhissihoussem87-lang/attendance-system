const assert = require('assert');
const http = require('http');
const https = require('https');

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
        options.headers['content-type'] = typeof body === 'string'
          ? 'text/plain'
          : 'application/json';
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

function ensureString(value, label) {
  assert.strictEqual(typeof value, 'string', `${label} must be string`);
}

function assertErrorEnvelope(body) {
  assert.ok(body && typeof body === 'object', 'error body is required');
  ensureString(body.error, 'error.error');
  ensureString(body.code, 'error.code');
  ensureString(body.message, 'error.message');
}

async function run() {
  const baseUrl = getBaseUrl();

  const res = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/simulate/day`,
    headers: { 'content-type': 'application/json' },
    body: {
      date: '2026-01-01'
    }
  });

  assert.strictEqual(res.status, 400, 'missing person_id should return 400');
  assertErrorEnvelope(res.body);
  assert.strictEqual(res.body.code, 'VALIDATION_ERROR', 'validation code mismatch');
  assert.strictEqual(res.body.message, 'Validation failed', 'validation message mismatch');
  assert.ok(
    res.body.details && res.body.details.kind === 'validation',
    'validation details.kind should be validation'
  );
  assert.strictEqual(
    res.body.details.error,
    'person_id_required',
    'validation details.error mismatch'
  );

  console.log('simulate day error envelope contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
