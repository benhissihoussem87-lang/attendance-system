const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const {
  ingestDiscoveryReport,
  claimCandidateDevice
} = require('../../services/agentBridgeDb');

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

function createDiscoveryDbMock({ existingBefore, upsertRow }) {
  const state = {
    events: [],
    tx: []
  };

  const db = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        state.tx.push(text);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('INSERT INTO device_discovery_reports')) {
        return {
          rows: [
            {
              id: 'report-1',
              company_id: 'DEFAULT',
              agent_id: 'agent-1',
              command_id: null,
              adapter_id: 'zkteco',
              reported_at: new Date().toISOString(),
              created_at: new Date().toISOString()
            }
          ],
          rowCount: 1
        };
      }
      if (text.includes('SELECT')
        && text.includes('FROM devices')
        && text.includes('device_uid = $2')
        && text.includes('identity_status')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT')
        && text.includes('FROM devices')
        && text.includes('device_uid = $2')
        && text.includes('manageability_reason')) {
        return { rows: existingBefore ? [existingBefore] : [], rowCount: existingBefore ? 1 : 0 };
      }
      if (text.includes('INSERT INTO devices') && text.includes('ON CONFLICT (company_id, device_uid) DO UPDATE')) {
        return { rows: [upsertRow], rowCount: 1 };
      }
      if (text.includes('INSERT INTO device_identity_aliases')) {
        return {
          rows: [{
            id: 'alias-1',
            company_id: 'DEFAULT',
            canonical_device_uid: upsertRow.device_uid,
            alias_kind: 'device_uid',
            vendor: 'zkteco',
            alias_value_normalized: upsertRow.device_uid,
            status: 'active',
            metadata: {}
          }],
          rowCount: 1
        };
      }
      if (text.includes('INSERT INTO device_lifecycle_events')) {
        state.events.push(decodeLifecycleEventParams(params));
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('UPDATE agent_commands') && text.includes("SET status = 'acknowledged'")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text.slice(0, 140)}`);
    }
  };
  return { db, state };
}

function createClaimDbMock({ beforeRow, afterRow }) {
  const state = {
    events: [],
    tx: []
  };

  const db = {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        state.tx.push(text);
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT')
        && text.includes('FROM devices')
        && text.includes('FOR UPDATE')
        && text.includes('managed_status = $3')) {
        return { rows: beforeRow ? [beforeRow] : [], rowCount: beforeRow ? 1 : 0 };
      }
      if (text.includes('UPDATE devices')
        && text.includes('SET managed_status = $1')
        && text.includes('RETURNING company_id, device_uid')) {
        return { rows: afterRow ? [afterRow] : [], rowCount: afterRow ? 1 : 0 };
      }
      if (text.includes('INSERT INTO device_lifecycle_events')) {
        state.events.push(decodeLifecycleEventParams(params));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text.slice(0, 140)}`);
    }
  };
  return { db, state };
}

async function runCandidateCreationEventCase() {
  const { db, state } = createDiscoveryDbMock({
    existingBefore: null,
    upsertRow: {
      company_id: 'DEFAULT',
      device_uid: 'zkteco:ip:192.168.1.20',
      managed_status: 'candidate',
      discovery_status: 'probable',
      discovered_by_agent_id: 'agent-1',
      discovery_metadata: {
        ip: '192.168.1.20'
      },
      last_seen_at: '2026-03-18T00:00:00.000Z',
      manageability_status: 'protocol_reachable',
      manageability_reason: 'discovery_protocol_reachable',
      inserted: true
    }
  });

  await ingestDiscoveryReport(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    commandId: null,
    adapterId: 'zkteco',
    subnetTargets: ['192.168.1.0/24'],
    reportedAt: '2026-03-18T00:00:00.000Z',
    discoveredDevices: [
      {
        ip: '192.168.1.20',
        mac: null,
        vendor: 'zkteco',
        model: 'K80 Pro',
        serial_number: null,
        device_uid: null,
        discovery_method: 'contract_test',
        confidence: 0.8,
        confidence_class: 'medium',
        confirmation_state: 'zk_service_reachable',
        outcome_class: 'probable',
        identity_source: null,
        failure_reason: null,
        protocol: {},
        observed_at: '2026-03-18T00:00:00.000Z',
        raw: {}
      }
    ],
    summary: {
      run_id: 'run-create'
    }
  });

  assert.deepStrictEqual(state.tx, ['BEGIN', 'COMMIT'], 'discovery create should commit transaction');
  assert.strictEqual(state.events.length, 1, 'candidate creation should emit one lifecycle event');
  const event = state.events[0];
  assert.strictEqual(event.lifecycle_event, 'candidate_created');
  assert.strictEqual(event.actor_type, 'agent');
  assert.strictEqual(event.agent_id, 'agent-1');
  assert.strictEqual(event.reason, 'discovery_report_ingested');
  assert.strictEqual(event.to_state.managed_status, 'candidate');
  assert.strictEqual(event.metadata.source, 'agent_discovery');
}

async function runCandidateUpdateEventCase() {
  const beforeRow = {
    company_id: 'DEFAULT',
    device_uid: 'zkteco:ip:192.168.1.21',
    managed_status: 'candidate',
    discovery_status: 'probable',
    discovered_by_agent_id: 'agent-1',
    manageability_status: 'protocol_reachable',
    manageability_reason: 'discovery_protocol_reachable',
    discovery_metadata: {
      ip: '192.168.1.21'
    }
  };
  const afterRow = {
    company_id: 'DEFAULT',
    device_uid: 'zkteco:ip:192.168.1.21',
    managed_status: 'candidate',
    discovery_status: 'confirmed',
    discovered_by_agent_id: 'agent-1',
    discovery_metadata: {
      ip: '192.168.1.21'
    },
    last_seen_at: '2026-03-18T00:05:00.000Z',
    manageability_status: 'manageable',
    manageability_reason: 'discovery_confirmed',
    inserted: false
  };

  const { db, state } = createDiscoveryDbMock({
    existingBefore: beforeRow,
    upsertRow: afterRow
  });

  await ingestDiscoveryReport(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    commandId: null,
    adapterId: 'zkteco',
    subnetTargets: ['192.168.1.0/24'],
    reportedAt: '2026-03-18T00:05:00.000Z',
    discoveredDevices: [
      {
        ip: '192.168.1.21',
        mac: null,
        vendor: 'zkteco',
        model: 'K80 Pro',
        serial_number: null,
        device_uid: null,
        discovery_method: 'contract_test',
        confidence: 0.95,
        confidence_class: 'high',
        confirmation_state: 'confirmed',
        outcome_class: 'confirmed',
        identity_source: 'protocol',
        failure_reason: null,
        protocol: {},
        observed_at: '2026-03-18T00:05:00.000Z',
        raw: {}
      }
    ],
    summary: {
      run_id: 'run-update'
    }
  });

  assert.deepStrictEqual(state.tx, ['BEGIN', 'COMMIT'], 'discovery update should commit transaction');
  assert.strictEqual(state.events.length, 1, 'candidate update should emit one lifecycle event');
  const event = state.events[0];
  assert.strictEqual(event.lifecycle_event, 'candidate_updated');
  assert.strictEqual(event.actor_type, 'agent');
  assert.strictEqual(event.reason, 'discovery_report_ingested');
  assert.strictEqual(event.from_state.discovery_status, 'probable');
  assert.strictEqual(event.to_state.discovery_status, 'confirmed');
}

async function runCandidateClaimEventCase() {
  const { db, state } = createClaimDbMock({
    beforeRow: {
      company_id: 'DEFAULT',
      device_uid: 'zkteco:ip:192.168.1.22',
      managed_status: 'candidate',
      discovery_status: 'probable',
      discovered_by_agent_id: 'agent-2',
      manageability_status: 'protocol_reachable',
      manageability_reason: 'discovery_protocol_reachable',
      discovery_metadata: {
        ip: '192.168.1.22'
      }
    },
    afterRow: {
      company_id: 'DEFAULT',
      device_uid: 'zkteco:ip:192.168.1.22',
      provider: 'zkteco',
      device_name: 'K80 Claimed',
      active: true,
      metadata: {},
      managed_status: 'managed',
      discovery_status: 'probable',
      discovered_by_agent_id: 'agent-2',
      source: 'agent_discovery',
      claimed_at: '2026-03-18T00:10:00.000Z',
      claimed_by_key_id: 'ak_test',
      last_seen_at: '2026-03-18T00:10:00.000Z',
      discovery_metadata: {
        ip: '192.168.1.22'
      },
      manageability_status: 'protocol_reachable',
      manageability_reason: 'discovery_protocol_reachable',
      manageability_updated_at: '2026-03-18T00:10:00.000Z',
      manageability_last_proven_at: null,
      remediation_manual_status: null,
      remediation_manual_note: null,
      remediation_manual_owner: null,
      remediation_manual_updated_at: null,
      remediation_manual_updated_by_key_id: null,
      created_at: '2026-03-18T00:00:00.000Z',
      updated_at: '2026-03-18T00:10:00.000Z'
    }
  });

  const claimed = await claimCandidateDevice(db, {
    companyId: 'DEFAULT',
    deviceUid: 'zkteco:ip:192.168.1.22',
    claimedByKeyId: 'ak_test',
    claimedByRole: 'admin',
    updates: {
      device_name: 'K80 Claimed'
    }
  });

  assert.ok(claimed, 'claim should return updated row');
  assert.strictEqual(claimed.managed_status, 'managed');
  assert.deepStrictEqual(state.tx, ['BEGIN', 'COMMIT'], 'claim should commit transaction');
  assert.strictEqual(state.events.length, 1, 'claim should emit one lifecycle event');
  const event = state.events[0];
  assert.strictEqual(event.lifecycle_event, 'candidate_claimed');
  assert.strictEqual(event.actor_type, 'admin');
  assert.strictEqual(event.reason, 'manual_claim');
  assert.strictEqual(event.from_state.managed_status, 'candidate');
  assert.strictEqual(event.to_state.managed_status, 'managed');
  assert.strictEqual(event.metadata.source, 'agent_admin.claim');
}

async function run() {
  await runCandidateCreationEventCase();
  await runCandidateUpdateEventCase();
  await runCandidateClaimEventCase();
  console.log('agentBridgeDb lifecycle event tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
