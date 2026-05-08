const assert = require('assert');
const { validateDiscoveryReportPayload } = require('../../contracts/agentBridgeContract');

function runValidPayloadCase() {
  const now = new Date().toISOString();
  const payload = {
    adapter_id: 'zkteco',
    reported_at: now,
    discovered_devices: [
      {
        ip: '192.168.10.20',
        vendor: 'zkteco',
        model: 'MB560',
        serial_number: 'SN200',
        device_uid: 'zkteco:sn:SN200',
        discovery_method: 'zkteco_udp_protocol_interrogation',
        confidence: 0.97,
        confidence_class: 'high',
        confirmation_state: 'confirmed',
        outcome_class: 'confirmed',
        identity_source: 'serial_number',
        failure_reason: null,
        protocol: {
          family: 'zkteco-4370',
          transport: 'udp'
        },
        observed_at: now,
        raw: {
          zk_ack_code: 2000
        }
      }
    ],
    summary: {
      hosts_confirmed: 1
    }
  };

  const validated = validateDiscoveryReportPayload(payload);
  assert.strictEqual(validated.ok, true, 'valid payload should pass');
  assert.ok(validated.value.discovered_devices[0].protocol, 'protocol evidence should survive normalization');
  assert.strictEqual(validated.value.discovered_devices[0].confirmation_state, 'confirmed');
}

function runInvalidCases() {
  const now = new Date().toISOString();

  const invalidConfidence = validateDiscoveryReportPayload({
    adapter_id: 'zkteco',
    reported_at: now,
    discovered_devices: [
      {
        ip: '192.168.10.21',
        vendor: 'zkteco',
        confidence: 1.4,
        observed_at: now
      }
    ]
  });
  assert.strictEqual(invalidConfidence.ok, false, 'confidence above 1 should fail');

  const invalidState = validateDiscoveryReportPayload({
    adapter_id: 'zkteco',
    reported_at: now,
    discovered_devices: [
      {
        ip: '192.168.10.21',
        vendor: 'zkteco',
        confidence: 0.5,
        confirmation_state: 'definitely_zk',
        observed_at: now
      }
    ]
  });
  assert.strictEqual(invalidState.ok, false, 'invalid confirmation_state should fail');

  const invalidFailureReason = validateDiscoveryReportPayload({
    adapter_id: 'zkteco',
    reported_at: now,
    discovered_devices: [
      {
        ip: '192.168.10.21',
        vendor: 'zkteco',
        confidence: 0.5,
        confirmation_state: 'host_reachable',
        outcome_class: 'heuristic',
        failure_reason: 'maybe',
        observed_at: now
      }
    ]
  });
  assert.strictEqual(invalidFailureReason.ok, false, 'invalid failure_reason should fail');
}

function run() {
  runValidPayloadCase();
  runInvalidCases();
  console.log('agent bridge discovery payload contract tests passed');
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
