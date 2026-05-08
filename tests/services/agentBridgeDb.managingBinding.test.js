const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const {
  setManagingAgentBinding
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

function createBindingDbMock(options = {}) {
  const state = {
    tx: [],
    events: [],
    insertedBindings: [],
    supersededBindingIds: []
  };

  const canonicalDeviceUid = options.canonicalDeviceUid || 'zkteco:sn:ABC001';
  const directRow = options.directRow || null;
  const aliasRow = options.aliasRow || null;
  const deviceRow = options.deviceRow || {
    company_id: 'DEFAULT',
    device_uid: canonicalDeviceUid,
    managed_status: 'managed',
    discovery_status: 'confirmed',
    discovered_by_agent_id: 'agent-1',
    manageability_status: 'manageable',
    manageability_reason: 'discovery_confirmed',
    discovery_metadata: {}
  };
  const agentRow = options.agentRow || {
    id: 'agent-1',
    company_id: 'DEFAULT',
    status: 'active'
  };
  let activeBinding = Object.prototype.hasOwnProperty.call(options, 'activeBinding')
    ? options.activeBinding
    : null;

  const db = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        state.tx.push(text);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT device_uid, identity_status, superseded_by_device_uid')
        && text.includes('FROM devices')) {
        return { rows: directRow ? [directRow] : [], rowCount: directRow ? 1 : 0 };
      }
      if (text.includes('FROM device_identity_aliases')) {
        if (!aliasRow) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{
            canonical_device_uid: aliasRow.canonical_device_uid || canonicalDeviceUid,
            alias_kind: aliasRow.alias_kind || 'device_uid',
            status: aliasRow.status || 'active'
          }],
          rowCount: 1
        };
      }
      if (text.includes('FROM devices')
        && text.includes('FOR UPDATE')
        && text.includes('managed_status')) {
        return { rows: deviceRow ? [deviceRow] : [], rowCount: deviceRow ? 1 : 0 };
      }
      if (text.includes('FROM agent_nodes') && text.includes('status')) {
        return { rows: agentRow ? [agentRow] : [], rowCount: agentRow ? 1 : 0 };
      }
      if (text.includes('FROM device_managing_agent_bindings')
        && text.includes("status = 'active'")
        && text.includes('FOR UPDATE')) {
        return { rows: activeBinding ? [activeBinding] : [], rowCount: activeBinding ? 1 : 0 };
      }
      if (text.includes('UPDATE device_managing_agent_bindings')
        && text.includes("SET status = 'superseded'")) {
        state.supersededBindingIds.push(params[1]);
        activeBinding = null;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO device_managing_agent_bindings')) {
        const inserted = {
          id: `binding-${state.insertedBindings.length + 1}`,
          company_id: params[0],
          device_uid: params[1],
          agent_id: params[2],
          status: 'active'
        };
        state.insertedBindings.push(inserted);
        activeBinding = inserted;
        return { rows: [inserted], rowCount: 1 };
      }
      if (text.includes('INSERT INTO device_lifecycle_events')) {
        state.events.push(decodeLifecycleEventParams(params));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text.slice(0, 150)}`);
    }
  };

  return { db, state };
}

async function runBindFromAliasCase() {
  const requestedAliasUid = 'zkteco:ip:192.168.1.20';
  const canonicalUid = 'zkteco:sn:ABC001';
  const { db, state } = createBindingDbMock({
    directRow: null,
    aliasRow: {
      canonical_device_uid: canonicalUid,
      alias_kind: 'device_uid',
      status: 'active'
    },
    activeBinding: null
  });

  const result = await setManagingAgentBinding(db, {
    companyId: 'DEFAULT',
    deviceUid: requestedAliasUid,
    agentId: 'agent-1',
    boundByKeyId: 'ak_test',
    boundByRole: 'operator',
    reason: 'initial_bind',
    metadata: {
      source: 'test'
    }
  });

  assert.ok(result.value, 'bind should succeed');
  assert.strictEqual(result.value.binding_action, 'bound');
  assert.strictEqual(result.value.requested_device_uid, requestedAliasUid);
  assert.strictEqual(result.value.canonical_device_uid, canonicalUid);
  assert.deepStrictEqual(state.tx, ['BEGIN', 'COMMIT'], 'bind should commit transaction');
  assert.strictEqual(state.insertedBindings.length, 1, 'bind should insert active binding');
  assert.strictEqual(state.events.length, 1, 'bind should emit one lifecycle event');
  assert.strictEqual(state.events[0].lifecycle_event, 'managing_agent_bound');
  assert.strictEqual(state.events[0].agent_id, 'agent-1');
}

async function runRebindCase() {
  const canonicalUid = 'zkteco:sn:ABC001';
  const { db, state } = createBindingDbMock({
    directRow: {
      device_uid: canonicalUid,
      identity_status: 'canonical',
      superseded_by_device_uid: null
    },
    activeBinding: {
      id: 'binding-legacy',
      company_id: 'DEFAULT',
      device_uid: canonicalUid,
      agent_id: 'agent-old',
      status: 'active'
    }
  });

  const result = await setManagingAgentBinding(db, {
    companyId: 'DEFAULT',
    deviceUid: canonicalUid,
    agentId: 'agent-2',
    boundByKeyId: 'ak_test',
    boundByRole: 'admin',
    reason: 'agent_replaced',
    metadata: {}
  });

  assert.ok(result.value, 'rebind should succeed');
  assert.strictEqual(result.value.binding_action, 'rebound');
  assert.strictEqual(result.value.previous_agent_id, 'agent-old');
  assert.deepStrictEqual(state.tx, ['BEGIN', 'COMMIT'], 'rebind should commit transaction');
  assert.strictEqual(state.supersededBindingIds.length, 1, 'rebind should supersede previous active binding');
  assert.strictEqual(state.insertedBindings.length, 1, 'rebind should insert replacement active binding');
  assert.strictEqual(state.events.length, 1, 'rebind should emit one lifecycle event');
  assert.strictEqual(state.events[0].lifecycle_event, 'managing_agent_rebound');
  assert.strictEqual(state.events[0].actor_type, 'admin');
}

async function runIdempotentNoopCase() {
  const canonicalUid = 'zkteco:sn:ABC001';
  const { db, state } = createBindingDbMock({
    directRow: {
      device_uid: canonicalUid,
      identity_status: 'canonical',
      superseded_by_device_uid: null
    },
    activeBinding: {
      id: 'binding-same',
      company_id: 'DEFAULT',
      device_uid: canonicalUid,
      agent_id: 'agent-1',
      status: 'active'
    }
  });

  const result = await setManagingAgentBinding(db, {
    companyId: 'DEFAULT',
    deviceUid: canonicalUid,
    agentId: 'agent-1',
    boundByKeyId: 'ak_test',
    boundByRole: 'operator',
    reason: 'idempotent_bind',
    metadata: {}
  });

  assert.ok(result.value, 'noop bind should succeed');
  assert.strictEqual(result.value.binding_action, 'noop');
  assert.deepStrictEqual(state.tx, ['BEGIN', 'COMMIT'], 'noop bind should commit transaction');
  assert.strictEqual(state.insertedBindings.length, 0, 'noop bind should not insert duplicate active binding');
  assert.strictEqual(state.events.length, 0, 'noop bind should not emit lifecycle event');
}

async function run() {
  await runBindFromAliasCase();
  await runRebindCase();
  await runIdempotentNoopCase();
  console.log('agentBridgeDb managing-agent binding tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
