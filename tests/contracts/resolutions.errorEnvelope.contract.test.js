const assert = require('assert');
const http = require('http');
const https = require('https');
const { getCompanyId, operatorHeaders } = require('./_helpers/auth');

function requestJson({ method, url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const options = {
      method,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: { ...operatorHeaders(), ...headers }
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
  const companyId = getCompanyId();

  const invalidIdRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/attendance/not-a-uuid/resolutions`
  });

  assert.strictEqual(invalidIdRes.status, 400, 'invalid attendance_day_id should return 400');
  assertErrorEnvelope(invalidIdRes.body);
  assert.strictEqual(invalidIdRes.body.code, 'VALIDATION_ERROR', 'validation code mismatch');
  assert.strictEqual(invalidIdRes.body.message, 'Validation failed', 'validation message mismatch');
  assert.ok(
    invalidIdRes.body.details && invalidIdRes.body.details.kind === 'validation',
    'validation details.kind should be validation'
  );
  assert.strictEqual(
    invalidIdRes.body.details.error,
    'attendance_day_id_invalid',
    'validation details.error mismatch'
  );

  // 409 is not deterministically reachable without fixtures.
  const missingPersonId = `missing-${Math.random().toString(16).slice(2, 10)}`;
  const missingRes = await requestJson({
    method: 'GET',
    url: `${baseUrl}/api/resolutions?company_id=${encodeURIComponent(companyId)}&person_id=${encodeURIComponent(missingPersonId)}&date=2099-01-01`
  });

  assert.strictEqual(missingRes.status, 404, 'missing attendance day should return 404');
  assertErrorEnvelope(missingRes.body);
  assert.strictEqual(missingRes.body.code, 'LOOKUP_NOT_FOUND', 'lookup code mismatch');
  assert.strictEqual(missingRes.body.message, 'Attendance day not found', 'lookup message mismatch');
  assert.ok(
    missingRes.body.details && missingRes.body.details.kind === 'lookup_error',
    'lookup details.kind should be lookup_error'
  );
  assert.strictEqual(
    missingRes.body.details.error,
    'attendance_day_not_found',
    'lookup details.error mismatch'
  );

  console.log('resolutions error envelope contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
