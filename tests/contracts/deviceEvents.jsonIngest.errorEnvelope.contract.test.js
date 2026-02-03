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

  const missingRequired = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/device-events`,
    headers: { 'content-type': 'application/json' },
    body: {}
  });

  assert.strictEqual(missingRequired.status, 400, 'missing required fields should return 400');
  assertErrorEnvelope(missingRequired.body);
  assert.strictEqual(missingRequired.body.code, 'VALIDATION_ERROR', 'missing required code mismatch');
  assert.ok(
    missingRequired.body.details && missingRequired.body.details.kind === 'validation',
    'missing required details.kind should be validation'
  );

  const invalidDirection = await requestJson({
    method: 'POST',
    url: `${baseUrl}/api/device-events`,
    headers: { 'content-type': 'application/json' },
    body: {
      person_id: 'p1',
      event_time_utc: '2026-01-12T08:00:00Z',
      direction: 'SIDEWAYS',
      device_uid: 'DEV-1'
    }
  });

  assert.strictEqual(invalidDirection.status, 400, 'invalid direction should return 400');
  assertErrorEnvelope(invalidDirection.body);
  assert.strictEqual(invalidDirection.body.code, 'VALIDATION_ERROR', 'invalid direction code mismatch');
  assert.ok(
    invalidDirection.body.details && invalidDirection.body.details.kind === 'validation',
    'invalid direction details.kind should be validation'
  );

  console.log('device events json ingest error envelope contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
