const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { COMMAND_TYPES } = require('../../contracts/agentBridgeContract');
const { createLocalDiagnosticsTracker } = require('../../agent/lib/localDiagnosticsTracker');

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-diag-'));
  const file = path.join(dir, 'diag-state.json');

  try {
    const tracker = createLocalDiagnosticsTracker({
      filePath: file,
      heartbeatStaleMs: 60000,
      pollStaleMs: 20000,
      maxRecentActivity: 20
    });

    tracker.setAgentIdentity({
      agent_id: 'agent-1',
      company_id: 'DEFAULT',
      agent_name: 'k80-live-agent',
      base_url: 'http://localhost:3000',
      version: '1.0.0'
    });

    tracker.recordHeartbeatAttempt();
    tracker.recordHeartbeatResult({
      ok: true,
      status: 200,
      saasLastHeartbeatAt: new Date().toISOString()
    });
    tracker.recordPollAttempt();
    tracker.recordCommandReceived({
      id: 'cmd-validate-1',
      type: COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE
    });
    tracker.recordCommandStarted({
      id: 'cmd-validate-1',
      type: COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE
    }, {
      device_uid: 'zkteco:sn:K80-001',
      provider: 'zkteco',
      connection: {
        host: '192.168.22.201',
        port: 4370,
        transport: 'tcp',
        attlog_sequence: 'zktime_k80'
      }
    });
    tracker.recordCommandFinished({
      id: 'cmd-validate-1',
      type: COMMAND_TYPES.VALIDATE_DEVICE_CANDIDATE
    }, {
      device_uid: 'zkteco:sn:K80-001',
      provider: 'zkteco'
    }, {
      ok: true,
      reason_code: 'validation_succeeded',
      handshake_proved: true
    });

    const successSnapshot = tracker.buildSnapshot({
      pendingBufferedBatches: 0
    });

    assert.strictEqual(successSnapshot.agent.agent_id, 'agent-1');
    assert.strictEqual(successSnapshot.saas_connectivity.status, 'connected');
    assert.strictEqual(successSnapshot.command_polling.status, 'fresh');
    assert.strictEqual(successSnapshot.devices.length, 1);
    assert.strictEqual(successSnapshot.devices[0].device_uid, 'zkteco:sn:K80-001');
    assert.strictEqual(successSnapshot.devices[0].last_validation.status, 'succeeded');
    assert.strictEqual(successSnapshot.support_summary.status, 'healthy');
    assert.ok(Array.isArray(successSnapshot.commands.recent));
    assert.ok(successSnapshot.commands.recent.length > 0);

    tracker.recordCommandReceived({
      id: 'cmd-pull-1',
      type: COMMAND_TYPES.PULL_DEVICE_EVENTS
    });
    tracker.recordCommandStarted({
      id: 'cmd-pull-1',
      type: COMMAND_TYPES.PULL_DEVICE_EVENTS
    }, {
      device_uid: 'zkteco:sn:K80-001',
      provider: 'zkteco'
    });
    tracker.recordCommandFinished({
      id: 'cmd-pull-1',
      type: COMMAND_TYPES.PULL_DEVICE_EVENTS
    }, {
      device_uid: 'zkteco:sn:K80-001'
    }, {
      ok: false,
      reason_code: 'pull_batch_buffer_failed',
      event_count: 0
    });

    const failureSnapshot = tracker.buildSnapshot({
      pendingBufferedBatches: 2
    });

    assert.strictEqual(failureSnapshot.support_summary.status, 'attention');
    assert.strictEqual(failureSnapshot.support_summary.primary_issue, 'recent_command_failure');
    assert.strictEqual(failureSnapshot.buffered_event_batches, 2);
    assert.strictEqual(failureSnapshot.commands.last_failure.reason_code, 'pull_batch_buffer_failed');
    assert.strictEqual(failureSnapshot.devices[0].last_pull.status, 'failed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('agent local diagnostics tracker tests passed');
}

if (require.main === module) {
  try {
    run();
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { run };
