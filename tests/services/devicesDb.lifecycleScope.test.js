const assert = require('assert');

const {
  listDevices,
  upsertDevice,
  upsertDeviceMinimal
} = require('../../services/devicesDb');

function createDbMock(returnRow = {}) {
  const calls = [];
  const db = {
    query: async (sql, params) => {
      calls.push({
        text: String(sql),
        params: Array.isArray(params) ? params.slice() : []
      });
      return {
        rows: [returnRow],
        rowCount: 1
      };
    }
  };
  return { db, calls };
}

async function runListDevicesLifecycleScopeFilterCase() {
  const { db, calls } = createDbMock({
    company_id: 'DEFAULT',
    device_uid: 'dev-1',
    lifecycle_scope: 'bridge_ops'
  });

  await listDevices(db, {
    companyId: 'DEFAULT',
    provider: null,
    deviceUid: null,
    managedStatus: null,
    manageabilityStatus: null,
    remediationManualStatus: null,
    lifecycleScope: 'Bridge_Ops',
    limit: 10,
    offset: 0
  });

  assert.strictEqual(calls.length, 1, 'listDevices should execute one query');
  const query = calls[0];
  assert.ok(query.text.includes('lifecycle_scope = $'), 'list query should include lifecycle_scope filter when provided');
  assert.ok(query.params.includes('bridge_ops'), 'list query should normalize lifecycle scope filter to lower-case');
}

async function runUpsertDeviceDefaultScopeCase() {
  const { db, calls } = createDbMock({
    company_id: 'DEFAULT',
    device_uid: 'dev-2',
    lifecycle_scope: 'ingest_only'
  });

  await upsertDevice(db, 'DEFAULT', 'dev-2', {
    provider: 'zkteco',
    metadata: { source: 'manual_registry' }
  });

  assert.strictEqual(calls.length, 1, 'upsertDevice should execute one query');
  const query = calls[0];
  assert.ok(query.text.includes('lifecycle_scope'), 'upsertDevice query should reference lifecycle_scope');
  assert.ok(
    query.text.includes("WHEN devices.lifecycle_scope = 'bridge_ops' THEN devices.lifecycle_scope"),
    'upsertDevice should preserve existing bridge_ops scope'
  );
  assert.ok(query.params.includes('ingest_only'), 'upsertDevice should write ingest_only as non-bridge default');
  assert.ok(query.params.includes('ingest'), 'upsertDevice should set non-bridge source as ingest');
}

async function runUpsertDeviceMinimalDefaultScopeCase() {
  const { db, calls } = createDbMock({
    company_id: 'DEFAULT',
    device_uid: 'dev-3',
    lifecycle_scope: 'ingest_only'
  });

  await upsertDeviceMinimal(db, 'DEFAULT', 'dev-3', {
    provider: 'zkteco',
    metadata: { source: 'ingest' }
  });

  assert.strictEqual(calls.length, 1, 'upsertDeviceMinimal should execute one query');
  const query = calls[0];
  assert.ok(query.text.includes('lifecycle_scope'), 'upsertDeviceMinimal query should reference lifecycle_scope');
  assert.ok(
    query.text.includes("WHEN devices.lifecycle_scope = 'bridge_ops' THEN devices.lifecycle_scope"),
    'upsertDeviceMinimal should preserve existing bridge_ops scope'
  );
  assert.ok(query.params.includes('ingest_only'), 'upsertDeviceMinimal should write ingest_only as non-bridge default');
  assert.ok(query.params.includes('ingest'), 'upsertDeviceMinimal should set non-bridge source as ingest');
}

async function run() {
  await runListDevicesLifecycleScopeFilterCase();
  await runUpsertDeviceDefaultScopeCase();
  await runUpsertDeviceMinimalDefaultScopeCase();
  console.log('devicesDb lifecycle scope tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
