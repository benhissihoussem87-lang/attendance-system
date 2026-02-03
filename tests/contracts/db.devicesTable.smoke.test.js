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

async function assertDevicesTable(client) {
  const regRes = await client.query("SELECT to_regclass('public.devices') as reg;");
  const reg = regRes && regRes.rows && regRes.rows[0] ? regRes.rows[0].reg : null;
  if (!reg) {
    throw new Error('devices table NOT found (public.devices)');
  }

  const columnsRes = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'devices'`
  );
  const columns = new Set((columnsRes.rows || []).map(row => row.column_name));

  const requiredColumns = [
    'company_id',
    'device_uid',
    'provider',
    'device_name',
    'active',
    'metadata',
    'created_at',
    'updated_at'
  ];

  for (const column of requiredColumns) {
    if (!columns.has(column)) {
      throw new Error(`devices table missing expected column: ${column}`);
    }
  }
}

async function run() {
  const config = buildConfig();
  const client = new Client(config);
  try {
    await client.connect();
    await assertDevicesTable(client);
    console.log('PASS: db devices table smoke');
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
