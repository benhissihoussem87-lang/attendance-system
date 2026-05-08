const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const {
  upsertManualOnboardingCandidate
} = require('../../services/agentBridgeDb');

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    return {};
  }
}

function decodeLifecycleEventParams(params) {
  return {
    company_id: params[0],
    device_uid: params[1],
    lifecycle_event: params[2],
    actor_type: params[3],
    actor_ref: params[4],
    agent_id: params[5],
    from_state: parseJson(params[6]),
    to_state: parseJson(params[7]),
    reason: params[8],
    correlation_id: params[9],
    metadata: parseJson(params[10])
  };
}

function createManualOnboardingDbMock(options = {}) {
  const state = {
    tx: [],
    aliasWrites: [],
    lifecycleEvents: []
  };

  const existingRow = options.existingRow || null;
  const insertedRow = options.insertedRow || null;
  const updatedRow = options.updatedRow || null;
  const directCanonicalRow = options.directCanonicalRow || null;

  const db = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        state.tx.push(text);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT device_uid, identity_status, superseded_by_device_uid')
        && text.includes('FROM devices')
        && text.includes('LIMIT 1')) {
        return { rows: directCanonicalRow ? [directCanonicalRow] : [], rowCount: directCanonicalRow ? 1 : 0 };
      }
      if (text.includes('FROM device_identity_aliases a')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT')
        && text.includes('FROM devices')
        && text.includes('FOR UPDATE')
        && text.includes('lifecycle_scope')) {
        return { rows: existingRow ? [existingRow] : [], rowCount: existingRow ? 1 : 0 };
      }
      if (text.includes('INSERT INTO devices')
        && text.includes('managed_status')
        && text.includes('lifecycle_scope')) {
        return { rows: insertedRow ? [insertedRow] : [], rowCount: insertedRow ? 1 : 0 };
      }
      if (text.includes('UPDATE devices')
        && text.includes('SET provider = CASE WHEN')) {
        return { rows: updatedRow ? [updatedRow] : [], rowCount: updatedRow ? 1 : 0 };
      }
      if (text.includes('INSERT INTO device_identity_aliases')) {
        state.aliasWrites.push({
          company_id: params[0],
          canonical_device_uid: params[1],
          alias_kind: params[2],
          vendor: params[3],
          alias_value_normalized: params[4],
          status: params[5],
          metadata: parseJson(params[7])
        });
        return {
          rows: [{
            id: `alias-${state.aliasWrites.length}`,
            company_id: params[0],
            canonical_device_uid: params[1],
            alias_kind: params[2],
            vendor: params[3],
            alias_value_normalized: params[4],
            status: params[5],
            metadata: parseJson(params[7])
          }],
          rowCount: 1
        };
      }
      if (text.includes('INSERT INTO device_lifecycle_events')) {
        state.lifecycleEvents.push(decodeLifecycleEventParams(params));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text.slice(0, 180)}`);
    }
  };

  return { db, state };
}

async function runCreateCase() {
  const createdRow = {
    company_id: 'DEFAULT',
    device_uid: 'zkteco:sn:B1-CREATE',
    provider: 'zkteco',
    device_name: 'K80 Manual',
    active: true,
    metadata: {
      identity: {
        serial_number: 'B1-CREATE'
      },
      connection: {
        host: '192.168.22.201',
        port: 4370,
        communication_key: 1234,
        auth_password: 1234,
        device_number: 1,
        transport: 'tcp',
        attlog_sequence: 'zktime_k80'
      },
      ip: '192.168.22.201',
      auth_password: 1234,
      communication_key: 1234,
      device_number: 1,
      transport: 'tcp',
      attlog_sequence: 'zktime_k80'
    },
    managed_status: 'candidate',
    discovery_status: 'manual',
    discovered_by_agent_id: null,
    source: 'manual_onboarding',
    claimed_at: null,
    claimed_by_key_id: null,
    last_seen_at: '2026-03-21T10:00:00.000Z',
    discovery_metadata: null,
    manageability_status: 'unknown',
    manageability_reason: 'not_yet_verified',
    manageability_updated_at: null,
    manageability_last_proven_at: null,
    remediation_manual_status: null,
    remediation_manual_note: null,
    remediation_manual_owner: null,
    remediation_manual_updated_at: null,
    remediation_manual_updated_by_key_id: null,
    lifecycle_scope: 'bridge_ops',
    identity_status: 'canonical',
    superseded_by_device_uid: null,
    created_at: '2026-03-21T10:00:00.000Z',
    updated_at: '2026-03-21T10:00:00.000Z'
  };
  const { db, state } = createManualOnboardingDbMock({
    insertedRow: createdRow
  });

  const result = await upsertManualOnboardingCandidate(db, {
    companyId: 'DEFAULT',
    payload: {
      provider: 'zkteco',
      canonical_device_uid: 'zkteco:sn:B1-CREATE',
      device_uid: null,
      device_name: 'K80 Manual',
      identity: {
        serial_number: 'B1-CREATE',
        mac: null
      },
      connection: {
        host: '192.168.22.201',
        port: 4370,
        communication_key: 1234,
        auth_password: 1234,
        device_number: 1,
        transport: 'tcp',
        attlog_sequence: 'zktime_k80'
      },
      device_profile: {},
      site_context: {},
      operator_notes: {}
    },
    actorType: 'operator',
    actorRef: 'ak_test',
    correlationId: 'manual-b1-create'
  });

  assert.ok(result.value, 'create should return value');
  assert.strictEqual(result.value.created, true, 'create should set created=true');
  assert.strictEqual(result.value.device_uid, 'zkteco:sn:B1-CREATE');
  assert.strictEqual(result.value.managed_status, 'candidate');
  assert.strictEqual(result.value.lifecycle_scope, 'bridge_ops');
  assert.strictEqual(result.value.configuration_status, 'complete');
  assert.strictEqual(result.value.ready_for_validation, true);
  assert.deepStrictEqual(result.value.missing_required_fields, []);

  assert.deepStrictEqual(state.tx, ['BEGIN', 'COMMIT'], 'create should commit transaction');
  assert.strictEqual(state.lifecycleEvents.length, 1, 'create should emit one lifecycle event');
  assert.strictEqual(state.lifecycleEvents[0].lifecycle_event, 'candidate_created');
  assert.strictEqual(state.lifecycleEvents[0].reason, 'manual_onboarding_registered');
  assert.strictEqual(state.lifecycleEvents[0].metadata.source, 'agent_admin.manual_onboarding');
  assert.ok(state.aliasWrites.length >= 2, 'create should write canonical alias and at least one identity alias');
}

async function runUpdateCase() {
  const beforeRow = {
    company_id: 'DEFAULT',
    device_uid: 'zkteco:sn:B1-UPDATE',
    provider: 'zkteco',
    device_name: 'Old Name',
    active: true,
    metadata: {
      identity: {
        serial_number: 'B1-UPDATE'
      },
      connection: {
        host: '192.168.22.210',
        port: 4370,
        communication_key: 1234,
        auth_password: 1234,
        device_number: 1,
        transport: 'udp',
        attlog_sequence: 'deviceid_platform'
      }
    },
    managed_status: 'candidate',
    discovery_status: 'manual',
    lifecycle_scope: 'bridge_ops'
  };
  const afterRow = {
    ...beforeRow,
    device_name: 'Updated Name',
    metadata: {
      ...beforeRow.metadata,
      connection: {
        ...beforeRow.metadata.connection,
        transport: 'tcp',
        attlog_sequence: 'zktime_k80'
      }
    }
  };
  const { db, state } = createManualOnboardingDbMock({
    existingRow: beforeRow,
    updatedRow: afterRow,
    directCanonicalRow: {
      device_uid: 'zkteco:sn:B1-UPDATE',
      identity_status: 'canonical',
      superseded_by_device_uid: null
    }
  });

  const result = await upsertManualOnboardingCandidate(db, {
    companyId: 'DEFAULT',
    payload: {
      provider: 'zkteco',
      canonical_device_uid: 'zkteco:sn:B1-UPDATE',
      device_uid: 'zkteco:sn:B1-UPDATE',
      device_name: 'Updated Name',
      identity: {
        serial_number: 'B1-UPDATE',
        mac: null
      },
      connection: {
        host: '192.168.22.210',
        port: 4370,
        communication_key: 1234,
        auth_password: 1234,
        device_number: 1,
        transport: 'tcp',
        attlog_sequence: 'zktime_k80'
      },
      device_profile: {},
      site_context: {},
      operator_notes: {}
    },
    actorType: 'operator',
    actorRef: 'ak_test',
    correlationId: 'manual-b1-update'
  });

  assert.ok(result.value, 'update should return value');
  assert.strictEqual(result.value.created, false, 'update should set created=false');
  assert.deepStrictEqual(state.tx, ['BEGIN', 'COMMIT'], 'update should commit transaction');
  assert.strictEqual(state.lifecycleEvents.length, 1, 'update should emit one lifecycle event');
  assert.strictEqual(state.lifecycleEvents[0].lifecycle_event, 'candidate_updated');
  assert.strictEqual(state.lifecycleEvents[0].reason, 'manual_onboarding_updated');
}

async function runNoopUpdateCase() {
  const row = {
    company_id: 'DEFAULT',
    device_uid: 'zkteco:sn:B1-NOOP',
    provider: 'zkteco',
    device_name: 'Noop Name',
    active: true,
    metadata: {
      identity: {
        serial_number: 'B1-NOOP'
      },
      connection: {
        host: '192.168.22.220',
        port: 4370,
        communication_key: 1234,
        auth_password: 1234,
        device_number: 1,
        transport: 'tcp',
        attlog_sequence: 'zktime_k80'
      }
    },
    managed_status: 'candidate',
    discovery_status: 'manual',
    lifecycle_scope: 'bridge_ops'
  };
  const { db, state } = createManualOnboardingDbMock({
    existingRow: row,
    updatedRow: row,
    directCanonicalRow: {
      device_uid: 'zkteco:sn:B1-NOOP',
      identity_status: 'canonical',
      superseded_by_device_uid: null
    }
  });

  const result = await upsertManualOnboardingCandidate(db, {
    companyId: 'DEFAULT',
    payload: {
      provider: 'zkteco',
      canonical_device_uid: 'zkteco:sn:B1-NOOP',
      device_uid: 'zkteco:sn:B1-NOOP',
      device_name: 'Noop Name',
      identity: {
        serial_number: 'B1-NOOP',
        mac: null
      },
      connection: {
        host: '192.168.22.220',
        port: 4370,
        communication_key: 1234,
        auth_password: 1234,
        device_number: 1,
        transport: 'tcp',
        attlog_sequence: 'zktime_k80'
      },
      device_profile: {},
      site_context: {},
      operator_notes: {}
    },
    actorType: 'operator',
    actorRef: 'ak_test',
    correlationId: 'manual-b1-noop'
  });

  assert.ok(result.value, 'noop update should return value');
  assert.strictEqual(result.value.created, false);
  assert.deepStrictEqual(state.tx, ['BEGIN', 'COMMIT'], 'noop update should commit transaction');
  assert.strictEqual(state.lifecycleEvents.length, 0, 'noop update should not emit lifecycle event');
}

async function run() {
  await runCreateCase();
  await runUpdateCase();
  await runNoopUpdateCase();
  console.log('agentBridgeDb manual onboarding tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
