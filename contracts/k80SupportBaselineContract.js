const K80_SUPPORT_BASELINE_CONTRACT_VERSION = 'k80_support_baseline_contract_v1';

const K80_SUPPORT_CLASSIFICATION = Object.freeze({
  BASELINE_SUPPORTED: 'baseline_supported',
  CONDITIONAL: 'conditional',
  EXPERIMENTAL: 'experimental',
  OBSOLETE_SUPERSEDED: 'obsolete_superseded'
});

const K80_SUPPORT_BASELINE_CONTRACT = Object.freeze({
  contract_version: K80_SUPPORT_BASELINE_CONTRACT_VERSION,
  behavior_change: 'none',
  baseline_goal: 'classify_only_no_runtime_behavior_change',
  companion_contracts: Object.freeze([
    'contracts/k80FlagOwnershipContract.js'
  ]),
  categories: Object.freeze([
    Object.freeze({
      key: 'normal_pull_queue_and_ingest',
      classification: K80_SUPPORT_CLASSIFICATION.BASELINE_SUPPORTED,
      files: Object.freeze([
        'api/agentAdmin.routes.js',
        'services/agentDeviceEventsService.js',
        'agent/index.js',
        'api/agent.routes.js'
      ]),
      summary: 'Normal pull queue/poll/batch ingest to device_events is part of production baseline.'
    }),
    Object.freeze({
      key: 'phase1_post_punch_fact_anchor_guarantee',
      classification: K80_SUPPORT_CLASSIFICATION.BASELINE_SUPPORTED,
      files: Object.freeze([
        'services/agentDeviceEventsService.js'
      ]),
      summary: 'Post-punch trigger path for bounded auto-pull is baseline-supported.'
    }),
    Object.freeze({
      key: 'pull_direction_provenance_normalization',
      classification: K80_SUPPORT_CLASSIFICATION.BASELINE_SUPPORTED,
      files: Object.freeze([
        'services/agentDeviceEventsService.js'
      ]),
      summary: 'Pull-carried direction is explicitly persisted as non-authoritative evidence.'
    }),
    Object.freeze({
      key: 'derived_direction_attachment_creation',
      classification: K80_SUPPORT_CLASSIFICATION.BASELINE_SUPPORTED,
      files: Object.freeze([
        'services/historicalDirectionWorkerService.js',
        'services/agentDeviceEventsService.js',
        'migrations/20260410_derived_direction_attachments.sql'
      ]),
      summary: 'Derived attachment persistence and fresh fact trigger are baseline-supported.'
    }),
    Object.freeze({
      key: 'diagnostics_consumer_side_by_side_direction',
      classification: K80_SUPPORT_CLASSIFICATION.BASELINE_SUPPORTED,
      files: Object.freeze([
        'api/agentAdmin.routes.js',
        'services/agentDeviceEventsService.js'
      ]),
      summary: 'Operator diagnostics endpoint exposes legacy + derived direction side-by-side.'
    }),
    Object.freeze({
      key: 'realtime_rt_01f4_ingest',
      classification: K80_SUPPORT_CLASSIFICATION.CONDITIONAL,
      files: Object.freeze([
        'agent/lib/events/zktecoPullAdapter.js',
        'services/agentDeviceEventsService.js',
        'migrations/20260406_k80_rt_direction_observations.sql'
      ]),
      required_env: Object.freeze([
        'K80_RT_01F4_INGEST_ENABLED',
        'K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST'
      ]),
      summary: 'Realtime direction ingest is policy/allowlist gated and must be treated as conditional.'
    }),
    Object.freeze({
      key: 'history_drain_pull_mode',
      classification: K80_SUPPORT_CLASSIFICATION.CONDITIONAL,
      files: Object.freeze([
        'agent/lib/events/zktecoPullAdapter.js',
        'services/agentDeviceEventsService.js'
      ]),
      required_env: Object.freeze([
        'K80_HISTORY_DRAIN_MODE_ENABLED',
        'K80_HISTORY_DRAIN_MODE_DEVICE_UID_ALLOWLIST'
      ]),
      summary: 'History drain mode is conditional on explicit policy enablement and mode recognition.'
    }),
    Object.freeze({
      key: 'deep_k80_guarded_protocol_families',
      classification: K80_SUPPORT_CLASSIFICATION.EXPERIMENTAL,
      files: Object.freeze([
        'agent/lib/events/zktecoPullAdapter.js'
      ]),
      required_env: Object.freeze([
        'K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED',
        'K80_EXPERIMENTAL_PROTOCOL_FAMILIES_DEVICE_UID_ALLOWLIST',
        'K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ALLOWLIST'
      ]),
      summary: 'Deep guarded K80 continuation/recovery families remain experimental and are not baseline truth.'
    }),
    Object.freeze({
      key: 'legacy_simulation_run_surface',
      classification: K80_SUPPORT_CLASSIFICATION.OBSOLETE_SUPERSEDED,
      files: Object.freeze([
        'api/simulation.routes.js'
      ]),
      summary: 'Legacy /api/simulation/run is deprecated/bounded; modern simulation truth is /api/simulate/*.'
    }),
    Object.freeze({
      key: 'legacy_pull_direction_authority_assumption',
      classification: K80_SUPPORT_CLASSIFICATION.OBSOLETE_SUPERSEDED,
      files: Object.freeze([
        'services/agentDeviceEventsService.js'
      ]),
      summary: 'Treating pull-carried direction as automatically authoritative is superseded.'
    })
  ]),
  policy_guardrail: Object.freeze({
    no_silent_interpretation: true,
    note: 'Experimental and conditional categories must not be interpreted as always-on production truth.',
    experimental_boundary: 'K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED'
  })
});

function getK80SupportBaselineContract() {
  return K80_SUPPORT_BASELINE_CONTRACT;
}

module.exports = {
  K80_SUPPORT_BASELINE_CONTRACT_VERSION,
  K80_SUPPORT_CLASSIFICATION,
  K80_SUPPORT_BASELINE_CONTRACT,
  getK80SupportBaselineContract
};
