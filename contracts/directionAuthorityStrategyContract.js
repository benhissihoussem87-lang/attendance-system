const DIRECTION_AUTHORITY_STRATEGY_CONTRACT_VERSION = 'direction_authority_strategy_contract_v1';

const DIRECTION_AUTHORITY_SUPPORT_TIER = Object.freeze({
  SUPPORTED: 'supported',
  PARTIAL: 'partial',
  UNKNOWN: 'unknown'
});

const DIRECTION_AUTHORITY_STRATEGY = Object.freeze({
  LEGACY_FALLBACK_DEFAULT: 'legacy_fallback_default',
  ZK_K80_RT_PREFERRED_WHEN_ELIGIBLE: 'zk_k80_rt_preferred_when_eligible',
  UNKNOWN_VENDOR_DEFAULT: 'unknown_vendor_default'
});

const DIRECTION_AUTHORITY_STRATEGY_CONTRACT = Object.freeze({
  contract_version: DIRECTION_AUTHORITY_STRATEGY_CONTRACT_VERSION,
  behavior_change: 'none',
  purpose: 'device_profile_based_direction_authority_registry',
  guardrails: Object.freeze({
    do_not_mutate_device_events: true,
    do_not_flip_derived_decision_behavior_in_this_slice: true,
    do_not_interpret_rt_as_global_truth: true,
    do_not_drop_pull_as_evidence: true
  }),
  strategies: Object.freeze([
    Object.freeze({
      strategy_id: DIRECTION_AUTHORITY_STRATEGY.LEGACY_FALLBACK_DEFAULT,
      support_tier: DIRECTION_AUTHORITY_SUPPORT_TIER.SUPPORTED,
      intended_scope: 'global_safe_default_all_devices',
      precedence_concept: 'current_derived_logic_unchanged',
      fallback_concept: 'pull_status_map_fallback_when_rt_not_selected',
      non_goals: Object.freeze([
        'do_not_claim_pull_is_universal_truth',
        'do_not_claim_rt_is_universal_truth'
      ])
    }),
    Object.freeze({
      strategy_id: DIRECTION_AUTHORITY_STRATEGY.ZK_K80_RT_PREFERRED_WHEN_ELIGIBLE,
      support_tier: DIRECTION_AUTHORITY_SUPPORT_TIER.PARTIAL,
      intended_scope: 'zkteco_k80_profile_when_runtime_evidence_is_eligible',
      precedence_concept: 'rt_preferred_when_eligible_then_pull_fallback',
      fallback_concept: 'pull_fallback_with_explicit_conflict_provenance',
      non_goals: Object.freeze([
        'not_rt_only_global_truth',
        'not_active_behavior_in_this_slice'
      ])
    }),
    Object.freeze({
      strategy_id: DIRECTION_AUTHORITY_STRATEGY.UNKNOWN_VENDOR_DEFAULT,
      support_tier: DIRECTION_AUTHORITY_SUPPORT_TIER.UNKNOWN,
      intended_scope: 'unknown_or_unprofiled_devices',
      precedence_concept: 'unknown_safe_mode',
      fallback_concept: 'fallback_only_until_profile_support_is_proven',
      non_goals: Object.freeze([
        'do_not_apply_vendor_specific_authority_without_profile'
      ])
    })
  ]),
  default_strategy_id: DIRECTION_AUTHORITY_STRATEGY.LEGACY_FALLBACK_DEFAULT
});

function getDirectionAuthorityStrategyContract() {
  return DIRECTION_AUTHORITY_STRATEGY_CONTRACT;
}

module.exports = {
  DIRECTION_AUTHORITY_STRATEGY_CONTRACT_VERSION,
  DIRECTION_AUTHORITY_SUPPORT_TIER,
  DIRECTION_AUTHORITY_STRATEGY,
  DIRECTION_AUTHORITY_STRATEGY_CONTRACT,
  getDirectionAuthorityStrategyContract
};
