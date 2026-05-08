const assert = require('assert');
const http = require('http');
const https = require('https');
const { getCompanyId, operatorHeaders, requireAuth } = require('./_helpers/auth');

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

function assertStatus(actual, allowed, label) {
  assert.ok(allowed.includes(actual), `${label}: expected HTTP ${allowed.join('/')} got ${actual}`);
}

function isoUtcDate(daysOffset, hourUtc) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysOffset);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date.toISOString().replace('.000Z', 'Z');
}

function ymdUtc(daysOffset) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysOffset);
  return date.toISOString().slice(0, 10);
}

async function run() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();
  const authHeaders = operatorHeaders();
  const authEnabled = requireAuth();

  if (authEnabled && !authHeaders['x-api-key']) {
    throw new Error('REQUIRE_AUTH=1 but operator API key is missing. Set TEST_API_KEY_OPERATOR (or API_KEY).');
  }

  const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const personId1 = `demo_contract_p1_${runId}`;
  const personId2 = `demo_contract_p2_${runId}`;
  const badge1 = `DEMO-BADGE-${runId}`;
  const badge2 = `DEMO-BADGE2-${runId}`;
  const deviceUid = `DEMO-DEVICE-${runId}`;

  const commonJsonHeaders = { ...authHeaders, 'content-type': 'application/json' };

  const emp1 = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(personId1)}?company_id=${encodeURIComponent(companyId)}`,
    headers: commonJsonHeaders,
    body: {
      employee_code: `EMP1-${runId}`,
      full_name: 'Demo Contract Person 1',
      active: true,
      metadata: { source: 'demo_contract' }
    }
  });
  assert.strictEqual(emp1.status, 200, 'employee 1 upsert should return 200');
  assert.ok(emp1.body && typeof emp1.body === 'object', 'employee 1 body is required');
  assert.strictEqual(emp1.body.person_id, personId1, 'employee 1 person_id mismatch');

  const emp2 = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(personId2)}?company_id=${encodeURIComponent(companyId)}`,
    headers: commonJsonHeaders,
    body: {
      employee_code: `EMP2-${runId}`,
      full_name: 'Demo Contract Person 2',
      active: true,
      metadata: { source: 'demo_contract' }
    }
  });
  assert.strictEqual(emp2.status, 200, 'employee 2 upsert should return 200');
  assert.ok(emp2.body && typeof emp2.body === 'object', 'employee 2 body is required');
  assert.strictEqual(emp2.body.person_id, personId2, 'employee 2 person_id mismatch');

  const map1 = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: commonJsonHeaders,
    body: {
      provider: 'demo',
      identifier_type: 'badge',
      identifier_value: badge1,
      person_id: personId1,
      active: true,
      metadata: { source: 'demo_contract' }
    }
  });
  assert.strictEqual(map1.status, 200, 'identity mapping 1 upsert should return 200');
  assert.ok(map1.body && typeof map1.body === 'object', 'identity mapping 1 body is required');
  assert.strictEqual(map1.body.person_id, personId1, 'identity mapping 1 person_id mismatch');

  const map2 = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings?company_id=${encodeURIComponent(companyId)}`,
    headers: commonJsonHeaders,
    body: {
      provider: 'demo',
      identifier_type: 'badge',
      identifier_value: badge2,
      person_id: personId2,
      active: true,
      metadata: { source: 'demo_contract' }
    }
  });
  assert.strictEqual(map2.status, 200, 'identity mapping 2 upsert should return 200');
  assert.ok(map2.body && typeof map2.body === 'object', 'identity mapping 2 body is required');
  assert.strictEqual(map2.body.person_id, personId2, 'identity mapping 2 person_id mismatch');

  const deviceRes = await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/devices/${encodeURIComponent(deviceUid)}?company_id=${encodeURIComponent(companyId)}`,
    headers: commonJsonHeaders,
    body: {
      provider: 'demo',
      device_name: `Demo Device ${runId}`,
      active: true,
      metadata: { source: 'demo_contract' }
    }
  });
  assert.strictEqual(deviceRes.status, 200, 'device upsert should return 200');
  assert.ok(deviceRes.body && typeof deviceRes.body === 'object', 'device body is required');
  assert.strictEqual(deviceRes.body.device_uid, deviceUid, 'device_uid mismatch');

  for (const offset of [-2, -1, 0]) {
    for (const event of [
      { direction: 'IN', event_time_utc: isoUtcDate(offset, 8) },
      { direction: 'OUT', event_time_utc: isoUtcDate(offset, 17) }
    ]) {
      const ingestRes = await requestJson({
        method: 'POST',
        url: `${baseUrl}/api/device-events`,
        headers: commonJsonHeaders,
        body: {
          company_id: companyId,
          person_id: personId1,
          event_time_utc: event.event_time_utc,
          direction: event.direction,
          vendor: 'demo',
          device_uid: deviceUid,
          provider: 'demo',
          identifier_type: 'badge',
          identifier_value: badge1,
          raw_payload: {
            source: 'demo_contract',
            direction: event.direction
          }
        }
      });
      assertStatus(ingestRes.status, [200, 201], `device event ${offset} ${event.direction}`);
      assert.ok(ingestRes.body && typeof ingestRes.body === 'object', 'device event response body is required');
      assert.strictEqual(ingestRes.body.status, 'ok', 'device event response status field mismatch');
    }
  }

  for (const offset of [-2, -1, 0]) {
    const date = ymdUtc(offset);
    const attendanceRes = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/attendance?company_id=${encodeURIComponent(companyId)}&person_id=${encodeURIComponent(personId1)}&date=${encodeURIComponent(date)}`,
      headers: authHeaders
    });
    assert.strictEqual(attendanceRes.status, 200, `attendance ${date} should return 200`);
    assert.ok(Array.isArray(attendanceRes.body), `attendance ${date} should return array`);
    assert.ok(attendanceRes.body.length >= 1, `attendance ${date} should include at least one row`);

    const row = attendanceRes.body[0];
    assert.ok(row && typeof row === 'object', `attendance ${date} row should be object`);
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'status'), `attendance ${date} row.status missing`);
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'source'), `attendance ${date} row.source missing`);
  }

  console.log('demo golden path contract test passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
