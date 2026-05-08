const assert = require('assert');

process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

const {
  fetchNextCommandForAgent,
  reconcileAgentCommandLifecycle
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

function createLifecycleDbMock(state) {
  return {
    query: async (sql, params) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      if (text.includes('SELECT id, command_type, command_payload') && text.includes('status = $3') && text.includes('expires_at')) {
        const companyId = params[0];
        const agentId = params[1];
        const now = new Date(params[3]).getTime();
        const rows = state.commands
          .filter(cmd => cmd.company_id === companyId
            && cmd.agent_id === agentId
            && cmd.status === params[2]
            && cmd.expires_at
            && new Date(cmd.expires_at).getTime() <= now)
          .map(cmd => ({
            id: cmd.id,
            command_type: cmd.command_type,
            command_payload: cmd.command_payload
          }));
        return { rows };
      }

      if (text.includes('SELECT id, command_type, command_payload, sent_at') && text.includes('status = $3')) {
        const companyId = params[0];
        const agentId = params[1];
        const rows = state.commands
          .filter(cmd => cmd.company_id === companyId
            && cmd.agent_id === agentId
            && cmd.status === params[2]
            && cmd.sent_at)
          .map(cmd => ({
            id: cmd.id,
            command_type: cmd.command_type,
            command_payload: cmd.command_payload,
            sent_at: cmd.sent_at
          }));
        return { rows };
      }

      if (text.includes('UPDATE agent_commands') && text.includes('WHERE id = ANY($4::uuid[])')) {
        const status = params[0];
        const failureReason = params[1];
        const resultPayload = parseJson(params[2]);
        const ids = new Set(params[3]);
        let rowCount = 0;
        for (const cmd of state.commands) {
          if (!ids.has(cmd.id)) continue;
          cmd.status = status;
          cmd.failure_reason = failureReason;
          cmd.result_payload = {
            ...(parseJson(cmd.result_payload)),
            ...resultPayload
          };
          rowCount += 1;
        }
        return { rowCount, rows: [] };
      }

      if (text.includes('UPDATE agent_device_sync_states') && text.includes("SET status = 'error'")) {
        const failureReason = params[0];
        const metadata = parseJson(params[1]);
        const companyId = params[2];
        const agentId = params[3];
        const deviceUid = params[4];
        const row = state.syncStates.find(item => item.company_id === companyId
          && item.agent_id === agentId
          && item.device_uid === deviceUid);
        if (!row) {
          return { rowCount: 0, rows: [] };
        }
        row.status = 'error';
        row.failure_reason = failureReason;
        row.consecutive_failures += 1;
        row.metadata = { ...(row.metadata || {}), ...metadata };
        return { rowCount: 1, rows: [] };
      }

      if (text.includes('SELECT id, company_id, agent_id, command_type, command_payload, created_at')
        && text.includes("status = 'queued'")) {
        const companyId = params[0];
        const agentId = params[1];
        const row = state.commands.find(cmd => cmd.company_id === companyId
          && cmd.agent_id === agentId
          && cmd.status === 'queued');
        return { rows: row ? [row] : [] };
      }

      if (text.includes("UPDATE agent_commands")
        && text.includes("SET status = 'failed'")
        && text.includes('failure_reason = $1')
        && text.includes('WHERE id = $3')) {
        const failureReason = params[0];
        const resultPatch = parseJson(params[1]);
        const commandId = params[2];
        const companyId = params[3];
        const agentId = params[4];
        const row = state.commands.find(cmd => cmd.id === commandId
          && cmd.company_id === companyId
          && cmd.agent_id === agentId);
        if (!row) {
          return { rowCount: 0, rows: [] };
        }
        row.status = 'failed';
        row.failure_reason = failureReason;
        row.result_payload = {
          ...(parseJson(row.result_payload)),
          ...resultPatch
        };
        return { rowCount: 1, rows: [] };
      }

      if (text.includes("UPDATE agent_commands") && text.includes("SET status = 'sent', sent_at = now()")) {
        const commandId = params[0];
        const row = state.commands.find(cmd => cmd.id === commandId);
        if (!row) {
          return { rowCount: 0, rows: [] };
        }
        row.status = 'sent';
        row.sent_at = '2026-03-06T10:00:00.000Z';
        return { rowCount: 1, rows: [] };
      }

      if (text.includes('UPDATE agent_device_sync_states') && text.includes("SET status = 'syncing'")) {
        const metadata = parseJson(params[0]);
        const companyId = params[1];
        const agentId = params[2];
        const deviceUid = params[3];
        const row = state.syncStates.find(item => item.company_id === companyId
          && item.agent_id === agentId
          && item.device_uid === deviceUid);
        if (!row) {
          return { rowCount: 0, rows: [] };
        }
        row.status = 'syncing';
        row.failure_reason = null;
        row.metadata = { ...(row.metadata || {}), ...metadata };
        row.last_sync_started_at = '2026-03-06T10:00:00.000Z';
        return { rowCount: 1, rows: [] };
      }

      if (text.includes('FROM site_agent_leases')
        && text.includes("status = 'active'")) {
        const activeLease = state.activeLease || null;
        if (!activeLease) {
          return { rows: [] };
        }
        if (text.includes('AND agent_id = $2')) {
          const companyId = params[0];
          const agentId = params[1];
          if (activeLease.company_id === companyId && activeLease.agent_id === agentId) {
            return { rows: [{ site_id: activeLease.site_id }] };
          }
          return { rows: [] };
        }
        if (text.includes('AND site_id = $2')) {
          const companyId = params[0];
          const siteId = params[1];
          if (activeLease.company_id === companyId && activeLease.site_id === siteId) {
            return {
              rows: [{
                lease_id: activeLease.lease_id || 'lease-1',
                company_id: activeLease.company_id,
                site_id: activeLease.site_id,
                agent_id: activeLease.agent_id,
                status: 'active',
                leased_at: activeLease.leased_at || '2026-03-06T09:00:00.000Z'
              }]
            };
          }
          return { rows: [] };
        }
        return { rows: [] };
      }

      throw new Error(`unexpected query: ${text.slice(0, 140)}`);
    }
  };
}

async function runQueuedExpiryCase() {
  const state = {
    commands: [
      {
        id: '00000000-0000-0000-0000-000000000001',
        company_id: 'DEFAULT',
        agent_id: 'agent-1',
        command_type: 'PULL_DEVICE_EVENTS',
        command_payload: { device_uid: 'zkteco:sn:EXP-1' },
        status: 'queued',
        sent_at: null,
        expires_at: '2026-03-06T09:00:00.000Z',
        failure_reason: null,
        result_payload: {}
      }
    ],
    syncStates: [
      {
        company_id: 'DEFAULT',
        agent_id: 'agent-1',
        device_uid: 'zkteco:sn:EXP-1',
        status: 'idle',
        failure_reason: null,
        consecutive_failures: 0,
        metadata: {}
      }
    ]
  };
  const db = createLifecycleDbMock(state);
  const result = await reconcileAgentCommandLifecycle(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    nowIso: '2026-03-06T10:00:00.000Z',
    sentStaleSeconds: 300
  });

  assert.strictEqual(result.expired_count, 1, 'queued expiry should transition one command');
  assert.strictEqual(result.stale_sent_failed_count, 0);
  assert.strictEqual(state.commands[0].status, 'expired');
  assert.strictEqual(state.commands[0].failure_reason, 'command_expired');
  assert.strictEqual(state.syncStates[0].status, 'error');
  assert.strictEqual(state.syncStates[0].failure_reason, 'command_expired');
  assert.strictEqual(state.syncStates[0].consecutive_failures, 1);
}

async function runStaleSentCase() {
  const state = {
    commands: [
      {
        id: '00000000-0000-0000-0000-000000000002',
        company_id: 'DEFAULT',
        agent_id: 'agent-1',
        command_type: 'PULL_DEVICE_EVENTS',
        command_payload: {
          device_uid: 'zkteco:sn:STALE-1',
          pull: { sent_stale_seconds: 30 }
        },
        status: 'sent',
        sent_at: '2026-03-06T09:00:00.000Z',
        expires_at: '2026-03-06T11:00:00.000Z',
        failure_reason: null,
        result_payload: {}
      }
    ],
    syncStates: [
      {
        company_id: 'DEFAULT',
        agent_id: 'agent-1',
        device_uid: 'zkteco:sn:STALE-1',
        status: 'syncing',
        failure_reason: null,
        consecutive_failures: 0,
        metadata: {}
      }
    ]
  };
  const db = createLifecycleDbMock(state);
  const result = await reconcileAgentCommandLifecycle(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1',
    nowIso: '2026-03-06T10:00:00.000Z',
    sentStaleSeconds: 300
  });

  assert.strictEqual(result.expired_count, 0);
  assert.strictEqual(result.stale_sent_failed_count, 1, 'stale sent should transition one command');
  assert.strictEqual(state.commands[0].status, 'failed');
  assert.strictEqual(state.commands[0].failure_reason, 'sent_timeout');
  assert.strictEqual(state.syncStates[0].status, 'error');
  assert.strictEqual(state.syncStates[0].failure_reason, 'sent_timeout');
}

async function runSentSyncAlignmentCase() {
  const state = {
    commands: [
      {
        id: '00000000-0000-0000-0000-000000000003',
        company_id: 'DEFAULT',
        agent_id: 'agent-1',
        command_type: 'PULL_DEVICE_EVENTS',
        command_payload: {
          device_uid: 'zkteco:sn:SYNC-1',
          pull: { sent_stale_seconds: 60 }
        },
        status: 'queued',
        sent_at: null,
        expires_at: '2099-03-06T11:00:00.000Z',
        created_at: '2026-03-06T09:59:00.000Z'
      }
    ],
    syncStates: [
      {
        company_id: 'DEFAULT',
        agent_id: 'agent-1',
        device_uid: 'zkteco:sn:SYNC-1',
        status: 'idle',
        failure_reason: 'old_error',
        consecutive_failures: 2,
        metadata: {}
      }
    ]
  };
  const db = createLifecycleDbMock(state);
  const command = await fetchNextCommandForAgent(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1'
  });

  assert.ok(command, 'command should be returned');
  assert.strictEqual(state.commands[0].status, 'sent', 'queued command should move to sent');
  assert.strictEqual(state.syncStates[0].status, 'syncing', 'sync status should move to syncing when command is sent');
  assert.strictEqual(state.syncStates[0].failure_reason, null, 'sync failure reason should clear when sent');
  assert.strictEqual(state.syncStates[0].metadata.last_command_status, 'sent');
}

async function runPollBlockedBySiteLeaseCase() {
  const state = {
    commands: [
      {
        id: '00000000-0000-0000-0000-000000000004',
        company_id: 'DEFAULT',
        agent_id: 'agent-1',
        command_type: 'PULL_DEVICE_EVENTS',
        command_payload: {
          device_uid: 'zkteco:sn:SYNC-2',
          runtime_context: {
            site_id: '11111111-1111-1111-1111-111111111111',
            bound_agent_id: 'agent-1'
          }
        },
        status: 'queued',
        sent_at: null,
        expires_at: '2099-03-06T11:00:00.000Z',
        created_at: '2026-03-06T09:59:00.000Z',
        result_payload: {}
      }
    ],
    syncStates: [],
    activeLease: {
      lease_id: 'lease-1',
      company_id: 'DEFAULT',
      site_id: '11111111-1111-1111-1111-111111111111',
      agent_id: 'agent-9',
      leased_at: '2026-03-06T09:00:00.000Z'
    }
  };
  const db = createLifecycleDbMock(state);
  const command = await fetchNextCommandForAgent(db, {
    companyId: 'DEFAULT',
    agentId: 'agent-1'
  });

  assert.strictEqual(command, null, 'poll should return no command when queued command is gate-blocked');
  assert.strictEqual(state.commands[0].status, 'failed', 'blocked queued command should transition to failed');
  assert.strictEqual(
    state.commands[0].failure_reason,
    'site_active_runtime_mismatch',
    'blocked command should record deterministic gate reason'
  );
}

async function run() {
  await runQueuedExpiryCase();
  await runStaleSentCase();
  await runSentSyncAlignmentCase();
  await runPollBlockedBySiteLeaseCase();
  console.log('agent bridge command lifecycle service tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
