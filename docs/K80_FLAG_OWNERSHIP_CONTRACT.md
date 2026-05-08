# K80 Flag Hygiene + Ownership Contract (v1)

Status: `Confirmed`  
Contract version: `k80_flag_ownership_contract_v3`  
Behavior change: `none` (classification/ownership/runbook clarity only)

Machine-readable source of truth:
- `contracts/k80FlagOwnershipContract.js`

This contract defines explicit ownership and operational classification for active/significant `K80_*` runtime controls so production operation and cleanup do not depend on tribal knowledge.

## Classification Semantics
- `baseline`: part of supported production baseline behavior.
- `conditional`: production-safe but only valid under explicit policy/env + scope truth.
- `experimental`: not baseline truth; must not silently influence production interpretation.
- `obsolete_superseded`: retained legacy controls not part of current supported direction.
- `unclear`: present and impactful, but still requires bounded evidence before final reclassification/removal.

## Coverage Summary (Grouped Controls)
1. `rt_01f4_ingest` (`conditional`, cross-runtime owner)
- `K80_RT_01F4_INGEST_ENABLED`
- `K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST`
- `K80_RT_01F4_INGEST_MAX_EVENTS_PER_PULL`
- `K80_RT_01F4_REQUIRE_PERSON_PARSE`
- `K80_RT_01F4_RECONCILE_WINDOW_MS`

2. `phase1_post_punch_fact_anchor` (`baseline`, ingest owner)
- `K80_POST_PUNCH_PULL_GUARANTEE_ENABLED`
- `K80_POST_PUNCH_PULL_GUARANTEE_DEVICE_UID_ALLOWLIST`
- `K80_POST_PUNCH_PULL_GUARANTEE_LOOKBACK_MINUTES`
- `K80_POST_PUNCH_PULL_GUARANTEE_MAX_EVENTS`
- `K80_POST_PUNCH_PULL_GUARANTEE_MIN_INTERVAL_SECONDS`
- `K80_POST_PUNCH_PULL_GUARANTEE_SAFETY_WINDOW_MINUTES`

3. `history_drain` (`conditional`, cross-runtime owner)
- `K80_HISTORY_DRAIN_MODE_ENABLED`
- `K80_HISTORY_DRAIN_MODE_DEVICE_UID_ALLOWLIST`
- `K80_HISTORY_DRAIN_NO_PROGRESS_PAGES_LIMIT`
- `K80_HISTORY_DRAIN_DUPLICATE_REPLAY_PAGES_LIMIT`

4. `experimental_master_boundary` (`experimental`, adapter owner)
- `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED`
- `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_DEVICE_UID_ALLOWLIST`
- `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ALLOWLIST`

5. `experimental_deep_protocol_families` (`experimental`, adapter owner)
- Includes deep 07d0/05e0/followup/recovery/pre-retrieval/premode/multipage/app-parity family controls.

6. `rt_subscriber_runtime` (`conditional`, adapter owner)
- `K80_RT_SUBSCRIBER_*` control family.

7. `legacy_direction_authority_pilots` (`obsolete_superseded`, adapter owner)
- `K80_DIRECTION_ENRICHMENT_*`
- `K80_DIRECTION_AUTHORITATIVE_*`

8. `queue_cursor_source_fix_family` (`unclear`, ingest owner)
- `K80_REQUESTED_SINCE_SOURCE_FIX_*`
- `K80_QUEUE_TIME_CURSOR_BYPASS_*`

9. `cursor_source_fix` (`conditional`, ingest owner)
- `K80_CURSOR_SOURCE_FIX_*`
- parity-coupled prerequisite: requires protocol diagnostics signal `zktime_dynamic_05e0_payload_app_parity_family_reached=true`
- operational interpretation: not part of the current supported synchronized baseline chain; do not treat as always-on baseline behavior.

10. `queue_bypass_state_snapshot` (`obsolete_superseded`, ingest owner)
- `K80_QUEUE_BYPASS_STATE_SNAPSHOT_*`
- Deprecated diagnostics-only payload snapshot control; not part of supported baseline interpretation.

11. `lab_diagnostics_controls` (`experimental`, adapter owner)
- `K80_PRENORMALIZATION_DUMP_*`
- `K80_NORMALIZATION_REASON_DIAGNOSTICS_*`
- `K80_NEWEST_FIRST_EMIT_*`
- `K80_RELAX_REQUESTED_SINCE_*`

12. `legacy_second_ledger_read_controls` (`obsolete_superseded`, ops runtime owner)
- `K80_SECOND_LEDGER_READ_*`

## Operational Guardrails
- Do not treat `conditional`/`experimental` controls as always-on production truth.
- Do not enable experimental deep protocol branches without explicit master experimental boundary enablement.
- Do not perform cleanup deletion from this contract alone; isolate/reclassify with evidence slices first.

## Alignment
- Baseline support freeze: `contracts/k80SupportBaselineContract.js`
- Baseline contract doc: `docs/K80_SUPPORT_BASELINE_CONTRACT.md`
- Durable memory/decisions: `docs/CODEX_PROJECT_MEMORY.md`
