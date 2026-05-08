const assert = require('assert');

const {
  MANAGEABILITY_STATUS,
  MANAGEABILITY_REASON,
  mapDiscoveryOutcomeToManageability,
  mapPullOutcomeToManageability,
  buildManageabilityView
} = require('../../services/deviceManageability');

function runDiscoveryMappingCases() {
  const hostReachable = mapDiscoveryOutcomeToManageability({
    confirmationState: 'host_reachable',
    failureReason: null
  });
  assert.strictEqual(hostReachable.status, MANAGEABILITY_STATUS.REACHABLE);
  assert.strictEqual(hostReachable.reason, MANAGEABILITY_REASON.DISCOVERY_HOST_REACHABLE);

  const confirmed = mapDiscoveryOutcomeToManageability({
    confirmationState: 'confirmed',
    failureReason: null
  });
  assert.strictEqual(confirmed.status, MANAGEABILITY_STATUS.PROTOCOL_REACHABLE);
  assert.strictEqual(confirmed.reason, MANAGEABILITY_REASON.DISCOVERY_CONFIRMED);

  const authBlocked = mapDiscoveryOutcomeToManageability({
    confirmationState: 'zk_service_reachable',
    failureReason: 'auth_required'
  });
  assert.strictEqual(authBlocked.status, MANAGEABILITY_STATUS.BLOCKED);
  assert.strictEqual(authBlocked.reason, MANAGEABILITY_REASON.AUTH_REQUIRED);
}

function runPullMappingCases() {
  const ingesting = mapPullOutcomeToManageability({
    batchStatus: 'accepted',
    pullOk: true,
    insertedCount: 2,
    dedupedCount: 0,
    failureReason: null
  });
  assert.strictEqual(ingesting.status, MANAGEABILITY_STATUS.INGESTING);
  assert.strictEqual(ingesting.reason, MANAGEABILITY_REASON.INGESTION_ACCEPTED);
  assert.strictEqual(ingesting.proven, true);

  const manageable = mapPullOutcomeToManageability({
    batchStatus: 'accepted',
    pullOk: true,
    insertedCount: 0,
    dedupedCount: 0,
    failureReason: null
  });
  assert.strictEqual(manageable.status, MANAGEABILITY_STATUS.MANAGEABLE);
  assert.strictEqual(manageable.reason, MANAGEABILITY_REASON.PULL_SUCCEEDED);
  assert.strictEqual(manageable.proven, true);

  const blocked = mapPullOutcomeToManageability({
    batchStatus: 'rejected',
    pullOk: false,
    insertedCount: 0,
    dedupedCount: 0,
    failureReason: 'connect_timeout'
  });
  assert.strictEqual(blocked.status, MANAGEABILITY_STATUS.BLOCKED);
  assert.strictEqual(blocked.reason, MANAGEABILITY_REASON.CONNECT_TIMEOUT);
  assert.strictEqual(blocked.proven, false);
}

function runViewCases() {
  const view = buildManageabilityView({
    manageability_status: 'ingesting',
    manageability_reason: 'ingestion_accepted',
    manageability_last_proven_at: '2026-03-13T10:00:00.000Z',
    remediation_manual_status: 'needs_field_action',
    remediation_manual_note: 'Device is locked',
    remediation_manual_owner: 'field-tech'
  });

  assert.strictEqual(view.system_status, MANAGEABILITY_STATUS.INGESTING);
  assert.strictEqual(view.effective_status, 'needs_field_action');
  assert.strictEqual(view.effective_reason, MANAGEABILITY_REASON.MANUAL_NEEDS_FIELD_ACTION);
  assert.strictEqual(view.is_proven_manageable, true);
}

function run() {
  runDiscoveryMappingCases();
  runPullMappingCases();
  runViewCases();
  console.log('device manageability service tests passed');
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
