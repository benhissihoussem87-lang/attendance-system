const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const { __test } = require('../../services/agentBridgeDb');

function createDbMock({ candidateRow, existingRow }) {
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes('SELECT')
        && text.includes('FROM devices')
        && text.includes('device_uid = $2')
        && text.includes('identity_status')) {
        if (candidateRow && String(candidateRow.device_uid) === String(params[1])) {
          return { rows: [candidateRow] };
        }
        return { rows: [] };
      }
      if (text.includes('SELECT device_uid, managed_status') && text.includes('FROM devices')) {
        return { rows: existingRow ? [existingRow] : [] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 120)}`);
    }
  };
}

async function runBuildDeviceUidPriorityCase() {
  const uid = __test.buildDeviceUid({
    vendor: 'zkteco',
    serial_number: 'sn-001',
    device_uid: 'zkteco:ip:192.168.1.10',
    ip: '192.168.1.10'
  });
  assert.strictEqual(uid, 'zkteco:sn:SN-001', 'serial should take precedence over direct ip uid');
}

async function runNoStableIdentityCase() {
  const db = createDbMock({ candidateRow: null, existingRow: null });
  const resolved = await __test.resolveCanonicalDeviceUid(db, {
    companyId: 'DEFAULT',
    discovered: {
      vendor: 'zkteco',
      ip: '192.168.1.30'
    },
    candidateUid: 'zkteco:ip:192.168.1.30'
  });
  assert.strictEqual(resolved.device_uid, 'zkteco:ip:192.168.1.30');
  assert.strictEqual(resolved.matched_existing_uid, null);
  assert.strictEqual(resolved.identity_transition, 'none');
}

async function runManagedExistingCase() {
  const db = createDbMock({
    candidateRow: null,
    existingRow: {
      device_uid: 'zkteco:ip:192.168.1.40',
      managed_status: 'managed'
    }
  });
  const resolved = await __test.resolveCanonicalDeviceUid(db, {
    companyId: 'DEFAULT',
    discovered: {
      vendor: 'zkteco',
      serial_number: 'SN40',
      ip: '192.168.1.40'
    },
    candidateUid: 'zkteco:sn:SN40'
  });
  assert.strictEqual(resolved.device_uid, 'zkteco:ip:192.168.1.40', 'managed row should stay canonical');
  assert.strictEqual(resolved.auto_supersession_allowed, false);
  assert.strictEqual(resolved.requires_operator_intervention, true);
  assert.strictEqual(resolved.identity_transition, 'existing_preferred');
}

async function runCandidateAutoSupersessionCase() {
  const db = createDbMock({
    candidateRow: null,
    existingRow: {
      device_uid: 'zkteco:ip:192.168.1.50',
      managed_status: 'candidate'
    }
  });
  const resolved = await __test.resolveCanonicalDeviceUid(db, {
    companyId: 'DEFAULT',
    discovered: {
      vendor: 'zkteco',
      serial_number: 'SN50',
      ip: '192.168.1.51'
    },
    candidateUid: 'zkteco:sn:SN50'
  });
  assert.strictEqual(resolved.device_uid, 'zkteco:sn:SN50', 'stable candidate uid should become canonical target');
  assert.strictEqual(resolved.superseded_from_uid, 'zkteco:ip:192.168.1.50');
  assert.strictEqual(resolved.auto_supersession_allowed, true);
  assert.strictEqual(resolved.identity_transition, 'auto_supersede_provisional');
}

async function runSupersededRedirectCase() {
  const db = createDbMock({
    candidateRow: {
      company_id: 'DEFAULT',
      device_uid: 'zkteco:ip:192.168.1.60',
      identity_status: 'superseded',
      superseded_by_device_uid: 'zkteco:sn:SN60'
    },
    existingRow: null
  });
  const resolved = await __test.resolveCanonicalDeviceUid(db, {
    companyId: 'DEFAULT',
    discovered: {
      vendor: 'zkteco',
      ip: '192.168.1.60'
    },
    candidateUid: 'zkteco:ip:192.168.1.60'
  });
  assert.strictEqual(resolved.device_uid, 'zkteco:sn:SN60', 'superseded candidate uid should redirect to canonical');
  assert.strictEqual(resolved.identity_transition, 'superseded_redirect');
  assert.strictEqual(resolved.superseded_from_uid, 'zkteco:ip:192.168.1.60');
}

async function run() {
  await runBuildDeviceUidPriorityCase();
  await runNoStableIdentityCase();
  await runManagedExistingCase();
  await runCandidateAutoSupersessionCase();
  await runSupersededRedirectCase();
  console.log('agentBridgeDb discovery identity tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
