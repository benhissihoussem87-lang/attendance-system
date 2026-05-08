const assert = require('assert');

const {
  createSite,
  ensureDefaultSiteForCompany,
  listSites,
  updateSite,
  setAgentSiteAssignment,
  setDeviceSiteAssignment,
  setSiteActiveAgentLease
} = require('../../services/sitesDb');

function createDbMock(handler) {
  return {
    query: async (sql, params) => {
      return handler(String(sql), Array.isArray(params) ? params : []);
    }
  };
}

async function runCreateSiteDerivesKeyCase() {
  let captured = null;
  const db = createDbMock((sql, params) => {
    if (sql.includes('INSERT INTO sites')) {
      captured = params.slice();
      return {
        rows: [{
          site_id: '8a2905c0-7ec5-4f13-88ca-a6f554220001',
          company_id: params[0],
          site_key: params[1],
          site_name: params[2],
          status: params[3],
          metadata: JSON.parse(params[4]),
          created_at: '2026-03-22T10:00:00.000Z',
          updated_at: '2026-03-22T10:00:00.000Z'
        }]
      };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  });

  const row = await createSite(db, {
    companyId: 'DEFAULT',
    siteKey: '',
    siteName: 'HQ Main Site',
    status: undefined,
    metadata: { source: 'test' }
  });
  assert.ok(row, 'createSite should return row');
  assert.strictEqual(captured[1], 'hq-main-site', 'site key should derive from site_name');
  assert.strictEqual(captured[3], 'active', 'status should default to active');
}

async function runEnsureDefaultSiteReusesByKeyCase() {
  const calls = [];
  const siteId = '8a2905c0-7ec5-4f13-88ca-a6f554220005';
  const db = createDbMock((sql, params) => {
    calls.push({ sql, params: params.slice() });
    if (sql.includes('INSERT INTO sites') && sql.includes('ON CONFLICT')) {
      return {
        rows: [{
          site_id: siteId,
          company_id: params[0],
          site_key: params[1],
          site_name: params[2],
          status: 'active',
          metadata: JSON.parse(params[3]),
          created_at: '2026-05-05T10:00:00.000Z',
          updated_at: '2026-05-05T10:00:00.000Z'
        }]
      };
    }
    if (sql.includes('FROM sites s') && sql.includes('WHERE s.company_id = $1')) {
      return {
        rows: [{
          site_id: siteId,
          company_id: params[0],
          site_key: 'default-site',
          site_name: 'Default Site',
          status: 'active',
          metadata: { timezone: 'Africa/Tunis', product_default_site: true },
          created_at: '2026-05-05T10:00:00.000Z',
          updated_at: '2026-05-05T10:00:00.000Z',
          active_lease_id: null,
          active_agent_id: null,
          active_leased_at: null,
          active_agent_name: null,
          active_agent_status: null,
          active_agent_last_seen_at: null,
          active_agent_last_heartbeat_at: null
        }]
      };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 140)}`);
  });

  const row = await ensureDefaultSiteForCompany(db, {
    companyId: 'DEFAULT',
    metadata: { purpose: 'test' }
  });
  assert.ok(row, 'ensureDefaultSiteForCompany should return a site');
  assert.strictEqual(row.site_key, 'default-site', 'default site key should be stable');
  assert.strictEqual(row.status, 'active', 'default site should be active');
  const insertCall = calls.find(call => call.sql.includes('INSERT INTO sites'));
  assert.ok(insertCall.sql.includes('ON CONFLICT (company_id, site_key)'), 'default site should be duplicate-safe by key');
  const metadata = JSON.parse(insertCall.params[3]);
  assert.strictEqual(metadata.timezone, 'Africa/Tunis', 'default site should carry timezone metadata');
  assert.strictEqual(metadata.product_default_site, true, 'default site should be marked as product default');
}

async function runListSitesStatusFilterCase() {
  let captured = null;
  const db = createDbMock((sql, params) => {
    if (sql.includes('FROM sites')) {
      captured = { sql, params: params.slice() };
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  });

  await listSites(db, {
    companyId: 'DEFAULT',
    status: 'inactive',
    limit: 10,
    offset: 0
  });
  assert.ok(captured, 'listSites should query DB');
  assert.ok(captured.sql.includes('s.status = $2'), 'listSites should apply status filter');
  assert.strictEqual(captured.params[1], 'inactive', 'status filter should normalize lower-case');
}

async function runUpdateSiteRequiresPatchFieldCase() {
  const db = createDbMock(() => ({ rows: [] }));
  let failed = false;
  try {
    await updateSite(db, {
      companyId: 'DEFAULT',
      siteId: '8a2905c0-7ec5-4f13-88ca-a6f554220002'
    });
  } catch (err) {
    failed = true;
    assert.strictEqual(err.code, 'invalid_request');
  }
  assert.strictEqual(failed, true, 'updateSite should fail when no update fields are provided');
}

async function runAssignmentWritesCase() {
  const state = {
    agentUpdated: false,
    deviceUpdated: false
  };
  const db = createDbMock((sql, params) => {
    if (sql.includes('UPDATE agent_nodes')) {
      state.agentUpdated = true;
      return {
        rows: [{
          id: params[1],
          company_id: params[0],
          agent_name: 'agent-a',
          status: 'active',
          last_seen_at: null,
          last_heartbeat_at: null,
          created_at: '2026-03-22T10:00:00.000Z',
          site_id: params[2],
          site_key: 'hq',
          site_name: 'HQ',
          site_status: 'active'
        }]
      };
    }
    if (sql.includes('UPDATE devices')) {
      state.deviceUpdated = true;
      return {
        rows: [{
          company_id: params[0],
          device_uid: params[1],
          provider: 'zkteco',
          device_name: 'K80',
          managed_status: 'managed',
          lifecycle_scope: 'bridge_ops',
          site_id: params[2],
          updated_at: '2026-03-22T10:00:00.000Z',
          site_key: 'hq',
          site_name: 'HQ',
          site_status: 'active'
        }]
      };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 120)}`);
  });

  const siteId = '8a2905c0-7ec5-4f13-88ca-a6f554220003';
  const agentRow = await setAgentSiteAssignment(db, {
    companyId: 'DEFAULT',
    agentId: '11111111-1111-4111-8111-111111111111',
    siteId
  });
  const deviceRow = await setDeviceSiteAssignment(db, {
    companyId: 'DEFAULT',
    deviceUid: 'zkteco:sn:SVC-1',
    siteId
  });

  assert.strictEqual(state.agentUpdated, true, 'agent assignment should update agent row');
  assert.strictEqual(state.deviceUpdated, true, 'device assignment should update device row');
  assert.strictEqual(agentRow.site_id, siteId, 'agent assignment should return site_id');
  assert.strictEqual(deviceRow.site_id, siteId, 'device assignment should return site_id');
}

async function runSetSiteActiveAgentLeaseReassignedCase() {
  const state = {
    currentLease: {
      lease_id: '8a2905c0-7ec5-4f13-88ca-a6f554220111',
      agent_id: '11111111-1111-4111-8111-111111111111'
    },
    insertedLeaseId: null,
    updatedAgentSiteId: null
  };

  const siteId = '8a2905c0-7ec5-4f13-88ca-a6f554220222';
  const nextAgentId = '22222222-2222-4222-8222-222222222222';

  const db = createDbMock((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    if (sql.includes('FROM sites') && sql.includes('FOR UPDATE')) {
      return {
        rows: [{
          site_id: params[1],
          company_id: params[0],
          site_key: 'hq',
          site_name: 'HQ',
          status: 'active'
        }]
      };
    }
    if (sql.includes('FROM site_agent_leases') && sql.includes("status = 'active'") && sql.includes('FOR UPDATE')) {
      return { rows: state.currentLease ? [{ ...state.currentLease }] : [] };
    }
    if (sql.includes('FROM agent_nodes') && sql.includes('FOR UPDATE')) {
      return {
        rows: [{
          id: params[1],
          company_id: params[0],
          site_id: null
        }]
      };
    }
    if (sql.includes("SET status = 'superseded'")) {
      const leaseId = state.currentLease ? state.currentLease.lease_id : null;
      return { rows: leaseId ? [{ lease_id: leaseId }] : [] };
    }
    if (sql.includes('INSERT INTO site_agent_leases')) {
      state.insertedLeaseId = '8a2905c0-7ec5-4f13-88ca-a6f554220333';
      return { rows: [{ lease_id: state.insertedLeaseId }] };
    }
    if (sql.includes('SET superseded_by_lease_id')) {
      return { rows: [] };
    }
    if (sql.includes('UPDATE agent_nodes') && sql.includes('SET site_id')) {
      state.updatedAgentSiteId = params[2];
      return { rows: [] };
    }
    if (sql.includes('FROM site_agent_leases l') && sql.includes('AND l.lease_id = $2')) {
      return {
        rows: [{
          lease_id: params[1],
          company_id: params[0],
          site_id: siteId,
          agent_id: params[1] === state.insertedLeaseId ? nextAgentId : state.currentLease.agent_id,
          status: params[1] === state.insertedLeaseId ? 'active' : 'superseded',
          leased_at: '2026-03-23T10:00:00.000Z',
          released_at: params[1] === state.insertedLeaseId ? null : '2026-03-23T10:01:00.000Z',
          leased_by_key_id: 'ak_test',
          released_by_key_id: params[1] === state.insertedLeaseId ? null : 'ak_test',
          superseded_by_lease_id: params[1] === state.insertedLeaseId ? null : state.insertedLeaseId,
          metadata: {},
          created_at: '2026-03-23T10:00:00.000Z',
          updated_at: '2026-03-23T10:01:00.000Z',
          agent_name: params[1] === state.insertedLeaseId ? 'agent-new' : 'agent-old',
          agent_status: 'active',
          agent_last_seen_at: null,
          agent_last_heartbeat_at: null,
          agent_site_id: siteId
        }]
      };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 140)}`);
  });

  const result = await setSiteActiveAgentLease(db, {
    companyId: 'DEFAULT',
    siteId,
    agentId: nextAgentId,
    leasedByKeyId: 'ak_test',
    metadata: { reason: 'switch' }
  });

  assert.ok(result && result.value, 'setSiteActiveAgentLease should return value payload');
  assert.strictEqual(result.value.action, 'reassigned', 'active lease switch should report reassigned');
  assert.strictEqual(result.value.active_lease.agent_id, nextAgentId, 'new active lease should target requested agent');
  assert.strictEqual(result.value.previous_active_lease.status, 'superseded', 'previous active lease should be superseded');
  assert.strictEqual(state.updatedAgentSiteId, siteId, 'reassignment should align agent_nodes.site_id with leased site');
}

async function runSetSiteActiveAgentLeaseReleaseNoChangeCase() {
  const db = createDbMock((sql, params) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [] };
    }
    if (sql.includes('FROM sites') && sql.includes('FOR UPDATE')) {
      return {
        rows: [{
          site_id: params[1],
          company_id: params[0],
          site_key: 'hq',
          site_name: 'HQ',
          status: 'active'
        }]
      };
    }
    if (sql.includes('FROM site_agent_leases') && sql.includes("status = 'active'") && sql.includes('FOR UPDATE')) {
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql.slice(0, 140)}`);
  });

  const result = await setSiteActiveAgentLease(db, {
    companyId: 'DEFAULT',
    siteId: '8a2905c0-7ec5-4f13-88ca-a6f554220444',
    agentId: null,
    leasedByKeyId: 'ak_test',
    metadata: {}
  });
  assert.ok(result && result.value, 'release path should return value payload');
  assert.strictEqual(result.value.action, 'no_change', 'release without active lease should be no_change');
  assert.strictEqual(result.value.active_lease, null, 'no_change release should keep active_lease null');
}

async function run() {
  await runCreateSiteDerivesKeyCase();
  await runEnsureDefaultSiteReusesByKeyCase();
  await runListSitesStatusFilterCase();
  await runUpdateSiteRequiresPatchFieldCase();
  await runAssignmentWritesCase();
  await runSetSiteActiveAgentLeaseReassignedCase();
  await runSetSiteActiveAgentLeaseReleaseNoChangeCase();
  console.log('sitesDb service tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
