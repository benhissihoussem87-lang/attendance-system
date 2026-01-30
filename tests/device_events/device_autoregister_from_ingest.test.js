const http = require('http');
const https = require('https');
const { Client } = require('pg');

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
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });

    req.on('error', reject);
    if (payload !== null) {
      req.write(payload);
    }
    req.end();
  });
}

function requireEnv(name) {
  const value = process.env[name];
  return value && value.toString().trim() ? value.toString().trim() : '';
}

function getPgConfigOrNull() {
  const host = requireEnv('PGHOST');
  const user = requireEnv('PGUSER');
  const database = requireEnv('PGDATABASE');

  if (!host || !user || !database) {
    return null;
  }

  const portRaw = requireEnv('PGPORT');
  const port = portRaw ? Number.parseInt(portRaw, 10) : 5432;
  if (Number.isNaN(port)) {
    throw new Error(`Invalid PGPORT value: ${portRaw}`);
  }

  return {
    host,
    port,
    user,
    password: process.env.PGPASSWORD || undefined,
    database
  };
}

function getBaseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
}

async function isServerReady(baseUrl) {
  try {
    const res = await requestJson({
      method: 'GET',
      url: `${baseUrl}/api/ops/test/mode`
    });
    if (res.status !== 200 || !res.body || !res.body.allow_test_endpoints) {
      return false;
    }
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureIdentityMapping({ baseUrl, companyId, personId, identifierValue }) {
  await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/employees-registry/${encodeURIComponent(personId)}`,
    headers: { 'content-type': 'application/json' },
    body: {
      company_id: companyId,
      employee_code: personId,
      full_name: 'AutoReg Test',
      active: true
    }
  });

  await requestJson({
    method: 'PUT',
    url: `${baseUrl}/api/identity-mappings`,
    headers: { 'content-type': 'application/json' },
    body: {
      company_id: companyId,
      provider: 'generic',
      identifier_type: 'person_id',
      identifier_value: identifierValue,
      person_id: personId,
      active: true
    }
  });
}

async function generateUniqueDeviceUid(client, companyId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `autoRegTest:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const exists = await client.query(
      'SELECT 1 FROM public.devices WHERE company_id=$1 AND device_uid=$2 LIMIT 1',
      [companyId, candidate]
    );
    if (!exists.rows || exists.rows.length === 0) {
      return candidate;
    }
  }
  throw new Error('Unable to generate unique device_uid');
}

async function run() {
  const config = getPgConfigOrNull();
  if (!config) {
    console.log('SKIP: device auto-register from ingest (PG env vars not set)');
    return;
  }

  const baseUrl = getBaseUrl();
  const serverOk = await isServerReady(baseUrl);
  if (!serverOk) {
    console.log('SKIP: device auto-register from ingest (server not ready/test endpoints disabled)');
    return;
  }

  const client = new Client(config);
  const companyId = 'DEFAULT';
  const personId = `autoreg_person_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const identifierValue = `AUTO-${Math.random().toString(16).slice(2, 10)}`;

  try {
    await client.connect();
    const deviceUid = await generateUniqueDeviceUid(client, companyId);

    await ensureIdentityMapping({ baseUrl, companyId, personId, identifierValue });

    const event = {
      company_id: companyId,
      person_id: personId,
      event_time_utc: '2026-01-27T12:00:00Z',
      direction: 'IN',
      device_uid: deviceUid,
      vendor: 'generic',
      provider: 'generic',
      identifier_type: 'person_id',
      identifier_value: identifierValue
    };

    const ingestRes = await requestJson({
      method: 'POST',
      url: `${baseUrl}/api/device-events`,
      headers: { 'content-type': 'application/json' },
      body: event
    });

    if (ingestRes.status !== 200 && ingestRes.status !== 201) {
      throw new Error(`ingest failed. status=${ingestRes.status} body=${ingestRes.raw}`);
    }
    if (!ingestRes.body || ingestRes.body.status !== 'ok') {
      throw new Error(`ingest response not ok. status=${ingestRes.status} body=${ingestRes.raw}`);
    }

    const deviceRes = await client.query(
      'SELECT company_id, device_uid, provider, metadata FROM public.devices WHERE company_id=$1 AND device_uid=$2',
      [companyId, deviceUid]
    );

    if (!deviceRes.rows || deviceRes.rows.length !== 1) {
      throw new Error('device row not created after ingest');
    }

    const metadata = deviceRes.rows[0].metadata;
    if (!metadata || typeof metadata !== 'object') {
      throw new Error('device metadata should be a jsonb object');
    }
    if (Object.prototype.hasOwnProperty.call(metadata, 'source') && metadata.source !== 'ingest') {
      throw new Error(`device metadata.source expected ingest, got ${metadata.source}`);
    }

    console.log('PASS: device auto-register from ingest');
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
