const assert = require('assert');
const {
  validateInventorySnapshotCreatePayload,
  validateEnrollmentPreflightPayload
} = require('../../contracts/deviceUserInventoryContract');

function run() {
  {
    const result = validateInventorySnapshotCreatePayload({
      inventory_scope: 'zk_k80',
      parsed_device_user_ids: [7, '2', 7, '10', 'invalid'],
      inventory_confidence_status: 'high',
      inventory_completeness_status: 'partial',
      snapshot_taken_at: '2026-04-14T13:57:50.556Z',
      raw_evidence_ref: { capture_file: 'users.pcapng' },
      source_metadata: { note: 'phase1' }
    });
    assert.strictEqual(result.ok, true, 'valid payload should pass');
    assert.deepStrictEqual(result.value.parsed_device_user_ids, [2, 7, 10], 'ids should normalize and dedupe');
    assert.strictEqual(result.value.inventory_scope, 'zk_k80');
    assert.strictEqual(result.value.inventory_confidence_status, 'high');
    assert.strictEqual(result.value.inventory_completeness_status, 'partial');
  }

  {
    const result = validateInventorySnapshotCreatePayload({
      inventory_scope: 'hikvision',
      parsed_device_user_ids: [1],
      inventory_confidence_status: 'high',
      inventory_completeness_status: 'complete'
    });
    assert.strictEqual(result.ok, false, 'non-k80 scope should be blocked in phase1');
  }

  {
    const result = validateInventorySnapshotCreatePayload({
      parsed_device_user_ids: [1],
      inventory_confidence_status: 'bad-status',
      inventory_completeness_status: 'complete'
    });
    assert.strictEqual(result.ok, true, 'unknown confidence should safely normalize in phase1');
    assert.strictEqual(result.value.inventory_confidence_status, 'unknown');
  }

  {
    const result = validateEnrollmentPreflightPayload({
      manual_override: {
        device_user_id: 42,
        override_reason: 'legacy_id_reservation',
        override_note: 'operator validated on-site'
      },
      note: 'manual preflight test'
    });
    assert.strictEqual(result.ok, true, 'manual override preflight payload should validate');
    assert.strictEqual(result.value.manual_override.device_user_id, 42);
  }

  {
    const result = validateEnrollmentPreflightPayload({
      manual_override: {
        device_user_id: 'invalid'
      }
    });
    assert.strictEqual(result.ok, false, 'invalid manual override id should fail');
  }
}

try {
  run();
  console.log('ok - deviceUserInventoryContract');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
