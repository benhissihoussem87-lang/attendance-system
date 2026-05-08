const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const {
  executeLifecycleReconciliationRepair
} = require('../../services/agentBridgeDb');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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

function createRepairDbMock(options = {}) {
  const deviceRowsByCompanyUid = new Map();
  const deviceRows = Array.isArray(options.deviceRows) ? options.deviceRows : [];
  for (const row of deviceRows) {
    const key = `${row.company_id}::${row.device_uid}`;
    deviceRowsByCompanyUid.set(key, clone(row));
  }

  const state = {
    tx: [],
    failLifecycleEventInsert: options.failLifecycleEventInsert === true,
    persistedAliases: clone(Array.isArray(options.aliasRows) ? options.aliasRows : []),
    persistedEvents: [],
    txActive: false,
    txAliases: null,
    txEvents: null
  };

  function currentAliases() {
    return state.txActive ? state.txAliases : state.persistedAliases;
  }

  function currentEvents() {
    return state.txActive ? state.txEvents : state.persistedEvents;
  }

  function getDeviceRow(companyId, deviceUid) {
    return deviceRowsByCompanyUid.get(`${companyId}::${deviceUid}`) || null;
  }

  const db = {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text === 'BEGIN') {
        state.tx.push('BEGIN');
        state.txActive = true;
        state.txAliases = clone(state.persistedAliases);
        state.txEvents = clone(state.persistedEvents);
        return { rows: [], rowCount: 0 };
      }
      if (text === 'COMMIT') {
        state.tx.push('COMMIT');
        if (state.txActive) {
          state.persistedAliases = state.txAliases;
          state.persistedEvents = state.txEvents;
          state.txAliases = null;
          state.txEvents = null;
          state.txActive = false;
        }
        return { rows: [], rowCount: 0 };
      }
      if (text === 'ROLLBACK') {
        state.tx.push('ROLLBACK');
        state.txAliases = null;
        state.txEvents = null;
        state.txActive = false;
        return { rows: [], rowCount: 0 };
      }

      if (text.includes('SELECT device_uid, identity_status, superseded_by_device_uid')
        && text.includes('FROM devices')
        && text.includes('LIMIT 1')) {
        const row = getDeviceRow(params[0], params[1]);
        return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
      }

      if (text.includes('FROM device_identity_aliases a')
        && text.includes("a.status IN ('active', 'superseded')")) {
        const companyId = params[0];
        const aliasValue = String(params[1] || '').toLowerCase();
        const aliasRow = currentAliases().find(row =>
          row.company_id === companyId
          && String(row.alias_value_normalized || '').toLowerCase() === aliasValue
          && ['active', 'superseded'].includes(String(row.status || '').toLowerCase())
        );
        if (!aliasRow) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{
            canonical_device_uid: aliasRow.canonical_device_uid,
            alias_kind: aliasRow.alias_kind,
            status: aliasRow.status
          }],
          rowCount: 1
        };
      }

      if (text.includes('FROM public.devices')
        && text.includes('identity_status')
        && text.includes('provider')
        && text.includes('LIMIT 1')) {
        const row = getDeviceRow(params[0], params[1]);
        return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
      }

      if (text.includes('FROM public.device_identity_aliases')
        && text.includes("alias_kind = 'device_uid'")
        && text.includes('lower(alias_value_normalized) = lower($2)')) {
        const companyId = params[0];
        const aliasValue = String(params[1] || '').toLowerCase();
        const rows = currentAliases()
          .filter(row =>
            row.company_id === companyId
            && row.alias_kind === 'device_uid'
            && String(row.alias_value_normalized || '').toLowerCase() === aliasValue
          )
          .map(row => clone(row));
        return { rows, rowCount: rows.length };
      }

      if (text.includes('UPDATE public.device_identity_aliases')
        && text.includes("SET status = 'active'")
        && text.includes('WHERE id = $2')) {
        const metadata = parseJson(params[0]);
        const aliasId = params[1];
        const companyId = params[2];
        const rows = currentAliases();
        const target = rows.find(row => row.id === aliasId && row.company_id === companyId);
        if (!target) {
          return { rows: [], rowCount: 0 };
        }
        target.status = 'active';
        target.metadata = { ...(target.metadata || {}), ...metadata };
        target.updated_at = '2026-03-18T00:00:00.000Z';
        return { rows: [clone(target)], rowCount: 1 };
      }

      if (text.includes('INSERT INTO public.device_identity_aliases')
        && text.includes("VALUES ($1, $2, 'device_uid', $3, $4, 'active'")) {
        const rows = currentAliases();
        const inserted = {
          id: `alias-${rows.length + 1}`,
          company_id: params[0],
          canonical_device_uid: params[1],
          alias_kind: 'device_uid',
          vendor: params[2],
          alias_value_normalized: params[3],
          status: 'active',
          first_seen_at: '2026-03-18T00:00:00.000Z',
          last_seen_at: '2026-03-18T00:00:00.000Z',
          metadata: parseJson(params[4]),
          created_at: '2026-03-18T00:00:00.000Z',
          updated_at: '2026-03-18T00:00:00.000Z'
        };
        rows.push(inserted);
        return { rows: [clone(inserted)], rowCount: 1 };
      }

      if (text.includes('INSERT INTO device_lifecycle_events')) {
        if (state.failLifecycleEventInsert) {
          throw new Error('forced lifecycle event insert failure');
        }
        const event = decodeLifecycleEventParams(params);
        currentEvents().push(event);
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`unexpected query: ${text.slice(0, 140)}`);
    }
  };

  return {
    db,
    state,
    get aliases() {
      return state.persistedAliases;
    },
    get events() {
      return state.persistedEvents;
    }
  };
}

async function runSuccessfulRepairCase() {
  const canonicalDeviceUid = 'zkteco:sn:SAFE-REPAIR-1';
  const ctx = createRepairDbMock({
    deviceRows: [
      {
        company_id: 'DEFAULT',
        device_uid: canonicalDeviceUid,
        identity_status: 'canonical',
        superseded_by_device_uid: null,
        provider: 'zkteco'
      }
    ],
    aliasRows: []
  });

  const result = await executeLifecycleReconciliationRepair(ctx.db, {
    companyId: 'DEFAULT',
    anomalyType: 'canonical_device_missing_active_device_uid_alias',
    targetDeviceUid: canonicalDeviceUid,
    apply: true,
    actorType: 'operator',
    actorRef: 'ak_test',
    reason: 'contracted_repair',
    metadata: { source: 'service_test' }
  });

  assert.ok(result.value, 'repair should return value');
  assert.strictEqual(result.value.mode, 'apply');
  assert.strictEqual(result.value.write_executed, true, 'repair should execute writes');
  assert.strictEqual(result.value.repair_result, 'repaired');
  assert.strictEqual(result.value.repair_action, 'insert_active_device_uid_self_alias');
  assert.deepStrictEqual(ctx.state.tx, ['BEGIN', 'COMMIT'], 'repair should commit transaction');
  assert.strictEqual(ctx.aliases.length, 1, 'repair should insert one alias');
  assert.strictEqual(ctx.aliases[0].canonical_device_uid, canonicalDeviceUid);
  assert.strictEqual(ctx.aliases[0].status, 'active');
  assert.strictEqual(ctx.events.length, 1, 'repair should emit one lifecycle event');
  assert.strictEqual(ctx.events[0].lifecycle_event, 'identity_alias_added');
}

async function runNoopCase() {
  const canonicalDeviceUid = 'zkteco:sn:SAFE-REPAIR-2';
  const ctx = createRepairDbMock({
    deviceRows: [
      {
        company_id: 'DEFAULT',
        device_uid: canonicalDeviceUid,
        identity_status: 'canonical',
        superseded_by_device_uid: null,
        provider: 'zkteco'
      }
    ],
    aliasRows: [
      {
        id: 'alias-existing',
        company_id: 'DEFAULT',
        canonical_device_uid: canonicalDeviceUid,
        alias_kind: 'device_uid',
        vendor: 'zkteco',
        alias_value_normalized: canonicalDeviceUid,
        status: 'active',
        metadata: {},
        created_at: '2026-03-18T00:00:00.000Z',
        updated_at: '2026-03-18T00:00:00.000Z'
      }
    ]
  });

  const result = await executeLifecycleReconciliationRepair(ctx.db, {
    companyId: 'DEFAULT',
    anomalyType: 'canonical_device_missing_active_device_uid_alias',
    targetDeviceUid: canonicalDeviceUid,
    apply: true,
    actorType: 'operator',
    actorRef: 'ak_test'
  });

  assert.ok(result.value, 'noop should return value');
  assert.strictEqual(result.value.mode, 'apply');
  assert.strictEqual(result.value.write_executed, false, 'noop should not execute writes');
  assert.strictEqual(result.value.repair_result, 'noop_already_correct');
  assert.deepStrictEqual(ctx.state.tx, ['BEGIN', 'COMMIT'], 'noop apply should still commit transaction');
  assert.strictEqual(ctx.aliases.length, 1, 'noop should keep existing alias untouched');
  assert.strictEqual(ctx.events.length, 0, 'noop should not emit lifecycle event');
}

async function runUnsupportedAnomalyCase() {
  const ctx = createRepairDbMock();
  const result = await executeLifecycleReconciliationRepair(ctx.db, {
    companyId: 'DEFAULT',
    anomalyType: 'managed_bridge_missing_active_binding',
    targetDeviceUid: 'zkteco:sn:UNSUPPORTED-1',
    apply: true,
    actorType: 'operator',
    actorRef: 'ak_test'
  });

  assert.strictEqual(result.error, 'lifecycle_repair_unsupported_anomaly_type');
  assert.ok(result.value && Array.isArray(result.value.supported_anomaly_types));
  assert.deepStrictEqual(ctx.state.tx, [], 'unsupported anomaly should not start transaction');
}

async function runCompanyScopedLookupCase() {
  const canonicalDeviceUid = 'zkteco:sn:OTHER-COMPANY-ONLY';
  const ctx = createRepairDbMock({
    deviceRows: [
      {
        company_id: 'OTHER',
        device_uid: canonicalDeviceUid,
        identity_status: 'canonical',
        superseded_by_device_uid: null,
        provider: 'zkteco'
      }
    ]
  });

  const result = await executeLifecycleReconciliationRepair(ctx.db, {
    companyId: 'DEFAULT',
    anomalyType: 'canonical_device_missing_active_device_uid_alias',
    targetDeviceUid: canonicalDeviceUid,
    apply: true,
    actorType: 'operator',
    actorRef: 'ak_test'
  });

  assert.strictEqual(result.error, 'device_not_found', 'repair should stay company scoped');
}

async function runTransactionalRollbackCase() {
  const canonicalDeviceUid = 'zkteco:sn:SAFE-REPAIR-ROLLBACK';
  const ctx = createRepairDbMock({
    deviceRows: [
      {
        company_id: 'DEFAULT',
        device_uid: canonicalDeviceUid,
        identity_status: 'canonical',
        superseded_by_device_uid: null,
        provider: 'zkteco'
      }
    ],
    aliasRows: [],
    failLifecycleEventInsert: true
  });

  let failed = false;
  try {
    await executeLifecycleReconciliationRepair(ctx.db, {
      companyId: 'DEFAULT',
      anomalyType: 'canonical_device_missing_active_device_uid_alias',
      targetDeviceUid: canonicalDeviceUid,
      apply: true,
      actorType: 'operator',
      actorRef: 'ak_test'
    });
  } catch (err) {
    failed = true;
  }

  assert.strictEqual(failed, true, 'forced lifecycle failure should bubble as error');
  assert.deepStrictEqual(ctx.state.tx, ['BEGIN', 'ROLLBACK'], 'repair should rollback transaction on failure');
  assert.strictEqual(ctx.aliases.length, 0, 'rollback should discard inserted alias');
  assert.strictEqual(ctx.events.length, 0, 'rollback should discard lifecycle event writes');
}

async function run() {
  await runSuccessfulRepairCase();
  await runNoopCase();
  await runUnsupportedAnomalyCase();
  await runCompanyScopedLookupCase();
  await runTransactionalRollbackCase();
  console.log('agentBridgeDb lifecycle reconciliation repair service tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
