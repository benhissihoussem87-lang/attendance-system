const assert = require('assert');
const http = require('http');
const https = require('https');
const { viewerHeaders, getCompanyId, requireAuth } = require('./_helpers/auth');

function getBaseUrl() {
  return process.env.BASE_URL || 'http://localhost:3000';
}

function requestSseReady({ url, headers = {} }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers
    }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk.toString('utf8');
        if (data.includes('event: ready')) {
          req.destroy();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            data
          });
        }
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('SSE ready timeout'));
    });
    req.end();
  });
}

async function run() {
  const baseUrl = getBaseUrl();
  const companyId = getCompanyId();
  const deviceUid = `zkteco:sn:SSE-${Math.random().toString(16).slice(2, 10)}`;

  if (requireAuth()) {
    const unauth = await new Promise((resolve, reject) => {
      const target = new URL(`${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/realtime-observations/stream?company_id=${encodeURIComponent(companyId)}`);
      const req = http.request({
        method: 'GET',
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, data }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(unauth.status, 401, 'SSE stream should require auth');
  }

  const ready = await requestSseReady({
    url: `${baseUrl}/api/agent-admin/devices/${encodeURIComponent(deviceUid)}/realtime-observations/stream?company_id=${encodeURIComponent(companyId)}`,
    headers: { ...viewerHeaders(), 'x-company-id': companyId }
  });
  assert.strictEqual(ready.status, 200, 'SSE stream should return 200');
  assert.ok(String(ready.headers['content-type'] || '').includes('text/event-stream'), 'SSE content type expected');
  assert.ok(ready.data.includes('event: ready'), 'SSE should emit ready event');

  console.log('agent admin realtime observations SSE contract tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
