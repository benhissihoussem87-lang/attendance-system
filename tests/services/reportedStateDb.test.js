const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const {
  RUNTIME_SCHEMA_NOT_READY_CODE,
  CAPABILITY_REPORTING_REQUIRED_MIGRATION,
  normalizeReportedHealthStatus,
  normalizeValidationStatus,
  normalizePullStatus,
  normalizeCapabilityReason,
  isReportedStateStale,
  getCapabilityReportingSchemaReadiness,
  ensureCapabilityReportingSchemaReady,
  toCapabilityReportedReadModel,
  toSiteRuntimeReportedReadModel,
  toDeviceRuntimeReportedReadModel
} = require('../../services/reportedStateDb');

function runNormalizersCase() {
  assert.strictEqual(normalizeReportedHealthStatus('HEALTHY'), 'healthy');
  assert.strictEqual(normalizeReportedHealthStatus('unsupported', 'unknown'), 'unknown');
  assert.strictEqual(normalizeValidationStatus('FAILED'), 'failed');
  assert.strictEqual(normalizeValidationStatus('bad', null), null);
  assert.strictEqual(normalizePullStatus('ACCEPTED'), 'accepted');
  assert.strictEqual(normalizePullStatus('bogus', null), null);
  assert.strictEqual(normalizeCapabilityReason(' capability_ok '), 'capability_ok');
  assert.strictEqual(normalizeCapabilityReason('', null), null);
}

function runStaleCase() {
  const freshIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const staleIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  assert.strictEqual(isReportedStateStale(freshIso, 10), false, 'fresh report should not be stale');
  assert.strictEqual(isReportedStateStale(staleIso, 10), true, 'old report should be stale');
  assert.strictEqual(isReportedStateStale(null, 10), true, 'missing report should be stale');
}

function runSiteReadModelCase() {
  const missing = toSiteRuntimeReportedReadModel(null, { staleMinutes: 10 });
  assert.strictEqual(missing.health_status, 'unknown');
  assert.strictEqual(missing.health_reason, 'reported_state_missing');
  assert.strictEqual(missing.reported_stale, true);

  const stale = toSiteRuntimeReportedReadModel({
    reporting_agent_id: '11111111-1111-4111-8111-111111111111',
    runtime_health_status: 'healthy',
    runtime_health_reason: 'heartbeat_received',
    reported_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    last_heartbeat_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    last_poll_at: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  }, {
    staleMinutes: 10
  });
  assert.strictEqual(stale.health_status, 'unknown');
  assert.strictEqual(stale.health_reason, 'reported_state_stale');
  assert.strictEqual(stale.reported_stale, true);
}

function runDeviceReadModelCase() {
  const fresh = toDeviceRuntimeReportedReadModel({
    reporting_agent_id: '11111111-1111-4111-8111-111111111111',
    reported_health_status: 'blocked',
    reported_health_reason: 'auth_stage_failed',
    reported_at: new Date(Date.now() - 60 * 1000).toISOString(),
    last_validation_status: 'failed',
    last_validation_reason: 'auth_stage_failed',
    last_pull_status: null,
    last_pull_reason: null,
    last_successful_pull_at: null,
    last_local_contact_at: new Date(Date.now() - 60 * 1000).toISOString()
  }, {
    staleMinutes: 15
  });
  assert.strictEqual(fresh.status, 'blocked');
  assert.strictEqual(fresh.reason, 'auth_stage_failed');
  assert.strictEqual(fresh.last_validation_status, 'failed');
  assert.strictEqual(fresh.reported_stale, false);

  const dateObjectRow = toDeviceRuntimeReportedReadModel({
    reporting_agent_id: '11111111-1111-4111-8111-111111111111',
    reported_health_status: 'healthy',
    reported_health_reason: 'validation_succeeded',
    reported_at: new Date(),
    last_validation_status: 'succeeded',
    last_validation_reason: 'validation_succeeded',
    last_pull_status: 'accepted',
    last_pull_reason: null,
    last_successful_pull_at: new Date(),
    last_local_contact_at: new Date()
  }, {
    staleMinutes: 15
  });
  assert.strictEqual(dateObjectRow.status, 'healthy');
  assert.strictEqual(dateObjectRow.reported_stale, false);
  assert.ok(typeof dateObjectRow.reported_at === 'string' && dateObjectRow.reported_at.endsWith('Z'));
}

function runCapabilityReadModelCase() {
  const missing = toCapabilityReportedReadModel(null, { staleMinutes: 20 });
  assert.strictEqual(missing.status, 'unknown');
  assert.strictEqual(missing.reason, 'reported_state_missing');
  assert.strictEqual(missing.reported_stale, true);

  const stale = toCapabilityReportedReadModel({
    capability_key: 'command.pull_device_events',
    capability_status: 'supported',
    capability_reason: 'command_acknowledged',
    reported_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    metadata: { source: 'test' }
  }, {
    staleMinutes: 10
  });
  assert.strictEqual(stale.status, 'unknown');
  assert.strictEqual(stale.reason, 'reported_state_stale');
  assert.strictEqual(stale.reported_stale, true);

  const fresh = toCapabilityReportedReadModel({
    capability_key: 'command.pull_device_events',
    capability_status: 'disabled',
    capability_reason: 'policy_disabled',
    reported_at: new Date(Date.now() - 30 * 1000).toISOString(),
    metadata: { source: 'test' }
  }, {
    staleMinutes: 10
  });
  assert.strictEqual(fresh.status, 'disabled');
  assert.strictEqual(fresh.reason, 'policy_disabled');
  assert.strictEqual(fresh.reported_stale, false);
}

async function runCapabilitySchemaReadinessCase() {
  const db = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text.includes("to_regclass('public.agent_runtime_capability_reported_state')")) {
        return {
          rows: [{
            agent_runtime_capability_table: 'public.agent_runtime_capability_reported_state',
            device_runtime_capability_table: 'public.device_runtime_capability_reported_state',
            schema_migrations_table: 'public.schema_migrations'
          }]
        };
      }
      if (text.includes('FROM public.schema_migrations')) {
        assert.strictEqual(params[0], CAPABILITY_REPORTING_REQUIRED_MIGRATION);
        return { rows: [{ '?column?': 1 }] };
      }
      throw new Error(`unexpected query in capability schema readiness test: ${text.slice(0, 120)}`);
    }
  };

  const readiness = await getCapabilityReportingSchemaReadiness(db);
  assert.strictEqual(readiness.ready, true);
  assert.deepStrictEqual(readiness.missing_relations, []);
  assert.strictEqual(readiness.required_migration, CAPABILITY_REPORTING_REQUIRED_MIGRATION);
  assert.strictEqual(readiness.migration_recorded, true);

  const ensured = await ensureCapabilityReportingSchemaReady(db, {
    runtimePath: '/api/agent/heartbeat'
  });
  assert.strictEqual(ensured.ready, true);
}

async function runCapabilitySchemaMissingCase() {
  const db = {
    query: async sql => {
      const text = String(sql);
      if (text.includes("to_regclass('public.agent_runtime_capability_reported_state')")) {
        return {
          rows: [{
            agent_runtime_capability_table: null,
            device_runtime_capability_table: null,
            schema_migrations_table: 'public.schema_migrations'
          }]
        };
      }
      if (text.includes('FROM public.schema_migrations')) {
        return { rows: [] };
      }
      throw new Error(`unexpected query in capability schema missing test: ${text.slice(0, 120)}`);
    }
  };

  let thrown = null;
  try {
    await ensureCapabilityReportingSchemaReady(db, {
      runtimePath: '/api/agent/device-events/batch'
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'schema guard should throw when capability tables are missing');
  assert.strictEqual(thrown.code, RUNTIME_SCHEMA_NOT_READY_CODE);
  assert.strictEqual(thrown.status, 503);
  assert.strictEqual(thrown.details.runtime_path, '/api/agent/device-events/batch');
  assert.ok(Array.isArray(thrown.details.missing_relations));
  assert.ok(thrown.details.missing_relations.includes('public.agent_runtime_capability_reported_state'));
  assert.ok(thrown.details.missing_relations.includes('public.device_runtime_capability_reported_state'));
}

async function run() {
  runNormalizersCase();
  runStaleCase();
  runSiteReadModelCase();
  runDeviceReadModelCase();
  runCapabilityReadModelCase();
  await runCapabilitySchemaReadinessCase();
  await runCapabilitySchemaMissingCase();
  console.log('reportedStateDb service tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
