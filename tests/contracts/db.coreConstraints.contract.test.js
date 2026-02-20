const assert = require('assert');
const { Client } = require('pg');

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

async function getConstraint(client, constraintName) {
  const res = await client.query(
    `
    SELECT
      c.conname AS constraint_name,
      c.contype AS constraint_type,
      ns.nspname AS schema_name,
      tbl.relname AS table_name,
      pg_get_constraintdef(c.oid, true) AS constraint_def
    FROM pg_constraint c
    JOIN pg_class tbl ON tbl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public'
      AND c.conname = $1
    LIMIT 1
    `,
    [constraintName]
  );
  return res.rows[0] || null;
}

async function assertConstraint(client, expected) {
  const row = await getConstraint(client, expected.name);
  assert.ok(row, `constraint missing: ${expected.name}`);
  assert.strictEqual(row.schema_name, 'public', `constraint schema mismatch: ${expected.name}`);
  assert.strictEqual(row.table_name, expected.table, `constraint table mismatch: ${expected.name}`);
  assert.strictEqual(row.constraint_type, expected.type, `constraint type mismatch: ${expected.name}`);
  assert.strictEqual(
    normalizeSql(row.constraint_def),
    normalizeSql(expected.def),
    `constraint definition mismatch: ${expected.name}`
  );
}

async function getIndexCatalogRow(client, indexName) {
  const res = await client.query(
    `
    SELECT
      i.relname AS index_name,
      idxns.nspname AS index_schema,
      tbl.relname AS table_name,
      tblns.nspname AS table_schema,
      ix.indisunique AS is_unique,
      pg_get_indexdef(i.oid) AS index_def,
      pg_get_expr(ix.indpred, ix.indrelid) AS predicate
    FROM pg_class i
    JOIN pg_index ix ON ix.indexrelid = i.oid
    JOIN pg_class tbl ON tbl.oid = ix.indrelid
    JOIN pg_namespace idxns ON idxns.oid = i.relnamespace
    JOIN pg_namespace tblns ON tblns.oid = tbl.relnamespace
    WHERE idxns.nspname = 'public'
      AND i.relname = $1
    LIMIT 1
    `,
    [indexName]
  );
  return res.rows[0] || null;
}

async function getIndexViewRow(client, indexName) {
  const res = await client.query(
    `
    SELECT
      schemaname,
      tablename,
      indexname,
      indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = $1
    LIMIT 1
    `,
    [indexName]
  );
  return res.rows[0] || null;
}

function assertContainsTokens(haystack, tokens, label) {
  for (const token of tokens) {
    assert.ok(haystack.includes(token), `${label} missing token: ${token}`);
  }
}

async function assertIndex(client, expected) {
  const catalogRow = await getIndexCatalogRow(client, expected.name);
  assert.ok(catalogRow, `index missing in pg_class/pg_index: ${expected.name}`);
  assert.strictEqual(catalogRow.index_schema, 'public', `index schema mismatch: ${expected.name}`);
  assert.strictEqual(catalogRow.table_schema, 'public', `index table schema mismatch: ${expected.name}`);
  assert.strictEqual(catalogRow.table_name, expected.table, `index table mismatch: ${expected.name}`);
  assert.strictEqual(catalogRow.is_unique, true, `index uniqueness mismatch: ${expected.name}`);

  const viewRow = await getIndexViewRow(client, expected.name);
  assert.ok(viewRow, `index missing in pg_indexes: ${expected.name}`);
  assert.strictEqual(viewRow.schemaname, 'public', `pg_indexes schema mismatch: ${expected.name}`);
  assert.strictEqual(viewRow.tablename, expected.table, `pg_indexes table mismatch: ${expected.name}`);

  const normalizedCatalogDef = normalizeSql(catalogRow.index_def);
  const normalizedViewDef = normalizeSql(viewRow.indexdef);
  assertContainsTokens(normalizedCatalogDef, expected.definitionTokens, `${expected.name} index_def`);
  assertContainsTokens(normalizedViewDef, expected.definitionTokens, `${expected.name} pg_indexes.indexdef`);

  const normalizedPredicate = normalizeSql(catalogRow.predicate);
  assertContainsTokens(normalizedPredicate, expected.predicateTokens, `${expected.name} predicate`);
}

async function run() {
  const config = buildConfig();
  const client = new Client(config);

  const constraints = [
    {
      name: 'attendance_days_company_person_date_uk',
      table: 'attendance_days',
      type: 'u',
      def: 'UNIQUE (company_id, person_id, work_date)'
    },
    {
      name: 'device_events_dedup_company_uk',
      table: 'device_events',
      type: 'u',
      def: 'UNIQUE (company_id, person_id, event_time_utc, direction, device_uid)'
    },
    {
      name: 'employee_assignments_pkey',
      table: 'employee_assignments',
      type: 'p',
      def: 'PRIMARY KEY (company_id, person_id, valid_from)'
    },
    {
      name: 'identity_mappings_pkey',
      table: 'identity_mappings',
      type: 'p',
      def: 'PRIMARY KEY (company_id, provider, identifier_type, identifier_value)'
    }
  ];

  const indexes = [
    {
      name: 'ux_attendance_day_resolutions_one_active',
      table: 'attendance_day_resolutions',
      definitionTokens: [
        'create unique index ux_attendance_day_resolutions_one_active',
        'on public.attendance_day_resolutions using btree (attendance_day_id)',
        'where (is_active = true)'
      ],
      predicateTokens: ['is_active', '= true']
    },
    {
      name: 'ux_employees_company_employee_code',
      table: 'employees',
      definitionTokens: [
        'create unique index ux_employees_company_employee_code',
        'on public.employees using btree (company_id, employee_code)',
        'where',
        'employee_code is not null',
        'btrim',
        "<> ''::text"
      ],
      predicateTokens: ['employee_code is not null', 'btrim', "<> ''::text"]
    }
  ];

  try {
    await client.connect();
    for (const constraint of constraints) {
      await assertConstraint(client, constraint);
    }
    for (const index of indexes) {
      await assertIndex(client, index);
    }
    console.log('PASS: db core constraints contract');
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
