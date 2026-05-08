const assert = require('assert');
const { Client } = require('pg');

const REQUIRED_MIGRATIONS = [
  {
    filename: '20260318_device_lifecycle_coherence_phase2_slice21.sql',
    reason: 'Lifecycle identity foundation tables/columns/indexes (Slice 2.1)'
  },
  {
    filename: '20260318_device_lifecycle_coherence_phase2_slice25.sql',
    reason: 'device_uid immutability trigger function + trigger attachment (Slice 2.5)'
  },
  {
    filename: '20260328_capability_reporting_feature_gates_foundation.sql',
    reason: 'Capability reporting foundation tables used by heartbeat/batch runtime paths'
  }
];

function requireEnv(name) {
  const value = process.env[name];
  return value && value.toString().trim() ? value.toString().trim() : '';
}

function buildConfig() {
  const missing = [];
  const host = requireEnv('PGHOST');
  const user = requireEnv('PGUSER');
  const database = requireEnv('PGDATABASE');

  if (!host) missing.push('PGHOST');
  if (!user) missing.push('PGUSER');
  if (!database) missing.push('PGDATABASE');

  if (missing.length) {
    throw new Error(`Missing required PG env vars: ${missing.join(', ')}`);
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

function normalizeSql(value) {
  return (value || '')
    .toString()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

async function assertSchemaMigrationsTable(client) {
  const res = await client.query(
    `
    SELECT to_regclass('public.schema_migrations') AS table_regclass
    `
  );
  const regclass = res.rows[0] ? res.rows[0].table_regclass : null;
  assert.ok(
    regclass,
    [
      'Missing required table: public.schema_migrations.',
      'This table tracks applied migrations and is required for lifecycle guardrail verification.'
    ].join('\n')
  );
}

async function assertRequiredLifecycleMigrationsApplied(client) {
  const expectedFilenames = REQUIRED_MIGRATIONS.map(item => item.filename);
  const res = await client.query(
    `
    SELECT filename
    FROM public.schema_migrations
    WHERE filename = ANY($1::text[])
    `,
    [expectedFilenames]
  );

  const applied = new Set(res.rows.map(row => String(row.filename)));
  const missing = REQUIRED_MIGRATIONS.filter(item => !applied.has(item.filename));
  assert.strictEqual(
    missing.length,
    0,
    [
      'Lifecycle migration guardrail failed: required migration(s) are not recorded in public.schema_migrations.',
      'Missing migrations:',
      ...missing.map(item => `- ${item.filename} (${item.reason})`),
      '',
      'Expected migrations:',
      ...REQUIRED_MIGRATIONS.map(item => `- ${item.filename}`),
      '',
      'Hint: run .\\scripts\\db\\apply-migrations.ps1 against this database before smoke/verification runs.'
    ].join('\n')
  );
}

async function assertDeviceUidImmutabilityTriggerAttached(client) {
  const res = await client.query(
    `
    SELECT
      t.tgname AS trigger_name,
      t.tgenabled AS trigger_enabled,
      ns.nspname AS table_schema,
      c.relname AS table_name,
      pns.nspname AS function_schema,
      p.proname AS function_name,
      pg_get_triggerdef(t.oid) AS trigger_def
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pns ON pns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND NOT t.tgisinternal
      AND t.tgname = 'trg_devices_device_uid_immutable'
    LIMIT 1
    `
  );

  const row = res.rows[0] || null;
  assert.ok(
    row,
    [
      'Lifecycle immutability guardrail failed: trigger missing.',
      'Expected trigger: public.trg_devices_device_uid_immutable ON public.devices.',
      'Expected migration: 20260318_device_lifecycle_coherence_phase2_slice25.sql.'
    ].join('\n')
  );

  assert.strictEqual(
    row.table_schema,
    'public',
    'Immutability trigger schema drift: expected table schema public.'
  );
  assert.strictEqual(
    row.table_name,
    'devices',
    'Immutability trigger attachment drift: expected trigger on public.devices.'
  );
  assert.strictEqual(
    row.function_schema,
    'public',
    'Immutability trigger function schema drift: expected public schema function.'
  );
  assert.strictEqual(
    row.function_name,
    'devices_prevent_device_uid_mutation_fn',
    'Immutability trigger function drift: expected devices_prevent_device_uid_mutation_fn.'
  );
  assert.notStrictEqual(
    row.trigger_enabled,
    'D',
    'Immutability trigger is disabled (tgenabled=D) and will not enforce device_uid immutability.'
  );

  const normalizedDef = normalizeSql(row.trigger_def);
  const requiredTokens = [
    'create trigger trg_devices_device_uid_immutable',
    'before update of device_uid on public.devices',
    'for each row',
    'execute function devices_prevent_device_uid_mutation_fn()'
  ];
  for (const token of requiredTokens) {
    assert.ok(
      normalizedDef.includes(token),
      `Immutability trigger definition drift: missing token "${token}".`
    );
  }
}

async function assertCapabilityReportingTablesPresent(client) {
  const res = await client.query(
    `
    SELECT
      to_regclass('public.agent_runtime_capability_reported_state') AS agent_runtime_capability_table,
      to_regclass('public.device_runtime_capability_reported_state') AS device_runtime_capability_table
    `
  );
  const row = res.rows[0] || {};
  const missing = [];
  if (!row.agent_runtime_capability_table) {
    missing.push('public.agent_runtime_capability_reported_state');
  }
  if (!row.device_runtime_capability_table) {
    missing.push('public.device_runtime_capability_reported_state');
  }
  assert.strictEqual(
    missing.length,
    0,
    [
      'Capability reporting schema guardrail failed: required runtime tables are missing.',
      'Missing tables:',
      ...missing.map(name => `- ${name}`),
      '',
      'These tables are required by /api/agent/heartbeat and /api/agent/device-events/batch capability upserts.',
      'Expected migration: 20260328_capability_reporting_feature_gates_foundation.sql.'
    ].join('\n')
  );
}

async function run() {
  const client = new Client(buildConfig());
  try {
    await client.connect();
    await assertSchemaMigrationsTable(client);
    await assertRequiredLifecycleMigrationsApplied(client);
    await assertDeviceUidImmutabilityTriggerAttached(client);
    await assertCapabilityReportingTablesPresent(client);
    console.log('PASS: db lifecycle coherence migration/immutability guardrails');
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
