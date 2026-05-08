const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const { updateHeartbeat } = require('../../services/agentBridgeDb');
const { CAPABILITY_REPORTING_REQUIRED_MIGRATION } = require('../../services/reportedStateDb');
const {
  buildDefaultRuntimeHeartbeatCapabilities
} = require('../../contracts/capabilityContract');

function createHeartbeatDbMock(captures, options = {}) {
  const schemaReady = options.schemaReady !== false;
  const migrationRecorded = options.migrationRecorded !== false;
  const agentFound = options.agentFound !== false;
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        captures.txStatements = captures.txStatements || [];
        captures.txStatements.push(text);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("to_regclass('public.agent_runtime_capability_reported_state')")) {
        captures.schemaGuardQueried = true;
        return {
          rows: [{
            agent_runtime_capability_table: schemaReady
              ? 'public.agent_runtime_capability_reported_state'
              : null,
            device_runtime_capability_table: schemaReady
              ? 'public.device_runtime_capability_reported_state'
              : null,
            schema_migrations_table: 'public.schema_migrations'
          }]
        };
      }
      if (text.includes('FROM public.schema_migrations') && text.includes('WHERE filename = $1')) {
        captures.schemaMigrationQuery = params[0];
        return { rows: migrationRecorded ? [{ '?column?': 1 }] : [] };
      }
      if (text.includes('UPDATE agent_nodes') && text.includes('last_heartbeat_at')) {
        captures.nodeUpdateCalled = true;
        if (!agentFound) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{
            id: 'agent-1',
            company_id: 'DEFAULT',
            agent_name: 'agent one',
            status: 'active',
            site_id: null,
            last_seen_at: '2026-03-23T10:00:00.000Z',
            last_heartbeat_at: '2026-03-23T10:00:00.000Z'
          }],
          rowCount: 1
        };
      }
      if (text.includes('FROM agent_runtime_capability_reported_state') && text.includes('capability_key = $3')) {
        captures.runtimeCapabilityLookup = true;
        return { rows: [] };
      }
      if (text.includes('INSERT INTO agent_runtime_capability_reported_state')) {
        captures.runtimeCapabilityUpserts = captures.runtimeCapabilityUpserts || [];
        captures.runtimeCapabilityUpserts.push({
          companyId: params[0],
          agentId: params[1],
          siteId: params[2],
          capabilityKey: params[3],
          capabilityStatus: params[4],
          capabilityReason: params[5],
          reportedAt: params[6]
        });
        return {
          rows: [{
            company_id: params[0],
            agent_id: params[1],
            site_id: params[2],
            capability_key: params[3],
            capability_status: params[4],
            capability_reason: params[5],
            reported_at: params[6]
          }],
          rowCount: 1
        };
      }
      if (text.includes('INSERT INTO agent_runtime_version_reported_state')) {
        captures.runtimeVersionUpsert = {
          companyId: params[0],
          agentId: params[1],
          siteId: params[2],
          reportedVersion: params[3],
          reportedAt: params[5]
        };
        return {
          rows: [{
            company_id: params[0],
            agent_id: params[1],
            site_id: params[2],
            reported_version: params[3],
            rollout_channel: params[4],
            reported_at: params[5]
          }],
          rowCount: 1
        };
      }
      if (text.includes('FROM site_agent_leases') && text.includes("status = 'active'")) {
        captures.siteLeaseLookup = true;
        return { rows: [] };
      }
      throw new Error(`unexpected query in heartbeat integrity test: ${text.slice(0, 140)}`);
    }
  };
}

async function runHeartbeatSchemaReadyCase() {
  const captures = {};
  const db = createHeartbeatDbMock(captures, {
    schemaReady: true,
    migrationRecorded: true
  });
  const row = await updateHeartbeat(db, {
    agentId: 'agent-1',
    companyId: 'DEFAULT',
    payload: { ping: true }
  });

  assert.ok(row, 'heartbeat should return updated row when agent exists');
  assert.strictEqual(row.id, 'agent-1');
  assert.deepStrictEqual(captures.txStatements, ['BEGIN', 'COMMIT']);
  assert.strictEqual(captures.schemaGuardQueried, true, 'heartbeat should query schema readiness');
  assert.strictEqual(captures.schemaMigrationQuery, CAPABILITY_REPORTING_REQUIRED_MIGRATION);
  assert.strictEqual(captures.nodeUpdateCalled, true, 'heartbeat should update agent row when schema ready');
  assert.strictEqual(captures.runtimeCapabilityLookup, true, 'heartbeat should upsert runtime capability evidence');
}

async function runHeartbeatPersistsReportedCommandCapabilitiesCase() {
  const captures = {};
  const db = createHeartbeatDbMock(captures, {
    schemaReady: true,
    migrationRecorded: true
  });
  const row = await updateHeartbeat(db, {
    agentId: 'agent-1',
    companyId: 'DEFAULT',
    payload: {
      agent_version: '1.4.0',
      capabilities: buildDefaultRuntimeHeartbeatCapabilities()
    }
  });

  assert.ok(row, 'heartbeat should return updated row when agent exists');
  const upserts = captures.runtimeCapabilityUpserts || [];
  const byKey = new Map(upserts.map(entry => [entry.capabilityKey, entry]));

  for (const capabilityKey of [
    'command.pull_device_events',
    'command.start_device_monitoring',
    'command.stop_device_monitoring'
  ]) {
    const entry = byKey.get(capabilityKey);
    assert.ok(entry, `${capabilityKey} should be persisted from heartbeat capabilities`);
    assert.strictEqual(entry.capabilityStatus, 'supported');
    assert.strictEqual(entry.reportedAt, '2026-03-23T10:00:00.000Z');
  }
}

async function runHeartbeatSchemaMissingCase() {
  const captures = {};
  const db = createHeartbeatDbMock(captures, {
    schemaReady: false,
    migrationRecorded: false
  });
  let thrown = null;
  try {
    await updateHeartbeat(db, {
      agentId: 'agent-1',
      companyId: 'DEFAULT',
      payload: { ping: true }
    });
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'heartbeat should throw when capability schema is missing');
  assert.strictEqual(thrown.code, 'RUNTIME_SCHEMA_NOT_READY');
  assert.deepStrictEqual(captures.txStatements, ['BEGIN', 'ROLLBACK']);
  assert.strictEqual(captures.nodeUpdateCalled, undefined, 'schema guard should fail before node mutation');
  assert.strictEqual(captures.runtimeCapabilityLookup, undefined, 'schema guard should fail before capability writes');
}

async function run() {
  await runHeartbeatSchemaReadyCase();
  await runHeartbeatPersistsReportedCommandCapabilitiesCase();
  await runHeartbeatSchemaMissingCase();
  console.log('agentBridgeDb heartbeat integrity service tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
