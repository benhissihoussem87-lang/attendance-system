const K80_FLAG_OWNERSHIP_CONTRACT_VERSION = 'k80_flag_ownership_contract_v3';

const K80_FLAG_CLASSIFICATION = Object.freeze({
  BASELINE: 'baseline',
  CONDITIONAL: 'conditional',
  EXPERIMENTAL: 'experimental',
  OBSOLETE_SUPERSEDED: 'obsolete_superseded',
  UNCLEAR: 'unclear'
});

const K80_FLAG_OWNERSHIP_CONTRACT = Object.freeze({
  contract_version: K80_FLAG_OWNERSHIP_CONTRACT_VERSION,
  behavior_change: 'none',
  purpose: 'k80_flag_hygiene_ownership_scope_contract',
  owner_subsystems: Object.freeze({
    ADAPTER: 'agent:zktecoPullAdapter',
    INGEST: 'saas:agentDeviceEventsService',
    CROSS_RUNTIME: 'cross_runtime:adapter_and_ingest',
    OPS_RUNTIME: 'ops_runtime:launch_config'
  }),
  runbook_refs: Object.freeze([
    'docs/K80_SUPPORT_BASELINE_CONTRACT.md',
    'docs/BRIDGE_OPERATIONS_RUNBOOK.md',
    'docs/CODEX_PROJECT_MEMORY.md'
  ]),
  controls: Object.freeze([
    Object.freeze({
      control_id: 'rt_01f4_ingest',
      env_names: Object.freeze([
        'K80_RT_01F4_INGEST_ENABLED',
        'K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST',
        'K80_RT_01F4_INGEST_MAX_EVENTS_PER_PULL',
        'K80_RT_01F4_REQUIRE_PERSON_PARSE',
        'K80_RT_01F4_RECONCILE_WINDOW_MS'
      ]),
      functional_area: 'realtime_direction_ingest',
      classification: K80_FLAG_CLASSIFICATION.CONDITIONAL,
      owner_subsystem: 'cross_runtime:adapter_and_ingest',
      affects_production_baseline_directly: true,
      safe_for_normal_production_use: true,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze([
        'agent/lib/events/zktecoPullAdapter.js',
        'services/agentDeviceEventsService.js',
        'contracts/k80SupportBaselineContract.js'
      ]),
      future_cleanup_hint: 'keep_conditional'
    }),
    Object.freeze({
      control_id: 'phase1_post_punch_fact_anchor',
      env_names: Object.freeze([
        'K80_POST_PUNCH_PULL_GUARANTEE_ENABLED',
        'K80_POST_PUNCH_PULL_GUARANTEE_DEVICE_UID_ALLOWLIST',
        'K80_POST_PUNCH_PULL_GUARANTEE_LOOKBACK_MINUTES',
        'K80_POST_PUNCH_PULL_GUARANTEE_MAX_EVENTS',
        'K80_POST_PUNCH_PULL_GUARANTEE_MIN_INTERVAL_SECONDS',
        'K80_POST_PUNCH_PULL_GUARANTEE_SAFETY_WINDOW_MINUTES'
      ]),
      functional_area: 'post_punch_fact_anchor_guarantee',
      classification: K80_FLAG_CLASSIFICATION.BASELINE,
      owner_subsystem: 'saas:agentDeviceEventsService',
      affects_production_baseline_directly: true,
      safe_for_normal_production_use: true,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze(['services/agentDeviceEventsService.js']),
      future_cleanup_hint: 'keep_baseline'
    }),
    Object.freeze({
      control_id: 'history_drain',
      env_names: Object.freeze([
        'K80_HISTORY_DRAIN_MODE_ENABLED',
        'K80_HISTORY_DRAIN_MODE_DEVICE_UID_ALLOWLIST',
        'K80_HISTORY_DRAIN_NO_PROGRESS_PAGES_LIMIT',
        'K80_HISTORY_DRAIN_DUPLICATE_REPLAY_PAGES_LIMIT'
      ]),
      functional_area: 'history_pull_mode',
      classification: K80_FLAG_CLASSIFICATION.CONDITIONAL,
      owner_subsystem: 'cross_runtime:adapter_and_ingest',
      affects_production_baseline_directly: true,
      safe_for_normal_production_use: true,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze([
        'agent/lib/events/zktecoPullAdapter.js',
        'services/agentDeviceEventsService.js',
        'contracts/k80SupportBaselineContract.js'
      ]),
      future_cleanup_hint: 'keep_conditional'
    }),
    Object.freeze({
      control_id: 'experimental_master_boundary',
      env_names: Object.freeze([
        'K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED',
        'K80_EXPERIMENTAL_PROTOCOL_FAMILIES_DEVICE_UID_ALLOWLIST',
        'K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ALLOWLIST'
      ]),
      functional_area: 'experimental_protocol_isolation',
      classification: K80_FLAG_CLASSIFICATION.EXPERIMENTAL,
      owner_subsystem: 'agent:zktecoPullAdapter',
      affects_production_baseline_directly: false,
      safe_for_normal_production_use: false,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze([
        'agent/lib/events/zktecoPullAdapter.js',
        'contracts/k80SupportBaselineContract.js',
        'docs/K80_SUPPORT_BASELINE_CONTRACT.md'
      ]),
      future_cleanup_hint: 'keep_for_isolation'
    }),
    Object.freeze({
      control_id: 'experimental_deep_protocol_families',
      env_names: Object.freeze([
        'K80_ATTLOG_07D0_FOLLOWUP_ENABLED',
        'K80_ATTLOG_07D0_DEVICE_UID_ALLOWLIST',
        'K80_ATTLOG_07D0_FOLLOWUP_PAYLOAD_HEX',
        'K80_DYNAMIC_05E0_PAYLOAD_ENABLED',
        'K80_DYNAMIC_05E0_PAYLOAD_DEVICE_UID_ALLOWLIST',
        'K80_PULL_REQUEST_07D0_CONTINUE_ENABLED',
        'K80_PULL_REQUEST_07D0_CONTINUE_DEVICE_UID_ALLOWLIST',
        'K80_LEDGER_REFRESH_ENABLED',
        'K80_LEDGER_REFRESH_DEVICE_UID_ALLOWLIST',
        'K80_LEDGER_REFRESH_MAX_CYCLES',
        'K80_LEDGER_REFRESH_INTERVAL_MS',
        'K80_FREE_DATA_STEP_ENABLED',
        'K80_FREE_DATA_DEVICE_UID_ALLOWLIST',
        'K80_SESSION_CONTEXT_HOLD_ENABLED',
        'K80_SESSION_CONTEXT_HOLD_DEVICE_UID_ALLOWLIST',
        'K80_SESSION_CONTEXT_HOLD_POLL_MS',
        'K80_SESSION_CONTEXT_HOLD_WINDOW_MS',
        'K80_RT_SUBSCRIBE_STEP_ENABLED',
        'K80_RT_SUBSCRIBE_DEVICE_UID_ALLOWLIST',
        'K80_STARTUP_NEGOTIATION_ENABLED',
        'K80_STARTUP_NEGOTIATION_DEVICE_UID_ALLOWLIST',
        'K80_STARTUP_NEGOTIATION_PAYLOAD_HEX',
        'K80_PREMODE_044C_ENABLED',
        'K80_PREMODE_044C_DEVICE_UID_ALLOWLIST',
        'K80_PREATTLOG_MODE_ENTRY_ENABLED',
        'K80_PREATTLOG_MODE_ENTRY_DEVICE_UID_ALLOWLIST',
        'K80_PREMODE_2710_SPECIAL_HANDLING_ENABLED',
        'K80_PREMODE_2710_SPECIAL_HANDLING_DEVICE_UID_ALLOWLIST',
        'K80_PRE_ATTLOG_ENABLE_BOUNDARY_ENABLED',
        'K80_PRE_ATTLOG_ENABLE_BOUNDARY_DEVICE_UID_ALLOWLIST',
        'K80_PRE_SIZE_SELECTOR_AB_ENABLED',
        'K80_PRE_SIZE_SELECTOR_AB_DEVICE_UID_ALLOWLIST',
        'K80_PRE_SIZE_SELECTOR_B_PAYLOAD_HEX',
        'K80_MULTIPAGE_ATTLOG_ENABLED',
        'K80_MULTIPAGE_ATTLOG_DEVICE_UID_ALLOWLIST',
        'K80_MULTIPAGE_ATTLOG_MAX_PAGES',
        'K80_APP_PARITY_RESTART_ENABLED',
        'K80_APP_PARITY_RESTART_DEVICE_UID_ALLOWLIST',
        'K80_PRE_RETRIEVAL_SUBFAMILY_ENABLED',
        'K80_PRE_RETRIEVAL_SUBFAMILY_DEVICE_UID_ALLOWLIST',
        'K80_PRE_RETRIEVAL_SUBFAMILY_MAX_0032_POLLS',
        'K80_PRE_RETRIEVAL_SUBFAMILY_POLL_INTERVAL_MS'
      ]),
      functional_area: 'deep_protocol_continuation_fallback_recovery',
      classification: K80_FLAG_CLASSIFICATION.EXPERIMENTAL,
      owner_subsystem: 'agent:zktecoPullAdapter',
      affects_production_baseline_directly: false,
      safe_for_normal_production_use: false,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze(['agent/lib/events/zktecoPullAdapter.js']),
      future_cleanup_hint: 'isolate_then_review_remove'
    }),
    Object.freeze({
      control_id: 'rt_subscriber_runtime',
      env_names: Object.freeze([
        'K80_RT_SUBSCRIBER_ENABLED',
        'K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST',
        'K80_RT_SUBSCRIBER_HOST',
        'K80_RT_SUBSCRIBER_PORT',
        'K80_RT_SUBSCRIBER_AUTH_PASSWORD',
        'K80_RT_SUBSCRIBER_SESSION_WINDOW_MS',
        'K80_RT_SUBSCRIBER_RECONNECT_DELAY_MS',
        'K80_RT_SUBSCRIBER_FLUSH_INTERVAL_MS',
        'K80_RT_SUBSCRIBER_MAX_EVENTS_PER_FLUSH'
      ]),
      functional_area: 'runtime_realtime_subscriber',
      classification: K80_FLAG_CLASSIFICATION.CONDITIONAL,
      owner_subsystem: 'agent:zktecoPullAdapter',
      affects_production_baseline_directly: false,
      safe_for_normal_production_use: true,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze([
        'agent/lib/events/zktecoPullAdapter.js',
        'agent/index.js'
      ]),
      future_cleanup_hint: 'keep_conditional'
    }),
    Object.freeze({
      control_id: 'legacy_direction_authority_pilots',
      env_names: Object.freeze([
        'K80_DIRECTION_ENRICHMENT_ENABLED',
        'K80_DIRECTION_ENRICHMENT_DEVICE_UID_ALLOWLIST',
        'K80_DIRECTION_ENRICHMENT_MATCH_WINDOW_MS',
        'K80_DIRECTION_AUTHORITATIVE_ENABLED',
        'K80_DIRECTION_AUTHORITATIVE_DEVICE_UID_ALLOWLIST'
      ]),
      functional_area: 'legacy_direction_semantics_pilot',
      classification: K80_FLAG_CLASSIFICATION.OBSOLETE_SUPERSEDED,
      owner_subsystem: 'agent:zktecoPullAdapter',
      affects_production_baseline_directly: false,
      safe_for_normal_production_use: false,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze([
        'agent/lib/events/zktecoPullAdapter.js',
        'docs/CODEX_PROJECT_MEMORY.md'
      ]),
      future_cleanup_hint: 'candidate_remove_later'
    }),
    Object.freeze({
      control_id: 'queue_cursor_source_fix_family',
      env_names: Object.freeze([
        'K80_REQUESTED_SINCE_SOURCE_FIX_ENABLED',
        'K80_REQUESTED_SINCE_SOURCE_FIX_DEVICE_UID_ALLOWLIST',
        'K80_REQUESTED_SINCE_SOURCE_FIX_BACKFILL_MINUTES',
        'K80_QUEUE_TIME_CURSOR_BYPASS_ENABLED',
        'K80_QUEUE_TIME_CURSOR_BYPASS_DEVICE_UID_ALLOWLIST',
        'K80_QUEUE_TIME_CURSOR_BYPASS_BACKFILL_MINUTES'
      ]),
      functional_area: 'queue_cursor_requested_since_fixes',
      classification: K80_FLAG_CLASSIFICATION.UNCLEAR,
      owner_subsystem: 'saas:agentDeviceEventsService',
      affects_production_baseline_directly: true,
      safe_for_normal_production_use: true,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze(['services/agentDeviceEventsService.js']),
      future_cleanup_hint: 'needs_evidence_then_reclassify'
    }),
    Object.freeze({
      control_id: 'cursor_source_fix',
      env_names: Object.freeze([
        'K80_CURSOR_SOURCE_FIX_ENABLED',
        'K80_CURSOR_SOURCE_FIX_DEVICE_UID_ALLOWLIST'
      ]),
      functional_area: 'queue_cursor_requested_since_fixes',
      classification: K80_FLAG_CLASSIFICATION.CONDITIONAL,
      owner_subsystem: 'saas:agentDeviceEventsService',
      affects_production_baseline_directly: false,
      safe_for_normal_production_use: true,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze([
        'services/agentDeviceEventsService.js',
        'agent/lib/events/zktecoPullAdapter.js',
        'docs/CODEX_PROJECT_MEMORY.md'
      ]),
      operational_note: 'parity_coupled_requires_protocol_diagnostics.zktime_dynamic_05e0_payload_app_parity_family_reached_true',
      baseline_support_note: 'not_part_of_current_supported_synchronized_baseline_chain',
      future_cleanup_hint: 'keep_conditional_not_ready_for_removal'
    }),
    Object.freeze({
      control_id: 'queue_bypass_state_snapshot',
      env_names: Object.freeze([
        'K80_QUEUE_BYPASS_STATE_SNAPSHOT_ENABLED',
        'K80_QUEUE_BYPASS_STATE_SNAPSHOT_DEVICE_UID_ALLOWLIST'
      ]),
      functional_area: 'queue_bypass_diagnostics_snapshot',
      classification: K80_FLAG_CLASSIFICATION.OBSOLETE_SUPERSEDED,
      owner_subsystem: 'saas:agentDeviceEventsService',
      affects_production_baseline_directly: false,
      safe_for_normal_production_use: false,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze(['services/agentDeviceEventsService.js']),
      future_cleanup_hint: 'deprecate_then_remove_when_safe'
    }),
    Object.freeze({
      control_id: 'lab_diagnostics_controls',
      env_names: Object.freeze([
        'K80_PRENORMALIZATION_DUMP_ENABLED',
        'K80_PRENORMALIZATION_DUMP_DEVICE_UID_ALLOWLIST',
        'K80_PRENORMALIZATION_DUMP_MAX_ROWS',
        'K80_NORMALIZATION_REASON_DIAGNOSTICS_ENABLED',
        'K80_NORMALIZATION_REASON_DIAGNOSTICS_DEVICE_UID_ALLOWLIST',
        'K80_NORMALIZATION_REASON_DIAGNOSTICS_MAX_ROWS',
        'K80_NEWEST_FIRST_EMIT_ENABLED',
        'K80_NEWEST_FIRST_EMIT_DEVICE_UID_ALLOWLIST',
        'K80_RELAX_REQUESTED_SINCE_ENABLED',
        'K80_RELAX_REQUESTED_SINCE_DEVICE_UID_ALLOWLIST',
        'K80_RELAX_REQUESTED_SINCE_BACKFILL_MINUTES'
      ]),
      functional_area: 'lab_debug_tuning',
      classification: K80_FLAG_CLASSIFICATION.EXPERIMENTAL,
      owner_subsystem: 'agent:zktecoPullAdapter',
      affects_production_baseline_directly: false,
      safe_for_normal_production_use: false,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze(['agent/lib/events/zktecoPullAdapter.js']),
      future_cleanup_hint: 'isolate_then_review_remove'
    }),
    Object.freeze({
      control_id: 'legacy_second_ledger_read_controls',
      env_names: Object.freeze([
        'K80_SECOND_LEDGER_READ_ENABLED',
        'K80_SECOND_LEDGER_READ_DEVICE_UID_ALLOWLIST',
        'K80_SECOND_LEDGER_READ_DELAY_MS'
      ]),
      functional_area: 'legacy_probe_only_controls',
      classification: K80_FLAG_CLASSIFICATION.OBSOLETE_SUPERSEDED,
      owner_subsystem: 'ops_runtime:launch_config',
      affects_production_baseline_directly: false,
      safe_for_normal_production_use: false,
      requires_allowlist_scope: true,
      evidence_refs: Object.freeze(['docs/CODEX_PROJECT_MEMORY.md']),
      future_cleanup_hint: 'remove_when_confirmed_unused'
    })
  ]),
  audit_guardrails: Object.freeze({
    do_not_change_runtime_behavior_in_this_contract_slice: true,
    do_not_enable_experimental_controls_without_master_boundary: true,
    do_not_interpret_conditional_controls_as_always_on: true
  })
});

function getK80FlagOwnershipContract() {
  return K80_FLAG_OWNERSHIP_CONTRACT;
}

module.exports = {
  K80_FLAG_OWNERSHIP_CONTRACT_VERSION,
  K80_FLAG_CLASSIFICATION,
  K80_FLAG_OWNERSHIP_CONTRACT,
  getK80FlagOwnershipContract
};
