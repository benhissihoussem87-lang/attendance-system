const assert = require('assert');
const {
  validatePullDeviceEventsCommandPayload,
  validateAgentEventBatchPayload,
  buildDedupKey
} = require('../../contracts/agentDeviceEventsContract');

function runPullCommandValidationCase() {
  const valid = validatePullDeviceEventsCommandPayload({
    device_uid: 'zkteco:sn:ABC001',
    options: {
      host: '192.168.1.20',
      port: 4370,
      auth_password: 1234,
      lookback_minutes: 720,
      safety_window_minutes: 5,
      max_events: 600,
      since_utc: '2026-03-06T09:00:00Z',
      device_timezone: 'Africa/Tunis'
    }
  });
  assert.strictEqual(valid.ok, true, 'valid pull command payload should pass');
  assert.strictEqual(valid.value.options.host, '192.168.1.20');
  assert.strictEqual(valid.value.options.max_events, 600);

  const invalidHost = validatePullDeviceEventsCommandPayload({
    device_uid: 'zkteco:sn:ABC001',
    options: {
      host: '8.8.8.8'
    }
  });
  assert.strictEqual(invalidHost.ok, false, 'public host should fail validation');
}

function runBatchValidationCase() {
  const payload = {
    command_id: '7c4962f8-1daa-4e90-9c85-f6218db726f5',
    run_id: 'run-1',
    device_uid: 'zkteco:sn:ABC001',
    vendor: 'zkteco',
    ingest_method: 'agent_pull',
    device_timezone: 'Africa/Tunis',
    pull_started_at: '2026-03-06T09:00:00Z',
    pull_completed_at: '2026-03-06T09:01:00Z',
    cursor: {
      requested_since_utc: '2026-03-06T08:00:00Z',
      latest_event_time_utc: '2026-03-06T08:50:00Z',
      has_more: false
    },
    events: [
      {
        device_person_id: '1001',
        event_time_local: '2026-03-06 09:50:00',
        event_time_utc: '2026-03-06T08:50:00Z',
        direction: 'IN',
        verify_state: '0',
        verify_method: 'fp',
        raw: {
          parser: 'text'
        }
      }
    ]
  };

  const validated = validateAgentEventBatchPayload(payload);
  assert.strictEqual(validated.ok, true, 'valid agent event batch should pass');
  assert.strictEqual(validated.value.events.length, 1);
  assert.ok(validated.value.events[0].dedup_key, 'normalized event should include dedup_key');

  const invalidDirection = validateAgentEventBatchPayload({
    ...payload,
    events: [
      {
        ...payload.events[0],
        direction: 'SIDEWAYS'
      }
    ]
  });
  assert.strictEqual(invalidDirection.ok, false, 'invalid direction should fail');
}

function runDedupKeyCase() {
  const keyA = buildDedupKey({
    vendor: 'zkteco',
    deviceUid: 'zkteco:sn:ABC001',
    devicePersonId: '1001',
    eventTimeUtc: '2026-03-06T08:50:00.000Z',
    direction: 'IN',
    verifyState: '0',
    verifyMethod: 'fp'
  });
  const keyB = buildDedupKey({
    vendor: 'zkteco',
    deviceUid: 'zkteco:sn:ABC001',
    devicePersonId: '1001',
    eventTimeUtc: '2026-03-06T08:50:00.000Z',
    direction: 'IN',
    verifyState: '0',
    verifyMethod: 'fp'
  });
  assert.strictEqual(keyA, keyB, 'dedup key must be deterministic');
}

function run() {
  runPullCommandValidationCase();
  runBatchValidationCase();
  runDedupKeyCase();
  console.log('agent device events contract tests passed');
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
