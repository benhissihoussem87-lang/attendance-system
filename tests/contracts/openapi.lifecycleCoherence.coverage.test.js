const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const specPath = path.join(repoRoot, 'openapi', 'openapi.yaml');
  const text = fs.readFileSync(specPath, 'utf8').replace(/\r\n/g, '\n');

  assert.ok(
    text.includes('/api/agent-admin/devices/{device_uid}/managing-agent-binding:'),
    'OpenAPI spec missing managing-agent binding route path'
  );
  assert.ok(
    text.includes('operationId: setManagingAgentBinding'),
    'OpenAPI spec missing operationId setManagingAgentBinding'
  );
  assert.ok(
    text.includes('ManagingAgentBindingRequest:'),
    'OpenAPI spec missing ManagingAgentBindingRequest schema'
  );
  assert.ok(
    text.includes('ManagingAgentBindingResponse:'),
    'OpenAPI spec missing ManagingAgentBindingResponse schema'
  );

  assert.ok(
    text.includes('/api/agent-admin/devices/manual-onboarding:'),
    'OpenAPI spec missing manual onboarding route path'
  );
  assert.ok(
    text.includes('operationId: upsertManualOnboardingCandidate'),
    'OpenAPI spec missing operationId upsertManualOnboardingCandidate'
  );
  assert.ok(
    text.includes('ManualDeviceOnboardingRequest:'),
    'OpenAPI spec missing ManualDeviceOnboardingRequest schema'
  );
  assert.ok(
    text.includes('ManualDeviceOnboardingResponse:'),
    'OpenAPI spec missing ManualDeviceOnboardingResponse schema'
  );
  assert.ok(
    text.includes('/api/agent-admin/devices/{device_uid}/validate:'),
    'OpenAPI spec missing manual device validation queue route path'
  );
  assert.ok(
    text.includes('operationId: queueManualDeviceValidation'),
    'OpenAPI spec missing operationId queueManualDeviceValidation'
  );
  assert.ok(
    text.includes('ManualDeviceValidationRequest:'),
    'OpenAPI spec missing ManualDeviceValidationRequest schema'
  );
  assert.ok(
    text.includes('ManualDeviceValidationResponse:'),
    'OpenAPI spec missing ManualDeviceValidationResponse schema'
  );
  assert.ok(
    text.includes('/api/agent-admin/devices/{device_uid}/onboarding-readiness:'),
    'OpenAPI spec missing onboarding-readiness route path'
  );
  assert.ok(
    text.includes('operationId: getDeviceOnboardingReadiness'),
    'OpenAPI spec missing operationId getDeviceOnboardingReadiness'
  );
  assert.ok(
    text.includes('DeviceOnboardingReadinessResponse:'),
    'OpenAPI spec missing DeviceOnboardingReadinessResponse schema'
  );
  assert.ok(
    text.includes('/api/agent-admin/sites:'),
    'OpenAPI spec missing sites collection route path'
  );
  assert.ok(
    text.includes('operationId: listSites')
      && text.includes('operationId: createSite'),
    'OpenAPI spec missing sites collection operationIds'
  );
  assert.ok(
    text.includes('/api/agent-admin/sites/{site_id}:'),
    'OpenAPI spec missing site item route path'
  );
  assert.ok(
    text.includes('operationId: getSite')
      && text.includes('operationId: updateSite'),
    'OpenAPI spec missing site item operationIds'
  );
  assert.ok(
    text.includes('/api/agent-admin/agents/{agent_id}/site:'),
    'OpenAPI spec missing agent site assignment route path'
  );
  assert.ok(
    text.includes('operationId: setAgentSiteAssignment'),
    'OpenAPI spec missing operationId setAgentSiteAssignment'
  );
  assert.ok(
    text.includes('/api/agent-admin/devices/{device_uid}/site:'),
    'OpenAPI spec missing device site assignment route path'
  );
  assert.ok(
    text.includes('operationId: setDeviceSiteAssignment'),
    'OpenAPI spec missing operationId setDeviceSiteAssignment'
  );
  assert.ok(
    text.includes('SiteRecord:')
      && text.includes('SiteCreateRequest:')
      && text.includes('SiteUpdateRequest:')
      && text.includes('SiteListResponse:'),
    'OpenAPI spec missing site schemas'
  );
  assert.ok(
    text.includes('AgentSiteAssignmentRequest:')
      && text.includes('AgentSiteAssignmentResponse:')
      && text.includes('DeviceSiteAssignmentRequest:')
      && text.includes('DeviceSiteAssignmentResponse:'),
    'OpenAPI spec missing site assignment schemas'
  );
  assert.ok(
    text.includes('/api/agent-admin/sites/{site_id}/active-agent:'),
    'OpenAPI spec missing site active-agent route path'
  );
  assert.ok(
    text.includes('operationId: getSiteActiveAgent')
      && text.includes('operationId: setSiteActiveAgent'),
    'OpenAPI spec missing site active-agent operationIds'
  );
  assert.ok(
    text.includes('/api/agent-admin/sites/{site_id}/active-agent/history:'),
    'OpenAPI spec missing site active-agent history route path'
  );
  assert.ok(
    text.includes('operationId: listSiteActiveAgentHistory'),
    'OpenAPI spec missing operationId listSiteActiveAgentHistory'
  );
  assert.ok(
    text.includes('SiteActiveAgentLeaseRecord:')
      && text.includes('SiteActiveAgentReadResponse:')
      && text.includes('SiteActiveAgentAssignmentRequest:')
      && text.includes('SiteActiveAgentAssignmentResponse:')
      && text.includes('SiteActiveAgentLeaseHistoryResponse:'),
    'OpenAPI spec missing site active-agent schemas'
  );
  assert.ok(
    text.includes('/api/agent/device-validations/result:'),
    'OpenAPI spec missing agent device validation result route path'
  );
  assert.ok(
    text.includes('operationId: submitAgentDeviceValidationResult'),
    'OpenAPI spec missing operationId submitAgentDeviceValidationResult'
  );
  assert.ok(
    text.includes('AgentDeviceValidationResultRequest:'),
    'OpenAPI spec missing AgentDeviceValidationResultRequest schema'
  );

  assert.ok(
    text.includes('/api/agent-admin/lifecycle-integrity:'),
    'OpenAPI spec missing lifecycle-integrity route path'
  );
  assert.ok(
    text.includes('operationId: getLifecycleIntegrityReport'),
    'OpenAPI spec missing operationId getLifecycleIntegrityReport'
  );
  assert.ok(
    text.includes('LifecycleIntegrityReportResponse:'),
    'OpenAPI spec missing LifecycleIntegrityReportResponse schema'
  );
  assert.ok(
    text.includes('/api/agent-admin/lifecycle-reconciliation/dry-run:'),
    'OpenAPI spec missing lifecycle-reconciliation dry-run route path'
  );
  assert.ok(
    text.includes('operationId: getLifecycleReconciliationDryRun'),
    'OpenAPI spec missing operationId getLifecycleReconciliationDryRun'
  );
  assert.ok(
    text.includes('LifecycleReconciliationDryRunResponse:'),
    'OpenAPI spec missing LifecycleReconciliationDryRunResponse schema'
  );
  assert.ok(
    text.includes('/api/agent-admin/lifecycle-reconciliation/repair:'),
    'OpenAPI spec missing lifecycle-reconciliation repair route path'
  );
  assert.ok(
    text.includes('operationId: executeLifecycleReconciliationRepair'),
    'OpenAPI spec missing operationId executeLifecycleReconciliationRepair'
  );
  assert.ok(
    text.includes('LifecycleReconciliationRepairRequest:'),
    'OpenAPI spec missing LifecycleReconciliationRepairRequest schema'
  );
  assert.ok(
    text.includes('LifecycleReconciliationRepairResponse:'),
    'OpenAPI spec missing LifecycleReconciliationRepairResponse schema'
  );
  assert.ok(
    text.includes('/api/agent-admin/device-events/recent:'),
    'OpenAPI spec missing recent device events route path'
  );
  assert.ok(
    text.includes('operationId: listAgentRecentDeviceEvents'),
    'OpenAPI spec missing operationId listAgentRecentDeviceEvents'
  );
  assert.ok(
    text.includes('RecentDeviceEventsListResponse:'),
    'OpenAPI spec missing RecentDeviceEventsListResponse schema'
  );
  assert.ok(
    text.includes('RecentDeviceEventRow:'),
    'OpenAPI spec missing RecentDeviceEventRow schema'
  );

  assert.ok(
    text.includes('name: lifecycle_scope'),
    'OpenAPI spec missing lifecycle_scope query parameter for /api/devices'
  );
  assert.ok(
    text.includes('enum: [bridge_ops, ingest_only]'),
    'OpenAPI spec missing lifecycle_scope enum values'
  );

  assert.ok(
    text.includes('lifecycle_scope:'),
    'OpenAPI Device schema missing lifecycle_scope field'
  );
  assert.ok(
    text.includes('site_id:')
      && text.includes('site_key:')
      && text.includes('site_name:')
      && text.includes('site_status:'),
    'OpenAPI site context fields should be present on operational device/agent/readiness schemas'
  );
  assert.ok(
    text.includes('site_active_lease_id:')
      && text.includes('site_active_agent_id:')
      && text.includes('site_active_leased_at:')
      && text.includes('is_site_active_runtime:'),
    'OpenAPI agent schema should expose active site lease context fields'
  );
  assert.ok(
    text.includes('site_runtime_reporting_agent_id:')
      && text.includes('site_runtime_health_status:')
      && text.includes('site_runtime_health_reason:')
      && text.includes('site_runtime_reported_at:')
      && text.includes('site_runtime_last_heartbeat_at:')
      && text.includes('site_runtime_last_poll_at:')
      && text.includes('site_runtime_reported_stale:'),
    'OpenAPI agent schema should expose desired-vs-reported site runtime context fields'
  );
  assert.ok(
    text.includes('/api/agent-admin/agents/{agent_id}/runtime-identity:')
      && text.includes('/api/agent-admin/agents/{agent_id}/runtime-identity/reissue:')
      && text.includes('/api/agent-admin/agents/{agent_id}/runtime-identity/revoke:'),
    'OpenAPI spec missing agent runtime-identity routes'
  );
  assert.ok(
    text.includes('operationId: getAgentRuntimeIdentity')
      && text.includes('operationId: reissueAgentRuntimeIdentity')
      && text.includes('operationId: revokeAgentRuntimeIdentity'),
    'OpenAPI spec missing agent runtime-identity operationIds'
  );
  assert.ok(
    text.includes('AgentRuntimeIdentityRecord:')
      && text.includes('AgentRuntimeIdentityReadResponse:')
      && text.includes('AgentRuntimeIdentityReissueRequest:')
      && text.includes('AgentRuntimeIdentityReissueResponse:')
      && text.includes('AgentRuntimeIdentityRevokeRequest:')
      && text.includes('AgentRuntimeIdentityRevokeResponse:'),
    'OpenAPI spec missing agent runtime-identity schemas'
  );
  assert.ok(
    text.includes('identity_status:')
      && text.includes('active_runtime_identity_id:')
      && text.includes('runtime_identity_status:')
      && text.includes('runtime_identity_issued_at:')
      && text.includes('runtime_identity_revoked_at:'),
    'OpenAPI agent schema should expose runtime identity status fields'
  );
  assert.ok(
    text.includes('identity_status:'),
    'OpenAPI Device schema missing identity_status field'
  );
  assert.ok(
    text.includes('superseded_by_device_uid:'),
    'OpenAPI Device schema missing superseded_by_device_uid field'
  );
  assert.ok(
    text.includes('DeviceReportedStateReadModel:')
      && text.includes('reported_state:'),
    'OpenAPI onboarding readiness schema should expose device reported-state read model'
  );

  assert.ok(
    text.includes('device_managing_agent_binding_missing')
      && text.includes('device_managing_agent_binding_conflict')
      && text.includes('device_uid_superseded_without_canonical'),
    'OpenAPI queue conflict docs should include lifecycle coherence conflict error codes'
  );
  assert.ok(
    text.includes('superseded_without_canonical')
      && text.includes('managed_bridge_missing_active_binding')
      && text.includes('ingest_only_with_bridge_evidence_advisory'),
    'OpenAPI lifecycle integrity docs should include strict/advisory anomaly category labels'
  );
  assert.ok(
    text.includes('action_mode:')
      && text.includes('dry_run_only')
      && text.includes('strict_only:'),
    'OpenAPI dry-run reconciliation docs should include no-write/dry-run response markers'
  );

  console.log('openapi lifecycle coherence coverage tests passed');
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
