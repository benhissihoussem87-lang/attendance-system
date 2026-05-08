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

async function assertConstraintContains(client, expected) {
  const row = await getConstraint(client, expected.name);
  assert.ok(row, `constraint missing: ${expected.name}`);
  assert.strictEqual(row.schema_name, 'public', `constraint schema mismatch: ${expected.name}`);
  assert.strictEqual(row.table_name, expected.table, `constraint table mismatch: ${expected.name}`);
  assert.strictEqual(row.constraint_type, expected.type, `constraint type mismatch: ${expected.name}`);
  const normalizedDef = normalizeSql(row.constraint_def);
  for (const token of expected.tokens) {
    assert.ok(
      normalizedDef.includes(normalizeSql(token)),
      `constraint definition mismatch: ${expected.name} missing token: ${token}`
    );
  }
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

function formatRows(rows, toLine) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '(none)';
  }
  return rows.map(toLine).join('\n');
}

async function assertTableExists(client, tableName) {
  const res = await client.query(
    `
    SELECT to_regclass($1) AS table_regclass
    `,
    [`public.${tableName}`]
  );
  const regclass = res.rows[0] ? res.rows[0].table_regclass : null;
  assert.ok(regclass, `table missing: public.${tableName}`);
}

async function assertTableHasColumns(client, tableName, requiredColumns) {
  const res = await client.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    `,
    [tableName]
  );
  const actualColumns = new Set(res.rows.map(row => row.column_name));
  for (const column of requiredColumns) {
    assert.ok(
      actualColumns.has(column),
      `column missing: public.${tableName}.${column}`
    );
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

async function assertTrigger(client, expected) {
  const res = await client.query(
    `
    SELECT
      t.tgname AS trigger_name,
      n.nspname AS table_schema,
      c.relname AS table_name,
      p.proname AS function_name
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public'
      AND NOT t.tgisinternal
      AND t.tgname = $1
    LIMIT 1
    `,
    [expected.name]
  );
  const row = res.rows[0] || null;
  assert.ok(row, `trigger missing: ${expected.name}`);
  assert.strictEqual(row.table_schema, 'public', `trigger schema mismatch: ${expected.name}`);
  assert.strictEqual(row.table_name, expected.table, `trigger table mismatch: ${expected.name}`);
  assert.strictEqual(row.function_name, expected.functionName, `trigger function mismatch: ${expected.name}`);
}

async function assertDeviceEventsUniqueSurfaces(client) {
  const expectedConstraints = [
    'device_events_dedup_company_uk',
    'device_events_pkey'
  ];
  const expectedIndexes = [
    'device_events_dedup_company_uk',
    'device_events_dedup_key_company_uk',
    'device_events_pkey'
  ];

  const constraintRes = await client.query(
    `
    SELECT
      c.conname AS constraint_name,
      c.contype AS constraint_type,
      pg_get_constraintdef(c.oid, true) AS constraint_def
    FROM pg_constraint c
    JOIN pg_class tbl ON tbl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public'
      AND tbl.relname = 'device_events'
      AND c.contype IN ('p', 'u')
    ORDER BY c.conname
    `
  );
  const actualConstraints = constraintRes.rows.map(row => row.constraint_name).sort();
  assert.deepStrictEqual(
    actualConstraints,
    expectedConstraints,
    [
      'Unexpected unique/primary constraints on public.device_events.',
      `Expected: ${expectedConstraints.join(', ')}`,
      `Actual: ${actualConstraints.join(', ') || '(none)'}`,
      'Constraint details:',
      formatRows(constraintRes.rows, row => `- ${row.constraint_name} [${row.constraint_type}] ${row.constraint_def}`)
    ].join('\n')
  );

  const indexRes = await client.query(
    `
    SELECT
      i.relname AS index_name,
      ix.indisprimary AS is_primary,
      ix.indisunique AS is_unique,
      pg_get_indexdef(i.oid) AS index_def,
      pg_get_expr(ix.indpred, ix.indrelid) AS predicate
    FROM pg_class i
    JOIN pg_index ix ON ix.indexrelid = i.oid
    JOIN pg_class tbl ON tbl.oid = ix.indrelid
    JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    WHERE ns.nspname = 'public'
      AND tbl.relname = 'device_events'
      AND ix.indisunique = true
    ORDER BY i.relname
    `
  );
  const actualIndexes = indexRes.rows.map(row => row.index_name).sort();
  assert.deepStrictEqual(
    actualIndexes,
    expectedIndexes,
    [
      'Unexpected unique indexes on public.device_events.',
      `Expected: ${expectedIndexes.join(', ')}`,
      `Actual: ${actualIndexes.join(', ') || '(none)'}`,
      'Index details:',
      formatRows(
        indexRes.rows,
        row => `- ${row.index_name} [primary=${row.is_primary}] ${row.index_def}${row.predicate ? ` | predicate: ${row.predicate}` : ''}`
      )
    ].join('\n')
  );

  const dedupKeyIndex = indexRes.rows.find(row => row.index_name === 'device_events_dedup_key_company_uk');
  assert.ok(
    dedupKeyIndex,
    'Missing expected partial unique index: device_events_dedup_key_company_uk.'
  );
  const dedupKeyDef = normalizeSql(dedupKeyIndex.index_def);
  const dedupKeyPredicate = normalizeSql(dedupKeyIndex.predicate);
  assert.ok(
    dedupKeyDef.includes('on public.device_events using btree (company_id, dedup_key)'),
    `device_events_dedup_key_company_uk definition drifted.\nActual: ${dedupKeyIndex.index_def}`
  );
  assert.ok(
    dedupKeyPredicate.includes('dedup_key is not null'),
    `device_events_dedup_key_company_uk must stay partial (dedup_key IS NOT NULL).\nActual predicate: ${dedupKeyIndex.predicate || '(none)'}`
  );
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
    },
    {
      name: 'ux_api_keys_api_key',
      table: 'api_keys',
      definitionTokens: [
        'create unique index ux_api_keys_api_key',
        'on public.api_keys using btree (api_key)'
      ],
      predicateTokens: []
    },
    {
      name: 'ux_device_identity_aliases_company_alias_kind_vendor_value',
      table: 'device_identity_aliases',
      definitionTokens: [
        'create unique index ux_device_identity_aliases_company_alias_kind_vendor_value',
        'on public.device_identity_aliases using btree (company_id, alias_kind, vendor, alias_value_normalized)'
      ],
      predicateTokens: []
    },
    {
      name: 'ux_device_managing_agent_bindings_one_active',
      table: 'device_managing_agent_bindings',
      definitionTokens: [
        'create unique index ux_device_managing_agent_bindings_one_active',
        'on public.device_managing_agent_bindings using btree (company_id, device_uid)',
        'where (status = \'active\'::text)'
      ],
      predicateTokens: [
        'status = \'active\'::text'
      ]
    },
    {
      name: 'ux_sites_company_site_key',
      table: 'sites',
      definitionTokens: [
        'create unique index ux_sites_company_site_key',
        'on public.sites using btree (company_id, site_key)'
      ],
      predicateTokens: []
    },
    {
      name: 'ux_sites_company_site_id',
      table: 'sites',
      definitionTokens: [
        'create unique index ux_sites_company_site_id',
        'on public.sites using btree (company_id, site_id)'
      ],
      predicateTokens: []
    },
    {
      name: 'ux_site_agent_leases_one_active_per_site',
      table: 'site_agent_leases',
      definitionTokens: [
        'create unique index ux_site_agent_leases_one_active_per_site',
        'on public.site_agent_leases using btree (company_id, site_id)',
        'where (status = \'active\'::text)'
      ],
      predicateTokens: [
        'status = \'active\'::text'
      ]
    },
    {
      name: 'ux_agent_runtime_identities_credential_hash',
      table: 'agent_runtime_identities',
      definitionTokens: [
        'create unique index ux_agent_runtime_identities_credential_hash',
        'on public.agent_runtime_identities using btree (credential_hash)'
      ],
      predicateTokens: []
    },
    {
      name: 'ux_agent_runtime_identities_one_active_per_agent',
      table: 'agent_runtime_identities',
      definitionTokens: [
        'create unique index ux_agent_runtime_identities_one_active_per_agent',
        'on public.agent_runtime_identities using btree (company_id, agent_id)',
        'where (status = \'active\'::text)'
      ],
      predicateTokens: [
        'status = \'active\'::text'
      ]
    },
    {
      name: 'ux_agent_nodes_active_runtime_identity_id',
      table: 'agent_nodes',
      definitionTokens: [
        'create unique index ux_agent_nodes_active_runtime_identity_id',
        'on public.agent_nodes using btree (active_runtime_identity_id)',
        'where (active_runtime_identity_id is not null)'
      ],
      predicateTokens: [
        'active_runtime_identity_id is not null'
      ]
    }
  ];

  const requiredTables = [
    'agent_nodes',
    'agent_runtime_identities',
    'agent_commands',
    'agent_device_sync_states',
    'agent_device_event_batches',
    'api_keys',
    'sites',
    'site_agent_leases',
    'site_runtime_reported_state',
    'device_runtime_reported_state',
    'agent_runtime_capability_reported_state',
    'device_runtime_capability_reported_state',
    'device_identity_aliases',
    'device_managing_agent_bindings',
    'device_lifecycle_events'
  ];

  try {
    await client.connect();
    for (const tableName of requiredTables) {
      await assertTableExists(client, tableName);
    }
    await assertTableHasColumns(client, 'devices', [
      'manageability_status',
      'manageability_reason',
      'remediation_manual_status',
      'lifecycle_scope',
      'identity_status',
      'superseded_by_device_uid',
      'site_id'
    ]);
    await assertTableHasColumns(client, 'agent_nodes', [
      'site_id',
      'active_runtime_identity_id',
      'identity_status',
      'runtime_identity_issued_at'
    ]);
    await assertTableHasColumns(client, 'agent_runtime_identities', [
      'identity_id',
      'company_id',
      'agent_id',
      'credential_hash',
      'credential_prefix',
      'status',
      'issued_at',
      'revoked_at',
      'issued_from_token_id',
      'replaced_by_identity_id',
      'replaced_reason',
      'metadata'
    ]);
    await assertTableHasColumns(client, 'sites', [
      'site_id',
      'company_id',
      'site_key',
      'site_name',
      'status',
      'metadata'
    ]);
    await assertTableHasColumns(client, 'site_agent_leases', [
      'lease_id',
      'company_id',
      'site_id',
      'agent_id',
      'status',
      'leased_at',
      'released_at',
      'leased_by_key_id',
      'released_by_key_id',
      'superseded_by_lease_id',
      'metadata'
    ]);
    await assertTableHasColumns(client, 'site_runtime_reported_state', [
      'company_id',
      'site_id',
      'reporting_agent_id',
      'last_heartbeat_at',
      'last_poll_at',
      'runtime_health_status',
      'runtime_health_reason',
      'reported_at',
      'metadata'
    ]);
    await assertTableHasColumns(client, 'device_runtime_reported_state', [
      'company_id',
      'device_uid',
      'site_id',
      'reporting_agent_id',
      'last_validation_status',
      'last_validation_reason',
      'last_pull_status',
      'last_pull_reason',
      'last_successful_pull_at',
      'last_local_contact_at',
      'reported_health_status',
      'reported_health_reason',
      'reported_at',
      'metadata'
    ]);
    await assertTableHasColumns(client, 'agent_runtime_capability_reported_state', [
      'company_id',
      'agent_id',
      'site_id',
      'capability_key',
      'capability_status',
      'capability_reason',
      'reported_at',
      'metadata'
    ]);
    await assertTableHasColumns(client, 'device_runtime_capability_reported_state', [
      'company_id',
      'device_uid',
      'site_id',
      'reporting_agent_id',
      'capability_key',
      'capability_status',
      'capability_reason',
      'reported_at',
      'metadata'
    ]);
    await assertTableHasColumns(client, 'device_identity_aliases', [
      'company_id',
      'canonical_device_uid',
      'alias_kind',
      'vendor',
      'alias_value_normalized',
      'status'
    ]);
    await assertTableHasColumns(client, 'device_managing_agent_bindings', [
      'company_id',
      'device_uid',
      'agent_id',
      'status',
      'bound_at'
    ]);
    await assertTableHasColumns(client, 'device_lifecycle_events', [
      'company_id',
      'device_uid',
      'lifecycle_event',
      'actor_type',
      'occurred_at'
    ]);
    await assertTableHasColumns(client, 'api_keys', [
      'id',
      'api_key',
      'company_id',
      'role',
      'active',
      'last_used_at'
    ]);
    await assertConstraintContains(client, {
      name: 'api_keys_role_ck',
      table: 'api_keys',
      type: 'c',
      tokens: [
        "role = any (array['viewer'::text, 'operator'::text, 'admin'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'api_keys_company_id_fkey',
      table: 'api_keys',
      type: 'f',
      tokens: [
        'foreign key (company_id) references companies(company_id)',
        'on delete cascade'
      ]
    });
    await assertConstraintContains(client, {
      name: 'devices_lifecycle_scope_ck',
      table: 'devices',
      type: 'c',
      tokens: [
        "lifecycle_scope = any (array['bridge_ops'::text, 'ingest_only'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'devices_identity_status_ck',
      table: 'devices',
      type: 'c',
      tokens: [
        "identity_status = any (array['canonical'::text, 'superseded'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'device_identity_aliases_alias_kind_ck',
      table: 'device_identity_aliases',
      type: 'c',
      tokens: [
        'alias_kind = any',
        'device_uid',
        'serial_number',
        'mac',
        'ip',
        'legacy',
        'manual'
      ]
    });
    await assertConstraintContains(client, {
      name: 'device_managing_agent_bindings_status_ck',
      table: 'device_managing_agent_bindings',
      type: 'c',
      tokens: [
        "status = any (array['active'::text, 'inactive'::text, 'superseded'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'device_lifecycle_events_actor_type_ck',
      table: 'device_lifecycle_events',
      type: 'c',
      tokens: [
        'actor_type = any',
        'system',
        'agent',
        'operator',
        'admin',
        'migration'
      ]
    });
    await assertConstraintContains(client, {
      name: 'sites_status_ck',
      table: 'sites',
      type: 'c',
      tokens: [
        "status = any (array['active'::text, 'inactive'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'site_agent_leases_status_ck',
      table: 'site_agent_leases',
      type: 'c',
      tokens: [
        "status = any (array['active'::text, 'superseded'::text, 'released'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'site_agent_leases_released_at_status_ck',
      table: 'site_agent_leases',
      type: 'c',
      tokens: [
        "status = 'active'::text and released_at is null",
        "array['superseded'::text, 'released'::text]",
        'released_at is not null'
      ]
    });
    await assertConstraintContains(client, {
      name: 'site_agent_leases_company_site_id_fkey',
      table: 'site_agent_leases',
      type: 'f',
      tokens: [
        'foreign key (company_id, site_id) references sites(company_id, site_id)',
        'on delete cascade'
      ]
    });
    await assertConstraintContains(client, {
      name: 'site_runtime_reported_state_runtime_health_status_ck',
      table: 'site_runtime_reported_state',
      type: 'c',
      tokens: [
        "runtime_health_status = any (array['healthy'::text, 'degraded'::text, 'blocked'::text, 'offline'::text, 'unknown'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'site_runtime_reported_state_company_site_id_fkey',
      table: 'site_runtime_reported_state',
      type: 'f',
      tokens: [
        'foreign key (company_id, site_id) references sites(company_id, site_id)',
        'on delete cascade'
      ]
    });
    await assertConstraintContains(client, {
      name: 'device_runtime_reported_state_last_validation_status_ck',
      table: 'device_runtime_reported_state',
      type: 'c',
      tokens: [
        'last_validation_status is null',
        'never_run',
        'queued',
        'in_progress',
        'failed',
        'succeeded'
      ]
    });
    await assertConstraintContains(client, {
      name: 'device_runtime_reported_state_last_pull_status_ck',
      table: 'device_runtime_reported_state',
      type: 'c',
      tokens: [
        'last_pull_status is null',
        'accepted',
        'partial',
        'rejected',
        'idle',
        'error',
        'unknown'
      ]
    });
    await assertConstraintContains(client, {
      name: 'device_runtime_reported_state_reported_health_status_ck',
      table: 'device_runtime_reported_state',
      type: 'c',
      tokens: [
        "reported_health_status = any (array['healthy'::text, 'degraded'::text, 'blocked'::text, 'offline'::text, 'unknown'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'device_runtime_reported_state_company_device_uid_fkey',
      table: 'device_runtime_reported_state',
      type: 'f',
      tokens: [
        'foreign key (company_id, device_uid) references devices(company_id, device_uid)',
        'on delete cascade'
      ]
    });
    await assertConstraintContains(client, {
      name: 'agent_runtime_capability_reported_state_capability_status_ck',
      table: 'agent_runtime_capability_reported_state',
      type: 'c',
      tokens: [
        "capability_status = any (array['supported'::text, 'unsupported'::text, 'disabled'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'agent_runtime_capability_reported_state_company_site_id_fkey',
      table: 'agent_runtime_capability_reported_state',
      type: 'f',
      tokens: [
        'foreign key (company_id, site_id) references sites(company_id, site_id)',
        'on delete set null'
      ]
    });
    await assertConstraintContains(client, {
      name: 'device_runtime_capability_reported_state_capability_status_ck',
      table: 'device_runtime_capability_reported_state',
      type: 'c',
      tokens: [
        "capability_status = any (array['supported'::text, 'unsupported'::text, 'disabled'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'device_runtime_capability_reported_state_company_device_uid_fkey',
      table: 'device_runtime_capability_reported_state',
      type: 'f',
      tokens: [
        'foreign key (company_id, device_uid) references devices(company_id, device_uid)',
        'on delete cascade'
      ]
    });
    await assertConstraintContains(client, {
      name: 'agent_nodes_company_site_id_fkey',
      table: 'agent_nodes',
      type: 'f',
      tokens: [
        'foreign key (company_id, site_id) references sites(company_id, site_id)',
        'on delete set null'
      ]
    });
    await assertConstraintContains(client, {
      name: 'agent_nodes_identity_status_ck',
      table: 'agent_nodes',
      type: 'c',
      tokens: [
        'identity_status = any',
        'bootstrap_only',
        'active',
        'revoked',
        'replaced'
      ]
    });
    await assertConstraintContains(client, {
      name: 'agent_nodes_active_runtime_identity_id_fkey',
      table: 'agent_nodes',
      type: 'f',
      tokens: [
        'foreign key (active_runtime_identity_id) references agent_runtime_identities(identity_id)',
        'on delete set null'
      ]
    });
    await assertConstraintContains(client, {
      name: 'agent_runtime_identities_status_ck',
      table: 'agent_runtime_identities',
      type: 'c',
      tokens: [
        "status = any (array['active'::text, 'revoked'::text, 'replaced'::text])"
      ]
    });
    await assertConstraintContains(client, {
      name: 'agent_runtime_identities_revoked_at_ck',
      table: 'agent_runtime_identities',
      type: 'c',
      tokens: [
        "status = 'active'::text and revoked_at is null",
        "array['revoked'::text, 'replaced'::text]",
        'revoked_at is not null'
      ]
    });
    await assertConstraintContains(client, {
      name: 'devices_company_site_id_fkey',
      table: 'devices',
      type: 'f',
      tokens: [
        'foreign key (company_id, site_id) references sites(company_id, site_id)',
        'on delete set null'
      ]
    });
    for (const constraint of constraints) {
      await assertConstraint(client, constraint);
    }
    for (const index of indexes) {
      await assertIndex(client, index);
    }
    await assertTrigger(client, {
      name: 'trg_devices_device_uid_immutable',
      table: 'devices',
      functionName: 'devices_prevent_device_uid_mutation_fn'
    });
    await assertDeviceEventsUniqueSurfaces(client);
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
