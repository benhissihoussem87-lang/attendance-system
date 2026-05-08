const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const db = require('../../db');
const {
  ensureDefaultSiteForCompany,
  setDeviceSiteAssignment,
  setSiteActiveAgentLease
} = require('../../services/sitesDb');

const companyId = process.env.K80_DEFAULT_COMPANY_ID || 'DEFAULT';
const deviceUid = process.env.K80_DEFAULT_DEVICE_UID || 'zkteco:sn:BIND-QUEUE-c26a7486';
const agentId = process.env.K80_DEFAULT_AGENT_ID || 'ddc32a87-0b42-4448-bdcd-297642c66ee6';

async function assertSiteModelExists() {
  const res = await db.query(`
    SELECT
      to_regclass('public.sites') AS sites_table,
      to_regclass('public.site_agent_leases') AS leases_table
  `);
  const row = res.rows[0] || {};
  if (!row.sites_table || !row.leases_table) {
    throw new Error('Required site tables are missing');
  }
}

async function fetchTargetRows() {
  const deviceRes = await db.query(
    `
    SELECT d.company_id, d.device_uid, d.managed_status, d.site_id, s.site_key, s.site_name
    FROM devices d
    LEFT JOIN sites s
      ON s.company_id = d.company_id
     AND s.site_id = d.site_id
    WHERE d.company_id = $1
      AND d.device_uid = $2
    LIMIT 1
    `,
    [companyId, deviceUid]
  );
  const agentRes = await db.query(
    `
    SELECT id, company_id, status, site_id
    FROM agent_nodes
    WHERE company_id = $1
      AND id = $2
    LIMIT 1
    `,
    [companyId, agentId]
  );
  return {
    device: deviceRes.rows[0] || null,
    agent: agentRes.rows[0] || null
  };
}

async function main() {
  await assertSiteModelExists();
  const before = await fetchTargetRows();
  if (!before.device) {
    throw new Error(`Target device not found: ${companyId}/${deviceUid}`);
  }
  if (before.device.managed_status !== 'managed') {
    throw new Error(`Target device is not managed: ${before.device.managed_status || 'unknown'}`);
  }
  if (!before.agent) {
    throw new Error(`Target active agent not found: ${agentId}`);
  }

  const site = await ensureDefaultSiteForCompany(db, {
    companyId,
    siteKey: 'default-site',
    siteName: 'Default Site',
    timezone: 'Africa/Tunis',
    metadata: {
      purpose: 'product_default_site',
      device_uid: deviceUid,
      agent_id: agentId
    }
  });
  if (!site || !site.site_id) {
    throw new Error('Default Site was not created or reused');
  }

  const assignedDevice = await setDeviceSiteAssignment(db, {
    companyId,
    deviceUid,
    siteId: site.site_id
  });
  const leaseResult = await setSiteActiveAgentLease(db, {
    companyId,
    siteId: site.site_id,
    agentId,
    leasedByKeyId: 'codex-site-model-wiring',
    metadata: {
      purpose: 'product_default_site_runtime_alignment',
      device_uid: deviceUid
    }
  });

  const after = await fetchTargetRows();
  const activeLease = leaseResult && leaseResult.value ? leaseResult.value.active_lease : null;
  console.log(JSON.stringify({
    ok: true,
    site,
    before,
    after,
    assigned_device: assignedDevice,
    lease_action: leaseResult && leaseResult.value ? leaseResult.value.action : null,
    active_lease: activeLease,
    untouched: [
      'device_events',
      'device_realtime_direction_observations',
      'k80 parser',
      'full-history protocol',
      'RT protocol',
      'enrollment'
    ]
  }, null, 2));
}

main()
  .catch(err => {
    console.error(JSON.stringify({
      ok: false,
      error: err && err.message ? err.message : String(err)
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(() => {
    if (db && typeof db.end === 'function') {
      db.end();
    }
  });
