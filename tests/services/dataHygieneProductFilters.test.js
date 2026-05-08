const assert = require('assert');

require('dotenv').config();
const db = require('../../db');
const { listDevices } = require('../../services/devicesDb');
const { listIdentityMappings } = require('../../services/identityMappingsDb');
const { listSites } = require('../../services/sitesDb');

function label(row) {
  return Object.values(row)
    .filter(value => typeof value === 'string')
    .join(' ');
}

function assertNoFixtureLabels(rows, message) {
  const pattern = /1001_|1002_|autoreg|dedup|evt|norm|preview|registry|policy|vendor|vendcsv|vendanviz|lease-site-|hq-[0-9a-f]{8}|mon-|rt-|b1-conflict|readiness|dev-bulk|test-device|demo-device/i;
  const offender = rows.find(row => pattern.test(label(row)));
  assert.ok(!offender, `${message}: ${JSON.stringify(offender)}`);
}

async function run() {
  const companyId = process.env.COMPANY_ID || 'DEFAULT';

  const devices = await listDevices(db, {
    companyId,
    productSurface: true,
    limit: 500,
    offset: 0
  });
  assert.ok(devices.some(row => row.device_uid === 'zkteco:sn:BIND-QUEUE-c26a7486'), 'product devices should include real K80');
  assertNoFixtureLabels(devices, 'product device filter should hide fixture devices');

  const sites = await listSites(db, {
    companyId,
    productSurface: true,
    limit: 200,
    offset: 0
  });
  assert.ok(sites.some(row => row.site_key === 'default-site'), 'product sites should include real Default Site');
  assertNoFixtureLabels(sites, 'product site filter should hide fixture sites');

  const mappings = await listIdentityMappings(db, {
    companyId,
    productSurface: true,
    limit: 500,
    offset: 0
  });
  assertNoFixtureLabels(mappings, 'product identity mapping filter should hide fixture mappings');

  await db.end();
  console.log('PASS: data hygiene product filters');
}

run().catch(err => {
  console.error(err);
  db.end().finally(() => process.exit(1));
});
