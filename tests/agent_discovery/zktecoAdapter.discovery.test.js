const assert = require('assert');
const zktecoAdapter = require('../../agent/lib/discovery/zktecoAdapter');

async function runConfirmedPath() {
  const result = await zktecoAdapter.discover(
    ['192.168.10.12/32'],
    {
      timeout_ms: 300,
      max_hosts: 1,
      __probeTcp: async () => ({ open: true }),
      __probeZkProtocol: async () => ({
        handshake_ok: true,
        zk_response_received: true,
        ack_code: 2000,
        auth_required: false,
        option_reads: {
          serial_number: 'sn-abc-001',
          device_name: 'MB560',
          platform: 'ZEM800',
          mac: '001122334455'
        },
        firmware: 'Ver 6.66',
        errors: []
      })
    }
  );

  assert.ok(result && Array.isArray(result.discovered_devices), 'adapter should return discovered_devices array');
  assert.strictEqual(result.discovered_devices.length, 1, 'confirmed path should return one candidate');
  const device = result.discovered_devices[0];
  assert.strictEqual(device.confirmation_state, 'confirmed');
  assert.strictEqual(device.outcome_class, 'confirmed');
  assert.strictEqual(device.confidence_class, 'high');
  assert.strictEqual(device.device_uid, 'zkteco:sn:SN-ABC-001');
  assert.strictEqual(device.serial_number, 'SN-ABC-001');
  assert.strictEqual(device.model, 'MB560');
  assert.ok(device.protocol && device.protocol.transport === 'udp', 'confirmed path should mark udp protocol');
  assert.ok(result.summary && result.summary.hosts_confirmed === 1, 'summary should count confirmed host');
}

async function runProbablePathForMissingStableIdentity() {
  const result = await zktecoAdapter.discover(
    ['192.168.10.13/32'],
    {
      timeout_ms: 300,
      max_hosts: 1,
      __probeTcp: async () => ({ open: false, failure_reason: 'timeout' }),
      __probeZkProtocol: async () => ({
        handshake_ok: true,
        zk_response_received: true,
        ack_code: 2000,
        auth_required: false,
        option_reads: {
          device_name: 'K40'
        },
        firmware: '6.60',
        errors: []
      })
    }
  );

  assert.strictEqual(result.discovered_devices.length, 1, 'handshake without stable identity should still produce probable candidate');
  const device = result.discovered_devices[0];
  assert.strictEqual(device.confirmation_state, 'zk_service_reachable');
  assert.strictEqual(device.outcome_class, 'probable');
  assert.strictEqual(device.confidence_class, 'medium');
  assert.ok(device.device_uid.startsWith('zkteco:ip:'), 'probable candidate should fallback to ip uid');
  assert.ok(result.summary && result.summary.hosts_probable === 1, 'summary should count probable host');
}

async function runAuthRequiredPath() {
  const result = await zktecoAdapter.discover(
    ['192.168.10.17/32'],
    {
      timeout_ms: 300,
      max_hosts: 1,
      __probeTcp: async () => ({ open: true }),
      __probeZkProtocol: async () => ({
        handshake_ok: true,
        zk_response_received: true,
        ack_code: 2005,
        auth_required: true,
        auth_attempted: false,
        auth_succeeded: false,
        option_reads: {},
        firmware: '',
        errors: ['auth_required']
      })
    }
  );

  assert.strictEqual(result.discovered_devices.length, 1, 'auth-required handshake should produce probable candidate');
  const device = result.discovered_devices[0];
  assert.strictEqual(device.outcome_class, 'probable');
  assert.strictEqual(device.failure_reason, 'auth_required');
  assert.ok(result.summary.failure_reason_counts.auth_required >= 1, 'summary should include auth_required failures');
}

async function runHeuristicAndUnreachablePaths() {
  const tcpOnly = await zktecoAdapter.discover(
    ['192.168.10.14/32'],
    {
      timeout_ms: 300,
      max_hosts: 1,
      __probeTcp: async () => ({ open: true }),
      __probeZkProtocol: async () => ({
        handshake_ok: false,
        zk_response_received: false,
        ack_code: null,
        option_reads: {},
        firmware: '',
        errors: ['timeout']
      })
    }
  );
  assert.strictEqual(tcpOnly.discovered_devices.length, 1, 'tcp-only path should produce heuristic candidate');
  assert.strictEqual(tcpOnly.discovered_devices[0].confirmation_state, 'host_reachable');
  assert.strictEqual(tcpOnly.discovered_devices[0].outcome_class, 'heuristic');
  assert.strictEqual(tcpOnly.discovered_devices[0].confidence_class, 'low');
  assert.ok(tcpOnly.summary && tcpOnly.summary.hosts_heuristic === 1, 'summary should count heuristic');

  const unreachable = await zktecoAdapter.discover(
    ['192.168.10.15/32'],
    {
      timeout_ms: 300,
      max_hosts: 1,
      __probeTcp: async () => ({ open: false, failure_reason: 'timeout' }),
      __probeZkProtocol: async () => ({
        handshake_ok: false,
        zk_response_received: false,
        ack_code: null,
        option_reads: {},
        firmware: '',
        errors: ['timeout']
      })
    }
  );
  assert.strictEqual(unreachable.discovered_devices.length, 0, 'unreachable path should not produce candidate');
  assert.ok(unreachable.summary && unreachable.summary.hosts_unreachable === 1, 'summary should count unreachable');
}

async function runMalformedResponsePath() {
  const unreachable = await zktecoAdapter.discover(
    ['192.168.10.18/32'],
    {
      timeout_ms: 300,
      max_hosts: 1,
      __probeTcp: async () => ({ open: false, failure_reason: 'network_unreachable' }),
      __probeZkProtocol: async () => ({
        handshake_ok: false,
        zk_response_received: false,
        ack_code: null,
        option_reads: {},
        firmware: '',
        errors: ['malformed_response']
      })
    }
  );
  assert.strictEqual(unreachable.discovered_devices.length, 0, 'malformed/unreachable path should not produce candidate');
  assert.ok(unreachable.summary.failure_reason_counts.malformed_response >= 1, 'summary should include malformed_response count');
}

async function runHostCallbackCase() {
  const hostResults = [];
  await zktecoAdapter.discover(
    ['192.168.10.19/32'],
    {
      timeout_ms: 300,
      max_hosts: 1,
      __probeTcp: async () => ({ open: true }),
      __probeZkProtocol: async () => ({
        handshake_ok: true,
        zk_response_received: true,
        ack_code: 2000,
        option_reads: {
          serial_number: 'HOST-CB-01'
        },
        firmware: '',
        errors: []
      }),
      on_host_result: row => hostResults.push(row)
    }
  );
  assert.strictEqual(hostResults.length, 1, 'on_host_result callback should receive one row');
  assert.strictEqual(hostResults[0].outcome_class, 'confirmed');
  assert.strictEqual(hostResults[0].device_uid, 'zkteco:sn:HOST-CB-01');
}

async function runAuthOptionForwardingCase() {
  let forwardedAuthPassword = null;
  await zktecoAdapter.discover(
    ['192.168.10.16/32'],
    {
      timeout_ms: 300,
      max_hosts: 1,
      auth_password: 1234,
      __probeTcp: async () => ({ open: false, failure_reason: 'timeout' }),
      __probeZkProtocol: async args => {
        forwardedAuthPassword = args.authPassword;
        return {
          handshake_ok: false,
          zk_response_received: false,
          ack_code: null,
          option_reads: {},
          firmware: '',
          errors: []
        };
      }
    }
  );
  assert.strictEqual(forwardedAuthPassword, 1234, 'discover should forward auth_password to protocol probe');
}

async function run() {
  await runConfirmedPath();
  await runProbablePathForMissingStableIdentity();
  await runAuthRequiredPath();
  await runHeuristicAndUnreachablePaths();
  await runMalformedResponsePath();
  await runHostCallbackCase();
  await runAuthOptionForwardingCase();
  console.log('zkteco discovery adapter tests passed');
}

if (require.main === module) {
  run().catch(err => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { run };
