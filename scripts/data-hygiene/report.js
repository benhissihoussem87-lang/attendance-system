#!/usr/bin/env node

require('dotenv').config();

const db = require('../../db');
const {
  classifyAgentCommand,
  classifyCompany,
  classifyDevice,
  classifyEmployee,
  classifyEvidenceRow,
  classifyIdentityMapping,
  classifySite
} = require('../../services/dataHygieneClassification');

const DEFAULT_TABLES = [
  'companies',
  'sites',
  'devices',
  'employees',
  'identity_mappings',
  'device_events',
  'device_realtime_direction_observations',
  'agent_commands',
  'agent_device_event_batches',
  'device_monitoring_sessions',
  'users',
  'user_sessions',
  'api_keys',
  'agent_runtime_capability_reported_state',
  'agent_runtime_version_reported_state',
  'device_runtime_capability_reported_state',
  'device_runtime_reported_state',
  'site_runtime_reported_state'
];

const COMPANY_TABLES = new Set(DEFAULT_TABLES.filter(table => table !== 'companies'));

function limit() {
  const parsed = Number.parseInt(process.env.DATA_HYGIENE_REPORT_LIMIT || '8', 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 25) : 8;
}

async function count(sql, params = []) {
  const result = await db.query(sql, params);
  return Number(result.rows[0].count || 0);
}

async function rows(sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows;
}

function bump(bucket, classification) {
  bucket[classification] = (bucket[classification] || 0) + 1;
}

function takeExample(examples, classification, row) {
  if (!examples[classification]) examples[classification] = [];
  if (examples[classification].length >= limit()) return;
  examples[classification].push(row);
}

function summarizeRows(list, classifier, projector) {
  const counts = {};
  const examples = {};
  list.forEach(row => {
    const classification = classifier(row);
    bump(counts, classification);
    takeExample(examples, classification, projector(row));
  });
  return { classification_counts: counts, examples };
}

async function summarizeTable(table, companyId) {
  const where = COMPANY_TABLES.has(table) ? ' WHERE company_id = $1' : '';
  const params = COMPANY_TABLES.has(table) ? [companyId] : [];
  return {
    total: await count(`SELECT count(*) FROM ${table}${where}`, params)
  };
}

async function companySummary() {
  const list = await rows(`
    SELECT company_id, display_name, timezone, is_active, created_at
    FROM companies
    ORDER BY created_at DESC
  `);
  return {
    total: list.length,
    ...summarizeRows(list, classifyCompany, row => row)
  };
}

async function siteSummary(companyId) {
  const list = await rows(`
    SELECT site_id, company_id, site_key, site_name, status, metadata, created_at
    FROM sites
    WHERE company_id = $1
    ORDER BY created_at DESC
  `, [companyId]);
  return {
    total: list.length,
    ...summarizeRows(list, classifySite, row => ({
      site_id: row.site_id,
      site_key: row.site_key,
      site_name: row.site_name,
      status: row.status,
      purpose: row.metadata && row.metadata.purpose
    }))
  };
}

async function deviceSummary(companyId) {
  const list = await rows(`
    SELECT company_id, device_uid, provider, device_name, managed_status, source, lifecycle_scope, site_id, metadata, created_at
    FROM devices
    WHERE company_id = $1
    ORDER BY created_at DESC
  `, [companyId]);
  return {
    total: list.length,
    ...summarizeRows(list, classifyDevice, row => ({
      device_uid: row.device_uid,
      device_name: row.device_name,
      provider: row.provider,
      managed_status: row.managed_status,
      source: row.source,
      lifecycle_scope: row.lifecycle_scope,
      site_id: row.site_id
    }))
  };
}

async function employeeSummary(companyId) {
  const list = await rows(`
    SELECT company_id, person_id, employee_code, full_name, active, metadata, created_at
    FROM employees
    WHERE company_id = $1
    ORDER BY created_at DESC
  `, [companyId]);
  return {
    total: list.length,
    ...summarizeRows(list, classifyEmployee, row => ({
      person_id: row.person_id,
      employee_code: row.employee_code,
      full_name: row.full_name,
      active: row.active,
      source: row.metadata && row.metadata.source,
      product_managed: row.metadata && row.metadata.product_managed
    }))
  };
}

async function identityMappingSummary(companyId) {
  const list = await rows(`
    SELECT im.company_id, im.provider, im.identifier_type, im.identifier_value, im.person_id,
           im.active, im.metadata, e.metadata AS employee_metadata
    FROM identity_mappings im
    LEFT JOIN employees e
      ON e.company_id = im.company_id
     AND e.person_id = im.person_id
    WHERE im.company_id = $1
    ORDER BY im.created_at DESC
  `, [companyId]);
  return {
    total: list.length,
    ...summarizeRows(
      list,
      row => classifyIdentityMapping(row, { metadata: row.employee_metadata || {} }),
      row => ({
        provider: row.provider,
        identifier_type: row.identifier_type,
        identifier_value: row.identifier_value,
        person_id: row.person_id,
        active: row.active
      })
    )
  };
}

async function evidenceSummary(table, companyId, selectSql, orderSql) {
  const list = await rows(`${selectSql} WHERE company_id = $1 ${orderSql}`, [companyId]);
  return {
    total: list.length,
    ...summarizeRows(list, classifyEvidenceRow, row => ({
      id: row.id,
      device_uid: row.device_uid,
      person_id: row.person_id,
      device_person_id: row.device_person_id,
      created_at: row.created_at,
      event_time_utc: row.event_time_utc,
      direction: row.direction || row.direction_provisional
    }))
  };
}

async function commandSummary(companyId) {
  const list = await rows(`
    SELECT id, company_id, agent_id, command_type, status, created_at, acknowledged_at, failure_reason
    FROM agent_commands
    WHERE company_id = $1
    ORDER BY created_at DESC
  `, [companyId]);
  return {
    total: list.length,
    ...summarizeRows(list, classifyAgentCommand, row => ({
      id: row.id,
      command_type: row.command_type,
      status: row.status,
      created_at: row.created_at
    }))
  };
}

async function statusSummary(table, companyId) {
  const byStatus = await rows(`
    SELECT status, count(*)::int AS count, max(created_at) AS latest_created_at
    FROM ${table}
    WHERE company_id = $1
    GROUP BY status
    ORDER BY latest_created_at DESC NULLS LAST
  `, [companyId]);
  return {
    total: await count(`SELECT count(*) FROM ${table} WHERE company_id = $1`, [companyId]),
    by_status: byStatus
  };
}

async function authSummary(companyId) {
  return {
    users: {
      total: await count('SELECT count(*) FROM users WHERE company_id = $1', [companyId]),
      by_role_active: await rows(`
        SELECT role, active, count(*)::int AS count
        FROM users
        WHERE company_id = $1
        GROUP BY role, active
        ORDER BY role, active
      `, [companyId])
    },
    user_sessions: {
      total: await count('SELECT count(*) FROM user_sessions WHERE company_id = $1', [companyId]),
      active_unrevoked_unexpired: await count(`
        SELECT count(*)
        FROM user_sessions
        WHERE company_id = $1 AND revoked_at IS NULL AND expires_at > now()
      `, [companyId])
    },
    api_keys: {
      total: await count('SELECT count(*) FROM api_keys WHERE company_id = $1', [companyId]),
      by_role_active: await rows(`
        SELECT role, active, count(*)::int AS count
        FROM api_keys
        WHERE company_id = $1
        GROUP BY role, active
        ORDER BY role, active
      `, [companyId])
    },
    classification: 'auth_validation'
  };
}

async function capabilitySummary(companyId) {
  const tables = [
    'agent_runtime_capability_reported_state',
    'agent_runtime_version_reported_state',
    'device_runtime_capability_reported_state',
    'device_runtime_reported_state',
    'site_runtime_reported_state'
  ];
  const out = {};
  for (const table of tables) {
    out[table] = {
      total: await count(`SELECT count(*) FROM ${table} WHERE company_id = $1`, [companyId]),
      latest_reported_at: (await rows(`SELECT max(reported_at) AS latest_reported_at FROM ${table} WHERE company_id = $1`, [companyId]))[0].latest_reported_at,
      classification: 'protocol_evidence'
    };
  }
  return out;
}

async function main() {
  const companyId = process.env.DATA_HYGIENE_COMPANY_ID || 'DEFAULT';
  const report = {
    generated_at: new Date().toISOString(),
    company_id: companyId,
    mode: 'read_only_report',
    backup_prerequisite: {
      pg_dump: 'pg_dump -h localhost -p 5432 -U postgres -Fc -f "C:\\\\attendance-system\\\\backups\\\\attendance-$stamp.before-data-hygiene.dump" attendance',
      verify: 'pg_restore -l "C:\\\\attendance-system\\\\backups\\\\attendance-$stamp.before-data-hygiene.dump" | Select-Object -First 20'
    },
    table_totals: {}
  };

  for (const table of DEFAULT_TABLES) {
    report.table_totals[table] = await summarizeTable(table, companyId);
  }
  report.companies = await companySummary();
  report.sites = await siteSummary(companyId);
  report.devices = await deviceSummary(companyId);
  report.employees = await employeeSummary(companyId);
  report.identity_mappings = await identityMappingSummary(companyId);
  report.device_events = await evidenceSummary(
    'device_events',
    companyId,
    'SELECT id, company_id, device_uid, person_id, device_person_id, event_time_utc, direction, created_at FROM device_events',
    'ORDER BY created_at DESC'
  );
  report.device_realtime_direction_observations = await evidenceSummary(
    'device_realtime_direction_observations',
    companyId,
    'SELECT id, company_id, device_uid, person_id, device_person_id, direction_provisional, created_at FROM device_realtime_direction_observations',
    'ORDER BY created_at DESC'
  );
  report.agent_commands = await commandSummary(companyId);
  report.agent_device_event_batches = await statusSummary('agent_device_event_batches', companyId);
  report.device_monitoring_sessions = await statusSummary('device_monitoring_sessions', companyId);
  report.auth = await authSummary(companyId);
  report.capability_reported_state = await capabilitySummary(companyId);

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
