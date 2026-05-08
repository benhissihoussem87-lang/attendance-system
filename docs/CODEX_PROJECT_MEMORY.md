# 1. Purpose
This file is the durable project memory for Codex operations in this repository.

It exists to reduce repeated mistakes and preserve continuity across sessions by recording:
- architecture direction,
- confirmed implementation state,
- fragile/partial areas,
- recurring errors and resolutions,
- roadmap priorities,
- real-device field realities.

This file is operational, not aspirational. Keep it grounded in repository evidence.

# 2. How Codex Must Use This File
- Read this file before any substantive planning, review, or implementation.
- Treat repository code/tests/docs as the source of truth; update this memory when truth changes.
- Update this file when:
  - a significant decision is made,
  - a recurring error pattern is discovered,
  - a known error is confirmed resolved,
  - roadmap phases/priorities materially change.
- Do not rewrite history aggressively. Prefer additive updates, status changes, and dated notes.
- Keep entries concise and evidence-based.
- Mark items as:
  - `Confirmed`: directly supported by repository evidence.
  - `Inferred`: likely, but not fully confirmed.
  - `Open`: unresolved question or future work.

# 3. Current Product Identity
- Attendance System SaaS with cloud/server-hosted backend.
- SaaS must provide a real operator-facing product UI; it is not only a backend for test consoles.
- Customer biometric devices live inside private LANs.
- Local Agent is the default SaaS-to-LAN bridge.
- SaaS UI is the primary control plane for onboarding, readiness, and operations.
- SaaS control plane is the authoritative source for device inventory, desired configuration, managing-agent bindings, command ledger, lifecycle audit/history, and rollout/version policy.
- Local Agent is the site runtime/execution plane: it executes LAN operations and reports local/runtime truth, but it is not the authoritative source of control-plane intent.
- `/boss` is an evolving real operations surface and should be improved incrementally, not discarded blindly.
- A future Local Agent UI (if introduced) is secondary local diagnostics/support, not a competing primary dashboard.
- Discovery is a means, not final product value.
- Discovery is useful but not guaranteed to be sufficient for trustworthy onboarding on all real devices/firmware paths.
- Manual per-device onboarding (operator-provided connection metadata) plus agent-side validation is now an expected first-class operational path.
- Site model remains one Local Agent per site/network, and one site agent can manage multiple devices in that same LAN/site.
- Site is now an explicit architecture priority and must become a first-class SaaS operating entity (current normalized model is still partial).
- Architecture direction must keep desired state, reported state, historical ledger, and unknown/live state (when runtime is offline) explicitly separated.
- Core product value is:
  - device/fingerprint event capture,
  - reliable ingestion into `device_events`,
  - attendance computation from those facts.
- Attendance outputs are derived and recomputable; raw event facts are the long-term source of truth.

# 4. Non-Negotiable Invariants
- Local Agent is a first-class product component.
- Site is a first-class concept in the operating model (not a forever-inferred label).
- One site has one active Local Agent via explicit lease/ownership semantics.
- One site agent may manage multiple devices in that same site/network.
- SaaS authoritative control-plane truth and Local Agent reported/runtime truth must remain explicitly separated.
- Raw device events are immutable operational facts.
- Attendance outputs are derived/recomputable projections.
- Additive evolution only; avoid destructive rewrites.
- Strict tenant/company scoping is mandatory.
- Stable device identity (serial/mac/device UID) is more important than IP.
- Discovery is not final success; ingestion reliability is the success criterion.
- Never claim a discovered device is manageable without protocol evidence.
- Do not default to storing biometric templates in cloud SaaS.
- ZKTeco-first integration path before multi-vendor expansion.
- Reliability and correctness before feature flash.
- Maintainability for 10+ years is a core engineering goal.
- Local Agent runtime defaults: Windows/Windows Server => Windows Service, Linux => systemd service, Docker => optional/advanced only.

# 5. Current Architecture Snapshot
- **SaaS backend**: Node/Express API + Postgres persistence.
- **SaaS operator UI/control plane**:
  - `/boss` currently hosts real lifecycle/operations workflows and is the active foundation for product UI evolution,
  - UI evolution is additive and must preserve working lifecycle/backend truths.
- **Local Agent**:
  - primary deployment model is one agent per site/network,
  - one site agent may manage multiple biometric devices within that site LAN,
  - bootstraps with provisioning token,
  - receives bearer credential,
  - sends heartbeat,
  - polls queued commands.
- **Manual onboarding flow (first-class)**:
  - operator provides per-device connection metadata (vendor/provider, host/IP, port, auth/comm key, machine/device number, transport, protocol/profile/attlog sequence, optional model/firmware/label/notes),
  - SaaS persists onboarding intent and routes validation through Local Agent.
- **Discovery flow**:
  - admin queues subnet scan,
  - agent probes LAN (ZKTeco-oriented),
  - SaaS ingests discovery report with confidence/failure metadata.
  - discovery remains helper/optional evidence, not exclusive onboarding truth.
- **Claim flow**:
  - discovered devices enter candidate state,
  - admin claim transitions candidate to managed.
- **Validation gate**:
  - device is operational/actionable only after successful agent-side validation/pull evidence.
- **Ingestion flow**:
  - admin queues `PULL_DEVICE_EVENTS`,
  - agent pulls from device over LAN,
  - batch submit to SaaS,
  - SaaS dedups, updates cursor/sync state, stores facts in `device_events`.
- **Attendance flow**:
  - attendance computed from `device_events`,
  - cache/projection invalidated on new events.
- **Direction handling working principle (design direction, not fully implemented)**:
  - treat `device_events`/date-events pull as the event-fact lane (event occurrence/time/person/device),
  - treat realtime and historical direction outputs as direction-evidence lanes,
  - direction from pull facts is not automatically authoritative direction truth,
  - direction should be attached to fact events later in an explicit linking/derivation layer.
- **Runtime-validation interpretation note (Confirmed 2026-04-13)**:
  - synchronized live validation must only be judged after runtime/process policy truth is confirmed in the same serving process,
  - pipeline failures observed while realtime policy is OFF are runtime-config invalidations, not evidence that the trigger/fact/attachment pipeline is broken.

# 6. What Is Confirmed Implemented
- `Confirmed`: Agent provisioning/bootstrap/auth foundation exists.
- `Confirmed`: Agent heartbeat endpoint and persistence exist.
- `Confirmed`: Agent command polling exists (`commands/next`).
- `Confirmed`: Discovery report ingestion pipeline exists.
- `Confirmed`: Candidate device listing + claim workflow exists.
- `Confirmed`: ZKTeco discovery probing with confidence/failure taxonomy exists.
- `Confirmed`: Pull command queue + agent batch ingestion endpoint exists.
- `Confirmed`: Dedup/cursor/safety-window model exists.
- `Confirmed`: Disk-backed event batch buffer/retry path exists in agent runtime.
- `Confirmed`: Architecture Phase 5 hardening slice now adds deterministic delivery idempotency (`agent_device_event_batches.delivery_id` unique per company/agent) so replayed offline/reconnect submissions can return prior accepted truth instead of creating ambiguous duplicate batch ledger rows.
- `Confirmed`: Agent local event batch buffer now persists retry-attempt metadata (`delivery_attempt_count`, `last_attempt_*`, `next_retry_at`) with bounded backoff scheduling, reducing ghost retry ambiguity across restart/reconnect windows.
- `Confirmed`: Attendance recomputation reads from stored facts (`device_events`).
- `Confirmed`: OpenAPI route coverage and bridge contract tests exist and are wired in test harness.
- `Confirmed`: Device manageability/remediation axis is now explicit on `devices` (system manageability + manual remediation overlay fields).
- `Confirmed`: Discovery outcomes and pull batch outcomes now deterministically map to manageability state/reason.
- `Confirmed`: Pull failure -> blocked and successful retry -> ingesting transition is contract-tested in runtime mode.
- `Confirmed`: Operator remediation action endpoint exists (`PUT /api/agent-admin/devices/{device_uid}/remediation`) with tenant/auth/role enforcement.
- `Confirmed`: Minimum viable command lifecycle reconciler exists for agent commands (queued expiry + stale sent timeout transitions with deterministic `failure_reason`/`result_payload`).
- `Confirmed`: In-flight dedupe guard exists for `PULL_DEVICE_EVENTS` per `(company_id, agent_id, device_uid, command_type)` for `queued`/`sent`.
- `Confirmed`: Pull sync state now moves to `syncing` on actual command send (agent poll), not at queue time.
- `Confirmed`: Operator lifecycle visibility endpoint exists (`GET /api/agent-admin/commands`) with tenant-scoped filters and lifecycle fields.
- `Confirmed`: Operator agent visibility endpoint exists (`GET /api/agent-admin/agents`) with tenant-scoped filters (`company_id`, `status`, `seen_since`) and operational field-shape enforcement.
- `Confirmed`: Operator batch diagnostics endpoint exists (`GET /api/agent-admin/device-event-batches`) with tenant-scoped filters and bounded rejection-sample diagnostics.
- `Confirmed`: `/api/devices` supports operational filters (`managed_status`, `manageability_status`, `remediation_manual_status`) for onboarding/remediation triage.
- `Confirmed`: Operational console is now consolidated in `/boss` with a clean tabbed bridge-ops workflow (Overview, Agents, Devices, Commands, Sync & Batches) using existing Phase 5 read endpoints.
- `Confirmed`: `/boss` Devices tab now defaults operational filtering to `lifecycle_scope='bridge_ops'`, preserves explicit diagnostic scope access (`all`, `ingest_only`), and gates primary device action by lifecycle state (`candidate` -> claim action, `managed` -> queue action when eligible) with explicit unavailability reasons.
- `Confirmed`: Queue command eligibility now enforces active managing-agent binding with deterministic lifecycle errors (`device_managing_agent_binding_missing`, `device_managing_agent_binding_conflict`, `device_uid_superseded_without_canonical`); ingest canonicalization remains additive and does not hard-fail on binding in this phase.
- `Confirmed`: `/mvp` is now a redirect handoff to `/boss` to avoid competing operator dashboards.
- `Confirmed`: Day-2 Bridge Ops runbook exists (`docs/BRIDGE_OPERATIONS_RUNBOOK.md`) and is linked from bridge foundation docs.
- `Confirmed`: Read-only lifecycle integrity guardrail report exists (`scripts/db/lifecycle-coherence-integrity-report.sql`) with runbook procedure for migration/status drift checks before lifecycle cleanup actions.
- `Confirmed`: Read-only lifecycle integrity API surface exists (`GET /api/agent-admin/lifecycle-integrity`) with company-scoped strict/advisory anomaly counts and optional bounded detail payloads for diagnostics.
- `Confirmed`: Read-only lifecycle reconciliation dry-run API exists (`GET /api/agent-admin/lifecycle-reconciliation/dry-run`) that proposes candidate repairs for strict anomalies with explicit confidence/safety labels and no default writes.
- `Confirmed`: Runtime `device_events` currently has dual dedup surfaces (`device_events_dedup_company_uk` + partial unique `device_events_dedup_key_company_uk`) plus `device_events_pkey`; JSON/CSV/agent insert paths intentionally use `ON CONFLICT DO NOTHING`.
- `Confirmed`: This conflict strategy is safe under the current schema only; any new unique constraint/index added on `device_events` requires explicit re-review of insert conflict handling.
- `Confirmed`: Real-device validation is now a confirmed K80 Pro case study (ZKTeco K80 Pro, `ZLM60_TFT`, firmware `8.0.4.1-20190803`, IP `192.168.22.201`, port `4370`, communication key `1234`, device number `1`).
- `Confirmed`: For this K80 Pro path, in-project probe now reproduces successful post-auth retrieval sequence: `DeviceID` -> `0x0bb6` status probe -> `0x03eb` (`10270000`) -> `0x0032` -> `0x05df` (corrected 11-byte payload `010d000000000000000000`) -> direct `0x05dd` payload response.
- `Confirmed`: Successful K80 pull response now yields real payload (`0x05dd`, 444 bytes in validation run); the decisive blocker was `0x05df` payload-shape parity, not network/auth/session discovery.
- `Confirmed`: Decoder path now includes a dedicated attendance parser (`agent/lib/parsers/zktecoAttendanceParser.js`) that scores candidate record sizes (`16/24/32/40`), probes payload-header offsets, enforces timestamp sanity (`2000-01-01` to `2035-01-01`), and emits malformed-record diagnostics.
- `Confirmed` (fixed-clock replay pass, 2026-03-24): live K80 pull probe (`scripts/agent/pull-events-probe.js`) produced 19 decoded events with latest timestamp `2026-03-24T10:04:53Z`; ingest via `/api/agent/device-events/batch` accepted the replay batch (`inserted_count=8`, `deduped_count=11`) and persisted new `2026-03-24` events for `zkteco:sn:BIND-QUEUE-c26a7486`.
- `Confirmed` (fixed-clock replay pass, 2026-03-24): trusted surfaces stayed consistent on the replayed day for `person_id=3` and `date=2026-03-24` (`/api/attendance`, `/api/simulate/day`, `/api/simulate/range` all returned `status=INVALID`, `reason_code=FIRST_EVENT_OUT`, `late_minutes=0`, same flags/effective status); no cross-surface explainability drift was observed in this run.
- `Confirmed` (K80 direction-semantics capture, 2026-03-24): in a real TCP `4370` pull-ledger session (`0x05df -> 0x05dd`) around fresh `11:50` punches, decoded ledger records for those punches carried `status_code=1`; under current `defaultStatusMap`, this persisted as direction `OUT`.
- `Confirmed` (K80 direction-semantics capture, 2026-03-24): the same capture window contained separate `0x01f4` frames near those punches with a changing state byte sequence (`00`, `01`, `04`, `05`) not currently preserved by the pull-ledger ingestion path.
- `Confirmed` (K80 current accepted ingestion truth, 2026-03-24): K80 attendance ingestion currently accepts fresh punches through the pull-ledger path (`0x05df -> 0x05dd`) and parser/adapter decode, then persists direction via pull-centric parsed status mapping (`defaultStatusMap`), not from a richer real-time semantic source.
- `Confirmed` (K80 current direction derivation, 2026-03-24): current effective status-direction mapping is `0->IN`, `1->OUT`, `2->IN`, `3->OUT`, `4->IN`, `5->OUT`; therefore fresh pulled rows decoded as `status_code=1` persist as `OUT`.
- `Confirmed` (K80 authoritative direction pilot slice, 2026-03-25): pull normalization now supports a narrowly gated K80-only authoritative override (`K80_DIRECTION_AUTHORITATIVE_ENABLED` + required device allowlist) at post-parse/pre-persist decision point; override applies only when enriched `k80_rt_state_code` maps to `IN/OUT` and correlation confidence is `provisional_high`, otherwise deterministic legacy fallback remains in place.
- `Confirmed` (implementation note, 2026-04-06): schema + ingest path for `agent_realtime` now exists for K80 realtime direction observations (`device_realtime_direction_observations`) and was validated as safe no-op when no `0x01f4` observations are present; write path remains unproven without RT frames. Pull-fact `device_events` remain immutable and no reconciliation/override is performed in this slice.
- `Confirmed` (validation note, 2026-04-08): K80 separate realtime-direction channel is operational end-to-end under enabled server realtime ingest policy and device allowlist. Live-punch rerun (`command_id=32ebe2a3-adde-4753-9533-9c2a0d9be4c1`) produced pull batch `78f758ec-fb8a-4562-bab7-f63227fcf7bb` and realtime batch `e6b13431-a508-4019-a07d-5a80b09f0f27` with `session_rt01f4_frames_count=1`, realtime policy diagnostics true (`k80_rt_ingest_policy_flag_enabled`, `k80_rt_ingest_policy_allowlist_applied`, `k80_rt_ingest_policy_device_match`, `k80_rt_ingest_policy_enabled`), insert path entered (`k80_rt_ingest_insert_path_entered=true`, `k80_rt_ingest_insert_path_skipped=false`), and one row persisted to `device_realtime_direction_observations`. No pull-fact overwrite/reconciliation was introduced.
- `Confirmed` (implementation note, 2026-04-08): Historical-direction lane state/checkpoint foundation now exists as additive persisted metadata (`agent_device_sync_states.metadata.direction_historical`) with explicit lifecycle/status transitions and resumable checkpoint operations (`start/read/checkpoint/pause/stop/error/retry/no-progress`) via `services/directionHistoricalStateService.js`. This slice does not derive historical direction artifacts and does not implement reconciliation, `device_events.direction` overwrite, or pull-fact mutation.
- `Confirmed` (implementation/validation note, 2026-04-08): First bounded historical-direction worker slice is now implemented with separate artifact storage (`historical_direction_artifacts`) and conservative derivation (`services/historicalDirectionWorkerService.js`). Bounded validation processed one deterministic window and persisted 25 artifacts (`informational_only=25`, `usable=0`, `unresolved=0`) while advancing `metadata.direction_historical` checkpoint. No reconciliation was implemented, no `device_events.direction` overwrite occurred, no pull/live RT lane behavior changed, and historical artifacts remain separate from `device_realtime_direction_observations`.
- `Confirmed` (implementation/validation note, 2026-04-10): Normal RT ingest now uses an explicit dual-time metadata contract for realtime direction rows (`rt_time_contract_version=dual_time_v1`) while preserving existing schema fields: provisional decoded RT time is explicitly labeled untrusted (`rt_time_observed_basis=decoded_device_time_provisional`, `rt_time_observed_trust=untrusted`, `rt_time_decoded_*`), and ingest chronology is stored separately (`rt_time_chronology_utc`, `rt_time_chronology_source=server_ingest_clock`). Bounded validation batch `be87c851-455f-4499-a80a-c01f0d5f6c76` inserted row `62ec406d-75c7-4341-8d6d-634c8bef1d40` with dual-time metadata; pull fact counts remained unchanged and no pull parser/protocol/reconciliation/fact-overwrite logic was changed.
- `Confirmed` (implementation/validation note, 2026-04-10): Full-history direction worker now supports a worker-only provisional RT correlation clock using RT ingest chronology (`device_realtime_direction_observations.created_at`) while keeping `observed_at_utc` unchanged as raw/provenance. In bounded validation run `hist-created-clock-1775819673415`, anchor fact `9fc61395-4a2d-422e-9707-d6f3bbd05526` produced artifact `0e9cd523-39d1-4b60-a938-7741e0b64a0d` with `derived_direction=IN`, `confidence_basis=rt_pull_conflict_created_at_provisional`, and non-null `source_refs.rt_observation_id=e2c8ee98-f77d-42f6-9d71-b6cd3e8b66a1` (non-fallback RT-linked derivation). Separate bounded fallback-preservation run `hist-created-clock-fallback-1775819701638` persisted fallback-only artifacts (`confidence_basis=pull_status_map_fallback`, null RT refs). No `device_events` mutation, no pull/RT ingest logic change, and no reconciliation were introduced in this slice.
- `Confirmed` (implementation/validation note, 2026-04-10): Phase 1 post-punch fact-anchor guarantee foundation is now implemented additively in ingest service (`services/agentDeviceEventsService.js`) as an opt-in K80 policy path (`K80_POST_PUNCH_PULL_GUARANTEE_*`) triggered from accepted realtime ingest with inserted RT rows. It reuses `queuePullDeviceEventsCommand(...)`, respects existing queue guards/in-flight dedupe, and writes explicit trigger diagnostics (`k80_post_punch_fact_anchor_*`) to batch payload diagnostics plus sync-state metadata trace (`agent_device_sync_states.metadata.post_punch_fact_anchor_trigger`).
- `Confirmed` (bounded validation note, 2026-04-10): Trigger path evidence shows both suppression and success behavior under policy scope: one realtime run was suppressed by min-interval (`k80_post_punch_fact_anchor_queue_suppressed_reason=min_interval_not_elapsed`), and a later run queued command `f5637833-8059-4dde-b2b4-53c04be07d2b` with downstream pull batch `247aad3c-8971-4b9f-a1aa-64c1426ccab3` acknowledged. This bounded validation did not produce a new inserted pull fact row (`inserted_count=0`) because no fresh unseen device fact was present in that pull window.
- `Confirmed` (implementation/validation note, 2026-04-10): Direction Provenance Normalization slice is implemented additively for pull-fact ingestion. Pull-carried direction remains persisted unchanged in `device_events.direction`, but new pull rows now store explicit non-authoritative provenance contract metadata in `device_events.source_metadata` (`direction_contract_version=pull_direction_provenance_v1`, `direction_source_lane=pull_attlog_status`, `direction_basis=attendance_status_map`, `direction_basis_field=status_code`, `direction_basis_value`, `direction_flattened_value`, `direction_authority=non_authoritative`, `direction_confidence=low`). Validation row `34db4a61-7396-4acb-9448-6831f3d391b6` confirms contract fields with unchanged direction (`OUT`), while legacy row `f6bb0c87-2962-413b-9d7f-83e10a42a992` remains readable without backfill.
- `Confirmed` (implementation/validation note, 2026-04-10): Minimal derived-direction attachment storage/contract slice is now implemented additively via `derived_direction_attachments` (migration `20260410_derived_direction_attachments.sql`) and historical-direction service attachment upsert path (`services/historicalDirectionWorkerService.js`). Records are idempotent per `(company_id, fact_event_id)` and persist `derived_direction`, `artifact_outcome`, `confidence_basis`, `conflict_flag`, and explicit `source_refs`/`source_metadata` provenance without mutating `device_events`. Validation on disagreement anchor `fact_event_id=f6bb0c87-2962-413b-9d7f-83e10a42a992` produced attachment `9ce5497d-8bc9-46ac-a44e-ab68e84af635` (`derived_direction=IN`, `confidence_basis=rt_pull_conflict_created_at_provisional`, `conflict_flag=true`, `rt_observation_id=6d76d77f-f4d0-498f-a4f6-14de701dd221`) with unchanged fact row direction (`OUT`) and idempotent repeat upsert (same attachment id).
- `Confirmed` (implementation/validation note, 2026-04-10): One bounded consumer adoption is now implemented on the agent-admin diagnostics endpoint `GET /api/agent-admin/device-events/recent` (service: `listRecentDeviceEvents`). The endpoint now returns additive side-by-side interpretation fields per row (`legacy_direction`, `legacy_direction_authority`, and nullable `derived_direction_attachment` with `derived_direction`, `confidence_basis`, `conflict_flag`, `source_refs`, `source_metadata`) via null-safe join to `derived_direction_attachments` on `(company_id, fact_event_id=device_events.id)`. Legacy `direction` remains unchanged and existing non-adopter consumers are unchanged.
- `Confirmed` (K80 ATTLOG alternate branch hardening, 2026-03-24): K80 pull adapter now includes a gated alternate protocol branch for observed pull divergence (`0x05df -> 0x07d0 -> 0x05e0 -> 0x05dc/0x05dd`) with explicit K80 scope, TCP scope, and feature flag default OFF (`K80_ATTLOG_07D0_FOLLOWUP_ENABLED=false`).
- `Confirmed` (K80 ATTLOG alternate branch hardening, 2026-03-24): direct `0x05df -> 0x05dd` success path remains unchanged and preferred; `0x07d0` is never treated as success by itself, and branch success requires reaching non-empty `0x05dd` payload data.
- `Confirmed` (K80 ATTLOG alternate branch hardening, 2026-03-24): when the gated branch is entered, diagnostics now expose branch entry/follow-up/continuation/fallback evidence (`zktime_pull_07d0_*`) so failed branch attempts preserve current failure semantics with richer classification.
- `Confirmed` (K80 ATTLOG guarded branch wiring fix, 2026-03-24): `k80FollowupPolicy` initialization is now in reachable scope before `runZkTimeK80Step` consumes it; this was a wiring-only fix (no semantic/protocol redesign) and makes guarded branch enablement practically testable in runtime.
- `Confirmed` (capture-backed parity delta, 2026-04-01): in synchronized app-vs-agent evidence, the first material divergence point is `0x05e0` followup payload after `0x05df` state/ack; ZKTime parity payload family is `000000006c0b0000`, while prior fixed agent family was `00000000f4050000`.
- `Confirmed` (reproduced runtime parity result, 2026-04-01): guarded dynamic `0x05e0` derivation from immediate `0x05df` state was validated and reproduced in canonical queue+poll runs (`command_id=2ec49d79-73aa-43fb-a957-381715e175b3` -> `batch_id=961c3e3a-0234-40d5-8610-e441225fdce5`, and `command_id=688e306b-07a9-4035-a663-e57a0f1f8aeb` -> `batch_id=63108c12-4d07-4347-9fba-9256f7bc0a2c`): sent `0x05e0` payload `000000006c0b0000`, payload bytes `2924`, merged candidates `73`, merged max `2026-04-01T14:46:26Z`, and `any_merged_after_2026-03-24T14:26:40Z=true`.
- `Confirmed` (guard-alignment slice, 2026-04-08): K80 pull-request guarded-branch policy-truth diagnostics are now emitted in pull protocol diagnostics (`k80_pull_07d0_policy_*`, `k80_pull_request_07d0_continue_policy_*`, `k80_dynamic_05e0_policy_*`). In controlled rerun `command_id=28f12478-a1d3-410c-af1a-55fa446d988e`, batch `6d4caced-75c6-4f62-be80-787f064b7612`, aligned runtime env/allowlist truth for device `zkteco:sn:BIND-QUEUE-c26a7486` produced `..._flag_enabled=true`, `..._allowlist_applied=true`, `..._scope_allowed=true`, continuation activation (`zktime_pull_request_07d0_continue_enabled=true`, `...guard_entered=true`, `...attempted=true`), reached non-empty `0x05dd` (`...reached_non_empty_05dd=true`, `zktime_pull_07d0_branch_outcome=success_with_05dd_data`), and pull batch accepted with `events_received_count=7`.
- `Confirmed` (implementation/validation note, 2026-04-13): Fresh fact-anchor derived-attachment trigger is implemented additively in normal pull ingest (`services/agentDeviceEventsService.js`). After successful `device_events` insert, ingest performs post-commit best-effort attachment derivation by inserted fact id using `deriveAndUpsertDirectionAttachmentForFactEvent(...)`; failures do not roll back facts and are emitted via `k80_fresh_fact_attachment_*` diagnostics. Validation command `0f4c3f58-36a6-435d-bc06-ca8a07b50766` -> batch `9fac0257-0deb-4759-a21e-b1f06a3e45ca` inserted fresh facts `4ed374f2-a64b-48b0-9dfb-33aac98baa9a`, `ce51b950-375c-487f-a2b0-4d11d4e73783` and auto-created matching attachments `4bf4c32c-7c7c-42fd-8c40-dc30b20a5fd6`, `c7828460-d622-4a65-b022-ad770f86af77` with `k80_fresh_fact_attachment_trigger_succeeded_count=2`, `failed_count=0`.
- `Confirmed`: Queue-based pull command construction now propagates `transport`, `attlog_sequence`, and `device_number` from device discovery/metadata/options into `command_payload.connection`; this closed the managed K80 queue-path mismatch where commands were otherwise emitted as UDP-only and failed at ATTLOG stage.
- `Confirmed`: K80 real-device operational onboarding required explicit per-device connection metadata plus live agent runtime path; discovery alone was not the reliable primary onboarding mechanism.
- `Confirmed`: Current bridge data model/queue paths support one-agent-to-many-devices (commands, sync states, and batches are scoped by `(company_id, agent_id, device_uid)`).
- `Confirmed`: Phase B Slice B2 foundation is implemented: manual candidate validation can now be explicitly queued (`POST /api/agent-admin/devices/{device_uid}/validate`) to a chosen active agent, executed via dedicated command type (`VALIDATE_DEVICE_CANDIDATE`), and completed via agent result submission (`POST /api/agent/device-validations/result`) with transactional lifecycle/read-model updates.
- `Confirmed`: Validation path is operationally separated from attendance fact ingestion in this slice: validation updates candidate onboarding/readiness evidence (`validation_status`, `onboarding_state`, reason/evidence metadata) without writing `device_events`.
- `Confirmed`: Operator-facing onboarding/readiness read model is now available via `GET /api/agent-admin/devices/{device_uid}/onboarding-readiness` with canonical UID resolution, binding/agent context, validation summary, and explicit readiness status/reason projection.
- `Confirmed`: `/boss` Device Live View now consumes onboarding/readiness evidence and exposes lifecycle-aligned next actions (`Validate Device`, `Claim Device`, `Bind Agent`, `Queue Pull Now`) with plain-language blocked/actionable reasons.
- `Confirmed`: `/boss` already provides real operator value across devices, commands, sync/batches, and onboarding/readiness actions; it is no longer only a temporary bridge test surface.
- `Confirmed`: UI Phase 1 shell modernization is implemented on `/boss` with a product-grade SaaS shell (app header + stable primary navigation: `Overview`, `Sites & Agents`, `Devices`, `Activity`) while preserving existing backend/lifecycle behavior.
- `Confirmed`: UI Phase 2 Devices experience is implemented on `/boss`: device list now surfaces onboarding/readiness state, validation status, pull-readiness meaning, last successful pull, recent data signal, and lifecycle next action; selected-device live view now groups quick status, next action, configuration/identity, validation result, pull-readiness evidence, and recent pulled data.
- `Confirmed`: UI Phase 3 Sites/Agents clarity is implemented on `/boss`: Agents area now presents site-runtime health framing (online/offline, devices attached, pull-ready/blocked counts, recent activity, actionability, requires-attention reason) and makes runtime-to-device relationship evidence visible without inventing a hard site FK model.
- `Confirmed`: UI Phase 4 Local Agent diagnostics surface is implemented as a secondary local-first support plane (`/diagnostics` on the agent runtime): read-only runtime summary, SaaS connectivity/poll freshness, local known-device evidence, recent command activity, and bounded troubleshooting hints; `/boss` remains the primary control plane.
- `Confirmed`: UI Phase 5 alerting/health/history refinement is implemented: `/boss` Overview now surfaces explicit attention-first severity framing (`blocked`/`offline`/`degraded`) with recent operational signal timeline; Devices and Sites/Agents now expose clearer live health reasoning and latest failure/success context; local diagnostics now includes concise health+history interpretation including repeating-vs-historical failure guidance.
- `Confirmed`: Architecture Phase 1 site foundation is now implemented additively: first-class `sites` entity, nullable `site_id` references on `agent_nodes` and `devices`, minimal admin site CRUD (`/api/agent-admin/sites`), explicit site assignment endpoints for agents/devices, and site context surfaced in agent/device operational read models.
- `Confirmed`: Architecture Phase 2 active site-runtime ownership foundation is now implemented additively: `site_agent_leases` persistence, DB-enforced one-active-lease-per-site invariant, explicit assign/reassign/release APIs (`GET/PUT /api/agent-admin/sites/{site_id}/active-agent`, history read), and active-lease context surfaced in site/agent read models while device-level managing-agent binding semantics remain unchanged.
- `Confirmed`: Architecture Phase 3 desired-vs-reported foundation is now implemented additively: `site_runtime_reported_state` + `device_runtime_reported_state` persistence, runtime evidence writes from heartbeat/poll/validation/pull-result paths, and read-model projections that explicitly render stale/missing runtime evidence as `unknown` instead of reusing desired/historical truth.
- `Confirmed`: Architecture Phase 4 durable agent identity foundation is now implemented additively: bootstrap/provisioning credential is now separated from durable runtime identity via `agent_runtime_identities`, `agent_nodes.active_runtime_identity_id`, and `agent_nodes.identity_status`.
- `Confirmed`: Agent auth now validates active durable runtime identities first (with narrow bootstrap-only legacy fallback), and admin APIs now expose explicit runtime identity inspect/reissue/revoke control surfaces under `/api/agent-admin/agents/{agent_id}/runtime-identity*`.
- `Confirmed`: Agent bootstrap/runtime state now persists runtime identity metadata (`active_runtime_identity_id`, `identity_status`, `runtime_identity_issued_at`) in local state/diagnostics context without changing pull/discovery command semantics.
- `Confirmed`: Architecture Phase 6 version-governance foundation is now implemented additively: reported agent runtime version now persists in `agent_runtime_version_reported_state`, and control-plane compatibility policy now persists in `agent_version_governance_policies` (global baseline + company override).
- `Confirmed`: Agent heartbeat now reports `agent_version` + `rollout_channel`; SaaS persists latest reported version per `(company_id, agent_id)` without coupling it to runtime health state.
- `Confirmed`: Agent operational reads now expose explicit version governance projection (`reported version`, `support status`, `support level`, `support reason`, `policy min/target/channel`, `policy source`) and keep version support separate from site runtime health.
- `Confirmed`: Admin policy API now exists for version governance (`GET/PUT /api/agent-admin/version-policy`) with semver validation and tenant-scoped override writes.
- `Confirmed`: Architecture Phase 7 enforcement/gating foundation is now implemented additively on command issuance and poll acceptance paths: execution now evaluates active site runtime lease truth, runtime freshness/health truth, and version support truth with deterministic block reason codes (`site_active_runtime_mismatch`, `device_binding_site_runtime_conflict`, `runtime_reported_state_stale`, `runtime_health_offline`, `runtime_health_blocked`, `runtime_health_unknown`, `runtime_version_unsupported`, `runtime_version_unknown`).
- `Confirmed`: Architecture Phase 8 capability reporting/feature-gating foundation is now implemented additively: runtime and device-path capability reported-state persistence exists (`agent_runtime_capability_reported_state`, `device_runtime_capability_reported_state`) with explicit `supported`/`unsupported`/`disabled` truth and stale->`unknown` projection semantics.
- `Confirmed`: Command issuance/acceptance gates now evaluate command-class capability truth for `VALIDATE_DEVICE_CANDIDATE` and `PULL_DEVICE_EVENTS`, adding deterministic block reasons (`runtime_capability_unsupported`, `runtime_capability_disabled`, `device_path_capability_unsupported`, `device_path_capability_disabled`) while preserving compatibility-staged unknown handling.
- `Confirmed`: Agent heartbeat now reports explicit runtime capability map, and validation/pull result ingestion now persists device-path capability evidence for supported/unsupported/disabled outcomes where evidence is explicit.
- `Confirmed`: Architecture Phase 9 policy tightening/operationalization is now implemented additively: execution-gate policy levels are explicit (`allow`/`warn`/`block`) via profile (`compat`/`balanced`/`strict`), with `balanced` default now blocking unsafe pull-path unknowns (`runtime_version_unknown`, `runtime_capability_unknown`, `device_path_capability_unknown`) and missing site-runtime ownership/report truth (`site_active_runtime_missing`, `runtime_reported_state_missing`) while keeping validation-path unknowns as explicit warnings.
- `Confirmed`: Field Hardening Pass 1 now adds runtime capability-schema guardrails for heartbeat/batch critical paths: heartbeat persistence is transactional, capability schema readiness is checked before mutation, and schema drift now returns deterministic `runtime_schema_not_ready` `503` envelopes instead of ambiguous route-level `500`.
- `Confirmed` (runtime verification pass, 2026-03-23): In live local runtime, with capability table intentionally renamed out of place, `/api/agent/heartbeat` and `/api/agent/device-events/batch` both returned deterministic `503` `runtime_schema_not_ready` with missing-relation details; after table restoration, heartbeat and batch submit returned `200/201` and normal command/batch truth resumed.
- `Confirmed`: Legacy simulation surface `POST /api/simulation/run` is now explicitly bounded/deprecated as `baseline_delta_only` and does not accept modern policy override fields (`policy_profile_id`, `policy_override`, `rule_set_override`); current simulation truth model remains `/api/simulate/day` and `/api/simulate/range`.
- `Confirmed`: Trusted late/simulation surfaces now preserve computed explainability parity for decision metadata (`computed.reason_code`, `computed.flags`) across `/api/attendance`, `/api/simulate/day`, and `/api/simulate/range`; attendance cache writes now persist and restore a `decision_snapshot` to avoid explanation drift on cache hits.
- `Confirmed` (contract-freeze note, 2026-04-13): K80 baseline support classification freeze (`k80_support_baseline_contract_v1`) is now recorded additively in `contracts/k80SupportBaselineContract.js` with companion operator/developer documentation in `docs/K80_SUPPORT_BASELINE_CONTRACT.md`; this slice is classification-only and introduces no runtime behavior change.
- `Confirmed` (isolation-boundary note, 2026-04-13): K80 deep guarded protocol families are now explicitly isolated behind experimental profile gating (`K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED` with optional device/family allowlists) in `agent/lib/events/zktecoPullAdapter.js`; baseline-supported/conditional production paths remain unchanged.
- `Confirmed` (flag-hygiene contract note, 2026-04-13): K80 flag ownership/classification contract is now frozen additively in `contracts/k80FlagOwnershipContract.js` with human-readable companion `docs/K80_FLAG_OWNERSHIP_CONTRACT.md`; controls are explicitly grouped by owner/subsystem and classified (`baseline`/`conditional`/`experimental`/`obsolete_superseded`/`unclear`) with no runtime behavior changes in this slice.
- `Confirmed` (enrollment-capture review note, 2026-04-14): four-capture K80 enrollment workflow comparison is now documented in `docs/ZK_ENROLLMENT_CAPTURE_ANALYSIS.md` with phase candidates, command/session markers, confidence labels (`confirmed`/`likely`/`possible`/`unclear`), and pre-implementation guardrails.
- `Confirmed` (enrollment bounded-confirmation note, 2026-04-14): bounded three-run confirmation set (`enroll-confirm-success-fingerX-YYYYMMDD-HHMM.pcapng`, `enroll-confirm-cancel-fingerX-YYYYMMDD-HHMM.pcapng`, `enroll-confirm-partial-fingerX-YYYYMMDD-HHMM.pcapng`) upgraded packet-chain confidence for enrollment planning (`0x003e` phase boundary, `0x003d` selection packet family, `0x01f4` progress-channel involvement, success-associated `0x05df -> enrollment-session 0x05dd`), while keeping byte-level `0x003d` field map and `0x01f4` short-value semantics explicitly unresolved for direct coding.
- `Confirmed` (device-user inventory review note, 2026-04-14): `users.pcapng` browse-users workflow analysis is documented in `docs/ZK_DEVICE_USER_INVENTORY_ANALYSIS.md`; the capture shows a compact request chain ending in `0x05dd` user-record-bearing payload that includes IDs consistent with screenshot context (`1,2,3,4,5,6,7,10`), sufficient for planning-level inventory/ID-allocation strategy work but not yet coding-safe for count-field and paging semantics.
- `Confirmed` (implementation note, 2026-04-14): Phase 1 inventory prerequisite foundation is now implemented additively for K80 via `device_user_inventory_snapshots` persistence, `deviceUserInventoryService` contract/state model, and bounded admin APIs:
  - `POST /api/agent-admin/devices/{device_uid}/user-inventory-snapshots` (operator)
  - `GET /api/agent-admin/devices/{device_uid}/user-inventory-snapshots/latest` (viewer)
  This slice persists parsed ID sets, confidence/completeness states, and evidence refs without enrollment execution or candidate-allocation commit logic.
- `Confirmed` (implementation note, 2026-04-14): Conservative candidate-ID evaluation is now implemented additively on top of K80 inventory snapshots (no allocation commit) with explicit readiness/blocked states. `max+1` is only emitted when snapshot confidence/completeness pass strict gating (`high` + `complete` + non-empty parsed IDs); otherwise output is blocked with explicit reason and manual-override-required signal. This is exposed read-only via:
  - `GET /api/agent-admin/devices/{device_uid}/user-inventory-snapshots/latest` (`candidate_evaluation` block)
  - `GET /api/agent-admin/devices/{device_uid}/user-inventory-snapshots/latest/candidate` (viewer endpoint)
  and does not use attendance pulls for ID inference.
- `Confirmed` (implementation note, 2026-04-14): Enrollment preflight + manual-override decision layer is now implemented additively for K80 inventory scope (still no enrollment execution). `POST /api/agent-admin/devices/{device_uid}/enrollment-preflight` evaluates latest snapshot + conservative candidate + optional operator manual override, emits explicit readiness states (`ready_auto_candidate`, `ready_manual_override`, `blocked_refresh_inventory_required`, `blocked_confidence_insufficient`, `blocked_invalid_override`), persists auditable decision rows (`device_user_id_preflight_decisions`), and enforces override collision checks against parsed device-user IDs.
- `Confirmed` (implementation note, 2026-04-14): K80 enrollment orchestration entrypoint now exists with strict preflight dependency and auditable attempt lifecycle persistence (protocol execution placeholder only). `POST /api/agent-admin/devices/{device_uid}/enrollment-attempts` requires a latest ready preflight decision (`ready_auto_candidate` or `ready_manual_override`), derives `device_user_id` only from that decision, and persists `device_enrollment_attempts` (`attempt_status=pending`, `status_reason=awaiting_k80_protocol_execution`, source metadata + audit refs). `GET /api/agent-admin/enrollment-attempts/{attempt_id}` exposes read status. No device enrollment command execution is performed in this slice.
- `Confirmed` (implementation note, 2026-04-14): Bounded K80 enrollment protocol runner is now attached to attempt lifecycle via queued command execution and conservative result ingestion:
  - admin execution trigger: `POST /api/agent-admin/enrollment-attempts/{attempt_id}/execute` queues `RUN_K80_ENROLLMENT_ATTEMPT` only for `pending` K80 attempts and moves attempt to `starting`,
  - agent command handling now runs a K80-scoped conservative runner and posts results to `POST /api/agent/enrollment-attempts/result`,
  - poll/acceptance lifecycle moves attempt to `in_progress`, and result ingestion closes attempt as `success`/`cancelled`/`partial_or_failed` with explicit evidence flags + refs in `device_enrollment_attempts.evidence_ref/source_metadata`,
  - success is guarded by explicit chain evidence (`saw_05df && saw_05dd_after_05df`); reported `success` without that chain is downgraded to `partial_or_failed` (`status_reason=success_chain_missing`).
  This slice remains conservative: unresolved `0x003d` field map and unresolved `0x01f4` short-value semantics are kept as guarded uncertainty metadata; no attendance/direction logic changed.

# 7. What Is Partial / Fragile
- `Confirmed`: Auth/tenant enforcement is inconsistent across route families.
- `Confirmed`: `/api/simulation/run` remains intentionally non-parity with `/api/simulate/*` (legacy baseline-delta semantics); this is now explicit boundary behavior, not implicit drift.
- `Confirmed`: Command lifecycle has an MVP reconciler, but dead-letter queues and policy-driven automated requeue/backoff remain thin.
- `Confirmed`: Pull orchestration is largely manual/admin-triggered; unattended scheduling is limited.
- `Confirmed`: Device remediation now has a minimal operational model, but deeper field workflow ownership/runbooks remain partial.
- `Confirmed`: Operational UI coverage for bridge workflows is significantly improved in `/boss`, but advanced workflows (bulk actions, deep remediation guidance, richer trend/history views) remain limited.
- `Confirmed`: Current `/boss` shell/UX remains transitional and is not yet a final product-grade SaaS operations interface.
- `Confirmed`: Current UI can still mix historical proof, live-now status, and bridge diagnostics in ways that confuse operators if not explicitly separated.
- `Open`: Product information architecture for Sites -> Agents -> Devices is still incomplete and requires explicit modeling in operator flows.
- `Confirmed`: Current Sites/Agents UX now frames agents as site runtimes, but site context remains partially inferred/soft where normalized `site_id` truth is not yet present.
- `Confirmed`: Site lease/active-runtime ownership is now formalized with explicit, auditable active-lease records and one-active-lease-per-site DB constraints.
- `Open`: Queue/poll command acceptance still relies primarily on per-device managing-agent bindings; explicit runtime enforcement against site active-lease ownership remains a later hardening step.
- `Confirmed`: Desired-state vs reported-state separation now has a concrete persistence/read-model base for site runtime and device runtime health evidence.
- `Open`: Desired/control-plane intent is still distributed across existing lifecycle/configuration tables; a stricter explicit desired-state contract model remains pending later architecture phases.
- `Confirmed`: Local Agent diagnostics surface is intentionally read-mostly and local support-oriented; it is not yet a full remote support plane and should not be treated as a replacement for SaaS operational history.
- `Confirmed`: Current alerting remains lightweight in-product signaling only; there is still no background notification/incident engine in this phase.
- `Confirmed`: Docs/CI drift exists in places (inventory/docs/workflow mismatches have occurred).
- `Confirmed`: Migration-managed `api_keys` table is currently missing in at least one local/CI-style path (`apply-seeds -Profile ci` fails on `public.api_keys`); auth-hardening verification currently relies on fallback API keys where needed.
- `Confirmed`: K80 Pro path is now protocol-compatible for connect/auth/post-auth retrieval in probe mode; broader ZKTeco firmware/model matrix remains unproven and still requires evidence-first validation.
- `Confirmed`: Discovery-first onboarding is not sufficient for all real devices; manual onboarding + agent validation must remain explicit and first-class.
- `Confirmed`: Real-device K80 probe/runtime protocol path is proven, but this success is still partially out-of-band from canonical SaaS lifecycle persistence used by bridge-operational tables.
- `Confirmed`: Slice 2.6 foundation is in place: non-bridge upsert paths (`/api/devices` PUT and ingest auto-register) now default to `lifecycle_scope='ingest_only'` while preserving existing `bridge_ops`; bridge discovery/claim writes now explicitly stamp `lifecycle_scope='bridge_ops'`; `/api/devices` now supports `lifecycle_scope` filtering for operational separation.
- `Confirmed`: Operational readiness/actionability must be evaluated per device even when multiple devices share one site agent.
- `Open`: Manual DB enrichment has been used tactically during validation; productized onboarding flows must remove this as a normal long-term operator workflow.
- `Open`: Canonical lifecycle coherence for real devices still needs end-to-end runtime proof across discovery->claim->bind->queue->sync/batch continuity, with explicit queue-vs-ingest enforcement asymmetry tracking.
- `Open`: Phase 5 lifecycle reconciliation is still manual/read-only; no automated correction path exists yet for strict integrity anomalies.
- `Open`: New decoder hardening is implemented, but real-device rerun evidence is still required to confirm final attendance record quality on K80 payloads.
- `Open`: Fresh corrected-clock sample currently includes only OUT punches for the newest (`2026-03-24`) slice, so replay verifies ingest/cross-surface consistency but does not yet prove late-threshold delta behavior on a valid IN->OUT workday from corrected-clock data.
- `Open`: K80 direction semantics are still partial in pull-ledger ingestion: current persisted direction for fresh punches is derived from `0x05dd status_code` mapping (`1 -> OUT`), while a separate observed `0x01f4` signal likely carries additional direction-state semantics; this remains evidence-backed but vendor-unconfirmed.
- `Open`: Provisional K80-only `0x01f4` state interpretation (`00=Entree`, `01=Sortie`, `04=Prol.entree`, `05=Prol.sortie`) is not yet vendor-confirmed and must not be treated as cross-model/firmware truth.
- `Open`: Current app persistence does not preserve explicit Arrivee/Depart/Prol.* semantic labels from a richer K80 source; direction is flattened to `IN/OUT` from pull-ledger status mapping, which is likely where semantic loss now occurs.
- `Open`: K80 `0x01f4` companion-signal interpretation (`00/01/04/05`) remains evidence-backed but provisional and vendor-unconfirmed.
- `Open`: K80 alternate ATTLOG follow-up branch (`0x07d0 -> 0x05e0 -> 0x05dc/0x05dd`) is implemented as an OFF-by-default guarded recovery path; vendor-confirmed meaning and broader device/firmware applicability remain unresolved.
- `Open` (runtime rerun after wiring fix, 2026-03-24): guarded branch now activates in live queue/poll runs (`zktime_pull_07d0_branch_enabled=true`, `..._entered=true`, `..._followup_sent=true`) but the latest field run still ended `failed_timeout` without reaching `0x05dc/0x05dd`.
- `Confirmed` (configured guarded rerun, 2026-03-24): with `K80_ATTLOG_07D0_FOLLOWUP_PAYLOAD_HEX=00000000f4050000` and K80 guard enabled, a live queue/poll run reached `0x05dc` and `0x05dd` and reported branch outcome `success_with_05dd_data`; this proves branch continuation can succeed with capture-backed non-empty follow-up payload.
- `Open` (configured guarded rerun, 2026-03-24): the successful branch-continuation run above still produced an accepted batch with `events_received_count=0`, so branch transport recovery is proven but event-yield behavior remains variable and needs further controlled reruns.
- `Confirmed` (assembly-only hardening, 2026-03-25): alternate-branch `0x05dd` assembly path now preserves raw observed continuation-frame payload bytes for final pre-parse body construction; previous fallback that rebuilt chunks from bounded diagnostic hex could truncate large payloads (for example `1524` observed vs `512` assembled in prior diagnostics).
- `Open` (assembly-only hardening, 2026-03-25): parser/protocol/business semantics remain unchanged by this fix and a live SaaS queue + agent poll rerun is still required to confirm runtime `events_received_count` impact after full-body preservation.
- `Confirmed`: Version governance baseline is now formalized as a first-class control-plane contract (reported runtime version + minimum/target policy evaluation + operator read/update API).
- `Open`: Version governance currently evaluates support policy only; staged rollout execution, package distribution, and rollback orchestration remain intentionally out of scope.
- `Open`: Legacy agents that do not report `agent_version` remain `version_support_status=unknown` until upgraded.
- `Confirmed`: Phase 9 policy tightening now makes lease/report/version/capability unknown handling command-class aware under explicit execution policy profiles (`compat`/`balanced`/`strict`); default `balanced` blocks unsafe pull-path unknowns while validation-path unknowns remain warning-visible for transitional compatibility.
- `Open`: Legacy/no-site-context command paths remain transitional; pull issuance uses explicit staged policy for missing site context (`site_context_missing_for_pull`: warn in `compat`, warn in `balanced` by default, block in `strict`, and block in `balanced` when rollout override `EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT=true` is enabled) while non-pull compatibility handling remains unchanged.
- `Confirmed` (post-Phase-9 runtime review, 2026-03-23): current live command payloads are still predominantly site-less (`runtime_context.site_id = null` for `23/23` recent `PULL_DEVICE_EVENTS` and `16/16` `VALIDATE_DEVICE_CANDIDATE` rows), so lease/freshness/version/capability gates are underused in practice through the compatibility path.
- `Open`: Capability taxonomy is intentionally narrow in this phase (validation/pull command classes + core runtime signals); broader capability classes remain future expansion work.
- `Confirmed`: Durable runtime identity persistence and revocation/reissue controls are now in place, but automated rotation policy, richer identity-history operations, and formal same-host/new-host replacement runbooks remain partial.
- `Open`: Delivery idempotency is currently opt-in via `delivery_id`; legacy/manual batch submissions that omit `delivery_id` still rely on event-level dedup and can create extra batch-ledger rows.
- `Open`: Full operational SLO/SLA definition for ingestion freshness and failure recovery.

# 8. Roadmap Snapshot
- **P0: Trust boundary hardening**
  - status: `Completed (Phase 1 scoped routes, runtime-verified)`
  - focus: consistent auth + tenant enforcement.
- **P0: Device onboarding/remediation model**
  - status: `Completed (Phase 2 MVP slice, runtime-verified)`
  - focus: explicit manageability states and operator actions.
- **P1: Pull lifecycle reliability**
  - status: `Completed (Phase 3 MVP slice, runtime-verified)`
  - focus: requeue/retry/stuck-command handling and dead-letter visibility.
- **P1: Ingestion correctness hardening**
  - status: `Open`
  - focus: dedup/cursor/backfill/replay guarantees under failure.
- **P1: Operational surfaces + runbooks**
  - status: `Completed (Phase 5 MVP slice, runtime-verified)`
  - focus: support/operator clarity for bridge health and remediation.
- **P1: Phase 6.5 — Real Device Validation & Protocol Compatibility**
  - status: `In Progress (K80 case study validated)`
  - focus: reuse K80 evidence-first process for additional firmware/model paths before broader multi-device support.
- **P2: CI/docs/schema alignment**
  - status: `Open`
  - focus: keep automation/docs/contracts aligned with code reality.
- **P0/P1: Device Lifecycle Coherence V2 (K80 -> canonical SaaS `/boss`)**
  - status: `In Progress (Phase 4 completed; active focus: Phase 5 long-term cleanup + migration guardrails)`
  - problem statement: `K80 probe/runtime path is proven, but probe success is not yet fully represented as one canonical operational device lifecycle story in SaaS tables and /boss views.`
  - objective: `establish one coherent discovery -> candidate -> managed -> command/sync/batch -> /boss lifecycle with durable identity and binding invariants.`
  - phased plan:
    - `Phase 0`: runtime evidence gathering and exact break-point confirmation.
    - `Phase 1`: lifecycle/identity/binding/visibility contract codification.
    - `Phase 2`: minimal persistence/linkage foundation.
    - `Phase 3`: `/boss` operational coherence.
    - `Phase 4`: hardening/tests/contracts.
    - `Phase 5`: long-term cleanup and migration guardrails.
- **P0/P1: Manual Device Onboarding + Agent Validation (Site Agent Model)**
  - status: `In Progress (Phase A complete; Phase B Slice B1 + Slice B2 verified; Phase B Slice B3 operator readiness surface implemented)`
  - problem statement: `Discovery is helpful but not reliably sufficient as the primary onboarding path for all real device/firmware/site realities.`
  - objective: `make manual per-device onboarding and agent-side validation first-class while preserving one-agent-per-site and one-agent-many-devices operations.`
  - phased plan:
    - `Phase A`: onboarding contract + per-device field model (provider/vendor, host/IP, port, auth/comm key, machine/device number, transport, protocol/profile/attlog sequence, optional model/firmware/label/notes).
    - `Phase B`: agent-side per-device validation flow and explicit readiness gates.
    - `Phase C`: operator onboarding/validation UX with evidence-first status messaging.
    - `Phase D`: Local Agent operating-model hardening (Windows Service default on Windows/Windows Server; systemd default on Linux; Docker optional/advanced only).
    - `Phase E`: one-agent-many-devices per-site operationalization (readiness, queueing, sync, and troubleshooting at fleet-within-site level).
- **P0/P1: Control Plane & Site Runtime Architecture**
  - status: `In Progress (Architecture Phase 1 through Phase 9 foundational slices implemented; active focus now shifts to deeper command-class policy operationalization and rollout discipline)`
  - problem statement: `Site ownership/authority remains partially soft and desired-state vs reported-state boundaries are not yet fully formalized for long-term operational clarity.`
  - objective: `formalize site as a first-class SaaS entity with explicit active runtime ownership, clear desired-vs-reported truth boundaries, and durable compatibility governance.`
  - phased plan:
    - `Architecture Phase 1`: Site as first-class SaaS entity.
    - `Architecture Phase 2`: Site Agent Lease / active runtime ownership model. (foundation implemented: explicit leases + one active lease per site)
    - `Architecture Phase 3`: desired-state vs reported-state model formalization. (foundation implemented: dedicated reported-state tables + stale->unknown read semantics)
    - `Architecture Phase 4`: durable agent identity and local-state hardening. (foundation implemented: durable runtime identity issuance + revoke/reissue + auth integration)
    - `Architecture Phase 5`: offline buffer and command-truth hardening. (foundation implemented: delivery-idempotent batch truth + local retry-attempt/backoff persistence)
    - `Architecture Phase 6`: version governance and rollout compatibility policy. (foundation implemented: reported version state + global/company policy evaluation + admin control-plane API)
    - `Architecture Phase 7`: enforcement/gating layer. (foundation implemented: issuance + acceptance gate evaluation with deterministic block reason codes and staged compatibility defaults)
    - `Architecture Phase 8`: capability reporting / feature gates. (foundation implemented: runtime/device capability reported-state persistence + capability-aware issuance/acceptance gating for validation/pull command classes)
    - `Architecture Phase 9`: policy tightening / operationalization. (foundation implemented: explicit allow/warn/block policy profiles with balanced default tightening for unsafe pull-path unknowns and explicit transitional validation-path warnings)
- **P1/P2: SaaS Operations UI Evolution (Real Product Surface)**
  - status: `Completed (UI Phase 1 through UI Phase 5 implemented)`
  - problem statement: `Current /boss contains real operational lifecycle value but presentation/shell patterns are still transitional and can blur live-now actionability vs historical proof.`
  - objective: `evolve /boss into the real SaaS operations product surface while preserving proven lifecycle/backend contracts and avoiding delete-first rewrites.`
  - phased plan:
    - `UI Phase 1`: replace transitional `/boss` shell with a real SaaS application shell.
    - `UI Phase 2`: deliver a real Devices experience (manual onboarding, validation, claim, bind, pull readiness).
    - `UI Phase 3`: deliver Sites + Agents operational model (one site agent managing many devices).
    - `UI Phase 4`: add optional Local Agent diagnostics/support UI (secondary surface only).
    - `UI Phase 5`: add alerting/health/history refinements.
  - completion note: `Alerting scope in this phase is UI-level attention signaling and bounded recent-history clarity; notification engines/escalation workflows remain future work.`
- **Later (defer until proof)**
  - realtime/push acceleration,
  - multi-vendor expansion beyond ZKTeco-first path.

## Proposed Business-Function Phases (Pending Approval)

### Phase 7 — Timezone Policy Hardening
- **Objective**: Establish one canonical tenant timezone source (IANA timezone), keep UTC storage as fact truth, remove env/DB/route-path drift, and unify conversion/audit behavior across agent, JSON, CSV ingestion and attendance reads.
- **Why this phase comes in this order**: Time truth is foundational; downstream policy phases depend on consistent interpretation before business workflows are expanded.
- **What is already repo-confirmed today**: UTC event storage exists; agent ingestion carries `event_time_local`/`device_timezone`; timezone logic exists but is path-dependent.
- **What is missing today**: A single canonical tenant timezone authority and fully consistent cross-path conversion/audit semantics.
- **Completion proof**: Cross-path timezone consistency tests, DST-edge tests, and elimination of competing conversion assumptions.

### Phase 8 — Day-Boundary Formalization
- **Objective**: Make work-date/window behavior consistent across `/api/attendance`, `/api/simulate/*`, and `/api/simulation/run`; formalize anchored/calendar semantics; guarantee deterministic recompute/cache behavior when config changes.
- **Why this phase comes in this order**: Day-boundary policy should be formalized only after timezone truth is stabilized to avoid rework and contradictory outcomes.
- **What is already repo-confirmed today**: Anchored/calendar derivation utilities exist, and derived-window behavior is used in core attendance/simulate paths.
- **What is missing today**: Full cross-surface alignment (especially `/api/simulation/run`), explicit anchored/calendar contract coverage, and deterministic config-change recompute proof.
- **Completion proof**: Cross-midnight scenarios, anchored/calendar consistency tests, and deterministic recompute behavior after config changes.

### Phase 9 — Employee Enrollment Workflow
- **Objective**: Move beyond path-keyed upsert-only onboarding and add a production-ready employee creation/enrollment flow that reduces manual identifier mistakes and establishes HR-record-first workflow before device/user enrollment expansion.
- **Why this phase comes in this order**: Stable temporal policy should precede broad onboarding workflow expansion so new employee records are evaluated under finalized time/day semantics.
- **What is already repo-confirmed today**: Employee registry table + APIs exist, and identity mapping already depends on employee existence.
- **What is missing today**: A first-class create/enrollment flow, stronger onboarding ergonomics/guardrails, and an explicit operational onboarding protocol.
- **Completion proof**: Create/update/read contracts, company-scoped validation, and documented onboarding flow integrated with identity mapping prerequisites.

### Phase 10 — Identity Mapping Lifecycle Completion
- **Objective**: Add safe rebind lifecycle, deactivate/reactivate with auditability, and unresolved-identity operational handling while preserving replay safety and reducing manual DB intervention.
- **Why this phase comes in this order**: Identity lifecycle hardening should follow stable employee onboarding so rebind/correction flows have reliable upstream person records.
- **What is already repo-confirmed today**: Identity mappings exist with active-state handling; missing-mapping rejection and replay-after-fix behavior are already present in ingestion paths.
- **What is missing today**: Safe rebind workflow, mapping-change audit trail, and durable unresolved-identity backlog handling.
- **Completion proof**: Rebind/deactivate/reactivate contract matrix, replay-after-correction tests, and operational visibility for unresolved identity backlog.

### Phase 11 — Leave/Vacation Productization
- **Objective**: Deliver production leave CRUD/status/validation and attendance-impact preview, explicitly built on finalized timezone/day-boundary behavior and stable employee identity foundations.
- **Why this phase comes in this order**: Leave outcomes are policy-sensitive; leave productization should follow stabilized time and identity primitives to avoid repeated policy corrections.
- **What is already repo-confirmed today**: Leave facts and `affects_attendance` semantics exist and are consumed by attendance policy logic.
- **What is missing today**: Production leave APIs/workflows, status lifecycle/validation model, and non-test operational leave handling.
- **Completion proof**: Overlap/status validation tests, attendance impact contracts, tenant-scoped operational workflows, and explicitly non-test routes.

Recommended execution order: **Phase 7 -> Phase 8 -> Phase 9 -> Phase 10 -> Phase 11**.
- Time truth must stabilize before day-boundary and product policy work.
- Employee onboarding must stabilize before identity lifecycle completion.
- Leave productization should come after time/identity foundations are stable.

# Decision Log
Purpose: preserve major directional decisions so future runs do not silently drift.

## DEC-001
- **ID**: `DEC-001`
- **Decision**: Local Agent is first-class for SaaS-to-LAN bridging.
- **Status**: `Active`
- **Reason**: Customer devices are in private LANs where direct SaaS connectivity is unreliable or unavailable.
- **Implications**: Agent provisioning/auth/heartbeat/command lifecycle remains core product surface and must be hardened.
- **Last updated**: `2026-03-10`

## DEC-002
- **ID**: `DEC-002`
- **Decision**: Discovery is not end value; reliable event ingestion is.
- **Status**: `Active`
- **Reason**: Product value comes from durable attendance facts in `device_events`, not host visibility.
- **Implications**: Prioritize ingestion correctness, retries, dedup, and recomputation over discovery-only enhancements.
- **Last updated**: `2026-03-10`

## DEC-003
- **ID**: `DEC-003`
- **Decision**: Pull-first before push/realtime.
- **Status**: `Active`
- **Reason**: Current bridge contracts, agent command model, and known device behavior are pull-oriented and already partially implemented.
- **Implications**: Prove pull lifecycle reliability before expanding into push/realtime complexity.
- **Last updated**: `2026-03-10`

## DEC-004
- **ID**: `DEC-004`
- **Decision**: Stable device identity is more important than IP.
- **Status**: `Active`
- **Reason**: IP addresses are operationally unstable (DHCP/NAT/site changes) and cannot be primary identity.
- **Implications**: Claiming, dedup, and sync state should rely on stable device identity; IP remains diagnostic metadata.
- **Last updated**: `2026-03-10`

## DEC-005
- **ID**: `DEC-005`
- **Decision**: Locked/unprovisioned devices are a normal onboarding state.
- **Status**: `Active`
- **Reason**: Field evidence shows ping-reachable devices can still be protocol-inaccessible and unmanaged.
- **Implications**: Discovery/candidate flows must include explicit remediation states and operator guidance.
- **Last updated**: `2026-03-10`

## DEC-006
- **ID**: `DEC-006`
- **Decision**: Additive evolution only; avoid destructive rewrites.
- **Status**: `Active`
- **Reason**: Existing slices already carry product value and should be hardened incrementally for long-term maintainability.
- **Implications**: Extend current architecture with additive migrations/contracts/tests; avoid reset-style redesigns.
- **Last updated**: `2026-03-10`

## DEC-007
- **ID**: `DEC-007`
- **Decision**: ZKTeco-first before multi-vendor expansion.
- **Status**: `Active`
- **Reason**: Current adapters, diagnostics, and test surface are centered on ZKTeco path maturity.
- **Implications**: Complete reliability proof on ZKTeco pipeline before broadening vendor scope.
- **Last updated**: `2026-03-10`

## DEC-008
- **ID**: `DEC-008`
- **Decision**: Manual remediation is an overlay; operator actions must not fabricate proof-backed manageability states.
- **Status**: `Active`
- **Reason**: Real field operations require manual `needs_field_action` labeling, but proof states (`manageable`/`ingesting`) must remain evidence-driven.
- **Implications**: Keep system manageability transitions deterministic from discovery/pull evidence and keep manual remediation as separate state.
- **Last updated**: `2026-03-13`

## DEC-009
- **ID**: `DEC-009`
- **Decision**: Keep `device_events` runtime inserts on `ON CONFLICT DO NOTHING` while dual dedup surfaces are active.
- **Status**: `Active`
- **Reason**: Runtime schema currently includes both `device_events_dedup_company_uk` and partial unique `device_events_dedup_key_company_uk`; JSON/CSV/agent insert paths depend on conflict-safe idempotency across current surfaces.
- **Implications**: Re-review immediately if any new unique constraint/index is added on `device_events`.
- **Last updated**: `2026-03-14`

## DEC-010
- **ID**: `DEC-010`
- **Decision**: Use `/boss` as the single primary operator console and de-emphasize `/mvp` for operations.
- **Status**: `Active`
- **Reason**: Split/competing dashboards reduce scanability and slow incident triage for non-expert operators.
- **Implications**: Keep operational UX hierarchy and status semantics centralized in `/boss`; avoid reintroducing duplicate operations dashboards.
- **Last updated**: `2026-03-15`

## DEC-011
- **ID**: `DEC-011`
- **Decision**: New ZKTeco device support must be evidence-first and must not assume UDP-only behavior on `4370`.
- **Status**: `Active`
- **Reason**: K80 Pro case study confirms TCP transport (`50 50 82 7d`) and proves that protocol parity depends on evidence-backed post-auth sequencing and packet-shape details (not transport assumptions alone).
- **Implications**: Require capture-backed validation workflow for new device/firmware paths before claiming compatibility or widening scope.
- **Last updated**: `2026-03-16`

## DEC-012
- **ID**: `DEC-012`
- **Decision**: Device protocol onboarding must follow a reusable playbook and evidence package (`docs/DEVICE_VALIDATION_PLAYBOOK.md`).
- **Status**: `Active`
- **Reason**: K80 Pro investigation required multiple narrow evidence loops (transport, connect/auth, sequencing, final pull packet shape) that should not be rediscovered from scratch.
- **Implications**: Future device validation runs must produce structured evidence artifacts and use the same triage process before runtime feature expansion.
- **Last updated**: `2026-03-16`

## DEC-013
- **ID**: `DEC-013`
- **Decision**: Decode `0x05dd` attendance payloads using scored record-layout detection, not fixed single-offset assumptions.
- **Status**: `Active`
- **Reason**: K80 payload decoding produced invalid user IDs/timestamps under fixed offsets even though protocol transport/sequence were already correct.
- **Implications**: Keep decoder logic additive/diagnostic (`record_size_used`, header skip, malformed samples) and validate against field payload evidence before broadening model support.
- **Last updated**: `2026-03-17`

## DEC-014
- **ID**: `DEC-014`
- **Decision**: Promotion from candidate to managed remains manual claim only.
- **Status**: `Active`
- **Reason**: Operational ownership and tenant intent must be explicit before command-queue eligibility.
- **Implications**: Do not auto-promote from discovery/probe evidence alone; claim is the promotion gate.
- **Last updated**: `2026-03-18`

## DEC-015
- **ID**: `DEC-015`
- **Decision**: `/boss` default operational scope is `bridge_ops`.
- **Status**: `Active`
- **Reason**: Mixed ingest/demo/device clutter obscures real bridge-operational state and incident response.
- **Implications**: Default `/boss` views prioritize managed bridge lifecycle evidence; non-default scopes remain inspectable but not default truth.
- **Last updated**: `2026-03-18`

## DEC-016
- **ID**: `DEC-016`
- **Decision**: `devices.device_uid` is immutable after creation.
- **Status**: `Active`
- **Reason**: Mutating primary operational identity creates audit drift and unstable command/sync targeting.
- **Implications**: Resolve provisional-to-stable transitions with aliasing/supersession, not primary identity mutation.
- **Last updated**: `2026-03-18`

## DEC-017
- **ID**: `DEC-017`
- **Decision**: Provisional-to-stable identity upgrade uses aliasing + supersession, not PK mutation.
- **Status**: `Active`
- **Reason**: Real-device rediscovery can improve identity evidence over time; historical continuity must be preserved.
- **Implications**: Maintain deterministic mapping from provisional identifiers to canonical managed identity with auditable transition records.
- **Last updated**: `2026-03-18`

## DEC-018
- **ID**: `DEC-018`
- **Decision**: Lifecycle transitions require DB-backed lifecycle-audit persistence.
- **Status**: `Active`
- **Reason**: Candidate/managed/binding transitions are operational control points that require durable traceability.
- **Implications**: Persist lifecycle events for candidate creation, claim, supersession/alias finalization, and managed linkage changes.
- **Last updated**: `2026-03-18`

## DEC-019
- **ID**: `DEC-019`
- **Decision**: Managed devices require explicit active managing-agent binding.
- **Status**: `Active`
- **Reason**: Command routing and operational accountability must target a known active manager agent.
- **Implications**: Queue eligibility and `/boss` operational status depend on explicit managing-agent linkage, not implicit discovery-only association.
- **Last updated**: `2026-03-18`

## DEC-020
- **ID**: `DEC-020`
- **Decision**: Phase 5 starts with read-only lifecycle-integrity diagnostics before any cleanup/reclassification writes.
- **Status**: `Active`
- **Reason**: Recent runtime verification exposed local migration drift risk (missing immutability migration) that can silently weaken lifecycle invariants.
- **Implications**: Treat lifecycle cleanup as evidence-gated; run integrity report + migration checks first, then apply narrowly scoped fixes only for proven anomalies.
- **Last updated**: `2026-03-18`

## DEC-021
- **ID**: `DEC-021`
- **Decision**: Controlled lifecycle repair writes start with one strict, deterministic anomaly class only.
- **Status**: `Active`
- **Reason**: `canonical_device_missing_active_device_uid_alias` is the safest first repair target because it is company-scoped, deterministic, non-destructive, and does not require identity reassignment.
- **Implications**: Repair execution remains explicit and operator-invoked (`apply=true`), transactional, dry-run aligned, and evidence-linked; all other anomaly classes remain manual/dry-run only until separately approved.
- **Last updated**: `2026-03-18`

## DEC-022
- **ID**: `DEC-022`
- **Decision**: Primary deployment model is one Local Agent per site/network.
- **Status**: `Active`
- **Reason**: Site-local connectivity and operational ownership are site-scoped; per-device agents are unnecessary operational complexity.
- **Implications**: Site agent runtime, credential/state durability, and service-style deployment become first-class operational concerns.
- **Last updated**: `2026-03-21`

## DEC-023
- **ID**: `DEC-023`
- **Decision**: One site agent may manage multiple biometric devices in the same site/network.
- **Status**: `Active`
- **Reason**: Current bridge contracts and evidence support per-device readiness under shared agent control.
- **Implications**: Readiness/actionability, validation, and troubleshooting remain explicit per device even when agent runtime is shared.
- **Last updated**: `2026-03-21`

## DEC-024
- **ID**: `DEC-024`
- **Decision**: Discovery is helper evidence, not primary onboarding truth.
- **Status**: `Active`
- **Reason**: Real K80 validation showed discovery alone is not reliably sufficient for trusted onboarding.
- **Implications**: Discovery remains optional/assistive; onboarding must support explicit operator-provided connection metadata.
- **Last updated**: `2026-03-21`

## DEC-025
- **ID**: `DEC-025`
- **Decision**: Manual device onboarding is a first-class product path.
- **Status**: `Active`
- **Reason**: Real device onboarding required explicit device connection metadata and controlled validation beyond discovery heuristics.
- **Implications**: Product flows must capture and validate per-device metadata without relying on manual DB edits as normal operations.
- **Last updated**: `2026-03-21`

## DEC-026
- **ID**: `DEC-026`
- **Decision**: Operational readiness requires successful agent-side validation.
- **Status**: `Active`
- **Reason**: Device row visibility and historical evidence alone do not prove current pull actionability.
- **Implications**: Queue/action readiness must remain explicitly evidence-gated per device.
- **Last updated**: `2026-03-21`

## DEC-027
- **ID**: `DEC-027`
- **Decision**: Windows/Windows Server default Local Agent runtime is Windows Service.
- **Status**: `Active`
- **Reason**: Production Windows operations require durable startup/restart behavior and service-level manageability.
- **Implications**: Long-term packaging/runbook direction on Windows targets service deployment as default.
- **Last updated**: `2026-03-21`

## DEC-028
- **ID**: `DEC-028`
- **Decision**: Linux default Local Agent runtime is systemd service.
- **Status**: `Active`
- **Reason**: Linux production operations require deterministic startup, restart, and observability under native service management.
- **Implications**: Long-term Linux packaging/runbook direction targets systemd deployment as default.
- **Last updated**: `2026-03-21`

## DEC-029
- **ID**: `DEC-029`
- **Decision**: Docker is optional/advanced Local Agent deployment, not default.
- **Status**: `Active`
- **Reason**: Site/customer environments vary; defaulting to Docker creates avoidable operational mismatch.
- **Implications**: Docker remains supported where fit is proven, but default assumptions and docs prioritize Windows Service/systemd.
- **Last updated**: `2026-03-21`

## DEC-030
- **ID**: `DEC-030`
- **Decision**: `/boss` evolves into the real SaaS operations UI rather than being discarded immediately.
- **Status**: `Active`
- **Reason**: `/boss` already contains working lifecycle/readiness logic and operational value; delete-first replacement would discard proven behavior.
- **Implications**: UI modernization must be additive and preserve existing lifecycle truths while improving operator clarity.
- **Last updated**: `2026-03-22`

## DEC-031
- **ID**: `DEC-031`
- **Decision**: SaaS UI is the primary control plane.
- **Status**: `Active`
- **Reason**: Operator onboarding/readiness/actions must be coordinated in one canonical product surface.
- **Implications**: Avoid introducing competing primary dashboards; keep operational actions and evidence centralized in SaaS UI.
- **Last updated**: `2026-03-22`

## DEC-032
- **ID**: `DEC-032`
- **Decision**: Local Agent UI (if added) is local diagnostics/support only.
- **Status**: `Active`
- **Reason**: Agent runtime is a first-class bridge component, but product control-plane ownership remains in SaaS.
- **Implications**: Any agent UI must complement SaaS operations and avoid control-plane duplication.
- **Last updated**: `2026-03-22`

## DEC-033
- **ID**: `DEC-033`
- **Decision**: SaaS UI must explicitly model one-site-agent-to-many-devices operations.
- **Status**: `Active`
- **Reason**: Architecture and runtime evidence already support one agent managing multiple devices within a site.
- **Implications**: UI information architecture and readiness/action surfaces should be site/agent/device aware, not one-agent-one-device.
- **Last updated**: `2026-03-22`

## DEC-034
- **ID**: `DEC-034`
- **Decision**: UI evolution preserves working lifecycle/backend truths and improves clarity instead of restarting from scratch.
- **Status**: `Active`
- **Reason**: Current lifecycle/binding/readiness logic is already validated and should be retained during UI upgrades.
- **Implications**: Prefer incremental read-model/presentation improvements over wholesale rewrites that risk regression.
- **Last updated**: `2026-03-22`

## DEC-035
- **ID**: `DEC-035`
- **Decision**: Local Agent diagnostics defaults to local-first, read-only support visibility with no sensitive secret exposure.
- **Status**: `Active`
- **Reason**: Field/support diagnostics need direct runtime truth, but control-plane writes and credential exposure must stay constrained.
- **Implications**: Keep diagnostics additive, bound to local runtime context, and avoid exposing communication/auth keys in local support UI payloads.
- **Last updated**: `2026-03-22`

## DEC-036
- **ID**: `DEC-036`
- **Decision**: UI Phase 5 alerting is intentionally lightweight and evidence-bound (attention signals + bounded history), not a full notification/incident platform.
- **Status**: `Active`
- **Reason**: Current product maturity needs operator clarity first while avoiding over-engineered alerting subsystems that are not yet backed by explicit SLO/escalation policy.
- **Implications**: Keep health/attention labels honest (`healthy`/`degraded`/`blocked`/`offline`/`unknown`), preserve uncertainty, and defer email/SMS/escalation workflows to a dedicated future track.
- **Last updated**: `2026-03-22`

## DEC-037
- **ID**: `DEC-037`
- **Decision**: SaaS is the primary and authoritative control plane.
- **Status**: `Active`
- **Reason**: Long-term operability requires one canonical authority for inventory, desired configuration, bindings, command ledger, lifecycle audit/history, and version policy.
- **Implications**: Local runtime reports and executes; SaaS owns intent and authoritative operational history.
- **Last updated**: `2026-03-22`

## DEC-038
- **ID**: `DEC-038`
- **Decision**: Site becomes a first-class operating entity.
- **Status**: `Active`
- **Reason**: Site/network context is central to runtime ownership, troubleshooting, and long-term fleet operations.
- **Implications**: Stop relying indefinitely on soft/inferred site ownership; formalize site contracts in data and operations surfaces.
- **Last updated**: `2026-03-22`

## DEC-039
- **ID**: `DEC-039`
- **Decision**: One site has one active agent through explicit lease/ownership semantics.
- **Status**: `Active`
- **Reason**: Command routing and responsibility must be deterministic to avoid split-brain runtime ambiguity.
- **Implications**: Agent activity for a site must be explicit, auditable, and conflict-resolved through ownership/lease rules.
- **Last updated**: `2026-03-22`

## DEC-040
- **ID**: `DEC-040`
- **Decision**: One Local Agent may manage multiple devices within the same site/network.
- **Status**: `Active`
- **Reason**: This matches confirmed runtime behavior and avoids unnecessary per-device agent sprawl.
- **Implications**: Readiness/actionability remains per-device, while runtime ownership/health remains site-agent scoped.
- **Last updated**: `2026-03-22`

## DEC-041
- **ID**: `DEC-041`
- **Decision**: Architecture must distinguish desired state from reported state.
- **Status**: `Active`
- **Reason**: Blended state creates operational ambiguity, especially during offline runtime windows.
- **Implications**: Data/read models must clearly separate desired intent, reported runtime truth, historical ledger, and unknown/live-now status.
- **Last updated**: `2026-03-22`

## DEC-042
- **ID**: `DEC-042`
- **Decision**: Default Local Agent runtime model remains service-based (Windows Service/systemd).
- **Status**: `Active`
- **Reason**: Durable startup/restart behavior and operational manageability are required for long-term site reliability.
- **Implications**: Packaging/runbooks prioritize Windows Service on Windows/Windows Server and systemd on Linux.
- **Last updated**: `2026-03-22`

## DEC-043
- **ID**: `DEC-043`
- **Decision**: Docker remains optional/advanced Local Agent deployment, not the default.
- **Status**: `Active`
- **Reason**: Defaulting to Docker before site fit is proven creates avoidable operational mismatch.
- **Implications**: Docker support remains available when justified, but default architecture and onboarding assumptions are service-first.
- **Last updated**: `2026-03-22`

## DEC-044
- **ID**: `DEC-044`
- **Decision**: Site first-class rollout is additive and compatibility-first in Phase 1 (entity + references + minimal APIs), without premature lease/failover enforcement.
- **Status**: `Active`
- **Reason**: Existing onboarding/validation/claim/bind/queue flows must keep working while site identity is formalized safely.
- **Implications**: Introduce `sites` and nullable `site_id` links now; defer active lease ownership semantics and desired/reported control-plane separation to subsequent architecture phases.
- **Last updated**: `2026-03-22`

## DEC-045
- **ID**: `DEC-045`
- **Decision**: Site runtime ownership is explicit, auditable, and lease-based with at most one active lease per `(company_id, site_id)`.
- **Status**: `Active`
- **Reason**: Runtime authority for a site must be deterministic and visible; inferred ownership from heartbeat/discovery alone is operationally ambiguous.
- **Implications**: Active-agent assignment/reassignment/release must flow through explicit lease APIs with auditable supersession/release records; no silent runtime ownership switches.
- **Last updated**: `2026-03-23`

## DEC-046
- **ID**: `DEC-046`
- **Decision**: Phase 2 preserves separation between site-level active lease ownership and device-level managing-agent binding.
- **Status**: `Active`
- **Reason**: Replacing per-device binding semantics during lease foundation would risk regressions in validated claim/bind/queue flows.
- **Implications**: Site lease truth is introduced first as additive runtime ownership context; tighter queue/poll lease enforcement remains explicit later-phase hardening work.
- **Last updated**: `2026-03-23`

## DEC-047
- **ID**: `DEC-047`
- **Decision**: Reported runtime truth is persisted separately from desired/control-plane truth.
- **Status**: `Active`
- **Reason**: Operational ambiguity occurs when desired configuration, latest runtime observation, and historical evidence are conflated into one state.
- **Implications**: Use dedicated reported-state persistence for site runtime/device runtime and project stale/missing evidence as `unknown`.
- **Last updated**: `2026-03-23`

## DEC-048
- **ID**: `DEC-048`
- **Decision**: Historical ledger tables remain immutable evidence and are not reused as “latest live state” caches.
- **Status**: `Active`
- **Reason**: Commands/batches/lifecycle history represent audit truth, not current runtime freshness.
- **Implications**: Read models must compose desired + reported + historical views explicitly; “last success” never implies “live now” without fresh reported evidence.
- **Last updated**: `2026-03-23`

## DEC-049
- **ID**: `DEC-049`
- **Decision**: Bootstrap/provisioning tokens are enrollment-only and must not be reused as long-term runtime identity.
- **Status**: `Active`
- **Reason**: One-time bootstrap credentials do not provide durable runtime identity continuity or controlled replacement/revocation semantics.
- **Implications**: Post-bootstrap runtime auth is anchored on durable runtime identities (`agent_runtime_identities`) with explicit active/revoked/replaced state.
- **Last updated**: `2026-03-23`

## DEC-050
- **ID**: `DEC-050`
- **Decision**: Agent runtime identity and site active lease are separate control-plane concepts and must remain decoupled.
- **Status**: `Active`
- **Reason**: Identity answers “who is this runtime instance/credential,” while lease answers “which runtime is currently active for the site.”
- **Implications**: Revocation/reissue of runtime credential does not implicitly rewrite site lease ownership semantics.
- **Last updated**: `2026-03-23`

## DEC-051
- **ID**: `DEC-051`
- **Decision**: Runtime identity replacement/revocation must be explicit and auditable through admin actions, not silent background mutation.
- **Status**: `Active`
- **Reason**: Long-term operational trust requires deterministic credential lineage and clear operator intent for identity changes.
- **Implications**: `/api/agent-admin/agents/{agent_id}/runtime-identity` surfaces provide inspect/reissue/revoke controls with audit/bridge logs.
- **Last updated**: `2026-03-23`

## DEC-052
- **ID**: `DEC-052`
- **Decision**: Agent batch submissions must carry a stable `delivery_id` so reconnect/retry behavior is idempotent at batch-ledger level.
- **Status**: `Active`
- **Reason**: Event-level dedup alone does not prevent ambiguous duplicate batch rows or unclear command completion truth after offline reconnect retries.
- **Implications**: `agent_device_event_batches` now enforces unique `(company_id, agent_id, delivery_id)` for non-null deliveries; replayed submissions return prior batch truth and local buffer keeps retry-attempt/backoff metadata.
- **Last updated**: `2026-03-23`

## DEC-053
- **ID**: `DEC-053`
- **Decision**: Agent version governance must remain a distinct control-plane contract from runtime health, using explicit reported-version state plus explicit minimum/target policy evaluation.
- **Status**: `Active`
- **Reason**: A runtime can be heartbeat-healthy yet policy-unsupported; conflating health with compatibility creates operational ambiguity and unsafe rollout decisions.
- **Implications**: `agent_runtime_version_reported_state` stores latest reported runtime version truth, `agent_version_governance_policies` stores global/company policy truth, and agent read models expose `version_support_status` separately from runtime health status.
- **Last updated**: `2026-03-23`

## DEC-054
- **ID**: `DEC-054`
- **Decision**: Command executability must be explicitly gated by control-plane/runtime truth (active site lease, reported freshness/health, version support) with deterministic refusal reason codes.
- **Status**: `Active`
- **Reason**: Treating all reachable-looking runtimes as equally executable creates queued-but-never-actionable ambiguity and undermines operational trust.
- **Implications**: Queue issuance and agent poll acceptance now run a shared execution gate and return explicit block reasons (`site_active_runtime_mismatch`, `runtime_reported_state_stale`, `runtime_version_unsupported`, etc.); staged compatibility remains in place where site/report/version evidence is still absent.
- **Last updated**: `2026-03-23`

## DEC-055
- **ID**: `DEC-055`
- **Decision**: Command executability must also be capability-aware; version/health support alone is insufficient without explicit runtime/device-path capability truth.
- **Status**: `Active`
- **Reason**: A runtime can be healthy and version-supported yet still not support a specific command class or device path; hidden capability assumptions produce ambiguous queue/acceptance behavior.
- **Implications**: Persist runtime/device capability evidence with explicit `supported`/`unsupported`/`disabled` statuses, treat stale/missing capability evidence as explicit `unknown`, and use deterministic capability gate reason codes for validation/pull command classes.
- **Last updated**: `2026-03-23`

## DEC-056
- **ID**: `DEC-056`
- **Decision**: Execution gating now uses explicit command-class policy severity (`allow`/`warn`/`block`) with profile-based defaults (`compat`, `balanced`, `strict`) instead of implicit permissive fallthrough.
- **Status**: `Active`
- **Reason**: Production command trust requires deterministic policy outcomes; hidden compatibility fallbacks created queued-but-not-actionable ambiguity.
- **Implications**: `balanced` default blocks unsafe pull-path unknowns (missing active site lease/report, unknown version, unknown pull capabilities), keeps validation unknowns warning-visible for transition, and records policy decisions in gate details for operator explainability.
- **Last updated**: `2026-03-23`

## DEC-057
- **ID**: `DEC-057`
- **Decision**: Runtime-critical capability-schema preconditions must be enforced explicitly on heartbeat and batch-submit paths before any persistence mutation.
- **Status**: `Active`
- **Reason**: Missing capability-reporting migrations produced ambiguous `500` failures and partially-mutated runtime truth under drifted DB environments.
- **Implications**: Heartbeat/batch routes now fail deterministically with `RUNTIME_SCHEMA_NOT_READY` (`503`) when capability tables are absent; heartbeat writes run inside a transaction with precondition checks first; lifecycle DB guardrail tests now require capability migration/table presence.
- **Last updated**: `2026-03-23`

## DEC-058
- **ID**: `DEC-058`
- **Decision**: Pull-path site-context tightening remains staged, but `balanced` can now be explicitly elevated from transitional warning to deterministic block via rollout override (`EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT=true`) for `site_context_missing_for_pull`.
- **Status**: `Active`
- **Reason**: Runtime evidence shows site-less pull issuance is still common; immediate blanket blocking is unsafe, but indefinite warning-only behavior is also unsafe.
- **Implications**: Profile defaults remain stable (`compat=warn`, `balanced=warn`, `strict=block`), while operations can deliberately tighten `balanced` for pull issuance without redesigning the policy model; gate details now carry explicit site-context rollout/actionability hints.
- **Last updated**: `2026-03-23`

## DEC-059
- **ID**: `DEC-059`
- **Decision**: Keep `POST /api/simulation/run` as a bounded legacy surface and do not align it to `/api/simulate/*` semantics.
- **Status**: `Active`
- **Reason**: Repository/runtime evidence shows this route is materially different (baseline delta against `attendance_days`, date-bucket event query, no policy-effective projection) and forcing parity would expand scope/risk; ambiguity is lower when boundary is explicit.
- **Implications**: Marked deprecated/bounded (`legacy_surface=true`, `bounded_mode=baseline_delta_only`), reject modern simulation override fields on this route, and direct current simulation truth usage to `/api/simulate/day` and `/api/simulate/range`.
- **Last updated**: `2026-03-25`

## DEC-060
- **ID**: `DEC-060`
- **Decision**: Treat computed late-decision metadata parity (`reason_code`, `flags`) as a trusted cross-surface invariant for `/api/attendance`, `/api/simulate/day`, and `/api/simulate/range`.
- **Status**: `Active`
- **Reason**: Operators and what-if users lose trust when identical inputs/rules produce matching metrics but inconsistent decision metadata or cache-hit explanation fields.
- **Implications**: Keep route-specific payload shape differences, but preserve identical computed decision truth across trusted surfaces; attendance cache persistence now includes a `decision_snapshot` for deterministic cache-hit reconstruction; parity scripts must enforce these invariants in real harness runs.
- **Last updated**: `2026-03-24`

## DEC-061
- **ID**: `DEC-061`
- **Decision**: Treat newly observed K80 direction semantics as evidence-backed but provisional, and require a planning-only non-breaking pass before any ingestion mapping change.
- **Status**: `Active`
- **Reason**: Real capture evidence shows pull-ledger records (`0x05df -> 0x05dd`) can persist fresh punches as `OUT` (`status_code=1`) while separate `0x01f4` frames around the same punches carry changing state bytes (`00/01/04/05`) likely related to Entrée/Sortie semantics.
- **Implications**: Keep current behavior unchanged until a scoped planning pass defines safe integration and rollback path; scope this evidence to K80 case-study context only and avoid vendor-wide generalization without new protocol evidence.
  - Treat Arrivee/Depart/Prol.* preservation as unresolved in current ingestion truth; start any change with planning-only non-breaking design, and do not generalize K80 evidence to other ZKTeco models/firmware without model-specific proof.
- **Last updated**: `2026-03-24`

## DEC-062
- **ID**: `DEC-062`
- **Decision**: Handle observed K80 ATTLOG `0x07d0` pull-request divergence with a K80-only, OFF-by-default, reversible alternate branch; do not widen protocol acceptance globally.
- **Status**: `Active`
- **Reason**: Capture comparison shows some K80 runs continue successfully through `0x05e0 -> 0x05dc/0x05dd` after `0x05df` receives `0x07d0`, while current strict expectation (`0x05dd` only) rejects with `attlog_timeout`.
- **Implications**:
  - Keep direct `0x05df -> 0x05dd` path unchanged and preferred.
  - Treat `0x07d0` as branch signal only under explicit K80+TCP+flag guards.
  - Require non-empty `0x05dd` payload for branch success; `0x05dc` is intermediate marker only.
  - Preserve existing failure semantics when branch continuation is missing/ambiguous.
  - Keep this as protocol branch recovery only; no business direction/attendance/simulation semantic changes.
- **Last updated**: `2026-03-24`

## DEC-063
- **ID**: `DEC-063`
- **Decision**: Introduce K80 authoritative direction as a tiny, gated, allowlisted pilot override in normalization, with strict legacy fallback as the default.
- **Status**: `Active`
- **Reason**: Real K80 evidence shows a mismatch risk between pull-ledger `status_code` mapping and enriched `0x01f4` state semantics; safest first step is a narrow pilot that avoids global behavior change.
- **Implications**:
  - Apply only for K80-scoped paths (`vendor=zkteco`, `attlog_sequence=zktime_k80`) when `K80_DIRECTION_AUTHORITATIVE_ENABLED=true` and the device UID is explicitly allowlisted.
  - Require mapped enriched state (`00/04->IN`, `01/05->OUT`) plus `provisional_high` correlation confidence; otherwise keep legacy status-map direction.
  - Keep fallback reason markers for pilot observability and preserve non-target behavior.
  - Keep change local to pull normalization; no parser architecture rewrite, no attendance-engine changes, no backfill.
- **Last updated**: `2026-03-25`

## DEC-064
- **ID**: `DEC-064`
- **Decision**: Treat `requested_since_utc` authoritative source as the next safe control point for K80 post-protocol survival and apply a bounded, allowlisted upstream clamp in command queue shaping.
- **Status**: `Active`
- **Reason**: With dynamic `0x05e0` parity already yielding merged newer rows (`2026-04-01`), normalization reason buckets confirmed dominant drop cause is `requested_since_utc`; patching retrieval/protocol further is no longer the first safe lever for this loss.
- **Implications**:
  - Keep normalization gate intact globally; do not delete/bypass `requested_since_utc`.
  - Apply source fix only for allowlisted K80 parity path and only when source is cursor-derived (not explicit `options.since_utc`).
  - Clamp queued `requested_since_utc` to a bounded backfill floor and persist original/effective source diagnostics in command payload.
  - Success criterion is post-normalization survival of multiple newer `2026-04-01` rows without protocol-path changes.
- **Last updated**: `2026-04-01`

## DEC-065
- **ID**: `DEC-065`
- **Decision**: For allowlisted K80 queue shaping, make queue-time cursor bypass entry deterministic when `requested_since_utc` source is sync cursor and no explicit since is supplied.
- **Status**: `Active`
- **Reason**: Accepted-batch evidence on the working parity path still showed dominant normalization loss from `requested_since_utc` (`dropped_requested_since_utc_count=72/73`), and queue-time bypass non-entry kept effective since pinned near head.
- **Implications**:
  - Keep bypass OFF-by-default and allowlist-scoped via existing queue-bypass policy flags.
  - Keep protocol/parser/normalization semantics unchanged; this is queue-time source control only.
  - Bypass uses the existing bounded backfill source and now enters whenever source is sync cursor with no explicit since, with explicit reason diagnostics.
  - Measurement success is reduced `dropped_requested_since_utc_count` and higher normalized survival on accepted runs.
- **Last updated**: `2026-04-02`

## DEC-066
- **ID**: `DEC-066`
- **Decision**: Widen guarded K80 queue-time bypass backfill default window from 1 day to 7 days with a hard cap of 14 days, and persist queued backfill-minutes diagnostics.
- **Status**: `Active`
- **Reason**: Per-record keep/drop audit showed `requested_since_utc` remained the dominant post-protocol drop gate on accepted runs, with losses primarily historical and earlier than the previous 1-day threshold.
- **Implications**:
  - Scope remains queue-time K80 allowlist path only; no parser/protocol/normalization semantic changes.
  - Existing bypass guard and bounded model remain in force; only backfill window control was widened.
  - Queue diagnostics now include explicit `backfill_minutes_used` to support evidence-led tuning.
  - Immediate post-change measurement run failed operationally (`sent_timeout`, no batch), so survival impact remains unconfirmed.
- **Last updated**: `2026-04-02`

## DEC-067
- **ID**: `DEC-067`
- **Decision**: Treat K80 direction semantics as a separate feature/channel from pull-ledger ingestion, with later controlled reconciliation.
- **Status**: `Active`
- **Reason**: Capture evidence shows `0x01f4` direction semantics occur in a separate session context from pull-ledger `0x05dd`; runtime pull path does not reliably observe `0x01f4`, so forcing direction into pull normalization is unsafe.
- **Implications**:
  - Pull lane remains the authoritative attendance-fact lane; `device_events` facts stay immutable.
  - `0x01f4`-derived direction is stored as enrichment/overlay with explicit provenance and confidence, not as immediate overwrite during pull normalization.
- Merge/reconciliation of pull facts with realtime semantics happens later in an explicit, controlled layer; no pre-persist direction mutation in the pull lane.
- This is a planning/design direction only; no runtime behavior change is implied yet.
- **Last updated**: `2026-04-06`

## DEC-068
- **ID**: `DEC-068`
- **Decision**: For K80 direction investigation, evaluate event-time trust and IN/OUT-direction trust as separate judgments, not a single combined trust verdict.
- **Status**: `Active`
- **Reason**: Bounded four-surface evidence for a real `2026-04-10` anchor event showed pull fact lane time was correct while pull direction disagreed with user-confirmed direction; realtime direction matched user-confirmed IN/OUT but its persisted wall-clock time remained implausible/untrusted.
- **Implications**:
  - Keep `device_events.event_time_utc` as current trusted event-time anchor for this investigation.
  - Treat realtime direction signal quality separately from realtime wall-clock timestamp quality.
  - Do not use one lane's weakness on time to invalidate its direction signal, and do not use one lane's direction error to invalidate its time anchor.
  - Keep historical-direction outputs fallback/informational when RT-time pairing is untrusted or unmatched.
- **Last updated**: `2026-04-10`

## DEC-069
- **ID**: `DEC-069`
- **Decision**: Treat event-fact truth and direction-evidence truth as separate concerns, with later explicit linking/derivation between them.
- **Status**: `Active (design direction / working principle)`
- **Reason**: Current bounded evidence repeatedly shows pull fact lane is stronger for event-time capture while realtime direction can be stronger for provisional IN/OUT semantics on some anchors; mixing both trust judgments inside one lane caused repeated misclassification and review confusion.
- **Implications**:
  - `device_events` remains the event-fact lane and is primarily trusted for event occurrence/time/person/device.
  - Pull-carried direction is not automatically authoritative direction truth.
  - Realtime and historical direction paths are treated as direction-evidence lanes, not fact lanes.
  - Future work should keep linking/derivation explicit and auditable, instead of collapsing time-trust and direction-trust into one lane verdict.
- **Last updated**: `2026-04-10`

## DEC-070
- **ID**: `DEC-070`
- **Decision**: Fresh normal-pull fact inserts must trigger post-commit best-effort derived-direction attachment upsert for the same fact ids.
- **Status**: `Active`
- **Reason**: Fresh fact anchors were entering `device_events` without derived attachments because attachment writers were only on historical-direction paths, leaving fresh anchors un-attached until separate worker runs.
- **Implications**:
  - Pull ingest now triggers `deriveAndUpsertDirectionAttachmentForFactEvent(...)` for inserted fact ids only.
  - Attachment failures are observable (`k80_fresh_fact_attachment_*`) and must not roll back fact insertion.
  - Existing fact lane (`device_events`) remains immutable; this is additive attachment creation only.
- **Last updated**: `2026-04-13`

## DEC-071
- **ID**: `DEC-071`
- **Decision**: Treat synchronized fresh pipeline validation as proven end-to-end under correct runtime alignment/policy truth; do not reopen Phase 1 or fresh attachment viability questions without new contradictory evidence.
- **Status**: `Active`
- **Reason**: Fresh synchronized live chain for K80 completed with RT insert -> Phase 1 trigger -> auto pull -> accepted pull batch -> fresh fact insert -> derived attachment creation for same fact id -> diagnostics consumer side-by-side legacy+derived output.
- **Implications**:
  - Runtime/process policy truth is a mandatory prerequisite gate for live validation interpretation.
  - Current blocker space shifts from invocation/fact-anchor/attachment construction to semantic direction conflict handling between pull and RT evidence.
  - Future reviews should not classify pipeline failure when realtime policy is OFF in the serving runtime.
- **Last updated**: `2026-04-13`

## DEC-072
- **ID**: `DEC-072`
- **Decision**: Freeze current K80 support baseline as explicit classification contract (`baseline_supported`, `conditional`, `experimental`, `obsolete_superseded`) before any removal/isolation cleanup slices.
- **Status**: `Active`
- **Reason**: Core live chain is proven, but codebase cleanliness remains mixed due to broad guarded K80 branches and policy-gated paths; cleanup safety requires a stable contract boundary before behavior-changing work.
- **Implications**:
  - `contracts/k80SupportBaselineContract.js` is the additive machine-readable classification source for cleanup sequencing.
  - `docs/K80_SUPPORT_BASELINE_CONTRACT.md` is the human-readable baseline guide for operators/developers.
  - This decision does not change runtime semantics; later cleanup phases can reference this contract for isolate/remove actions.
- **Last updated**: `2026-04-13`

## DEC-073
- **ID**: `DEC-073`
- **Decision**: Enforce an explicit experimental isolation boundary for deep K80 protocol families so they cannot influence production baseline behavior unless intentionally enabled via experimental profile gate.
- **Status**: `Active`
- **Reason**: Baseline contract marked deep continuation/recovery families as experimental; code-level boundary was required so experimental branches are auditable and non-silent in production interpretation.
- **Implications**:
  - Experimental deep K80 protocol families now require `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED=true` (plus optional device/family allowlists) in addition to existing branch-specific flags.
  - Baseline-supported and conditional production paths (normal pull chain, Phase 1 trigger, fact insert, attachment creation, diagnostics consumer contract) remain unchanged in this slice.
  - This is isolation-before-deletion; no branch removal is implied yet.
- **Last updated**: `2026-04-13`

## DEC-074
- **ID**: `DEC-074`
- **Decision**: Freeze K80 runtime control ownership/classification in an explicit flag-hygiene contract so operational policy truth and future cleanup work are evidence-based, auditable, and not tribal.
- **Status**: `Active`
- **Reason**: K80 baseline and experimental boundaries are now contract-frozen, but `K80_*` control sprawl still created operational ambiguity; explicit ownership and classification mapping was required before safe later cleanup/removal slices.
- **Implications**:
  - `contracts/k80FlagOwnershipContract.js` is the machine-readable source for K80 control families (`baseline`/`conditional`/`experimental`/`obsolete_superseded`/`unclear`) and owner subsystem.
  - `docs/K80_FLAG_OWNERSHIP_CONTRACT.md` is the human-readable operations companion and runbook alignment reference.
  - This slice is classification-only; runtime behavior remains unchanged.
- **Last updated**: `2026-04-13`

## DEC-075
- **ID**: `DEC-075`
- **Decision**: Reclassify `queue_bypass_state_snapshot` as `obsolete_superseded` and separate it from the remaining `queue_cursor_source_fix_family` unclear set.
- **Status**: `Active`
- **Reason**: Bounded sub-control review confirmed `queue_bypass_state_snapshot` is diagnostics-only/write-only, has no in-repo consumer/read path, and does not influence queue/ingest runtime decisions; it is the safest first deprecation target in the unclear family cleanup sequence.
- **Implications**:
  - `contracts/k80FlagOwnershipContract.js` now tracks `queue_bypass_state_snapshot` as a standalone obsolete/superseded control with explicit future cleanup hint.
  - `docs/K80_FLAG_OWNERSHIP_CONTRACT.md` now reflects this control as deprecated diagnostics-only and not part of supported baseline interpretation.
  - Runtime behavior remains unchanged in this slice; removal/isolation can be handled safely in a later bounded cleanup slice.
- **Last updated**: `2026-04-13`

## DEC-076
- **ID**: `DEC-076`
- **Decision**: Reclassify `cursor_source_fix` from `unclear` to `conditional` with an explicit parity prerequisite and explicit non-baseline interpretation.
- **Status**: `Active`
- **Reason**: Direct runtime evidence showed `cursor_source_fix` was not used in the proven synchronized baseline chain (`2026-04-13` milestone batches had `enabled=false`, `entered=false`), but it did enter in two real historical batches where parity was true and pull path was `alternate_07d0_followup`; therefore it is neither baseline-supported nor obsolete.
- **Implications**:
  - `contracts/k80FlagOwnershipContract.js` now tracks `cursor_source_fix` as its own conditional control (`K80_CURSOR_SOURCE_FIX_*`) with parity-coupled operational note.
  - `docs/K80_FLAG_OWNERSHIP_CONTRACT.md` now states `cursor_source_fix` is conditional, parity-coupled, and not part of the current supported synchronized baseline chain.
  - Runtime behavior remains unchanged; this slice resolves classification ambiguity and keeps removal blocked pending further bounded evidence.
- **Last updated**: `2026-04-13`

## DEC-077
- **ID**: `DEC-077`
- **Decision**: Introduce direction-authority strategy registry + device-profile resolver as additive foundation only, while pinning effective derived-direction behavior to legacy fallback in this slice.
- **Status**: `Active`
- **Reason**: Direction authority must be modeled per device/vendor support profile over time, but immediate global RT-vs-pull behavior change is unsafe; first safe step is structural contract/resolution plumbing with no outcome flip.
- **Implications**:
  - `contracts/directionAuthorityStrategyContract.js` is now the machine-readable strategy registry (`legacy_fallback_default`, `zk_k80_rt_preferred_when_eligible`, `unknown_vendor_default`).
  - `services/directionAuthorityStrategyResolver.js` resolves strategy by precedence (device-profile override -> vendor/model default -> safe fallback) and emits effective strategy pinned to legacy behavior for this slice.
  - `historicalDirectionWorkerService` now persists resolved/effective strategy metadata in derived attachment `source_metadata` for auditability, without changing derived-direction selection outcome.
- **Last updated**: `2026-04-14`

## DEC-078
- **ID**: `DEC-078`
- **Decision**: Treat enrollment packet mapping as a staged evidence contract; allow planning from current capture phase markers, but block runtime implementation until one bounded confirmation pass validates field-level command semantics.
- **Status**: `Active`
- **Reason**: Four enrollment captures provide strong branch/phase markers (`0x003e`/`0x003d`/`0x01f4` loop and success-associated `0x05df -> 0x05dd`) but still leave field-level semantics vendor-unconfirmed for some bytes and transitions.
- **Implications**:
  - `docs/ZK_ENROLLMENT_CAPTURE_ANALYSIS.md` is now the durable reference for enrollment-phase candidates, confidence labels, and guardrails.
  - Future enrollment work must preserve uncertainty labels (`confirmed`/`likely`/`possible`/`unclear`) and avoid overclaiming protocol meaning until bounded confirmation evidence is collected.
- **Last updated**: `2026-04-14`

## DEC-079
- **ID**: `DEC-079`
- **Decision**: Treat device-user inventory retrieval as a required prerequisite state layer for enrollment ID safety; persist inventory snapshots with explicit confidence/completeness before candidate ID allocation slices.
- **Status**: `Active`
- **Reason**: `users.pcapng` confirms user-record-bearing inventory retrieval is available, but count-field mapping/paging guarantees remain unresolved; safe progression requires explicit confidence and auditable snapshot state before ID allocation/enrollment execution.
- **Implications**:
  - `device_user_inventory_snapshots` is now the additive persistence foundation for parsed device user IDs + evidence refs + confidence/completeness.
  - Phase 1 endpoints are bounded to snapshot-state only (`POST/GET .../user-inventory-snapshots`), with no enrollment execution and no auto-commit allocator behavior.
  - Future allocation/enrollment slices must consume snapshot confidence/completeness state and must not infer `device_user_id` truth from attendance pulls alone.
- **Last updated**: `2026-04-14`

## DEC-080
- **ID**: `DEC-080`
- **Decision**: Use a conservative, non-committing `max+1` candidate strategy for K80 only when inventory snapshot confidence/completeness are explicitly sufficient; otherwise block candidate emission with explicit reason.
- **Status**: `Active`
- **Reason**: Current device-user inventory evidence is planning-strong but not universally proven for count/paging semantics. Safe progression requires explicit gating and auditable blocked states instead of unsafe auto-assignment.
- **Implications**:
  - Candidate evaluation is now snapshot-derived and read-only; enrollment execution and allocator commit remain out of scope.
  - Read model now distinguishes `ready` vs explicit blocked states (`insufficient_confidence`, `insufficient_completeness`, `invalid_parsed_ids`, etc.) with `requires_manual_override` flag.
  - ID truth remains inventory-driven and explicitly excludes attendance-pull inference.
- **Last updated**: `2026-04-14`

## DEC-081
- **ID**: `DEC-081`
- **Decision**: Gate enrollment readiness behind explicit preflight evaluation over inventory snapshot truth, with operator manual override allowed only as explicit/auditable/collision-checked input.
- **Status**: `Active`
- **Reason**: Candidate generation is conservative and non-committing; operators still need a safe path when auto-candidate is blocked. The system must not silently bypass blocked states or start enrollment without explicit preflight outcome.
- **Implications**:
  - Enrollment preflight is now a dedicated operator step (`POST /api/agent-admin/devices/{device_uid}/enrollment-preflight`) with explicit outcome statuses and blocked reasons.
  - Manual override is accepted only when parse-valid and non-colliding with known parsed ID set; invalid/colliding override remains blocked.
  - Decisions are audit-persisted in `device_user_id_preflight_decisions` and remain non-committing (no device write, no enrollment execution).
- **Last updated**: `2026-04-14`

## DEC-082
- **ID**: `DEC-082`
- **Decision**: Enrollment orchestration start is now gated by latest-ready preflight decision and persists an explicit attempt lifecycle before any protocol execution semantics are attached.
- **Status**: `Active`
- **Reason**: Current protocol field semantics are still partially unresolved; safe progress requires orchestration/audit scaffolding now, while keeping execution classification conservative and placeholder-driven.
- **Implications**:
  - Enrollment attempt start endpoint exists and enforces preflight readiness/recency (`preflight_decision_not_latest`, `preflight_decision_not_ready`, etc. block start).
  - Selected `device_user_id` provenance is explicit (sourced from approved preflight only; no attendance inference).
  - Attempt lifecycle persistence exists (`device_enrollment_attempts`) with explicit separation between orchestration acceptance and future protocol execution result.
- **Last updated**: `2026-04-14`

## DEC-083
- **ID**: `DEC-083`
- **Decision**: Attach K80 enrollment protocol execution through the existing attempt lifecycle using conservative, chain-based evidence classification and explicit uncertainty guards.
- **Status**: `Active`
- **Reason**: Preconditions/preflight/orchestration foundations were already in place; the next safe step is executable lifecycle progression without overclaiming unresolved packet-field semantics.
- **Implications**:
  - Enrollment execution is now command-driven (`RUN_K80_ENROLLMENT_ATTEMPT`) and auditable across queue -> sent -> result acknowledge paths.
  - Attempt status transitions are explicit (`pending -> starting -> in_progress -> terminal`) and terminal success requires `0x05df -> 0x05dd` chain evidence.
- Non-success outcomes remain conservative (`cancelled` or `partial_or_failed`), raw evidence refs are preserved, and unresolved `0x003d`/`0x01f4` semantics remain explicitly guarded.
- **Last updated**: `2026-04-14`

## DEC-084
- **ID**: `DEC-084`
- **Decision**: Introduce a default-off guarded 26-byte `0x003d` enrollment-selection builder path with explicit offset diagnostics, while preserving legacy 8-byte behavior and conservative result classification.
- **Status**: `Active`
- **Reason**: Official success captures prove a 26-byte selection scaffold (`02..23=0x00`, `25=0x01`) with ID-linked offset `01` and finger-linked offset `24`, while offset `00` remains unresolved. Current 8-byte placeholder is the first confirmed structural divergence before missing progression.
- **Implications**:
  - New guarded path is runtime-flagged (`K80_ENROLL_003D_26B_GUARDED_ENABLED`) and OFF by default; guard-off remains legacy 8-byte payload unchanged.
  - Guard-on emits a 26-byte payload with explicit unresolved handling at offset `00` (deterministic default), ID-linked offset `01`, finger-linked offset `24`, and stable scaffold bytes.
  - Source metadata now records `selection_payload_version`, `selection_payload_len`, `selection_offset_00_emitted`, `selection_offset_01_emitted`, `selection_offset_24_emitted`, and `unresolved_003d_offset_00=true` for auditability.
  - No other enrollment protocol step changed in this slice.
- **Last updated**: `2026-04-16`

## DEC-085
- **ID**: `DEC-085`
- **Decision**: Treat enrollment protocol feature-flag truth as execution-runtime scoped (agent process), not API-server scoped.
- **Status**: `Active`
- **Reason**: A bounded guarded-`0x003d` live run was launched with `K80_ENROLL_003D_26B_GUARDED_ENABLED=true` on the API server, yet execution metadata still reported legacy selection payload basis (`conservative_placeholder_unresolved_003d_layout_v1`) and missing guarded payload diagnostics, proving flag scope mismatch at runtime.
- **Implications**:
  - Enrollment protocol flags must be verified in the active agent execution runtime before interpreting guarded-path validation outcomes.
  - API-server environment alone is insufficient evidence that agent-side protocol runner flags are active.
  - Live validation readiness must include execution-runtime flag proof to avoid false negatives.
- **Last updated**: `2026-04-16`

## DEC-086
- **ID**: `DEC-086`
- **Decision**: Device operations monitoring sessions are SaaS control-plane leases until an explicit agent runtime command contract is added.
- **Status**: `Active`
- **Reason**: The no-refresh device operations interface needs backend session/stream contracts now, but current K80 TCP/RT runtime ownership must remain unchanged after validation/freeze.
- **Implications**:
  - `device_monitoring_sessions` represents operator intent/lease state only; it does not replace `site_agent_leases` or `device_managing_agent_bindings`.
  - Active monitoring session truth requires an unexpired `starting`/`active` row plus existing managed-device, managing-agent binding, and execution-gate eligibility.
  - API responses must keep `monitoring_control_plane_only=true` and `agent_runtime_command_wired=false` until a later bounded command contract wires real runtime start/stop behavior.
  - Realtime observation listing/SSE is DB-backed read/stream surface only and must not trigger K80 parser/protocol/subscriber actions.
- **Last updated**: `2026-04-30`

# Do Not Repeat
- Do not treat ping success as device manageability.
- Do not assume port `4370` is open just because a host is reachable.
- Do not treat discovery success as ingestion success.
- Do not start multi-vendor work before ZKTeco reliability is proven.
- Do not widen scope before trust-boundary hardening.
- Do not assume locked devices are rare edge cases.
- Do not rewrite architecture before operational gaps are proven.
- Do not mark write-route hardening complete without runtime viewer-role `403` checks.
- Do not let manual operator remediation actions set proof-backed states (`manageable` / `ingesting`) without ingestion evidence.
- Do not enqueue duplicate `PULL_DEVICE_EVENTS` commands while one is already `queued` or `sent` for the same agent/device/tenant.
- Do not split operator-critical workflows across multiple competing dashboards.
- Do not treat managed+historically-successful devices as immediately executable without checking active site runtime ownership, fresh reported runtime state, and version support status.
- Do not assume all ZKTeco devices behave the same on port `4370`.
- Do not treat successful ping/open-port checks as protocol compatibility proof.
- Do not mix device protocol debugging with business-feature phase execution.
- Do not treat command-ID discovery as success; verify full post-auth sequence state/parity.
- Do not declare pull compatibility until direct payload-bearing pull response is captured and archived.
- Do not treat K80 `0x01f4` direction-state observations as vendor-confirmed truth or as universal ZKTeco semantics without model/firmware-specific proof.
- Do not treat enrollment capture command candidates (`0x003e`/`0x003d`/`0x01f4`/`0x05df`/`0x05dd`) as field-level confirmed protocol semantics until one bounded confirmation pass validates byte-level meaning.
- Do not classify enrollment success from standalone `0x05dd`; require `0x05df -> enrollment-session 0x05dd` chain context plus surrounding phase evidence.
- Do not treat guarded `0x003d` offset `00` emission as confirmed semantics; keep it explicitly unresolved until clean controlled capture isolation is complete.
- Do not assume API-server feature-flag environment automatically applies to agent-side enrollment execution runtime.
- Do not infer next safe `device_user_id` from attendance pulls alone; require explicit device user-inventory retrieval confidence first.
- Do not start enrollment from candidate lookup alone; require explicit enrollment preflight outcome (`ready_auto_candidate` or `ready_manual_override`) in the current inventory snapshot context.
- Do not start K80 enrollment orchestration without a latest-ready preflight decision id; reject stale or non-ready preflight decisions instead of inferring fallback device_user_id.
- Do not mark K80 enrollment attempt `success` without explicit `0x05df -> 0x05dd` chain evidence; downgrade to conservative non-success when chain proof is missing.
- Do not collapse time correctness and direction correctness into one trust judgment when evaluating K80 pull vs realtime evidence.
- Do not treat pull-carried direction as automatically authoritative direction truth; treat it as one direction evidence source until explicit linking/derivation resolves direction for a fact event.
- Do not start K80 cleanup removals/isolation before baseline-vs-conditional-vs-experimental classification is frozen and referenced.
- Do not treat deep K80 protocol-recovery branches as production baseline behavior unless the explicit experimental profile gate is enabled and evidenced.
- Do not toggle or interpret `K80_*` controls in production without first checking their owner/classification contract (`contracts/k80FlagOwnershipContract.js`) and live process policy truth.
- Do not implement K80 direction remapping directly in runtime code without a planning-only, non-breaking design pass that defines evidence boundaries, fallback behavior, and rollback safety.
- Do not assume current K80 pull-ledger ingestion already preserves Arrivee/Depart/Prol.* semantics; today it persists flattened `IN/OUT` from pull status mapping.
- Do not treat K80 `0x07d0` at ATTLOG pull-request as success by itself; success requires safe continuation to non-empty `0x05dd` payload under explicit K80-gated branch conditions.
- Do not assume fixed K80 `0x05e0` followup payload `00000000f4050000` is parity-safe when capture-backed immediate `0x05df` state supports dynamic app-like derivation (`000000006c0b0000` family).
- Do not treat cursor-derived `requested_since_utc` as inherently safe after protocol parity is restored; audit and bound its source before changing normalization gates.
- Do not place feature-gate/policy initialization after unconditional returns in protocol handlers; guard state must be initialized in reachable scope before step evaluators consume it.
- Do not assume one fixed record boundary/offset layout for all `0x05dd` payloads; score multiple candidate layouts and require timestamp sanity checks.
- Do not classify suspicious decoded timestamps as parser corruption until on-device date/time is verified; clock trust must be checked as a separate operational gate.
- Do not assemble alternate-branch `0x05dd` body from bounded diagnostic hex when raw frame payload bytes are already available; diagnostics hex is for observability and can be truncated by design.
- Do not treat probe success as canonical SaaS onboarding completion.
- Do not leave real-device validation evidence out-of-band from SaaS lifecycle/`/boss` operational surfaces.
- Do not mutate `devices.device_uid` after creation to solve identity drift.
- Do not auto-promote candidate devices to managed state.
- Do not mix ingest-only clutter with bridge-operational default `/boss` truth.
- Do not run lifecycle cleanup/reclassification SQL until `scripts/db/lifecycle-coherence-integrity-report.sql` is reviewed and strict anomaly counts are understood.
- Do not broaden controlled lifecycle repair writes beyond approved strict deterministic classes without a new evidence-backed slice decision.
- Do not assume discovery alone is enough to onboard real devices.
- Do not treat manual DB edits/enrichment as the normal long-term onboarding workflow.
- Do not assume a visible device row means operational readiness/actionability.
- Do not assume one agent should equal one device.
- Do not treat Docker as the default Local Agent runtime before site/customer fit is proven.
- Do not continue soft/inferred site ownership forever; formalize explicit site runtime ownership/lease semantics.
- Do not mix desired state and reported runtime state into one ambiguous operational truth.
- Do not treat local runtime reports as authoritative SaaS control-plane truth.
- Do not treat runtime health/version support as proof that every command class/device path is executable; require explicit capability truth.
- Do not silently treat missing capability evidence as supported truth.
- Do not jump into Docker-first execution before service-based site operating model is stabilized.
- Do not prioritize runtime packaging/governance implementation before site/control-plane ownership and state-separation contracts are formalized.
- Do not keep using soft `site_label` metadata as canonical site identity once formal `site_id` is available.
- Do not infer active site runtime ownership from heartbeat/discovery alone; use explicit site lease assignment/reassignment records.
- Do not silently switch active site runtime ownership without auditable supersession/release evidence.
- Do not treat historical success (`last successful pull`/`last validation success`) as live runtime truth without fresh reported-state evidence.
- Do not collapse desired/control-plane state, reported/runtime state, and historical ledger evidence into one ambiguous operational status field.
- Do not reuse provisioning/bootstrap tokens as durable runtime credentials.
- Do not authenticate agent runtime requests against revoked/replaced identities.
- Do not conflate runtime identity rotation/revocation with site active-lease reassignment.
- Do not perform silent runtime credential replacement without explicit operator intent and audit evidence.
- Do not return trusted simulation/attendance computed payloads without stable decision metadata (`reason_code`, `flags`) for identical input/rule conditions.
- Do not treat `/boss` as throwaway after it already contains real lifecycle logic.
- Do not create a second competing primary operations dashboard.
- Do not design operator UI around one-agent-one-device assumptions.
- Do not mix live-now actionability and historical proof without an explicit distinction.
- Do not delete working operational surfaces before a verified replacement exists.
- Do not expose device communication/authentication secrets in local diagnostics payloads or UI views.
- Do not replay buffered agent batch submissions without preserving the original stable `delivery_id` across retries/reconnects.
- Do not treat reported agent version strings in diagnostics as sufficient governance truth; enforce control-plane minimum/target policy evaluation.
- Do not conflate runtime health (`online/offline`) with version compatibility (`supported/outdated/unsupported/unknown`).
- Do not block runtime execution solely because policy status is `outdated` in this phase; use explicit operator attention surfaces until rollout enforcement phases are approved.
- Do not treat policy `warn` outcomes as equivalent to pull-path executability guarantees; unresolved warnings must still be operationally visible and intentionally managed.
- Do not reintroduce implicit permissive fallback for unknown lease/report/version/capability truth in pull-path issuance; keep policy profile and reason-code behavior explicit and tested.
- Do not run post-Phase schema-dependent runtime code on partially migrated DBs; capability/reporting migration drift can surface as `500` heartbeat/batch failures and command-truth ambiguity.
- Do not classify `runtime_schema_not_ready` (`503`) as device/protocol failure; treat it as environment migration/schema drift and fix DB readiness first.
- Do not judge synchronized pipeline failure before first proving realtime-policy truth and allowlist scope in the same live serving process.
- Do not enable `EXECUTION_GATE_BALANCED_PULL_REQUIRE_SITE_CONTEXT=true` blindly; verify site assignment coverage and monitor `site_context_missing_for_pull` conflict volume before rollout.
- Do not treat `/api/simulation/run` as a parity-equivalent surface to `/api/simulate/day` or `/api/simulate/range`; it is a bounded legacy baseline-delta endpoint.
- Do not reference block-local queue diagnostics variables outside their declaration scope in ingest-critical paths (`/api/agent/device-events/batch`); this can cause deterministic internal errors and cascade into `sent_timeout` command failures.
- Do not call `deriveAndUpsertDirectionAttachmentForFactEvent(...)` from ingest-trigger paths without full scope (`companyId`, `agentId`, `deviceUid`); missing scope yields `invalid_scope` and attachment gaps even when fact inserts succeed.
- Do not pass `{ requestedDeviceUid }` into `resolveCanonicalDeviceUidForOperations(...)` or dereference `canonicalResolution.value.*`; this resolver contract is `{ companyId, deviceUid }` with top-level canonical fields.

# 9. Known Device Reality / Field Notes
- `Confirmed (field reality)`: devices can be discoverable/reachable at network level but still not manageable at protocol level.
- `Confirmed (code paths)`: discovery and pull diagnostics include failure reasons such as `auth_required`, `auth_failed`, `connect_timeout`, `network_unreachable`, `attlog_timeout`, `empty_data`.
- `Confirmed (field evidence 2026-03-16)`: ZKTeco K80 Pro (`ZLM60_TFT`, firmware `8.0.4.1-20190803`, IP `192.168.22.201`, port `4370`, communication key `1234`, device number `1`) is reachable/manageable via official ZKTime 5.0 over Ethernet; Wireshark confirms TCP transport with wrapper bytes consistent with `50 50 82 7d`.
- `Confirmed (case-study completion)`: In-project probe now reproduces successful K80 pull path with direct payload-bearing pull response:
  - `DeviceID`,
  - status probe (`0x0bb6`),
  - pre-size step (`0x03eb` with `10270000`),
  - size query (`0x0032`),
  - pull request (`0x05df` with corrected 11-byte payload `010d000000000000000000`),
  - direct pull response (`0x05dd`) with real payload (`444` bytes observed).
- `Confirmed`: Final K80 blocker was pull-request payload-shape mismatch, not network/auth/session discovery.
- `Confirmed` (capture evidence 2026-03-24): in a real pull-ledger download window around fresh `11:50` punches, `0x05dd` decoded fresh records had `status_code=1` and current map persisted them as `OUT`; same window also contained separate `0x01f4` frames with state-byte changes (`00/01/04/05`) that likely encode direction-state semantics not preserved by the current pull-centric path.
- `Confirmed`: candidate discovery does not equal managed ingestion readiness.
- `Confirmed`: claim/managed gate exists before pull pipeline.
- `Open`: fleet quality is expected to vary significantly by site, firmware, and provisioning practices.
- `Operational rule`: treat locked/unprovisioned devices as a normal onboarding state, not exceptional edge case.

## K80 Direction Handling (Current State)
- `Confirmed`: Current accepted K80 pull ingestion path is pull-ledger based (`0x05df -> 0x05dd`) through existing parser/adapter flow.
- `Confirmed`: Direction currently persists from parsed pull status via `defaultStatusMap`:
  - `0 -> IN`
  - `1 -> OUT`
  - `2 -> IN`
  - `3 -> OUT`
  - `4 -> IN`
  - `5 -> OUT`
- `Confirmed`: Under this current behavior, fresh pulled rows with `status_code=1` persist as `OUT`.
- `Confirmed`: A separate `0x01f4` real-time-like signal was observed around the same fresh punches with varying byte values `00 / 01 / 04 / 05`.
- `Inferred` (K80-scoped, provisional): this `0x01f4` signal likely carries direction-state semantics that ZKTime uses for Entrée/Sortie distinction, while current pull-ledger persistence does not preserve that richness.
- `Inferred` (K80-scoped, provisional mapping):
  - `00 = Entree`
  - `01 = Sortie`
  - `04 = Prol.entree`
  - `05 = Prol.sortie`
- `Open`: Vendor-confirmed semantic meaning and merge strategy with `0x05dd status_code` remain unresolved.

# 10. Error Catalog
Use this schema for recurring issues:
- **ID**
- **Title**
- **Symptoms**
- **Likely cause**
- **Confirmed cause**
- **Resolution**
- **Status**
- **Last updated**
- **Related files / areas**

## Error Entry Template
- **ID**: `ERR-XXX`
- **Title**: `<short error title>`
- **Symptoms**: `<observable behavior>`
- **Likely cause**: `<best current hypothesis>`
- **Confirmed cause**: `Open` or `<validated cause>`
- **Resolution**: `<current resolution or remediation>`
- **Status**: `Open | Active | Monitoring | Resolved`
- **Last updated**: `YYYY-MM-DD`
- **Related files / areas**:
  - `<path-or-area-1>`
  - `<path-or-area-2>`

## ERR-001
- **ID**: `ERR-001`
- **Title**: Device reachable by ping, protocol path unavailable
- **Symptoms**: Ping succeeds; ZKTeco protocol port/handshake fails; management tools cannot connect.
- **Likely cause**: Device locked, service disabled, wrong provisioning state, or network filtering.
- **Confirmed cause**: `Open` (field-specific root cause not fully confirmed).
- **Resolution**:
  - classify as not manageable,
  - preserve diagnostics (`auth_required`, `connect_timeout`, etc.),
  - route to remediation workflow (field unlock/reprovisioning),
  - expose/manage explicit manageability + manual remediation state in API.
- **Status**: `Active`
- **Last updated**: `2026-03-13`
- **Related files / areas**:
  - `agent/lib/discovery/zktecoAdapter.js`
  - `agent/lib/events/zktecoPullAdapter.js`
  - `api/agentAdmin.routes.js`
  - `services/deviceManageability.js`

## ERR-002
- **ID**: `ERR-002`
- **Title**: Discovered device not ingest-ready
- **Symptoms**: Device appears in discovery candidate list but pull command fails (`device_not_managed` / host unknown / pull diagnostics failure).
- **Likely cause**: Candidate not claimed, missing stable metadata, or unresolved connectivity/auth path.
- **Confirmed cause**: `Confirmed` for managed-status and host checks in command queue path.
- **Resolution**:
  - enforce claim -> managed transition,
  - ensure connection host/metadata available before pull.
- **Status**: `Active`
- **Last updated**: `2026-03-10`
- **Related files / areas**:
  - `services/agentDeviceEventsService.js`
  - `services/agentBridgeDb.js`
  - `api/agentAdmin.routes.js`

## ERR-003
- **ID**: `ERR-003`
- **Title**: Tenant/auth route inconsistency risk
- **Symptoms**: Some tenant-scoped routes are protected; others are not uniformly guarded.
- **Likely cause**: Incremental route growth without uniform middleware policy.
- **Confirmed cause**: `Confirmed` by route-level middleware differences.
- **Resolution**:
  - completed Phase 1 hardening for scoped tenant routes:
    - `/api/devices` (+`/:deviceUid`),
    - `/api/company-profile`,
    - `/api/employee-assignments`,
    - `/api/simulate/day`,
    - `/api/simulate/range`,
    - `/api/simulation/run`,
  - runtime-verified auth + tenant-scope behavior with contract checks,
  - added viewer-role negative checks on simulate write routes to prevent regression.
- **Status**: `Monitoring` (Phase 1 scope resolved; keep monitoring other route families)
- **Last updated**: `2026-03-12`
- **Related files / areas**:
  - `api/lib/auth.js`
  - `api/devices.routes.js`
  - `api/companyProfile.routes.js`
  - `api/employeeAssignments.routes.js`
  - `api/simulate.routes.js`
  - `api/simulation.routes.js`

## ERR-005
- **ID**: `ERR-005`
- **Title**: Auth-mode verification blocked by missing `api_keys` schema path
- **Symptoms**: `apply-seeds -Profile ci` fails with `relation "public.api_keys" does not exist`, blocking DB-backed API key auth setup in that path.
- **Likely cause**: Schema/seed drift around `api_keys` table lifecycle.
- **Confirmed cause**: `Confirmed` in local Phase 1 verification run.

## ERR-006
- **ID**: `ERR-006`
- **Title**: Enrollment runner terminal return referenced out-of-scope `selectionPayload`
- **Symptoms**: Guarded-runtime enrollment attempts failed with `protocol_execution_state=runner_exception` and `status_reason=selectionPayload is not defined` before marker progression.
- **Likely cause**: `selectionPayload` defined inside `try` and read in terminal return metadata outside that scope.
- **Confirmed cause**: `Confirmed` in `runK80EnrollmentAttempt` return path (`agent/lib/events/zktecoPullAdapter.js`).
- **Resolution**:
  - initialize `selectionPayload` metadata defaults before entering `try`,
  - assign built payload into that pre-declared variable inside `try`,
  - keep guarded/legacy builder behavior unchanged.
- **Status**: `Resolved`
- **Last updated**: `2026-04-16`
- **Related files / areas**:
  - `agent/lib/events/zktecoPullAdapter.js`
  - `tests/agent_events/zktecoPullAdapter.pull.test.js`
- **Resolution**:
  - use fallback API keys (`DEFAULT_API_KEY*`) for current auth-mode contract verification,
  - keep DB schema/seed alignment as explicit follow-up hardening work.
- **Status**: `Active`
- **Last updated**: `2026-03-12`
- **Related files / areas**:
  - `services/auth/apiKeyProvider.js`
  - `seeds/010_demo_ci.sql`
  - `scripts/db/apply-seeds.ps1`

## ERR-006
- **ID**: `ERR-006`
- **Title**: Pull commands can remain stuck in non-terminal states without reconciliation
- **Symptoms**: Commands linger in `queued` past TTL or `sent` without ack, creating stale in-flight state and blocking retries/visibility.
- **Likely cause**: Missing lifecycle reconciliation path before poll/list/queue workflows.
- **Confirmed cause**: `Confirmed` before Phase 3 implementation.
- **Resolution**:
  - add deterministic server-side reconciler for queued expiry and stale sent timeout,
  - set explicit lifecycle `failure_reason` and `result_payload` transitions,
  - run reconciler before command poll, lifecycle list, and pull queue path.
- **Status**: `Resolved`
- **Last updated**: `2026-03-14`
- **Related files / areas**:
  - `services/agentBridgeDb.js`
  - `services/agentDeviceEventsService.js`
  - `api/agentAdmin.routes.js`


## ERR-004
- **ID**: `ERR-004`
- **Title**: Docs/CI drift and execution mismatch
- **Symptoms**: stale endpoint counts, workflow parameter mismatch, and historical doc-state divergence.
- **Likely cause**: fast feature evolution without synchronized docs/automation updates.
- **Confirmed cause**: `Confirmed` (specific mismatches observed in repo).
- **Resolution**:
  - align CI scripts and workflow parameters,
  - regenerate/update endpoint inventory docs and runbook references.
- **Status**: `Open`
- **Last updated**: `2026-03-10`
- **Related files / areas**:
  - `README.md`
  - `.github/workflows/ci-smoke.yml`
  - `tests/run-suite.ps1`
  - `docs/openapi/*`

## ERR-007
- **ID**: `ERR-007`
- **Title**: K80 pull request returns `0x137d` instead of direct payload response
- **Symptoms**: Connect/auth/preflight/size query succeed, but `0x05df` pull request returns `0x137d` and no payload.
- **Likely cause**: Final pull request packet-shape mismatch despite otherwise correct sequencing.
- **Confirmed cause**: `Confirmed` for K80 case study; `0x05df` payload length mismatch (10-byte probe payload vs successful 11-byte field path).
- **Resolution**:
  - keep proven post-auth sequence (`DeviceID` -> `0x0bb6` -> `0x03eb` -> `0x0032`),
  - correct `0x05df` payload to `010d000000000000000000` (11 bytes),
  - validate direct `0x05dd` payload response and archive diagnostics.
- **Status**: `Resolved`
- **Last updated**: `2026-03-16`
- **Related files / areas**:
  - `agent/lib/events/zktecoPullAdapter.js`
  - `scripts/agent/pull-events-probe.js`
  - `docs/DEVICE_VALIDATION_PLAYBOOK.md`

## ERR-008
- **ID**: `ERR-008`
- **Title**: `0x05dd` payload decodes into invalid timestamps/user IDs under fixed offsets
- **Symptoms**: Protocol sequence succeeds and payload bytes are returned, but decoded attendance entries contain unrealistic dates or inconsistent user IDs.
- **Likely cause**: Record boundary/header offset/layout assumptions were too rigid for K80 payload shape.
- **Confirmed cause**: `Confirmed` in parser diagnostics path; previous fixed-offset decoding could misalign payload header + record layout.
- **Resolution**:
  - add dedicated parser with candidate size/layout scoring (`16/24/32/40`),
  - enforce timestamp sanity window (`2000-01-01` to `2035-01-01`),
  - emit malformed-record diagnostics + selected layout metadata,
  - add offline decode harness for probe `run.json` evidence (`scripts/agent/decode-attlog-run.js`).
- **Status**: `Monitoring` (await fresh real-device rerun evidence)
- **Last updated**: `2026-03-17`
- **Related files / areas**:
  - `agent/lib/parsers/zktecoAttendanceParser.js`
  - `agent/lib/events/zktecoPullAdapter.js`
  - `scripts/agent/pull-events-probe.js`
  - `scripts/agent/decode-attlog-run.js`

## ERR-009
- **ID**: `ERR-009`
- **Title**: Decoded timestamps look implausible due to bad device clock state (not decode corruption)
- **Symptoms**: Decoder outputs structurally valid records but event years/times are unexpected (for example year `2002`) while protocol/decode stages are otherwise healthy.
- **Likely cause**: Device clock/date drift or reset after long powered-off interval.
- **Confirmed cause**: `Confirmed` for K80 field case; device had been previously tested, left off for a long period, and reopened with incorrect year/time.
- **Resolution**:
  - treat protocol/decode correctness and device-clock trust as separate checks,
  - add explicit on-device clock verification to onboarding checklist,
  - keep raw decoded evidence and record whether timestamp anomaly is parser-side or clock-side.
- **Status**: `Active`
- **Last updated**: `2026-03-17`
- **Related files / areas**:
  - `docs/DEVICE_VALIDATION_PLAYBOOK.md`
  - `docs/CODEX_PROJECT_MEMORY.md`

## ERR-010
- **ID**: `ERR-010`
- **Title**: Real device works in probe path but is absent from canonical `/boss` lifecycle story
- **Symptoms**: Real-device protocol evidence (connect/auth/pull/decode) exists, but `/boss` lacks one coherent managed device narrative across devices, commands, sync states, and batch evidence.
- **Likely cause**: Probe/runtime validation path is out-of-band from canonical discovery->claim->managed->binding persistence and visibility contracts.
- **Confirmed cause**: `Inferred` (active verification under Device Lifecycle Coherence V2 Phase 0).
- **Resolution**:
  - execute Device Lifecycle Coherence V2 in phases:
    - Phase 0 evidence and breakpoint confirmation,
    - Phase 1 lifecycle/identity/binding/visibility contracts,
    - then minimal persistence/linkage and `/boss` coherence phases.
- **Status**: `Active`
- **Last updated**: `2026-03-18`
- **Related files / areas**:
  - `api/agent.routes.js`
  - `api/agentAdmin.routes.js`
  - `services/agentBridgeDb.js`
  - `services/agentDeviceEventsService.js`
  - `services/devicesDb.js`
  - `/boss` bridge-ops surfaces

## ERR-011
- **ID**: `ERR-011`
- **Title**: Lifecycle immutability verification fails due unapplied Phase 2 migration
- **Symptoms**: `tests/contracts/db.deviceUidImmutability.behavior.test.js` fails because `devices.device_uid` update is not blocked.
- **Likely cause**: Local/CI DB migration drift where `20260318_device_lifecycle_coherence_phase2_slice25.sql` was not applied/recorded.
- **Confirmed cause**: `Confirmed` in local verification closure run (`slice21` applied, `slice25` missing until manual apply).
- **Resolution**:
  - apply missing migration(s) using canonical migration workflow,
  - verify `trg_devices_device_uid_immutable` exists on `public.devices`,
  - run lifecycle integrity report before cleanup work.
- **Status**: `Monitoring`
- **Last updated**: `2026-03-18`
- **Related files / areas**:
  - `migrations/20260318_device_lifecycle_coherence_phase2_slice25.sql`
  - `tests/contracts/db.deviceUidImmutability.behavior.test.js`
  - `scripts/db/lifecycle-coherence-integrity-report.sql`

## ERR-012
- **ID**: `ERR-012`
- **Title**: Managed K80 queue path emits UDP/default pull command shape and yields ATTLOG timeout
- **Symptoms**: Managed device is bound and command is queued/sent, but sync/batch shows `attlog_timeout` with diagnostics indicating `transport_used: udp`; `/boss` shows no successful pull evidence.
- **Likely cause**: Queue command builder omitted K80-critical connection fields (`transport`, `attlog_sequence`, `device_number`) even when known on device metadata.
- **Confirmed cause**: `Confirmed` in runtime closure pass for `zkteco:sn:BIND-QUEUE-c26a7486` (`DEFAULT` company); first queued command used UDP and failed at ATTLOG stage.
- **Resolution**:
  - propagate connection `transport`, `attlog_sequence`, and `device_number` into queued pull command payload from options/discovery/metadata,
  - bind device to live active managing agent,
  - queue initial historical backfill with explicit `since_utc` for first proof run.
- **Status**: `Resolved`
- **Last updated**: `2026-03-18`
- **Related files / areas**:
  - `services/agentDeviceEventsService.js`
  - `api/agentAdmin.routes.js`
  - `agent/lib/events/zktecoPullAdapter.js`
  - `/boss` Device Live View evidence surfaces

## ERR-013
- **ID**: `ERR-013`
- **Title**: Fresh runtime evidence misclassified as offline/stale due timestamp-type normalization gap
- **Symptoms**: Agent/device readiness surfaces can show `offline`/`unknown` immediately after heartbeat/validation success despite fresh evidence.
- **Likely cause**: Freshness helpers expected string timestamps while runtime rows can include native `Date` objects.
- **Confirmed cause**: `Confirmed` in Architecture Phase 3 verification pass.
- **Resolution**:
  - normalize reported/read-model timestamps from both string and `Date` object forms,
  - keep stale/unknown projection policy, but only after correct timestamp normalization,
  - add focused service test coverage for Date-object timestamp handling.
- **Status**: `Resolved`
- **Last updated**: `2026-03-23`
- **Related files / areas**:
  - `services/reportedStateDb.js`
  - `services/agentBridgeDb.js`
  - `tests/services/reportedStateDb.test.js`

## ERR-014
- **ID**: `ERR-014`
- **Title**: Offline/reconnect retry can create ambiguous duplicate batch ledger rows
- **Symptoms**: After temporary SaaS/network disruption, repeated agent batch submits can produce extra batch rows even when event facts are deduped; command completion truth becomes harder to interpret.
- **Likely cause**: Batch submit flow lacked a stable delivery-level idempotency key and local retry-attempt truth metadata.
- **Confirmed cause**: `Confirmed` in Phase 5 review; event-level dedup prevented duplicate facts but did not prevent duplicate batch-ledger writes under uncertain submit outcomes.
- **Resolution**:
  - add `agent_device_event_batches.delivery_id` with unique `(company_id, agent_id, delivery_id)` guard for non-null deliveries,
  - propagate `delivery_id`/`delivery_attempt` in agent batch request contract,
  - persist local buffer retry-attempt/backoff metadata (`delivery_attempt_count`, `last_attempt_*`, `next_retry_at`) for deterministic recovery visibility.
- **Status**: `Monitoring`
- **Runtime verification note (2026-03-23)**: Local runtime DB was confirmed missing the capability migration initially; after applying `20260328_capability_reporting_feature_gates_foundation.sql`, controlled schema-fault injection (temporary rename of `agent_runtime_capability_reported_state`) produced deterministic `503` `runtime_schema_not_ready` on heartbeat/batch, and restoration returned heartbeat/batch to normal `200/201` behavior.
- **Last updated**: `2026-03-23`
- **Related files / areas**:
  - `migrations/20260326_offline_buffer_command_truth_hardening.sql`
  - `services/agentDeviceEventsService.js`
  - `contracts/agentDeviceEventsContract.js`
  - `agent/lib/eventBatchBuffer.js`
  - `agent/index.js`

## ERR-015
- **ID**: `ERR-015`
- **Title**: Phase drift can make agents endpoint fail after version-governance code rollout
- **Symptoms**: `GET /api/agent-admin/agents` returns `500` in environments where Phase 6 code is deployed but `agent_runtime_version_reported_state` / `agent_version_governance_policies` migrations are not applied.
- **Likely cause**: Runtime/schema drift (new read-model joins/reference tables missing from active DB).
- **Confirmed cause**: `Confirmed` during Phase 6 runtime verification; contract run failed until `20260327_agent_version_governance_foundation.sql` was applied.
- **Resolution**:
  - apply migrations before runtime verification/deployment,
  - keep migration guardrails active in smoke/verification paths,
  - treat agents/version-policy contract failures as schema-drift signals first.
- **Status**: `Monitoring`
- **Last updated**: `2026-03-23`
- **Related files / areas**:
  - `migrations/20260327_agent_version_governance_foundation.sql`
  - `services/agentBridgeDb.js`
  - `services/versionGovernanceDb.js`
  - `tests/contracts/agentAdmin.agents.contract.test.js`
  - `tests/contracts/agentAdmin.versionPolicy.contract.test.js`

## ERR-016
- **ID**: `ERR-016`
- **Title**: Capability-migration drift causes heartbeat and batch-submit `500` failures with stale command truth
- **Symptoms**:
  - `/api/agent/heartbeat` returns `500` (`INTERNAL_ERROR`) for otherwise valid agent bearer credentials.
  - `/api/agent/device-events/batch` returns `500` and local agent repeatedly retries buffered submits.
  - Pull commands can move `queued -> sent -> sent_timeout/expired` despite successful local pull execution evidence.
- **Likely cause**: Runtime DB missing capability-reporting migration while Phase 8+/Phase 9 code paths call capability upsert functions.
- **Confirmed cause**: `Confirmed` in post-Phase-9 review (2026-03-23): `20260328_capability_reporting_feature_gates_foundation.sql` absent from `schema_migrations`; capability tables are missing (`to_regclass(...)` null) while heartbeat/batch paths invoke `upsertAgentRuntimeCapabilityReportedState` / `upsertDeviceRuntimeCapabilityReportedState`.
- **Resolution**:
  - apply missing capability-reporting migration before runtime verification/deployment,
  - rerun lifecycle integrity + contract/runtime checks,
  - keep migration guardrails active in smoke/verification paths to fail fast on drift,
  - enforce runtime schema-readiness checks on `/api/agent/heartbeat` and `/api/agent/device-events/batch` so drift returns deterministic `RUNTIME_SCHEMA_NOT_READY` (`503`) instead of ambiguous `500`,
  - keep heartbeat/batch persistence transactional so schema-drift failures do not partially mutate runtime truth.
- **Status**: `Monitoring`
- **Last updated**: `2026-03-23`
- **Related files / areas**:
  - `migrations/20260328_capability_reporting_feature_gates_foundation.sql`
  - `services/agentBridgeDb.js`
  - `services/reportedStateDb.js`
  - `api/agent.routes.js`
  - `tests/contracts/db.lifecycleCoherence.guardrails.contract.test.js`

## ERR-017
- **ID**: `ERR-017`
- **Title**: K80 ATTLOG pull-request can return `0x07d0` and fail before ledger retrieval
- **Symptoms**:
  - K80 `zktime_k80` pull sequence reaches `0x05df` but receives `0x07d0` instead of direct `0x05dd`.
  - Batch ends rejected (`attlog_timeout`) with zero events when strict direct-response expectation is applied.
- **Likely cause**: Device enters an alternate ATTLOG continuation branch not previously represented in the state machine.
- **Confirmed cause**:
  - `Confirmed` by comparative capture evidence (`agent` failing branch vs `ZKTime` continuing with `0x05e0`, then `0x05dc/0x05dd`).
  - `Confirmed` runtime wiring defect (2026-03-24): guarded-branch policy state was initialized after an unconditional return in TCP pull flow, leaving `zktime_pull_07d0_branch_enabled=false` in practice even when env flags were set.
- **Resolution**:
  - keep direct `0x05dd` path unchanged,
  - add K80/TCP/flag-gated alternate continuation branch for `0x07d0` (`0x05e0 -> 0x05dc/0x05dd`),
  - require non-empty `0x05dd` payload for success,
  - preserve existing failure semantics when continuation fails,
  - keep feature OFF by default and instrument branch diagnostics (`zktime_pull_07d0_*`),
  - move guarded-branch policy initialization into reachable scope before sequence-step evaluation.
- **Status**: `Monitoring`
- **Runtime verification note (2026-03-24)**: after the wiring fix, a live guarded rerun via normal SaaS queue + agent poll showed branch activation (`branch_enabled=true`, `branch_entered=true`, `followup_sent=true`) on `0x07d0`, but continuation still timed out before `0x05dc/0x05dd` (`branch_outcome=failed_timeout`, zero events).
- **Runtime verification note (2026-03-24, configured payload)**: with `K80_ATTLOG_07D0_FOLLOWUP_PAYLOAD_HEX=00000000f4050000`, a live guarded rerun reached `0x05dc` and `0x05dd` (`branch_outcome=success_with_05dd_data`, `followup_response_commands=[0x05dc/0x05dd-related flow observed as 1500/1501/2000 in diagnostics]`) and batch status became `accepted`; however the run still yielded `events_received_count=0`.
- **Runtime verification note (2026-03-24, payload-shape diagnostics)**: fresh guarded run `command_id=07bdca78-5db9-433b-97cf-760379097d9f`, batch `78c70096-fe9b-442a-a4fc-f9335b5c1279` showed branch continuation to `0x05dc/0x05dd` with `branch_outcome=success_with_05dd_data`, but new diagnostics reported `zktime_pull_07d0_expected_bytes_hint=1524` vs `zktime_pull_07d0_collected_payload_bytes=512` (`likely_truncated=true`), while direct eventful baseline batch `49a73f8a-1549-4311-8214-4a1064fd180a` remained `764` bytes with `events_received_count=19`. This narrows the zero-events blocker toward payload collection/truncation (and possible downstream shape mismatch), not true-empty alternate `0x05dd`.
- **Runtime verification note (2026-03-25, assembly-only code fix)**: alternate continuation assembly now prefers raw `0x05dd` frame payload bytes over bounded diagnostic hex reconstruction, preserving full observed body length in pre-parse assembly; this is a narrow assembly-only fix (no parser offsets/candidates, no protocol branch semantics, no business mapping changes).
- **Runtime verification note (2026-03-25, local rerun attempt boundary)**: one guarded rerun attempt from this workspace with `K80_ATTLOG_07D0_FOLLOWUP_ENABLED=true`, `K80_ATTLOG_07D0_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`, and `K80_ATTLOG_07D0_FOLLOWUP_PAYLOAD_HEX=00000000f4050000` could not execute against SaaS queue/poll due local API runtime unavailability (`ECONNREFUSED` to `http://localhost:3000`), so live command/batch/event impact remains pending runtime evidence.
- **Runtime verification note (2026-03-27, one-shot fresh-event discriminator)**: controlled SaaS queue + agent poll run `command_id=2511ffea-8505-4488-99a4-a5d03e539b09`, batch `5ef86d75-98d7-4296-b6be-5e731b726120` (guarded envs: `K80_ATTLOG_07D0_FOLLOWUP_ENABLED=true`, `K80_ATTLOG_07D0_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`, `K80_ATTLOG_07D0_FOLLOWUP_PAYLOAD_HEX=00000000f4050000`) confirmed protocol and parser success (`zktime_pull_07d0_branch_outcome=success_with_05dd_data`, collected payload `1524` bytes, `binary_candidates=38`, `merged_candidates=38`, `parse_errors=[]`) while normalized `events_count=0`, `events_received_count=0`, `inserted_count=0`, `deduped_count=0`, `rejected_count=0`.
- **Runtime verification note (2026-03-27, schema-guard discriminator rerun)**: controlled SaaS queue + agent poll run `command_id=a6ded8a8-fdb5-442f-8785-09291e2da21e`, batch `2c17482a-0413-4707-9917-555d8a1e2330` under the same guarded K80 envs confirmed command/batch success with zero inserts (`batch_status=accepted`, `events_received_count=0`, `inserted_count=0`, `deduped_count=0`, `rejected_count=0`) while parser diagnostics still reported candidates (`binary_candidates=38`, `merged_candidates=38`, `parse_errors=[]`) and schema guard did not fire (`failure_reason`/`failure_stage` empty; no `schema_payload` evidence).
- **Runtime code-path proof note (2026-03-27, normalization gate)**: in `queuePullDeviceEventsCommand`, `sinceBase` currently uses `normalizeText(syncState.cursor_event_time_utc)`. Because `normalizeText` is string-only and `pg` returns `timestamptz` as `Date`, cursor baseline can collapse to empty and fall back to `now - lookback` (`24h` default). For `command_id=a6ded8a8-fdb5-442f-8785-09291e2da21e`, `requested_since_utc=2026-03-26T15:54:23.185Z`, while parser diagnostics showed `38` candidates with `parse_errors=[]` and normalization emitted `events_count=0`; this confirms the post-parse drop is the silent cutoff gate (`event_time_utc < requested_since_utc`) in `normalizePulledEvents`, not parse/adapter or schema-guard failure.
- **Runtime verification note (2026-03-27, post-fix discriminator run)**: after the `sinceBase` cursor-Date handling fix in `services/agentDeviceEventsService.js`, controlled run `command_id=80b8fb6d-57a3-4edc-a7e7-a0cb5fc10c14`, batch `fc6f7c82-9204-44a7-86f0-9da8a5b4603c` used `requested_since_utc=2026-03-24T14:21:40.000Z` (cursor-based, not `now-lookback` fallback); parser still reported `binary_candidates=38`, `merged_candidates=38`, `parse_errors=[]`, and normalization now emitted `summary.events_count=7` / `events_received_count=7`. Persistence outcome was `inserted_count=0`, `deduped_count=7`, `rejected_count=0`, proving the next loss layer is ingest dedup (no new fact rows for this command), not pre-persist normalization filtering.
- **Runtime verification note (2026-03-27, dedup-collision proof)**: extracted payload events for batch `fc6f7c82-9204-44a7-86f0-9da8a5b4603c` are all for `2026-03-24` (`15:26:13`..`15:26:40` local; zero `2026-03-27` local/UTC) and each event matches an existing `device_events` row from prior command `28819bb2-8fe9-4a39-ae36-fbe82f1df135`; all seven satisfy both unique conflict surfaces (`device_events_dedup_company_uk` natural tuple and partial `device_events_dedup_key_company_uk` on `dedup_key`), explaining `inserted_count=0`, `deduped_count=7`.
- **Runtime verification note (2026-03-27, immediate fresh-punch validation run)**: controlled canonical queue+poll run `command_id=6dfeaa09-9312-4fd9-92c8-9a6da622d87b`, batch `ca70e28c-0268-4349-a722-842c52694cd9` used `requested_since_utc=2026-03-24T14:21:40.000Z`; batch `payload.events` again contained exactly seven records (all `2026-03-24 15:26:13..15:26:40` local / `2026-03-24T14:26:13..14:26:40Z` UTC) and zero records dated `2026-03-27` local/UTC, confirming the newly expected punch was not present in pulled payload content for this run.
- **Runtime verification note (2026-03-30, synchronized capture-vs-batch proof)**: for synchronized run `command_id=601b22ab-fd33-49e1-a911-db7a093c7ef2`, batch `97535e13-536c-4ff0-b98e-0e62abb8208a`, the same capture file (`sync-fresh-punch-2026-03-30-0905.pcapng`) contained one non-schema `0x05dd` payload (`1524` bytes) whose offline decode mapped `36` attendance events (no `person=3` event around `2026-03-30 09:05` local ±60s). Batch `payload.events` held `7` records from `2026-03-24`; set comparison showed overlap `5`, capture-only `31` (historical before cutoff), and batch-only `2` (`15:26:35`, `15:26:40`). Fresh punch absence is therefore already at captured `0x05dd` attendance surface for this run, not a downstream persistence/dedup loss.
- **Implementation note (2026-03-30, guarded experiment toggle)**: `agent/lib/events/zktecoPullAdapter.js` now includes an OFF-by-default K80-only second-ledger-read experiment (`K80_SECOND_LEDGER_READ_ENABLED`, allowlist `K80_SECOND_LEDGER_READ_DEVICE_UID_ALLOWLIST`, delay `K80_SECOND_LEDGER_READ_DELAY_MS`) that reuses the existing `runZkTimeK80Step` pull logic for one optional second `pull_request` cycle after the first successful payload and before cleanup; first cycle remains authoritative fallback if second cycle fails/timeouts. Comparative cycle diagnostics are emitted in protocol payload (`second_cycle_*`, first/second payload bytes, parser candidates, normalized event counts, first/last local times).
- **Implementation note (2026-03-30, guarded refresh-window experiment)**: `agent/lib/events/zktecoPullAdapter.js` now also supports an OFF-by-default K80-only multi-cycle ledger refresh experiment (`K80_LEDGER_REFRESH_ENABLED`, `K80_LEDGER_REFRESH_DEVICE_UID_ALLOWLIST`, `K80_LEDGER_REFRESH_MAX_CYCLES`, `K80_LEDGER_REFRESH_INTERVAL_MS`) that repeats the existing `pull_request` step via the unchanged `runZkTimeK80Step` path. First successful payload remains baseline fallback; final replacement occurs only when a later cycle is strictly better versus cycle 1 (new normalized events or higher normalized event count). Compact per-cycle diagnostics are emitted under `zktime_ledger_refresh_*`.
- **Runtime verification note (2026-03-30, realtime subscribe step)**: guarded pre-hold subscribe experiment (`K80_RT_SUBSCRIBE_STEP_ENABLED=true`, allowlist set to `zkteco:sn:BIND-QUEUE-c26a7486`) executed successfully in canonical run `command_id=8548dc1c-173c-4b7c-a7b9-25d3b25990ec`, batch `c4b263da-b732-4298-8c42-1648c66f7a74`: `zktime_rt_subscribe_enabled=true`, `zktime_rt_subscribe_executed=true`, `zktime_rt_subscribe_ok=true`, `zktime_rt_subscribe_response_command=2000`; however hold diagnostics still reported no realtime frames (`zktime_session_context_hold_rt01f4_seen=false`, `...frames_count=0`) and ATTLOG output remained the same seven historical `2026-03-24` rows (`events_received_count=7`, `inserted_count=0`, `deduped_count=7`). This weakens the “subscribe step alone unlocks realtime visibility in agent session” hypothesis for this runtime path.
- **Runtime verification note (2026-04-01, pre-normalization proof run)**: controlled device-scoped reset + rerun with guarded pre-normalization dump (`K80_PRENORMALIZATION_DUMP_ENABLED=true`) proved `requested_since_utc` directly zeroed output for that run (`requested_since_utc=2026-03-31T11:22:58.363Z`, merged rows `38`, `< since=38`, `>= since=0`, normalized count `0`), while merged corpus maximum remained `2026-03-24T14:26:40.000Z`; next discriminator is one explicit old-since rerun (`since_utc=2000-01-01T00:00:00Z`) to separate filter effect from protocol-surface staleness.
- **Runtime verification note (2026-04-01, `0x05e0` parity reproduction)**: guarded dynamic followup derivation (`K80_DYNAMIC_05E0_PAYLOAD_ENABLED=true`, allowlist `zkteco:sn:BIND-QUEUE-c26a7486`) entered and reproduced app-like payload send (`zktime_dynamic_05e0_payload_sent_hex=000000006c0b0000`, source payload `006c0b00006c0b0000c217bd00`) across two controlled runs (`2ec49d79-73aa-43fb-a957-381715e175b3`/`961c3e3a-0234-40d5-8610-e441225fdce5` and `688e306b-07a9-4035-a663-e57a0f1f8aeb`/`63108c12-4d07-4347-9fba-9256f7bc0a2c`) with payload bytes `2924`, merged candidates `73`, merged max `2026-04-01T14:46:26Z`, and merged rows beyond stale cutoff.
- **Implementation note (2026-04-02, newest-first capped emission guard)**: `agent/lib/events/zktecoPullAdapter.js` now includes a narrow K80-only guarded emission-order preference for cap-overflow normalization output (`K80_NEWEST_FIRST_EMIT_ENABLED`, `K80_NEWEST_FIRST_EMIT_DEVICE_UID_ALLOWLIST`). When enabled and normalized rows exceed `maxEvents`, emission now prefers newest rows (`slice(-maxEvents)` with newest-first payload order) while leaving protocol retrieval, `requested_since_utc` gating, ingest contract, and dedupe semantics unchanged. Proof diagnostics are emitted as `zktime_emission_ordering`, `zktime_emission_cap_applied`, and `zktime_newest_first_emit_policy_enabled` (plus parser mirrors). First bounded verification attempt (`command_id=88d5186f-04f9-4aab-a231-5bd3a33d0465`) ended `sent_timeout` before batch creation, so runtime proof is still pending.
- **Implementation note (2026-04-02, full-history drain foundation slice)**: normal incremental pull path remains preserved; a separate explicit guarded history-drain mode now exists for allowlisted K80 path via pull-command contract options (`history_mode=history_drain`, `history_before_utc`, `history_before_dedup_key`). Drain checkpoint model is tuple-based (`boundary_before_utc_exclusive`, `boundary_before_dedup_key_exclusive`) and drain session state is persisted under `agent_device_sync_states.metadata.history_drain` (`session_id`, `status`, boundary tuple, `last_page_fingerprint`, `no_progress_pages`, `sent_timeout_retries`, `last_command_id`, `last_batch_id`, `stop_reason`, `updated_at`). Agent normalization now applies boundary-exclusive filtering only in explicit drain mode; normal `requested_since_utc`/dedupe/protocol/direction behavior remains unchanged. Ingest now advances drain boundary from accepted emitted oldest tuple and preserves normal incremental cursor from intermediate drain progress.
- **Validation note (2026-04-02, dual-lane separation confirmed)**: normal incremental pull validation (`command_id=7907a910-c12a-4c0c-895f-21e7dfd32690`, `batch_id=e746f1b2-685c-4e38-a315-424f7bbdcbee`) stayed on normal lane (`history_drain.mode_recognized=false`, `history_drain.state_written=false`) with normal cursor lane active; full-history drain validation (`command_id=3ad8bf97-2970-4e14-b727-d781c8ce7ba3`, `batch_id=fa610d64-3302-4887-b521-29ddf08a3e2b`) recognized drain lane (`history_drain.mode_recognized=true`) and persisted `metadata.history_drain` update while preserving `cursor_event_time_utc` unchanged (`2026-04-02 14:25:57+01`), confirming lane separation.
- **Validation note (2026-04-03, drain state-write requires boundary tuple)**: `Confirmed` — accepted drain run `command_id=e19bf6c1-e08b-45cb-ab46-be7700c211fb` / `batch_id=502935a6-f5d4-47e7-aa89-6499ce13be1d` wrote drain state (`history_drain.state_written=true`), updated `agent_device_sync_states.metadata.history_drain`, and stopped with `stop_reason=history_exhausted`. Comparison to earlier accepted batch `0c33a7cb-60fc-4d0a-bb58-4a6c83bbbded` shows the first meaningful difference was presence of drain boundary tuple (`history_before_utc` + `history_before_dedup_key`) and `requested_since_utc=null` (`requested_since_utc_source=history_drain_unbounded`) in the newer run; the earlier run had no boundary tuple and used cursor-based `requested_since_utc`, so state write did not occur. Conclusion: no patch needed for the earlier behavior; state-write path is correct when boundary truth is present.
- **Confirmed inference update (2026-03-27)**: with parser-success evidence and zero parse errors in the same run, the observed loss layer is post-parse pre-persistence normalization filtering (most likely `requested_since_utc` gating), not protocol continuation failure, parser truncation, or DB insert/dedup rejection.
- **Last updated**: `2026-04-03`
- **Related files / areas**:
  - `agent/lib/events/zktecoPullAdapter.js`
  - `tests/agent_events/zktecoPullAdapter.pull.test.js`
  - `docs/CODEX_PROJECT_MEMORY.md`

## ERR-018
- **ID**: `ERR-018`
- **Title**: Buffered submit path returns `500 INTERNAL_ERROR` due ingest scope bug
- **Symptoms**:
  - Agent receives and executes pull command, then buffers batch (`pull_batch_buffered`), but command later becomes `sent_timeout`.
  - Buffered batch attempts show `last_attempt_http_status=500`, `last_attempt_error=INTERNAL_ERROR`.
  - No `agent_device_event_batches` row is created and command `acknowledged_at` remains null.
- **Likely cause**: Ingest runtime exception in `/api/agent/device-events/batch` path.
- **Confirmed cause**: `Confirmed` (2026-04-02) — `queuedRequestedSinceQueueBypassBackfillMinutes` declared block-locally inside `if (payload.command_id)` and referenced later outside that scope in `ingestAgentEventBatch(...)`.
- **Resolution**:
  - hoist `queuedRequestedSinceQueueBypassBackfillMinutes` to function scope in `ingestAgentEventBatch(...)` and assign inside conditional block,
  - restart server runtime and rerun one bounded validation pull.
- **Status**: `Resolved`
- **Last updated**: `2026-04-02`
- **Related files / areas**:
  - `services/agentDeviceEventsService.js`
  - `api/agent.routes.js`
  - `agent/index.js`
  - `agent/.state/agent-event-batches.json`

## ERR-019
- **ID**: `ERR-019`
- **Title**: Drain command fields dropped at queue/build when drain mode not recognized
- **Symptoms**:
  - Admin drain verification request included `options.history_mode=history_drain` but queued `agent_commands.command_payload.pull` lacked `history_mode/history_before_*`.
  - Captured request body showed `history_before_utc` and `history_before_dedup_key` were `null`.
- **Confirmed cause**: `Confirmed` (2026-04-03) — request capture via audit metadata proved `history_mode` was sent, but queue/build emitted no drain fields because drain-mode recognition was not active; boundary fields were not provided by the caller.
- **Confirmed cause**: `Confirmed` (2026-04-03) — agent runtime drain-policy envs were not applied; protocol diagnostics on command `e520daec-4de8-4edd-8856-5d48aff41b6e` showed `zktime_history_drain_policy_flag_enabled=false`, `allowlist_applied=false`, `scope_allowed=false`, `policy_enabled=false`, so `history_mode_effective` fell back to `normal` despite queued `history_mode=history_drain`.
- **Resolution update**: `Confirmed` (2026-04-03) — drain-recognition diagnostics are now consistent after unifying all reported fields from a single decision snapshot; protocol diagnostics now match `history_drain.mode_recognized` and no longer show contradictory policy flags.
- **Resolution update**: `Confirmed` (2026-04-03) — `summary.diagnostics.history_drain` now includes `mode_requested`, `mode_effective`, and `policy_enabled` copied from protocol diagnostics; protocol and history_drain recognition fields align (command `42148ee4-6593-477f-9933-296b38e9e48b`, batch `e8ea60ca-9f23-4489-ace2-376aff9e121f`).
- **Resolution**: `Open` (pending) — decide whether to enforce drain-mode recognition or to pass through drain fields regardless of guard, and ensure caller supplies boundary values.
- **Status**: `Open`
- **Last updated**: `2026-04-03`
- **Related files / areas**:
  - `api/agentAdmin.routes.js`
  - `contracts/agentDeviceEventsContract.js`
  - `services/agentDeviceEventsService.js`

## ERR-020
- **ID**: `ERR-020`
- **Title**: Buffered submit 500 due to UUID vs text comparison in ingest in-flight query
- **Symptoms**:
  - Buffered submit reached `/api/agent/device-events/batch` but returned HTTP 500.
  - No `agent_device_event_batches` row created for the command.
  - Server error: `l'opérateur n'existe pas : uuid <> text`.
- **Confirmed cause**: `Confirmed` (2026-04-03) — in `ingestAgentEventBatch(...)`, the in-flight query compared `id <> COALESCE($5, '')`, causing UUID vs text comparison error.
- **Resolution**: `Resolved` (2026-04-03) — cast `$5` to uuid and compare against a uuid sentinel (`id <> COALESCE($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`).
- **Evidence**: command `6bce9d20-74c3-4764-a060-ef98a4eb2aef` now created batch `c4b7caa3-d04e-4e1f-8078-1a500297a928` after the fix.
- **Status**: `Resolved`
- **Last updated**: `2026-04-03`
- **Related files / areas**:
  - `services/agentDeviceEventsService.js`
  - `api/agent.routes.js`

## ERR-021
- **ID**: `ERR-021`
- **Title**: Fresh attachment trigger failed with `invalid_scope` while fact insert succeeded
- **Symptoms**:
  - Pull batch inserted fresh `device_events` rows successfully.
  - Fresh-attachment diagnostics showed attempts with failures (`k80_fresh_fact_attachment_trigger_failed_count>0`).
  - Failure sample contained `error=invalid_scope`.
- **Confirmed cause**: `Confirmed` (2026-04-13) — ingest-trigger call omitted `agentId`; `deriveAndUpsertDirectionAttachmentForFactEvent(...)` requires scope `{ companyId, agentId, deviceUid }`.
- **Resolution**: `Resolved` (2026-04-13) — include `agentId` in helper scope. Validation batch `9fac0257-0deb-4759-a21e-b1f06a3e45ca` then showed `k80_fresh_fact_attachment_trigger_succeeded_count=2`, `failed_count=0` with attachment ids for both inserted fact rows.
- **Status**: `Resolved`
- **Last updated**: `2026-04-13`
- **Related files / areas**:
  - `services/agentDeviceEventsService.js`
  - `services/historicalDirectionWorkerService.js`

## ERR-022
- **ID**: `ERR-022`
- **Title**: Agent-admin inventory/preflight/attempt routes threw `500` due to canonical resolver contract mismatch
- **Symptoms**:
  - `GET /api/agent-admin/devices/:deviceUid/user-inventory-snapshots/latest/candidate` returned `500 INTERNAL_ERROR`.
  - `POST /api/agent-admin/devices/:deviceUid/enrollment-preflight` returned `500 INTERNAL_ERROR`.
  - `POST /api/agent-admin/devices/:deviceUid/enrollment-attempts` returned `500 INTERNAL_ERROR`.
  - Active runtime stack traces showed `TypeError: Cannot read properties of undefined (reading 'canonical_device_uid')` at `api/agentAdmin.routes.js` lines `2309`, `2536`, `2657`, `2838`.
- **Confirmed cause**: `Confirmed` (2026-04-16) — these routes passed `{ companyId, requestedDeviceUid }` to `resolveCanonicalDeviceUidForOperations(...)` (expects `{ companyId, deviceUid }`) and then dereferenced `canonicalResolution.value.canonical_device_uid` even though resolver returns top-level canonical fields.
- **Resolution**: `Resolved` (2026-04-16) — bounded route-family normalization in `api/agentAdmin.routes.js` for:
  - `/devices/:deviceUid/user-inventory-snapshots/latest`
  - `/devices/:deviceUid/user-inventory-snapshots`
  - `/devices/:deviceUid/user-inventory-snapshots/latest/candidate`
  - `/devices/:deviceUid/enrollment-preflight`
  - `/devices/:deviceUid/enrollment-attempts`
  using `{ companyId, deviceUid: requestedDeviceUid }` and top-level `canonicalResolution.*` consumption.
- **Verification evidence**: `Confirmed` (2026-04-16) —
  - candidate route now returns `200` with candidate payload,
  - preflight route now returns `200` and created decision `249191c4-f4c4-439c-882f-05b75d6ee7c9`,
  - attempt-start route now returns `202` and created attempt `2b60894d-f332-4277-8e0d-e7d590bbecc5`,
  - execute route still queues command (`73e8bd20-a29e-450d-ad7b-b4f8641a747b`) and result-ingest acknowledged it with conservative non-success classification.
- **Status**: `Resolved`
- **Last updated**: `2026-04-16`
- **Related files / areas**:
  - `api/agentAdmin.routes.js`
  - `services/agentBridgeDb.js`

# 11. Resolved Issues Log
- `Resolved`: Idempotent replay-safe ingestion for agent pull batches (dedup key + conflict-safe insert path) is in place.
- `Resolved`: Candidate claim gate prevents unmanaged devices from entering managed pull path by default.
- `Resolved`: Discovery classification distinguishes confirmed/probable/heuristic outcomes and avoids treating unreachable hosts as candidates.
- `Resolved`: OpenAPI full-coverage route verification includes agent and agent-admin surfaces.
- `Resolved`: Phase 1 trust-boundary hardening for scoped tenant routes is now runtime-verified, including role/scope negative checks for simulation write routes.
- `Resolved`: Phase 2 MVP onboarding/remediation model is implemented with explicit manageability axis, deterministic mapping, and operator remediation endpoint.
- `Resolved`: Phase 3 MVP pull lifecycle reliability is runtime-verified (queued expiry + stale sent reconciliation, in-flight dedupe guard, command lifecycle visibility endpoint, and retry-after-terminal behavior).
- `Resolved`: Phase 5 MVP operational surfaces are implemented and runtime-verified (`/api/agent-admin/agents`, `/api/agent-admin/device-event-batches`, `/api/devices` operational filters, `/mvp` Bridge Ops tab, and day-2 runbook).
- `Resolved`: Operator UI fragmentation between `/mvp` and `/boss` is reduced by consolidating operational workflows into `/boss` and redirecting `/mvp`.
- `Resolved`: K80 Pro real-device protocol compatibility proof now includes direct payload-bearing pull (`0x05df` -> `0x05dd`) after sequence/payload parity correction.
- `Resolved`: Phase 5 now includes a first controlled repair write path for strict anomaly `canonical_device_missing_active_device_uid_alias` via explicit operator-triggered lifecycle reconciliation repair.

# 12. Common Commands / Verification
## Environment + DB
- Load env (if used locally): `.\scripts\db\load-env.ps1`
- Apply migrations: `pwsh -NoProfile -File .\scripts\db\apply-migrations.ps1`
- Apply seeds (profile): `pwsh -NoProfile -File .\scripts\db\apply-seeds.ps1 -Profile ci`

## Server + Agent
- Start backend: `npm start`
- Start test-safe server mode: `pwsh -NoProfile -File .\scripts\run-test-server.ps1`
- Start local agent: `npm run agent:start`

## Device probing
- Discovery probe: `npm run agent:probe -- --target 192.168.1.0/24 --timeout-ms 1200`
- Pull-events probe: `npm run agent:pull-probe -- --host 192.168.1.20 --since-utc 2026-03-06T00:00:00Z`
- Decode probe payload offline: `node .\scripts\agent\decode-attlog-run.js --input .\run.json`

## Verification / contracts
- Deterministic suite: `pwsh -NoProfile -File .\tests\run-suite.ps1`
- Bridge foundation contract: `node .\tests\contracts\agentBridge.foundation.contract.test.js`
- Bridge event ingestion contract: `node .\tests\contracts\agentBridge.eventIngestion.contract.test.js`
- Agent command lifecycle contract: `node .\tests\contracts\agentAdmin.commandsLifecycle.contract.test.js`
- Agent list endpoint contract: `node .\tests\contracts\agentAdmin.agents.contract.test.js`
- Agent device-event-batches contract: `node .\tests\contracts\agentAdmin.deviceEventBatches.contract.test.js`
- Device remediation auth/tenant contract: `node .\tests\contracts\agentAdmin.deviceRemediation.errorEnvelope.contract.test.js`
- Agent device-events contract: `node .\tests\contracts\agentDeviceEvents.contract.test.js`
- Devices operational filters contract: `node .\tests\contracts\devices.operationalFilters.contract.test.js`
- Manageability service mapping test: `node .\tests\services\deviceManageability.test.js`
- Command lifecycle service test: `node .\tests\services\agentBridgeDb.lifecycle.test.js`
- Pull queue/ingestion service test: `node .\tests\services\agentDeviceEventsService.test.js`
- OpenAPI lint: `node .\tests\contracts\openapi.lint.test.js`
- OpenAPI coverage: `node .\tests\contracts\openapi.coverage.test.js`
- OpenAPI full coverage: `node .\tests\contracts\openapi.fullCoverage.test.js`

# 13. Real Device Validation Notes
Use this section as a chronological log for hardware evidence.

Log format:
- **Date**
- **Site / Device**
- **Observed behavior**
- **Interpretation**
- **Immediate action**
- **Next validation step**
- **Evidence source**

## Entry 2026-03-10
- **Date**: 2026-03-10
- **Site / Device**: Physical biometric device (field test)
- **Observed behavior**:
  - Ping reachable,
  - TCP 4370 non-responsive,
  - HTTP/HTTPS non-responsive,
  - ZKBioTime could not connect.
- **Interpretation**: Network presence confirmed, manageability not confirmed; likely locked/unprovision-ready state.
- **Immediate action**: Treat as non-manageable candidate, not ingestion-ready.
- **Next validation step**: Perform field unlock/reprovisioning and repeat protocol-level probe + pull validation.
- **Evidence source**: Field report provided to project context.

## Entry 2026-03-16
- **Date**: 2026-03-16
- **Site / Device**: ZKTeco K80 Pro (`ZLM60_TFT`, firmware `8.0.4.1-20190803`)
- **Observed behavior**:
  - serial observed in device/software screens,
  - IP `192.168.22.201`, port `4370`, communication key `1234`, device number `1`,
  - official ZKTime 5.0 connects successfully over Ethernet,
  - device info/counts/log count are readable in official software,
  - Wireshark capture confirms official traffic is TCP (not UDP),
  - payload bytes include TCP wrapper signature consistent with `50 50 82 7d`,
  - confirmed successful in-project pull sequence:
    - `DeviceID`,
    - status probe (`0x0bb6`),
    - pre-size step (`0x03eb` with `10270000`),
    - size query (`0x0032`) with binary payload,
    - pull request (`0x05df`) with corrected 11-byte payload `010d000000000000000000`,
    - direct pull response (`0x05dd`) with real payload (`444` bytes).
  - two decoded records appeared with year `2002`; field follow-up confirmed the device had been tested earlier, left powered off for a long period, then reopened with incorrect on-device year/time.
- **Interpretation**: K80 protocol compatibility is now proven in probe path; final blocker was `0x05df` payload-shape mismatch, not network/auth/session discovery.
- **Interpretation (clock note)**: These `2002` records are treated as valid decode output from an incorrect device clock state, not parser corruption.
- **Immediate action**: Preserve this sequence as the reference case and encode process in a reusable validation playbook.
- **Next validation step**: Reuse the same evidence-first workflow for next firmware/model path and compare divergence points explicitly.
- **Evidence source**: On-device + official software + Wireshark + in-project probe diagnostics (`request_inner_hex`, response command/payload bytes, step-state trace).

## Entry 2026-03-24
- **Date**: 2026-03-24
- **Site / Device**: ZKTeco K80 Pro (`192.168.22.201:4370`) protocol capture + export comparison (`out in .pcapng`, `in out expl.xls`)
- **Observed behavior**:
  - pull-ledger session (`0x05df -> 0x05dd`) near fresh `11:50` punches decoded those fresh punches with `status_code=1`,
  - current agent mapping (`defaultStatusMap`) persisted those fresh punches as direction `OUT`,
  - a separate `0x01f4` signal was present around the same punches with changing state-byte values `00`, `01`, `04`, `05`,
  - ZKTime visual output distinguishes Entrée/Sortie for those same fresh punches.
- **Interpretation**:
  - pull-ledger-only status mapping can lose direction semantics for this K80 path,
  - evidence-backed provisional K80 interpretation is now tracked as:
    - `00 = Entree`
    - `01 = Sortie`
    - `04 = Prol.entree`
    - `05 = Prol.sortie`
  - this mapping is provisional and not vendor-confirmed.
- **Immediate action**: Record this as K80-scoped evidence and defer runtime mapping changes.
- **Next validation step**: Run planning-only non-breaking design pass before any code change; require explicit fallback/rollback path and additional capture evidence.
- **Evidence source**: Raw capture stream analysis (`0x05dd` decoded records + `0x01f4` state-byte sequence) and ZKTime export/view comparison for the same punch window.

## Entry 2026-03-27
- **Date**: 2026-03-27
- **Site / Device**: ZKTeco K80 Pro (`zkteco:sn:BIND-QUEUE-c26a7486`, `192.168.22.201:4370`) single controlled rerun via canonical admin queue path.
- **Observed behavior**:
  - one pull command queued and executed through `POST /api/agent-admin/agents/:agentId/commands/pull-device-events`;
  - command acknowledged with `pull_ok=true`, `batch_status=accepted`;
  - batch payload diagnostics confirm guarded 0x07d0 continuation path ran and completed:
    - `zktime_pull_07d0_branch_enabled=true`,
    - `zktime_pull_07d0_branch_entered=true`,
    - `zktime_pull_07d0_followup_sent=true`,
    - `zktime_pull_07d0_expected_bytes_hint=1524`,
    - `zktime_pull_07d0_collected_payload_bytes=1524`,
    - `zktime_pull_07d0_likely_truncated=false`,
    - `zktime_pull_07d0_branch_outcome=success_with_05dd_data`;
  - payload override evidence persisted:
    - `zktime_pull_07d0_followup_payload_hex=00000000f4050000`,
    - `zktime_pull_07d0_followup_request_hex=5050827d10000000e0058b979a5c060000000000f4050000`;
  - assembly evidence persisted in chunk metadata:
    - `zktime_pull_07d0_collected_payload_chunks=1`,
    - `zktime_pull_07d0_collected_payload_chunk_sizes[0].source=followup_frame_raw`,
    - `payload_raw_bytes=1524`;
  - batch accepted but with no new records:
    - `events_received_count=0`, `inserted_count=0`, `deduped_count=0`, `rejected_count=0`.
- **Interpretation**: post-assembly-fix guarded 0x07d0 continuation path is functioning and non-truncated for this run; current gap is data availability/content for this pull window, not continuation transport assembly failure.
- **Immediate action**: keep guarded 0x07d0 evidence path as validated for this device/profile.
- **Next validation step**: execute a timed pull during known fresh-punch window to confirm non-zero ingestion under same guarded settings.
- **Evidence source**: command row `de07d458-9a60-432e-8c1b-4505e3adf319`, batch row `6dd23672-45c0-4bbf-a4f2-1af33aaba5b8`, persisted batch payload diagnostics in `agent_device_event_batches`.

## Entry 2026-04-08
- **Date**: 2026-04-08
- **Site / Device**: ZKTeco K80 (`zkteco:sn:BIND-QUEUE-c26a7486`, `192.168.22.201:4370`) live-punch realtime rerun with server realtime-ingest policy enabled.
- **Observed behavior**:
  - pull command queued and acknowledged: `command_id=32ebe2a3-adde-4753-9533-9c2a0d9be4c1`, pull batch `78f758ec-fb8a-4562-bab7-f63227fcf7bb` (`rejected` pull outcome unchanged),
  - separate realtime batch created: `e6b13431-a508-4019-a07d-5a80b09f0f27` (`ingest_method=agent_realtime`, `events_received_count=1`),
  - RT reception confirmed during live punch: `session_rt01f4_frames_count=1`,
  - server ingest diagnostics confirmed policy active and insert path entered:
    - `k80_rt_ingest_policy_flag_enabled=true`,
    - `k80_rt_ingest_policy_allowlist_applied=true`,
    - `k80_rt_ingest_policy_device_match=true`,
    - `k80_rt_ingest_policy_enabled=true`,
    - `k80_rt_ingest_insert_path_entered=true`,
    - `k80_rt_ingest_insert_path_skipped=false`,
  - persistence confirmed: one row inserted into `device_realtime_direction_observations` for batch `e6b13431-a508-4019-a07d-5a80b09f0f27`.
- **Interpretation**: Separate K80 realtime-direction channel now has confirmed end-to-end operational proof (frame capture -> realtime batch -> realtime table persist) under enabled server policy/allowlist.
- **Immediate action**: keep this as the policy-truth reference run for server-side realtime ingest gating.
- **Next validation step**: continue bounded reviews/planning for remaining non-policy blockers only; no direction overwrite/reconciliation in this slice.
- **Evidence source**: `agent/.state/agent-diagnostics.json` (`session_rt01f4_frames_count=1`), `agent_device_event_batches` rows `78f758ec-fb8a-4562-bab7-f63227fcf7bb` and `e6b13431-a508-4019-a07d-5a80b09f0f27`, `device_realtime_direction_observations` row count for realtime batch.

## Entry 2026-04-10
- **Date**: 2026-04-10
- **Site / Device**: ZKTeco K80 (`zkteco:sn:BIND-QUEUE-c26a7486`, `192.168.22.201:4370`) bounded four-surface comparison anchored to one real punch.
- **Observed behavior**:
  - user-confirmed anchor truth: event time `2026-04-10 10:52:27+01`, direction `IN`,
  - normal date/events pull captured anchor time correctly in `device_events.event_time_utc` but persisted direction `OUT`,
  - normal realtime direction captured provisional direction `IN` (matching user-confirmed direction) but persisted implausible/untrusted RT wall-clock time (`observed_at_utc=2014-03-13 08:27:54+01` in the reviewed run),
  - full-history date/events was requested as `history_drain` but fell back to normal with diagnostics `mode_requested=history_drain`, `mode_effective=normal`, `mode_recognized=false`, `policy_enabled=false`,
  - full-history direction worker ran for a today-inclusive window and produced artifacts, but remained fallback-only (`artifact_outcome=informational_only`, `confidence_basis=pull_status_map_fallback`, `source_refs.rt_observation_id=null`).
- **Interpretation**:
  - pull fact lane remains the trusted event-time source for this investigation,
  - pull direction for this anchor is incorrect against user-confirmed ground truth,
  - RT direction signal is useful for IN/OUT semantics on this anchor, but RT persisted wall-clock timestamp is currently untrusted,
  - historical direction did not independently resolve pull-vs-RT disagreement in this run and remained fallback-based.
- **Interpretation note (design direction)**:
  - `Inferred`: this run reinforces separating event-fact truth from direction-evidence truth; time trust and direction trust should be linked explicitly later, not collapsed inside one lane.
- **Immediate action**: preserve separate trust judgments for time and direction in ongoing bounded reviews.
- **Next validation step**: continue bounded evidence collection without collapsing lane trust into a single verdict; treat historical-direction outputs as informational/fallback until non-fallback RT-linked pairing is proven.
- **Evidence source**: bounded four-surface execution evidence in this project context (`device_events`, `device_realtime_direction_observations`, history-drain diagnostics, and `historical_direction_artifacts` for the 2026-04-10 anchor window).

## Entry 2026-04-13
- **Date**: 2026-04-13
- **Site / Device**: ZKTeco K80 (`zkteco:sn:BIND-QUEUE-c26a7486`, `192.168.22.201:4370`) fresh fact-anchor derived-attachment trigger validation.
- **Observed behavior**:
  - first post-slice run `command_id=e576b18a-1853-4cd2-a99b-db2bb9691eda` -> batch `fd61ede2-95f2-46ec-a2dc-d58a7a38e05d` inserted fresh fact `028cf493-8320-407e-8a5d-2262c8b98282` but attachment trigger failed with diagnostics `k80_fresh_fact_attachment_failure_samples=[{ error: invalid_scope }]`,
  - after scope fix (include `agentId`), run `command_id=0f4c3f58-36a6-435d-bc06-ca8a07b50766` -> batch `9fac0257-0deb-4759-a21e-b1f06a3e45ca` inserted two fresh facts (`4ed374f2-a64b-48b0-9dfb-33aac98baa9a`, `ce51b950-375c-487f-a2b0-4d11d4e73783`) and auto-created two matching attachments (`4bf4c32c-7c7c-42fd-8c40-dc30b20a5fd6`, `c7828460-d622-4a65-b022-ad770f86af77`) with diagnostics `k80_fresh_fact_attachment_trigger_succeeded_count=2`, `failed_count=0`.
- **Interpretation**: Fresh fact-anchor attachment trigger now works on normal pull ingest as best-effort post-commit behavior, and attachment failures are isolated from fact-ingest success.
- **Immediate action**: retain `k80_fresh_fact_attachment_*` diagnostics for trigger observability.
- **Next validation step**: collect one fully synchronized live anchor where RT row + Phase1 auto-pull + fresh fact + auto-attachment appear in the same bounded window.
- **Evidence source**: `agent_commands`, `agent_device_event_batches`, `device_events`, and `derived_direction_attachments` rows listed above.

## Entry 2026-04-13 (Synchronized Live Milestone)
- **Date**: 2026-04-13
- **Site / Device**: ZKTeco K80 (`zkteco:sn:BIND-QUEUE-c26a7486`, `192.168.22.201:4370`) synchronized fresh live validation under runtime-aligned policy truth.
- **Observed behavior**:
  - synchronized chain succeeded end-to-end in one live anchor window:
    - RT batch inserted: `79ce56c8-a205-4eb3-9878-497d119459f0`,
    - RT row inserted: `95c2f14d-4703-455c-9b9a-fec7e5f1e65f`,
    - Phase 1 post-punch trigger fired and queued command: `e88c0e42-c66d-49bd-8625-b953b6097708`,
    - pull batch accepted: `a467fca3-3d79-45ed-bfd7-c9b6f1b4be09`,
    - fresh fact row inserted: `3b84bd5a-05f9-45b4-b906-055824992e41`,
    - derived attachment created for same fact id: `5db15e91-e4f2-4fe3-af09-bee4d01ffa0f`,
    - diagnostics consumer (`/api/agent-admin/device-events/recent`) exposed legacy + derived side-by-side for the same anchor.
  - direction evidence for this anchor:
    - RT direction `IN` (`rt_state_code=00`),
    - legacy fact direction `OUT`,
    - derived direction `IN`,
    - `confidence_basis=rt_pull_conflict_created_at_provisional`,
    - `conflict_flag=true`,
    - source refs include both fact id and RT observation id plus pull provenance.
- **Interpretation**:
  - runtime alignment and policy truth are confirmed prerequisites for valid live pipeline judgment,
  - under correct runtime config, the intended trigger/fact/attachment/consumer pipeline now works end-to-end,
  - remaining disagreement is semantic direction conflict between pull and RT evidence, not invocation/fact-anchor/attachment pipeline failure.
- **Immediate action**: preserve this run as the synchronized-live reference milestone for K80.
- **Next validation step**: continue bounded semantic direction-conflict investigation without reopening already-proven pipeline viability questions.
- **Evidence source**: fresh live rows/ids listed above from `agent_device_event_batches`, `device_realtime_direction_observations`, `agent_commands`, `device_events`, `derived_direction_attachments`, and `/api/agent-admin/device-events/recent`.

## Entry 2026-04-14 (Enrollment Capture Comparison, Pre-Implementation)
- **Date**: 2026-04-14
- **Site / Device**: ZKTeco K80 enrollment workflow captures (`enroll-success-finger5-01.pcapng`, `enroll-success-finger6-01.pcapng`, `enroll-cancel-before-scan-01.pcapng`, `enroll-partial-fail-01.pcapng`).
- **Observed behavior**:
  - all four runs share a stable dual-session structure (general device session plus enrollment session),
  - enrollment-session transitions consistently include `0x003e` and `0x003d` (`body_len=26` with changing tail bytes),
  - success runs uniquely show result retrieval chain `0x05df -> 0x05dd` (with follow-up `0x0058`/`0x05dc`/second `0x05dd`),
  - cancel/partial runs show close path (`0x003e` + `0x003c`, then `0x03f5`/`0x03e9`) without the success retrieval chain.
- **Interpretation**:
  - phase markers are now strong enough for planning-level workflow modeling,
  - byte-level semantic mapping for some fields (especially `0x003d` field map and `0x01f4` progress/fail byte meanings) remains non-vendor-confirmed and must stay explicitly uncertain.
- **Immediate action**: preserve full analysis/uncertainty matrix in `docs/ZK_ENROLLMENT_CAPTURE_ANALYSIS.md`.
- **Next validation step**: run one bounded command-confirmation pass (single-finger success/cancel/partial repeats) to validate byte-level field semantics before runtime enrollment implementation.
- **Evidence source**: uploaded capture set + extracted command/session timelines (`.tmp-enroll-analysis/*.json`, `.tmp-enroll-analysis/*.non07d0.txt`) and user timeline notes.

## Entry 2026-04-14 (Enrollment Bounded Confirmation Set)
- **Date**: 2026-04-14
- **Site / Device**: ZKTeco K80 bounded enrollment confirmation captures (`enroll-confirm-success-fingerX-YYYYMMDD-HHMM.pcapng`, `enroll-confirm-cancel-fingerX-YYYYMMDD-HHMM.pcapng`, `enroll-confirm-partial-fingerX-YYYYMMDD-HHMM.pcapng`).
- **Observed behavior**:
  - all three runs retained the enrollment-session skeleton (`0x003e` before `0x003d`, then `0x003e` + `0x003c` close),
  - success run uniquely contained `0x05df` and post-request enrollment-session `0x05dd` responses,
  - cancel/partial runs had no `0x05df`,
  - `0x01f4` progression shape diverged by outcome (success: short + larger `14/72` payload frames; partial: short-only; cancel: no meaningful post-select progression).
- **Interpretation**:
  - enrollment branch discrimination is now strong enough for safe implementation planning,
  - direct coding is still blocked on explicit byte-field mapping for `0x003d` and non-vendor-confirmed short-value semantics for `0x01f4`.
- **Immediate action**: preserve updated confidence and guardrails in `docs/ZK_ENROLLMENT_CAPTURE_ANALYSIS.md`.
- **Next validation step**: one narrow field-mapping pass focused on explicit offset-level interpretation (`0x003d` field positions and `0x01f4` short-value classification) before runtime implementation.
- **Evidence source**: bounded capture set listed above + extracted command/session timelines in `.tmp-enroll-analysis`.

## Entry 2026-04-14 (Device User Inventory Browse Capture)
- **Date**: 2026-04-14
- **Site / Device**: ZKTeco K80 browse-users capture `users.pcapng` (ZKTime “From Device To PC” style user inventory view).
- **Observed behavior**:
  - single compact session (`sess=14477`) with request chain `0x0bb6 -> 0x0032 -> 0x03eb -> 0x05df`,
  - immediate `0x05dd` response (`len=580`) containing user-like records with explicit IDs visible in payload content (`1,2,3,4,5,6,7,10`),
  - screenshot context shows same apparent IDs/count (`8`) in UI.
- **Interpretation**:
  - this is strong planning-level evidence that device user inventory/ID discovery is protocol-retrievable,
  - coding-safe field mapping (count offsets/paging guarantees) is still unresolved from this single bounded capture.
- **Immediate action**: preserve detailed review and uncertainty markers in `docs/ZK_DEVICE_USER_INVENTORY_ANALYSIS.md`.
- **Next validation step**: one bounded inventory-stress capture (>10 users with gaps) to confirm count field mapping and any paging/chunking behavior.
- **Evidence source**: `users.pcapng`, extracted timeline `.tmp-enroll-analysis/users.pcapng.*`, and screenshot context in this thread.

## Entry 2026-04-16 (Fresh Live Enrollment Rerun, Post Route-Contract Fix)
- **Date**: 2026-04-16
- **Site / Device**: ZKTeco K80 (`zkteco:sn:BIND-QUEUE-c26a7486`) bounded fresh live rerun with current enrollment runner path.
- **Fresh IDs**:
  - preflight: `91b359da-e51c-495b-a3e8-b167db0957e5`
  - attempt: `860773c7-5da7-4ab4-b90e-4fe7bb18f528`
  - command: `aafaee11-0002-45b3-9e84-a9a8886f57c3`
- **Observed behavior**:
  - preflight created as `ready_auto_candidate`,
  - attempt created as `pending`,
  - execute queued and agent picked command,
  - command acknowledged with result payload,
  - attempt reached terminal `partial_or_failed` with `status_reason=partial_or_failed_without_success_chain`.
- **Marker evidence**:
  - `saw_003e=false`
  - `saw_003d=false`
  - `saw_01f4_progress=false`
  - `saw_05df=true`
  - `saw_05dd_after_05df=false`
  - success chain absent; conservative downgrade preserved.
- **Interpretation**:
  - enrollment admin create/execute/read path is operational after the bounded route-contract fix,
  - current K80 runtime execution still does not reach success-chain marker evidence required for `success`.
- **Immediate action**: keep conservative success gating unchanged; retain raw evidence refs for each rerun.
- **Next validation step**: bounded protocol-runner evidence slice focused on why enrollment markers (`0x003e`/`0x003d`/`0x01f4`) are not observed in live run while `0x05df` transmit is observed.
- **Evidence source**: `device_user_id_preflight_decisions`, `device_enrollment_attempts`, `agent_commands` (result payload), `/api/agent-admin/enrollment-attempts/:attemptId`, and bridge runtime logs.

# 14. Open Questions
- `Open`: For locked devices, what proportion can be remediated remotely vs requiring physical intervention?
- `Open`: How much ZKTeco behavior varies by firmware for auth/handshake/pull reliability?
- `Open`: Under unstable LAN conditions, what retry/backoff settings meet reliability without duplicate pressure?
- `Open`: Is device timezone reliably retrievable from hardware, or must operator-supplied timezone remain standard?
- `Open`: Who owns remediation in customer operations (customer IT, vendor technician, or SaaS support workflow)?
- `Open`: For K80 direction semantics, what is the vendor-confirmed meaning of `0x01f4` state-byte values (`00/01/04/05`), and how should they be merged with `0x05dd status_code` without breaking existing persisted truth?

# 15. Update Protocol
When completing substantive work:
1. Re-read impacted sections in this file.
2. Update only sections affected by confirmed new evidence.
3. For each meaningful change, keep status tags (`Confirmed`/`Inferred`/`Open`) explicit.
4. Update `Decision Log` when a new important direction is adopted or a decision status changes.
5. Update `Do Not Repeat` when a recurring false assumption is observed.
6. Add or update `Error Catalog` entries when recurring issues appear or confirmed resolutions land.
7. Update roadmap snapshot only for material priority/phase changes.
8. Preserve prior useful context; do not delete history unless it is obsolete and replaced.
9. If no memory edits are needed, explicitly mark key sections reviewed as unchanged (`Decision Log`, `Do Not Repeat`, `Error Catalog`).
10. In the final response, state either:
   - `Memory update: completed` (with sections touched), or
   - `Memory update: not needed` (with reviewed sections unchanged and reason).

- Confirmed (implementation note, 2026-03-30): Added guarded K80 provisional realtime ingestion path from  x01f4 for allowlisted devices (K80_RT_01F4_INGEST_ENABLED, K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST, K80_RT_01F4_INGEST_MAX_EVENTS_PER_PULL, K80_RT_01F4_RECONCILE_WINDOW_MS, K80_RT_01F4_REQUIRE_PERSON_PARSE). Adapter now emits provisional gent_realtime candidates (strict timestamp+direction decode, strict person parse gating), agent submits them as a separate gent_realtime batch after normal gent_pull submission, and ingest path reconciles near-matching provisional realtime rows on later authoritative gent_pull ingest with explicit counters (
ealtime_provisional_events_received/inserted/skipped_no_person/reconciled_by_pull/left_unreconciled). ATTLOG pull path remains unchanged as authoritative reconciliation/backfill.

## Entry 2026-04-16 (Post-Progression 0x05df Guarded Request-Shaping Slice)
- **Date**: 2026-04-16
- **Scope**: bounded enrollment runner change in `agent/lib/events/zktecoPullAdapter.js` (`runK80EnrollmentAttempt(...)`) for post-progression result probe only.
- **Confirmed implementation**:
  - added default-off runtime guard `K80_ENROLL_POST_PROGRESS_05DF_GUARDED_ENABLED`.
  - guard-off preserves legacy behavior (`0x05df` probe payload remains empty and uses legacy live-state context path).
  - guard-on now uses a bounded post-progression probe plan with:
    - frozen selection-ack context (`enroll_session_id_from_003d`, `enroll_reply_id_from_003d`),
    - `0x05df` request sent with `sessionId = enroll_session_id_from_003d`,
    - `replyId = nextReplyId(enroll_reply_id_from_003d)`,
    - non-empty body template `0109000500000000000000` (structural parity template only; semantics still guarded).
  - conservative success classification remains unchanged (success still requires observed `saw_05df && saw_05dd_after_05df`).
- **Confirmed diagnostics added**:
  - `post_progress_05df_mode`
  - `post_progress_05df_body_len`
  - `post_progress_05df_body_hex_prefix`
  - `post_progress_05df_session_id_sent`
  - `post_progress_05df_reply_id_sent`
  - `post_progress_05df_context_source`
  - `unresolved_05df_body_semantics_guarded=true`
- **Verification evidence**:
  - focused adapter test suite passed: `node tests/agent_events/zktecoPullAdapter.pull.test.js`.
  - added focused guard tests confirm:
    - guard-off -> legacy empty probe plan,
    - guard-on -> non-empty template probe plan with frozen-context reply progression.
- **Boundary note**: no `0x003d` payload redesign, no broader protocol-step changes, no relaxation of conservative enrollment result gating.

## Entry 2026-04-16 (Dual-Guard Live Enrollment Validation: 003d + Post-Progress 05df)
- **Date**: 2026-04-16
- **Target**: `zkteco:sn:BIND-QUEUE-c26a7486`
- **Run IDs**:
  - preflight: `655c955a-5f7b-4447-acf2-0b25a4483d72`
  - attempt: `edbe5922-3447-49f7-a3f5-26b9cfea9c1d`
  - command: `77e1671c-50fa-49d0-b0b9-4a68c1945e9e`
- **Guarded runtime truth**:
  - active agent restarted with both guards enabled:
    - `K80_ENROLL_003D_26B_GUARDED_ENABLED=true`
    - `K80_ENROLL_POST_PROGRESS_05DF_GUARDED_ENABLED=true`
- **Observed result**:
  - command acknowledged, attempt terminal `partial_or_failed` with `status_reason=partial_or_failed_without_success_chain`.
  - marker flags:
    - `saw_003e=false`
    - `saw_003d=false`
    - `saw_01f4_progress=true`
    - `saw_05df=true`
    - `saw_05dd_after_05df=false`
  - guarded diagnostics present:
    - `selection_payload_version=guarded_26b_v1`, `selection_payload_len=26`
    - `post_progress_05df_mode=guarded_enroll_probe_v1`
    - `post_progress_05df_body_len=11`
    - `post_progress_05df_body_hex_prefix=0109000500000000000000`
    - `post_progress_05df_context_source=selection_ack_frozen`
    - `post_progress_05df_session_id_sent=1`, `post_progress_05df_reply_id_sent=4`
- **Interpretation**:
  - progression entry is confirmed under dual-guard runtime,
  - post-progression guarded `0x05df` shaping path is active,
  - success chain still not reached (`0x05dd` missing after `0x05df`), so conservative non-success classification remains correct.

## Entry 2026-04-16 (Post-Progression 0x05df Context-Carry Fix: Selection TX Lineage)
- **Date**: 2026-04-16
- **Scope**: bounded change in `runK80EnrollmentAttempt(...)` (`agent/lib/events/zktecoPullAdapter.js`) for post-progression `0x05df` context carry only.
- **Confirmed implementation**:
  - guarded post-progress `0x05df` context now uses outbound `0x003d` control-session lineage captured before selection send (`selectionTxSessionId`, `selectionTxReplyId`) instead of ACK-flattened response context.
  - guarded `0x05df` body template remains unchanged (`0109000500000000000000`).
  - conservative success classification unchanged.
- **Diagnostics added**:
  - `post_progress_05df_session_source`
  - `post_progress_05df_reply_source`
  - context source value now distinguishes selection TX lineage (`selection_tx_control_lineage`).
- **Verification evidence**:
  - focused adapter tests pass (`node tests/agent_events/zktecoPullAdapter.pull.test.js`), including updated guard-on assertions for TX-lineage context source.
- **Boundary note**: no `0x003d` payload redesign, no broader protocol-step additions, no classification/gating relaxations.

## Entry 2026-04-16 (Dual-Guard Live Validation After TX-Lineage 0x05df Context Fix)
- **Date**: 2026-04-16
- **Target**: `zkteco:sn:BIND-QUEUE-c26a7486`
- **Run IDs**:
  - preflight: `c405baff-5c84-40e6-af95-da662c33c78b`
  - attempt: `9b3de616-b774-4d24-ab30-affd52d5f301`
  - command: `5a173fc3-06ff-48cf-9a22-39100d47e9bf`
- **Observed result**:
  - terminal `attempt_status=success`
  - `status_reason=success_chain_observed_05df_05dd`
  - marker flags: `saw_01f4_progress=true`, `saw_05df=true`, `saw_05dd_after_05df=true`
- **Context-carry diagnostics**:
  - `post_progress_05df_context_source=selection_tx_control_lineage`
  - `post_progress_05df_session_source=selection_tx_session_id`
  - `post_progress_05df_reply_source=selection_tx_reply_id`
  - `post_progress_05df_session_id_sent=57177`
  - `post_progress_05df_reply_id_sent=4`
  - `post_progress_05df_body_hex_prefix=0109000500000000000000`
- **Interpretation**:
  - bounded TX-lineage carry fix resolved the remaining post-progression blocker in this live run,
  - conservative success gating remains intact and now evaluates true on explicit success-chain evidence.

## Entry 2026-04-16 (Post-0x01f4 Guarded Continuation Parity Slice)
- **Date**: 2026-04-16
- **Scope**: bounded change in `agent/lib/events/zktecoPullAdapter.js` (`runK80EnrollmentAttempt(...)`) for post-progression parity only.
- **Confirmed implementation**:
  - added default-off guard `K80_ENROLL_POST_PROGRESS_CONTINUATION_GUARDED_ENABLED`.
  - when guard is enabled:
    - runner sends progression ACK cadence (`0x07d0`) for received `0x01f4` progression frames on control-session lineage,
    - after first `0x05dd` (following `0x05df`), runner sends continuation request `0x0058` with payload `080000`,
    - runner captures follow-up branch frames (`0x05dc` and second `0x05dd`) before final classification.
  - guarded success gating tightened for this branch: success is blocked when first `0x05dd` exists but continuation branch evidence is missing (`status_reason=continuation_branch_missing_after_first_05dd`).
- **Confirmed diagnostics added**:
  - `post_progress_continuation_mode`
  - `post_progress_continuation_payload_len`
  - `post_progress_continuation_payload_hex_prefix`
  - `post_progress_continuation_session_id_sent`
  - `post_progress_continuation_reply_id_sent`
  - `post_progress_continuation_context_source`
  - `post_progress_continuation_session_source`
  - `post_progress_continuation_reply_source`
  - `progression_ack_tx_count`
  - `progression_ack_tx_error_count`
- **Verification evidence**:
  - focused adapter tests passed:
    - `node tests/agent_events/zktecoPullAdapter.pull.test.js`
  - module load check passed:
    - `node -e "require('./agent/lib/events/zktecoPullAdapter')"`
- **Boundary note**: no `0x003d` payload redesign, no rollback of prior reply-id/`0x05df` guarded slices, no unrelated protocol changes.

## Entry 2026-04-16 (Pre-0x003e Upstream Priming Parity Guard Slice)
- **Date**: 2026-04-16
- **Scope**: bounded change in `agent/lib/events/zktecoPullAdapter.js` (`runK80EnrollmentAttempt(...)`) for same-session pre-enroll priming only.
- **Confirmed implementation**:
  - added default-off guard `K80_ENROLL_PRE_003E_PRIMING_GUARDED_ENABLED`.
  - when guard is enabled, runner now replays a bounded official-style priming subset before `0x003e` in-session and in-order:
    - `0x000c` (`SDKBuild=1`)
    - `0x01f5` (startup negotiation payload family)
    - `0x044c`
    - `0x0045` (`2080`)
    - `0x2710`
    - `0x000b` (`ZKFaceVersion`)
    - `0x000b` (`DeviceID`)
    - `0x01f4` (`ffff0000`)
    - `0x01f4` (`ff7f0000`)
  - priming executes as best-effort and then continues into existing enrollment flow; guarded `0x003d`, reply progression, guarded `0x05df`, and continuation logic remain unchanged.
- **Confirmed diagnostics added**:
  - `pre_003e_priming_mode`
  - `pre_003e_priming_steps_attempted`
  - `pre_003e_priming_replies_observed`
  - `pre_003e_priming_completed_before_003e`
- **Verification evidence**:
  - focused adapter tests passed:
    - `node tests/agent_events/zktecoPullAdapter.pull.test.js`
- **Boundary note**: this slice does not change success-classification rules and does not alter narrow post-`0x003e` behavior design; it only adds guarded upstream priming parity.

## Entry 2026-04-16 (Live Validation: Pre-0x003e Priming Guard Active, First 0x05dd Still Short-Form)
- **Date**: 2026-04-16
- **Target**: `zkteco:sn:BIND-QUEUE-c26a7486`
- **Run IDs**:
  - preflight: `a48e8f4c-b18e-416b-801d-ee7d02970c55`
  - attempt: `2bfbed3e-f609-478c-baf6-fb82985d3e7e`
  - command: `b0d330cb-907f-4717-9734-5885a3bcb7b9`
- **Guard/runtime truth**:
  - active guarded runtime used all required enrollment guards including `K80_ENROLL_PRE_003E_PRIMING_GUARDED_ENABLED=true`.
- **Observed result**:
  - `attempt_status=partial_or_failed`
  - `status_reason=continuation_branch_missing_after_first_05dd`
  - `protocol_execution_state=completed_non_success`
- **Confirmed diagnostics**:
  - pre-`0x003e` priming guard executed with full bounded step list and `pre_003e_priming_completed_before_003e=true`.
  - guarded selection remained active (`selection_payload_version=guarded_26b_v1`, `selection_payload_len=26`).
  - guarded post-progress `0x05df` remained active (`post_progress_05df_mode=guarded_enroll_probe_v1`, body `0109000500000000000000`).
  - guarded continuation remained active (`post_progress_continuation_mode=guarded_post_progress_continuation_v1`, payload `080000`).
- **First `0x05dd` form judgment**:
  - first post-`0x05df` `0x05dd` remained short-form (`payload_len=292`, first u32=`288`), not official full-form (`580/576`).
  - continuation still diverged to `0x1381` (no `0x05dc`, no second `0x05dd`).

## Entry 2026-04-17 (Post-0x2710 Closure Guard in Enrollment Priming Path)
- **Date**: 2026-04-17
- **Scope**: bounded change in `runK80EnrollmentAttempt(...)` pre-`0x003e` priming path only (`agent/lib/events/zktecoPullAdapter.js`).
- **Confirmed implementation**:
  - added default-off guard `K80_ENROLL_POST_2710_CLOSURE_GUARDED_ENABLED`.
  - when enabled, after priming step `premode_2710` the runner now:
    - validates response family for `0x2710` (`0x07d0`, `0x05dc`, `0x07d2`),
    - treats `0x05dc` (`PREPARE_DATA`) as explicit closure-trigger state,
    - performs bounded trailing frame drain before first `0x000b`,
    - invokes `FREE_DATA` in this closure branch,
    - records closure completion before advancing to first `0x000b`.
- **Confirmed diagnostics added**:
  - `post_2710_closure_mode`
  - `post_2710_expected_family_matched`
  - `post_2710_prepare_data_observed`
  - `post_2710_trailing_frames_drained`
  - `post_2710_free_data_invoked`
  - `post_2710_closure_completed_before_first_000b`
- **Guardrail confirmed in tests**:
  - command-code collision guard explicitly preserved: `0x05dd` (pull response) is **not** accepted as valid `0x2710` closure-family response in this slice.
- **Verification evidence**:
  - focused adapter tests pass:
    - `node tests/agent_events/zktecoPullAdapter.pull.test.js`
- **Boundary note**: no changes to guarded `0x003d`, post-progress `0x05df`, continuation branch logic, or success-classification semantics.

## Entry 2026-04-17 (Live Validation Rerun After Post-0x2710 Closure Guard)
- **Date**: 2026-04-17
- **Target**: `zkteco:sn:BIND-QUEUE-c26a7486`
- **Run IDs**:
  - preflight: `7767a772-f8af-4f94-9149-ed39d921be49`
  - attempt: `dfa73482-5fa9-49d9-bce4-ba1e0bd8b90c`
  - command: `0486a53f-6740-4240-a644-4793456de3b8`
- **Runtime/guard truth**:
  - active agent runtime processed this command and submitted result successfully.
  - command reached `acknowledged` with non-empty `result_payload`.
  - pre-`0x003e` priming + post-`0x2710` closure diagnostics were present in result metadata.
- **Observed result**:
  - `attempt_status=partial_or_failed`
  - `status_reason=continuation_branch_missing_after_first_05dd`
  - `protocol_execution_state=completed_non_success`
- **Marker/protocol evidence**:
  - `saw_01f4_progress=true`
  - `saw_05df=true`
  - `saw_05dd_after_05df=true`
  - continuation request sent (`0x0058` payload `080000`) followed by `0x1381` (no `0x05dc`, no second `0x05dd`).
- **First-`0x05dd` form judgment**:
  - first post-`0x05df` `0x05dd` remained short-form (`payload_len=292`, first u32=`288`), not official full-form (`580/576`).
- **Interpretation**:
  - post-`0x2710` closure parity guard executed as designed and prevented pre-`0x003e` uncontrolled carry, but it did not change downstream continuation-eligibility outcome for this run.

## Entry 2026-04-17 (Live Validation: Dynamic `0x0058` Guard Active)
- **Date**: 2026-04-17
- **Target**: `zkteco:sn:BIND-QUEUE-c26a7486`
- **Run IDs**:
  - preflight: `6387c13e-f512-4094-9644-3a7d62964924`
  - attempt: `0e849064-5227-4b1e-acb6-41a2813266b6`
  - command: `2d3ba32e-685c-4939-89fe-3fa48076d233`
- **Runtime/guard truth**:
  - active executing agent acknowledged the command and persisted result payload for this run.
  - continuation diagnostics confirm dynamic guard activation:
    - `continuation_0058_mode=dynamic_from_first_05dd_word0_guarded_v1`
    - `continuation_0058_payload_hex=050007`
    - `continuation_0058_word0_source=first_post_05df_05dd_word0_u32le`
    - `continuation_0058_word0_value=360`
    - `continuation_0058_byte0_derived=5`
    - `continuation_0058_byte1_emitted=0`
    - `continuation_0058_byte2_emitted=7`
    - `continuation_0058_byte2_source=selection_offset24_from_003d_payload`
- **Observed protocol result**:
  - continuation branch evidence completed (`0x05dc` observed after `0x0058`, followed by second `0x05dd`).
  - attempt persisted `attempt_status=success`, `status_reason=success_chain_observed_05df_05dd`, `protocol_execution_state=completed_success`.
- **Guardrail note**:
  - this entry confirms protocol-chain completion for the guarded run; real-world enrollment success still requires explicit operator/device-visible confirmation and must not be inferred from protocol chain alone.

## Entry 2026-04-17 (Pre-0x003e Priming Parity v2 Guard Slice)
- **Date**: 2026-04-17
- **Scope**: bounded `runK80EnrollmentAttempt(...)` pre-`0x003e` upstream priming parity only.
- **Confirmed implementation**:
  - added default-off guard `K80_ENROLL_PRE_003E_PRIMING_PARITY_GUARDED_ENABLED`.
  - when enabled, pre-`0x003e` priming plan switches to `guarded_official_pre003e_parity_v2` and replays official same-session sequence family:
    - `0x000c`, `0x01f5`, pre-`0x044c` `0x000b(ZKFaceVersion)`, `0x044c`, `0x0045(20a0)`, `0x2710`,
    - expanded `0x000b` fan-out (`MaskDetectionFunOn`, `IRTempDetectionFunOn`, `DeviceID`, `IsSupportP2P`, `IsSupportSFZ`, `SFZFunOn`, `VisilightFun`, repeat mask/irtemp),
    - pre-enroll `0x01f4(ffff0000)` and `0x01f4(ff7f0000)`.
  - existing legacy priming guard path remains unchanged and still default-off.
- **Confirmed diagnostics added**:
  - `pre_003e_priming_lineage_observed` (per-step tx/rx command/session/reply/payload-length lineage),
  - `pre_003e_progression_frames_observed_count`,
  - `pre_003e_first_progression_evidence_observed`.
- **Verification evidence**:
  - focused adapter tests pass:
    - `node tests/agent_events/zktecoPullAdapter.pull.test.js`
  - test assertions confirm:
    - default-off behavior preserved,
    - parity mode emits 17-step official-style pre-`0x003e` priming family,
    - `0x0045` parity payload uses `20a0`.
- **Boundary note**: no post-`0x003e` continuation redesign, no `0x0058` redesign, no success-classification rule changes in this slice.

## Entry 2026-04-17 (Guarded Dynamic `0x0058` Derivation Slice)
- **Date**: 2026-04-17
- **Scope**: bounded change in `runK80EnrollmentAttempt(...)` continuation branch only (`agent/lib/events/zktecoPullAdapter.js`).
- **Confirmed implementation**:
  - added default-off guard `K80_ENROLL_CONTINUATION_0058_DYNAMIC_GUARDED_ENABLED`.
  - guard-off keeps legacy continuation payload behavior unchanged (`0x0058` payload template `080000`).
  - guard-on derives continuation payload from first post-`0x05df` `0x05dd` state:
    - parses first `0x05dd` word0 (`u32_le` at offset `0`),
    - maps `0x0058[0] = word0 / 72` only when integer-safe (`word0 > 0`, divisible by `72`),
    - sets `0x0058[1] = 0x00`,
    - sets `0x0058[2]` from strongest bounded selector source available (`selection_offset24_from_003d_payload`, fallback `selected_finger_mapping_fallback`).
  - continuation plan wiring now receives first-`0x05dd` payload and selection offset-24 context from live runner state.
- **Confirmed diagnostics added**:
  - `continuation_0058_mode`
  - `continuation_0058_word0_source`
  - `continuation_0058_word0_value`
  - `continuation_0058_byte0_derived`
  - `continuation_0058_byte1_emitted`
  - `continuation_0058_byte2_emitted`
  - `continuation_0058_byte2_source`
  - `continuation_0058_payload_hex`
  - `unresolved_0058_byte2_semantics_guarded`
- **Verification evidence**:
  - focused adapter tests pass:
    - `node tests/agent_events/zktecoPullAdapter.pull.test.js`
  - test coverage confirms:
    - guard-off static payload remains `080000`,
    - guard-on dynamic payload derives to `050007` for first-`0x05dd` `word0=360` and selection offset-24 `=7`.
- **Boundary note**: no changes to `0x003d` guarded construction, post-progress `0x05df` body/context behavior, continuation success-classification rules, or unrelated enrollment protocol stages.

## Entry 2026-04-22 (Enrollment V2 Step-2 Lane Bring-Up Implemented, Step-3/4 Deferred)
- **Date**: 2026-04-22
- **Scope**: `agent/lib/events/zktecoEnrollmentV2Orchestrator.js` only (V2 isolated path).
- **Confirmed implementation**:
  - V2 now executes Step-1 baseline and Step-2 enroll-lane bring-up, then exits cleanly before Step-3 boundary.
  - Step-2 opens a fresh enroll lane (`CONNECT` + `AUTH`) and replays official bring-up family:
    - `0x000c`, `0x01f5`, `0x000b(ZKFaceVersion)`, `0x044c`, `0x0045(2030)`, `0x2710`,
    - repeated `0x000b` query burst,
    - `0x01f4 ffff0000`, `0x01f4 ff7f0000`.
  - Step-1 background lane is kept alive during Step-2 and explicitly probed for liveness (`0x000b DeviceID`) before Step-2 completion.
  - V2 remains isolated and default-off behind existing `K80_ENROLL_V2_LADDER_ENABLED` dispatch.
  - No Step-3 (`0x003e/0x003d`) or Step-4 (`0x05df` continuation chain) logic was introduced in this slice.
- **Confirmed diagnostics added/active for Step-2**:
  - `v2_enroll_lane_created`
  - `v2_enroll_session_id`
  - `v2_step2_sequence_ok`
  - `v2_ff7f_reply_seed`
  - `v2_step2_bg_lane_still_alive`
  - `v2_step2_last_command_sent`
  - `v2_step2_reply_progression_ok`
  - `v2_step2_session_stable`
- **Verification evidence**:
  - `node -e "require('./agent/lib/events/zktecoEnrollmentV2Orchestrator'); console.log('ok-v2-orchestrator-load')"`
  - `node tests/agent_events/zktecoPullAdapter.pull.test.js`
  - Both passed.
- **Boundary note**:
  - V2 status now reports `k80_enrollment_v2_step2_only` with `k80_enrollment_ladder_v2_step1_step2_only` mode; boundary/result phases remain intentionally unimplemented.

## Entry 2026-04-22 (Enrollment V2 Step-2 Tail Fix: Post-0x2710 Family + Tail Completion)
- **Date**: 2026-04-22
- **Scope**: `agent/lib/events/zktecoEnrollmentV2Orchestrator.js` only, `runV2PhaseEnrollLaneBringUp(...)`.
- **Confirmed implementation**:
  - V2 Step-2 no longer hard-fails solely on non-`0x07d0` immediate response at `0x2710`.
  - Added bounded post-`0x2710` family handling in Step-2 lane:
    - accepts `0x05dc` (`PREPARE_DATA`), optional `0x05dd` (`DATA`), and terminal `0x07d0` (`ACK.OK`) as observed closure family.
  - After post-`0x2710` handling, Step-2 tail now executes on enroll lane:
    - repeated `0x000b` queries,
    - `0x01f4 ffff0000`,
    - `0x01f4 ff7f0000`.
  - Step-2 success gating now requires full tail completion + closure-family readiness before `v2_step2_sequence_ok=true`.
  - Background lane liveness probe remains in Step-2 and is now explicitly recorded as post-tail evidence.
- **Confirmed diagnostics added**:
  - `v2_step2_tail_000b_count_sent`
  - `v2_step2_tail_ffff_sent`
  - `v2_step2_tail_ff7f_sent`
  - `v2_step2_bg_lane_alive_after_tail`
  - `v2_step2_post_2710_family_observed`
  - `v2_step2_post_2710_closure_ok`
  - `v2_step2_early_termination_before_tail`
- **Verification evidence**:
  - `node -e "require('./agent/lib/events/zktecoEnrollmentV2Orchestrator'); console.log('ok-v2-step2-tail-load')"`
  - `node tests/agent_events/zktecoPullAdapter.pull.test.js`
  - both passed.
- **Boundary note**:
  - no Step-3 (`0x003e/0x003d`) and no Step-4/result-chain logic added in this slice; no legacy enrollment-path changes.

## Entry 2026-04-22 (Enrollment V2 Step-2 Lifecycle Ownership Retention + Late-Tail Lineage Hardening)
- **Date**: 2026-04-22
- **Scope**: `agent/lib/events/zktecoEnrollmentV2Orchestrator.js` only (`runV2PhaseEnrollLaneBringUp(...)`, V2 orchestration cleanup policy).
- **Confirmed implementation**:
  - Step-2 no longer performs immediate client-side lane teardown on successful Step-2 completion.
  - Successful Step-2 now marks lane retention intent for continuation (`Step-3/Step-4`) and returns runtime ownership handles for enroll lane/session lineage.
  - V2 orchestrator cleanup now conditionally skips closing background/enroll channels when Step-2 completion indicates continuation retention.
  - Late Step-2 tx-lineage handling hardened:
    - tx session lineage no longer regresses to response `session_id=0` from post-`0x2710` data-family frames,
    - tx reply lineage now tracks sent request reply ids monotonically,
    - tail `0x01f4 ffff0000` and `0x01f4 ff7f0000` are explicitly validated as distinct ascending reply ids.
- **Confirmed diagnostics added**:
  - `v2_step2_enroll_lane_retained_for_continuation`
  - `v2_step2_bg_lane_retained_for_continuation`
  - `v2_step2_client_teardown_sent_at_step2_completion`
  - `v2_step2_late_tail_session_continuity_ok`
  - `v2_step2_late_tail_reply_continuity_ok`
- **Verification evidence**:
  - `node -e "require('./agent/lib/events/zktecoEnrollmentV2Orchestrator'); console.log('ok-v2-step2-lifecycle-load')"`
  - `node tests/agent_events/zktecoPullAdapter.pull.test.js`
  - both passed.
- **Boundary note**:
  - no legacy enrollment-path changes,
  - no Step-3/Step-4 protocol behavior completion in this slice; this patch is lifecycle/session ownership structure only.

## Entry 2026-04-22 (Enrollment V2 Explicit Dual-Lane Ownership Contract State)
- **Date**: 2026-04-22
- **Scope**: `agent/lib/events/zktecoEnrollmentV2Orchestrator.js` only (`runK80EnrollmentAttemptV2(...)` workflow ownership state).
- **Confirmed implementation**:
  - V2 now maintains explicit dual-lane ownership contract state (`background_lane` + `enroll_lane`) in orchestrator metadata.
  - Added explicit workflow-level ownership markers:
    - `workflow_owner=k80_enrollment_v2`
    - `final_close_eligible` (false while retained continuation is intended)
    - `workflow_ready_for_step3_entry` (true only when both lanes are retained and Step-2 sequence is complete).
  - Step-2-success path now explicitly records retained-lane ownership for continuation readiness, rather than only implying retention from cleanup behavior.
  - Orchestrator execution state now reports `v2_step2_completed_ready_for_step3` when dual-lane retention and Step-2 completion conditions are jointly satisfied.
- **Confirmed diagnostics added**:
  - `v2_dual_lane_contract_state`
  - `v2_workflow_ready_for_step3_entry`
  - `v2_auto_teardown_at_step2_success` (explicitly false in current retained Step-2 success contract).
- **Verification evidence**:
  - `node -e "require('./agent/lib/events/zktecoEnrollmentV2Orchestrator.js'); console.log('ok')"`
  - passed.
- **Boundary note**:
  - no Step-3/Step-4 protocol behavior implementation added in this slice,
  - no legacy enrollment-path changes.

## Entry 2026-04-23 (Enrollment V2 Step-2 Background-Lane Interleaving During Active Window)
- **Date**: 2026-04-23
- **Scope**: `agent/lib/events/zktecoEnrollmentV2Orchestrator.js` only (`runV2PhaseEnrollLaneBringUp(...)` + Step-2 source metadata mapping).
- **Confirmed implementation**:
  - Added bounded background/control-lane interleaving during active Step-2 enroll-lane execution, aligned to official Step-2 concurrency intent.
  - Interleaving sends are explicit `0x000b(DeviceID)` on background lane only and occur at bounded checkpoints in Step-2:
    - after `0x0045`,
    - once during early Step-2 tail (`0x000b` burst).
  - Background interleave traffic uses background lane/session/reply lineage only (no borrowing from enroll lane lineage).
  - Existing enroll-lane Step-2 sequence/order/payload behavior remains unchanged.
  - Step-2 success path still retains both lanes for continuation and does not auto-close at Step-2 success.
- **Confirmed diagnostics added**:
  - `v2_step2_bg_interleave_sent_count`
  - `v2_step2_bg_interleave_during_window`
  - `v2_step2_bg_interleave_last_reply_id`
  - `v2_step2_bg_interleave_session_continuity_ok`
  - `v2_step2_bg_interleave_reply_continuity_ok`
- **Verification evidence**:
  - `node -e "require('./agent/lib/events/zktecoEnrollmentV2Orchestrator.js'); console.log('ok-v2-step2-bg-interleave-load')"`
  - `node tests/agent_events/zktecoPullAdapter.pull.test.js`
  - both passed.
- **Boundary note**:
  - V2-only patch, no legacy enrollment-path changes,
  - no Step-3/Step-4 protocol behavior implementation in this slice.

## Entry 2026-04-23 (Enrollment V2 Step-3 Device-State Conflict Guard Relaxed to Warning-Only)
- **Date**: 2026-04-23
- **Scope**: `agent/lib/events/zktecoEnrollmentV2Orchestrator.js` only (`runV2PhasePromptBoundary(...)`, Step-3 pre-`0x003d` gating).
- **Confirmed implementation**:
  - removed hard pre-send Step-3 early-fail on `device_user_id > V2_STEP3_DEVICE_STATE_MAX_USER_ID` (legacy threshold `3`).
  - Step-3 now preserves narrow validity blocking only (`device_user_id` missing/invalid/out-of-range via existing resolver) and proceeds to `0x003d` send when `device_user_id` is otherwise valid.
  - device-state conflict detection (`device_user_id > 3`) is retained as warning-only instrumentation and no longer forces `v2_step3_003d_send_skipped`.
- **Confirmed diagnostics**:
  - retained: `v2_step3_003d_device_user_id_device_state_conflict`, `v2_step3_003d_derivation_blocked_reason`, `v2_step3_003d_send_attempted`, `v2_step3_003d_send_skipped`, `v2_step3_003d_skip_reason`
  - added: `v2_step3_003d_device_state_conflict_warning_only`
  - flattened `source_metadata` projection now includes:
    - `v2_step3_003d_device_user_id_device_state_conflict`
    - `v2_step3_003d_device_state_conflict_warning_only`
    - `v2_step3_003d_derivation_blocked_reason`
- **Boundary note**:
  - no Step-2 changes,
  - no Step-3 order/session/reply/ACK-matching/settle-delay changes,
  - no Step-4 implementation,
  - no legacy enrollment-path changes.

## Entry 2026-04-23 (Enrollment V2 Step-3 Resolver Check-Order Fix for Numeric `device_user_id`)
- **Date**: 2026-04-23
- **Scope**: `agent/lib/events/zktecoEnrollmentV2Orchestrator.js` only (`resolveStep3DeviceUserIdInput(...)`).
- **Confirmed implementation**:
  - fixed resolver check order so numeric values are validated before missing checks.
  - `Number.isInteger(rawValue)` now resolves valid u32-range numeric IDs (e.g., `11`) as valid input.
  - numeric-but-invalid values (negative, non-integer, out-of-u32) now classify as `device_user_id_invalid`, not missing.
  - missing classification now applies only to truly absent/blank inputs (`null`/`undefined`/empty string-like).
- **Boundary note**:
  - no Step-2 behavior changes,
  - no Step-3 order/session/reply/ACK/settle-delay changes,
  - no payload derivation semantic changes,
  - no Step-4 or legacy enrollment-path changes.

## Entry 2026-04-24 (Step-3 Single-Runtime Preflight Invariant for Comparative Validations)
- **Date**: 2026-04-24
- **Confirmed finding**:
  - mixed concurrent agent runtimes for the same agent identity can produce contradictory Step-3 comparisons (warning-only vs hard-block-like outcomes) that do not reflect a single effective runtime code path.
  - this was observed operationally in a real rerun window:
    - before cleanup: `10` relevant enrollment runtime processes (`node agent/index.js` / `npm ... agent:start` lineage),
    - after cleanup: one clean runtime only.
  - clean-runtime proof artifacts captured:
    - process: `PID=12588`,
    - command line: `"C:\\Program Files\\nodejs\\node.exe" agent/index.js`,
    - env proof: `C:\\attendance-system\\.tmp_agent_env_proof_single_runtime_step3.txt`,
    - startup log: `C:\\attendance-system\\.tmp_agent_single_runtime_step3.out.log`.
- **Why it matters**:
  - comparative Step-3 debug conclusions are unreliable when multiple runtimes poll and execute for the same identity at once.
  - mixed runtimes can mimic protocol instability and branch-semantic contradictions.
- **Operational invariant**:
  - single-runtime proof is mandatory before comparing Step-3/enrollment reruns.
- **Required preflight before future Step-3 / enrollment reruns**:
  - enumerate relevant runtime processes for enrollment execution.
  - stop duplicate/stale runtimes for the same agent identity.
  - prove exactly one enrollment runtime PID remains active.
  - prove `K80_ENROLL_V2_LADDER_ENABLED=true` in that single runtime launch context.
  - only then queue and compare rerun outcomes.
- **Interpretation rule for future contradictions**:
  - if run-to-run semantics differ (for example warning-only vs hard-block-like behavior) and single-runtime cleanliness was not proven first, classify the contradiction as operational/runtime-consistency risk until proven otherwise.
  - this rule is operational only; it does not claim protocol logic is fully solved.

## Entry 2026-04-24 (Enrollment Debug Operating Rules: Runtime Cleanliness, Gate Discipline, and Failure Classification)
- **Date**: 2026-04-24
- **Confirmed current state**:
  - mixed concurrent agent runtimes can produce contradictory enrollment behavior and misleading run-to-run comparisons.
  - Step-3 has at least one confirmed on-wire success (`0x003e` ACK, `0x003d` ACK, `protocol_execution_state=v2_step3_completed_ready_for_step4`).
  - Step-3 is not yet proven stable because a repeatability no-finger rerun also failed under comparable conditions.
  - strongest current instability boundary remains after `0x003e` ACK and before/at the `0x003d` send decision.
- **Working operating rules**:
  - single-runtime proof is mandatory before any comparative Step-3/enrollment rerun.
  - do not compare runs unless duplicate runtimes are eliminated and one active runtime PID is proven.
  - classify each failure first as `operational`, `observability`, or `protocol` before deeper reasoning.
- **Mandatory preflight before any future enrollment rerun**:
  - enumerate relevant agent runtimes for the same agent identity.
  - stop stale/duplicate runtimes.
  - prove one active runtime PID only.
  - prove required runtime flag state for that runtime launch.
  - only then queue and execute the rerun.
- **Run-design rule**:
  - each bounded rerun must ask exactly one question and avoid mixing multiple hypotheses in one pass.
- **Guard-design rule**:
  - do not add/keep hard-block guards unless supported by strong direct evidence.
  - `device_state_conflict` is not to be treated as a proven protocol hard-block invariant from current evidence.
- **Interpretation rule for failures**:
  - when a rerun fails, first determine whether failure is operational (runtime/process), observability (missing/ambiguous telemetry), or protocol (on-wire/branch behavior under clean runtime), then proceed.
- **Step-3 gate definition**:
  - treat Step-3 as passed only when all gate conditions are explicitly observed in the same clean runtime run:
    - `0x003e` sent and ACKed with coherent reply-id,
    - `0x003d` sent and ACKed with coherent reply-id,
    - `protocol_execution_state=v2_step3_completed_ready_for_step4`.
- **Step-4 caution note**:
  - no Step-4 confidence should be assumed from mixed-runtime or ungated Step-3 results; Step-4 work must begin only from a clean-runtime run that satisfies the Step-3 gate definition above.

## Entry 2026-04-27 (V2 Step-4 First Continuation Milestone: PCAP-Confirmed `0x05df -> 0x05dd`)
- **Date**: 2026-04-27
- **Evidence source**: `trytryrtryryryryryryr.pcapng` (PCAP is runtime protocol truth for this milestone).
- **Confirmed milestone**:
  - V2 Step-4 first continuation is now confirmed on wire through `0x05df -> 0x05dd`.
- **Confirmed preconditions present in the validated run**:
  - single-runtime cleanliness was enforced before comparison,
  - target fingerprint/device-side state was cleaned,
  - Step-3 `0x003d` was accepted (`0x07d0`),
  - post-`0x003d` `0x01f4` ACK parity occurred, including structured-frame ACK.
- **Confirmed wire sequence**:
  - `0x003e -> 0x07d0` (reply `19`),
  - `0x003d -> 0x07d0` (reply `20`),
  - post-`0x003d` `0x01f4` interaction frames received and ACKed with client `0x07d0`,
  - structured post-`0x003d` `0x01f4` received and ACKed,
  - client continuation `0x05df`,
  - device response `0x05dd`.
- **Confirmed `0x05df` details**:
  - session id: `18596`,
  - reply id: `21`,
  - payload hex: `0109000500000000000000`,
  - response command: `0x05dd`,
  - response reply id: `21`,
  - observed `0x05dd` payload length: `292`.
- **Scope boundary (explicit non-claims)**:
  - this milestone confirms first continuation only (`0x05df -> 0x05dd`),
  - this does **not** confirm `0x0058`,
  - absence of `0x0058` is not a failure criterion until `0x0058` is implemented and explicitly validated.
- **Next boundary to review**:
  - implement/review `0x0058` continuation behavior after confirmed `0x05df -> 0x05dd`,
  - treat any additional structured `0x01f4` after `0x05dd` as part of that next continuation boundary.

## Entry 2026-04-28 (V2 Step-4 `0x0058` Continuation Milestone: PCAP-Confirmed Selected-Finger Payload)
- **Date**: 2026-04-28
- **Evidence source**: fresh PCAP from the selected-finger-byte `0x0058` validation run (PCAP is runtime protocol truth for this milestone).
- **Confirmed milestone**:
  - V2 Step-4 continuation is now confirmed on wire through `0x05df -> 0x05dd -> 0x0058 -> 0x05dc` for the local `288` family.
- **Confirmed before/after evidence**:
  - before the selected-finger-byte payload fix, local `288` family sent `0x0058` payload `040000` and device replied `0x1381`,
  - after the fix, local `288` family sent `0x0058` payload `040006` and device replied `0x05dc`.
- **Confirmed wire sequence**:
  - `0x003e -> 0x07d0`,
  - `0x003d -> 0x07d0`,
  - short post-`0x003d` `0x01f4` frames ACKed by client `0x07d0`,
  - structured `0x01f4` payload length `14`, session `8`, ACKed by client `0x07d0`,
  - terminal structured `0x01f4` payload length `72`, session `4`, ACKed by client `0x07d0`,
  - `0x05df -> 0x05dd`,
  - `0x0058` payload `040006 -> 0x05dc`,
  - later `0x05dd`,
  - later `0x07d0`.
- **Confirmed `0x0058` payload derivation**:
  - first `0x05dd` after `0x05df` had word0 `288`,
  - derived count is `288 / 72 = 4`,
  - selected finger/index byte is `0x06`,
  - payload rule is `byte0=count`, `byte1=0x00`, `byte2=selected finger/index byte from Step-3 0x003d payload`,
  - therefore `288 + selected finger 0x06` produces `0x0058` payload `040006`.
- **Scope boundary (explicit non-claims)**:
  - this milestone confirms `0x0058 -> 0x05dc` continuation only,
  - this does **not** claim final enrollment completion,
  - this does **not** claim final close/finalization correctness.
- **Next boundary to review**:
  - review/implement the post-`0x05dc` continuation/finalization path using PCAP evidence before claiming complete enrollment success.

## Entry 2026-04-28 (V2 Step-4 Post-`0x05dc` Drain Milestone: PCAP-Confirmed Later `0x05dd` + Trailing `0x07d0`)
- **Date**: 2026-04-28
- **Evidence source**: `rtrtr.pcapng` (PCAP is runtime protocol truth for this milestone).
- **Confirmed milestone**:
  - V2 Step-4 post-`0x05dc` receive-only drain is now confirmed on wire through later `0x05dd` plus trailing `0x07d0` after `0x0058 -> 0x05dc`.
- **Confirmed wire sequence**:
  - terminal structured `0x01f4` payload length `72`, session `4`, reply `0`, ACKed by client `0x07d0` on retained session `61377`, reply `0`,
  - `0x05df` sent on session `61377`, reply `21`, payload `0109000500000000000000`,
  - `0x05dd` received after `0x05df` on session `61377`, reply `21`, payload length `292`,
  - `0x0058` sent on session `61377`, reply `22`, payload `040006`,
  - `0x05dc` received after `0x0058` on session `61377`, reply `22`, payload length `8`,
  - later `0x05dd` received after `0x05dc` on session `0`, reply `22`, payload length `1129`,
  - trailing `0x07d0` received on session `61377`, reply `22`, payload length `0`.
- **Scope boundary (explicit non-claims)**:
  - this milestone confirms the post-`0x05dc` drain only,
  - this does **not** claim final enrollment completion,
  - this does **not** claim final `0x003e` / `0x003c` close/finalization correctness.
- **Next boundary to review**:
  - review/implement final `0x003e -> 0x07d0` and `0x003c -> 0x07d0` after confirmed post-`0x05dc` drain before claiming complete enrollment success.

## Entry 2026-04-28 (V2 Enrollment-Lane Finalization Milestone: PCAP-Confirmed Final `0x003e` + `0x003c` ACKs)
- **Date**: 2026-04-28
- **Evidence source**: `iooio.pcapng` (PCAP is runtime protocol truth for this milestone).
- **Confirmed milestone**:
  - V2 enrollment-lane cleanup/finalization is now confirmed on wire through final `0x003e -> 0x07d0` and final `0x003c -> 0x07d0` after the confirmed post-`0x05dc` drain.
- **Confirmed preceding chain in the same PCAP**:
  - terminal structured `0x01f4` was ACKed,
  - `0x05df -> 0x05dd`,
  - `0x0058` payload `040006 -> 0x05dc`,
  - later `0x05dd`,
  - trailing `0x07d0`.
- **Confirmed finalization wire sequence**:
  - final `0x003e` sent on retained enroll session `61377`, reply `23`, empty payload,
  - device replied `0x07d0`, session `61377`, reply `23`,
  - final `0x003c` sent on retained enroll session `61377`, reply `24`, empty payload,
  - device replied `0x07d0`, session `61377`, reply `24`.
- **Confirmed non-behavior**:
  - no `0x03e9` (`CMD_EXIT`) was part of this finalization,
  - this is enrollment-lane cleanup/finalization, not main device/app-session disconnect.
- **Scope boundary (explicit non-claims)**:
  - this confirms the V2 enrollment protocol chain through final `0x003e` / `0x003c` ACKs,
  - this does **not** claim product/user-visible enrollment success,
  - this does **not** prove the fingerprint appears in device export/UI or can be used for verification.
- **Next boundary to validate**:
  - functional validation remains separate: verify the enrolled fingerprint appears on device/export and can be used for verification.

## 2026-04-30 K80 ATTLOG parser layout runtime validation

- Confirmed: after the parser-only fix, the K80 length-prefixed 40-byte ATTLOG layout (`k80_len4_ascii24_ts27_status26_verify25`) was runtime-validated against the managed K80 (`zkteco:sn:BIND-QUEUE-c26a7486`).
- Validation command `6b1215cf-a042-4f22-8ef5-b6c51d847993` produced accepted batch `5753a802-a57a-4dfb-81fb-b602c0628a1b` with `pull_ok=true`, `events_received_count=3`, `inserted_count=3`, `deduped_count=0`.
- Confirmed parser diagnostics: `binary_layout_id=k80_len4_ascii24_ts27_status26_verify25`, `binary_payload_header_bytes=4`, `binary_record_size_used=40`, `binary_records_total=104`, `binary_records_decoded=103`, `final_attlog_payload_bytes=4164`, `final_parser_merged_candidates=103`.
- Confirmed target event persisted: device/person `1`, local `2026-04-28 17:03:28 Africa/Tunis`, UTC `2026-04-28T16:03:28Z`, matching the ZKTime-visible attendance record. Surrounding device/person `3` events at local `17:03:13` and `17:03:17` were also inserted.
- Scope boundary: this confirms the parser/layout fix and pull/history-drain fact-lane ingestion for the ZKTime-visible event. Pull-carried direction remains non-authoritative direction evidence, and RT/UI behavior was not validated in this run.

## 2026-04-30 K80 full-history ATTLOG direction-state validation
- Confirmed: for the PCAP-proven K80 length-prefixed 40-byte ATTLOG layout (`k80_len4_ascii24_ts27_status26_verify25`), record offset 31 is the full-history direction/state byte for the labeled 2026-04-30 punches. Mapping validated: `0x00`/`0x04` => `IN`, `0x01`/`0x05` => `OUT`.
- Confirmed: record offset 26 remains parsed as `status_code`/verify-related evidence and is not authoritative direction for this K80 full-history layout. Regression coverage proves byte 26 value `0x01` alone must not force `OUT`.
- Patch scope: parser/tests only. Protocol retrieval, history-drain lifecycle, RT, enrollment, UI, legacy/generic ZKTeco layouts, and existing DB rows were not changed.
- Runtime validation: after restarting only the agent to load the parser patch, one bounded history-drain validation ran with command `b34f650d-81a2-4dfa-b6d6-ebbeb53e956e` and batch `aa5b0037-fb7c-4a3f-a38b-533b140da830`; batch accepted with `pull_ok=true`, `events_received_count=8`, `inserted_count=8`, `deduped_count=0`, `final_attlog_payload_bytes=4484`, and parser layout `binary_40_k80_len4_ascii24_ts27_status26_verify25`.
- Runtime direction proof: labeled records decoded as expected without RT: user 3 `2026-04-30 10:49:26` => `IN`, user 3 `10:49:29` => `OUT`, user 22 `10:49:34` => `IN`, user 22 `10:49:38` => `OUT`.
- Boundary: this confirms full-history direction values for the K80 length-prefixed 40-byte layout. Persisted metadata/source-basis still showed legacy `attendance_status_map` wording in DB after the parser-only patch; if strict persisted provenance is required, handle that as a separate narrow metadata propagation task.

## 2026-04-30 K80 live RT subscriber validation: capture worked, server ingest policy blocked rows
- Validation mode: live RT session after K80 full-history fact and direction GREEN validations.
- Runtime proof: agent restarted with `K80_RT_SUBSCRIBER_ENABLED=true`, RT initiation/auth succeeded with `0x07d0`, subscriber started, and PID `3784` held an established TCP connection to `192.168.22.201:4370`.
- Operator expected sequence: user `22` IN, user `3` IN, user `22` OUT, user `3` OUT.
- Captured RT batches after readiness baseline: three `agent_realtime` batches were accepted with `events_received_count=1` each, but `inserted_count=0` and no rows were inserted into `device_realtime_direction_observations`.
- Captured payload evidence: batch `9d267e34-7b9a-4603-ba33-56070f0f2d04` captured user `22` state `00` => `IN`; batch `429d5bf6-0a6e-427f-af06-2591b39e8c90` captured user `3` state `00` => `IN`; batch `c6957875-4856-417c-b6df-6cce96fb207f` captured user `3` state `01` => `OUT`.
- Missing in this run: expected user `22` OUT was not captured in the accepted RT batch payloads inspected after DONE.
- Blocker confirmed: server-side RT ingest policy was disabled in the running backend process (`k80_rt_ingest_policy_enabled=false`, `k80_rt_ingest_insert_path_skipped=true`, `k80_rt_ingest_insert_path_skip_reason=k80_rt_ingest_policy_disabled`), so accepted realtime batches did not create `device_realtime_direction_observations` rows. Agent RT flags alone are insufficient; backend/server RT ingest environment must also be enabled before claiming RT observation-table GREEN.
- Boundary: no code was changed; no pull/history-drain was run during the RT capture window after READY.

## 2026-04-30 K80 RT ingest retry with backend policy enabled
- Validation mode: live RT retry after enabling backend/server RT ingest policy and agent RT subscriber policy.
- Confirmed backend policy proof: arming batch `20e104d8-c6ac-4136-ac53-b31073867f93` showed `k80_rt_ingest_policy_enabled=true`, `k80_rt_ingest_policy_flag_enabled=true`, `k80_rt_ingest_policy_device_match=true`, and `realtime_policy_enabled=true`.
- Confirmed subscriber proof: RT initiation/auth succeeded with `0x07d0`; subscriber session was armed and later observed `session_rt01f4_frames_count=9`.
- Confirmed DB insertion: after READY/DONE, `device_realtime_direction_observations` received new rows for the target K80. Insert path diagnostics showed `k80_rt_ingest_insert_path_entered=true`, `k80_rt_ingest_insert_path_skipped=false`, and dual-time metadata (`dual_time_v1`, `untrusted`, `server_ingest_clock`) on inserted rows.
- Captured rows included user `3` OUT, user `22` OUT, user `3` OUT, user `22` OUT, user `3` IN, user `22` IN, user `22` IN, user `3` OUT, and user `3` IN across realtime batches `15298301-7780-4b58-bd83-779193fa4ce6`, `9cbc7b99-266c-473f-919b-9769d1997e68`, `e5db7fe9-d58d-4b63-abc4-bc212ac50650`, `8bf7a4c5-84a7-409c-919d-7dfaf08b1230`, and `a0b421ea-cfb8-41f9-9724-7e6451d1fa57`.
- Boundary: operator replied `done` without the expected per-press list/timestamps, so this run proves RT capture + DB insertion + direction decoding, but not exact expected-vs-captured completeness/order.

# K80 OPERATIONAL RUNBOOK — KNOWN GOOD STATE

## Current Working Status
- `Confirmed`: K80 full-history fact ingestion is GREEN for managed device `zkteco:sn:BIND-QUEUE-c26a7486`.
- `Confirmed`: K80 full-history direction decoding is GREEN for the length-prefixed 40-byte ATTLOG layout.
- `Confirmed`: K80 RT subscriber is operational when the agent-side RT subscriber policy is enabled.
- `Confirmed`: K80 backend RT ingest is operational when the backend/server-side RT ingest policy is enabled.

## Full-History Parser Contract
- Layout id: `k80_len4_ascii24_ts27_status26_verify25`.
- User/device id offset: record offset `2` as ASCII.
- Timestamp offset: record offset `27` as packed ZK timestamp.
- Direction offset: record offset `31`.
- Byte `26`: non-authoritative status/verify evidence only.
- Direction mapping for this K80 full-history layout:
  - `0x00` / `0x04` => `IN`.
  - `0x01` / `0x05` => `OUT`.
- Direction basis: `k80_full_history_direction_state`.
- Never use legacy `defaultStatusMap` as K80 full-history direction truth.

## Runtime Proof
- Parser tests passed:
  - `node tests\agent_events\zktecoAttendanceParser.test.js`
  - `node tests\agent_events\zktecoPullAdapter.pull.test.js`
- Runtime validation:
  - command_id: `b34f650d-81a2-4dfa-b6d6-ebbeb53e956e`
  - batch_id: `aa5b0037-fb7c-4a3f-a38b-533b140da830`
  - `pull_ok=true`
  - `events_received_count=8`
  - `inserted_count=8`
- Confirmed labeled direction records:
  - user `3`, `2026-04-30 10:49:26` => `IN`
  - user `3`, `2026-04-30 10:49:29` => `OUT`
  - user `22`, `2026-04-30 10:49:34` => `IN`
  - user `22`, `2026-04-30 10:49:38` => `OUT`

## Known-Good Full-History Agent Flags
- `K80_HISTORY_DRAIN_MODE_ENABLED=true`
- `K80_HISTORY_DRAIN_MODE_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`
- `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ENABLED=true`
- `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`
- `K80_EXPERIMENTAL_PROTOCOL_FAMILIES_ALLOWLIST=attlog_07d0_followup,dynamic_05e0_payload,pull_request_07d0_continue`
- `K80_ATTLOG_07D0_FOLLOWUP_ENABLED=true`
- `K80_ATTLOG_07D0_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`
- `K80_DYNAMIC_05E0_PAYLOAD_ENABLED=true`
- `K80_DYNAMIC_05E0_PAYLOAD_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`
- `K80_PULL_REQUEST_07D0_CONTINUE_ENABLED=true`
- `K80_PULL_REQUEST_07D0_CONTINUE_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`

## Known-Good RT Requirements
- RT observation-table ingest requires BOTH backend/server policy and agent policy.
- Backend/server flags:
  - `K80_RT_01F4_INGEST_ENABLED=true`
  - `K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`
  - `K80_RT_01F4_RECONCILE_WINDOW_MS=5000`
- Agent flags:
  - `K80_RT_SUBSCRIBER_ENABLED=true`
  - `K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`
  - `K80_RT_SUBSCRIBER_AUTH_PASSWORD=1234`
  - `K80_RT_01F4_INGEST_ENABLED=true`
  - `K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`
  - `K80_RT_01F4_RECONCILE_WINDOW_MS=5000`
  - `K80_RT_01F4_REQUIRE_PERSON_PARSE=true`

## RT Proof And Caveat
- `Confirmed`: backend RT ingest became operational when server-side policy was enabled.
- Expected insert diagnostics:
  - `k80_rt_ingest_policy_enabled=true`
  - `k80_rt_ingest_insert_path_entered=true`
  - `k80_rt_ingest_insert_path_skipped=false`
- RT rows insert into `device_realtime_direction_observations` with:
  - `rt_time_contract_version=dual_time_v1`
  - `rt_time_observed_trust=untrusted`
  - `rt_time_chronology_source=server_ingest_clock`
- RT mapping:
  - `0x00` / `0x04` => `IN`
  - `0x01` / `0x05` => `OUT`
- Caveat:
  - a multi-press live RT session produced extra/buffered frames.
  - strict RT validation should use one user, one press, then wait 10 seconds before inspecting rows or performing the next press.

## Quick Preflight Checklist
- `server.js` listening on port `3000`.
- Exactly one `agent/index.js` runtime.
- Diagnostics port `4780` listening.
- Active `agent_id`: `ddc32a87-0b42-4448-bdcd-297642c66ee6`.
- Device reachable: `192.168.22.201:4370`.
- Device UID: `zkteco:sn:BIND-QUEUE-c26a7486`.
- Company ID: `DEFAULT`.

## Do-Not-Touch List
- Do not touch enrollment V2 while working on pull/RT.
- Do not change parser offsets `2` / `27` / `31` without PCAP evidence plus tests.
- Do not treat byte `26` as direction.
- Do not treat legacy `defaultStatusMap` as K80 full-history truth.
- Do not change the guarded `0x05e0` protocol path without PCAP proof.
- Do not call K80 "working" unless fact ingestion, parser layout, direction decoding, and DB persistence proof are all checked.

## Future Production Cleanup
- Convert environment flags into a DB-backed device profile/policy.
- Do not require manual restart for toggling device features in production.
- Keep lab/debug flags separate from the stable K80 profile.

## 2026-05-01 Device Monitoring Runtime Command Wiring
- `Confirmed`: device monitoring sessions are now wired to agent runtime commands instead of remaining SaaS control-plane-only leases.
- `Confirmed`: command contract now includes `START_DEVICE_MONITORING` and `STOP_DEVICE_MONITORING`.
- `Confirmed`: monitoring session start queues `START_DEVICE_MONITORING`, records `start_command_id`, and returns `monitoring_control_plane_only=false` plus `agent_runtime_command_wired=true`.
- `Confirmed`: monitoring session stop queues `STOP_DEVICE_MONITORING`, records `stop_command_id`, and transitions through `stopping` until the agent reports stop completion.
- `Confirmed`: the agent handles monitoring commands by reusing existing K80 RT subscriber internals and reports results through the backend monitoring command result endpoint.
- `Confirmed`: initial runtime limitation is one active RT subscriber per agent process. Same-device start is idempotent/already-running; different-device start is a subscriber conflict.
- `Boundary`: K80 parser, full-history pull/history-drain behavior, direction decoding, RT frame decoding/mapping, enrollment, and UI were not changed in this slice.
- `Production note`: keep moving toward DB-backed device profile/policy so Connect/Disconnect does not depend on manual env-flag restarts.

# MONITORING COMMAND FLOW — PENDING OPERATOR PRESS

- After the monitoring-command patch, patched runtime was confirmed:
  - `server.js` running on port `3000`, PID `8420`.
  - `agent/index.js` running with diagnostics port `4780`, PID `5316`.
  - active `agent_id`: `ddc32a87-0b42-4448-bdcd-297642c66ee6`.
- Patched backend route proof:
  - `/api/agent/monitoring-command-results` returned `401` instead of old-runtime `404`.
- Monitoring session created:
  - session_id: `528db920-8b14-4ed0-a645-64e9ee89390a`.
  - `monitoring_control_plane_only=false`.
  - `agent_runtime_command_wired=true`.
  - `start_command_id=564ce743-a2bc-45f7-8140-bf7e9a684bf2`.
- `START_DEVICE_MONITORING` command:
  - command type: `START_DEVICE_MONITORING`.
  - command status: `acknowledged`.
  - agent received the command.
  - agent result: `OK`.
  - runtime state: `active`.
  - `rt_subscriber_started=true`.
  - `rt_subscriber_already_running=false`.
  - session status: `active`.
  - `initiation_ok=true`.
- Live RT proof was skipped:
  - no fresh finger press was available because operator was working from home.
  - no new RT observation through this monitoring-session flow was collected.
- Stop/disconnect flow was not executed:
  - `STOP_DEVICE_MONITORING` not tested yet.
  - session stopped proof not collected.

Current status: `MONITORING_FLOW_PENDING_OPERATOR_PRESS`.

Important: do NOT mark this as GREEN yet.

Next office validation:
1. Start or reuse a monitoring session.
2. Wait for READY.
3. Operator presses one fresh finger only.
4. Confirm one new `device_realtime_direction_observations` row.
5. Disconnect/stop session.
6. Confirm `STOP_DEVICE_MONITORING` is queued/acknowledged.
7. Confirm session status becomes stopped.

## 2026-05-01 First Logic-Only Operations Interface
- `Confirmed`: `/boss` remains the active operations UI foundation and now includes a logic-only Operations tab for companies, device operations, monitoring sessions, sync controls, and realtime observations.
- `Confirmed`: this slice added frontend API wiring only. It did not change K80 parser/full-history logic, RT protocol decoding/mapping, enrollment, CSS/design/styling, or V2 behavior.
- `Confirmed`: Operations tab behavior includes:
  - list/select companies and add a company through `GET /api/companies` and `POST /api/companies`,
  - list bridge devices for the active company,
  - show selected-device identity, connection metadata, managing agent, monitoring session state, latest command, latest sync, and latest batch evidence,
  - connect monitoring through `POST /api/agent-admin/devices/:deviceUid/monitoring-sessions`,
  - disconnect monitoring through `DELETE /api/agent-admin/device-monitoring-sessions/:sessionId`,
  - queue full-history sync through the existing pull command endpoint with `history_mode=history_drain`,
  - show realtime observations through the list endpoint and append rows through SSE when available.
- `Boundary`: the UI labels realtime rows as observations, not final attendance facts. It does not mark monitoring GREEN until a realtime observation is received through the monitoring-session flow.
- `Known limitation`: the browser `EventSource` API cannot send `x-api-key`; when API-key auth is required, the UI falls back to manual realtime-observation refresh instead of SSE.

## 2026-05-01 Boss Operations Interface Logic Validation
- `Confirmed`: `/boss` Operations tab rendered in a real headless Chrome browser against the running backend.
- `Confirmed`: companies list loaded, devices list loaded, and target device `zkteco:sn:BIND-QUEUE-c26a7486` could be selected.
- `Confirmed`: selected-device detail displayed identity, connection metadata, managing agent `ddc32a87-0b42-4448-bdcd-297642c66ee6`, readiness, latest command, latest batch, and latest sync state.
- `Confirmed`: Connect Monitoring from the UI created a monitoring session and queued `START_DEVICE_MONITORING`; DB proof for validation session `c770629b-7d6c-461f-8f65-fd659286a7fb` showed start command `8b7bd2f3-f3e9-4527-b4fa-4e68a9e2de31` acknowledged with `runtime_monitoring_state=active` and `rt_subscriber_started=true`.
- `Confirmed`: Disconnect Monitoring from the UI queued `STOP_DEVICE_MONITORING`; stop command `4064a6fb-318e-4f53-aa24-084531326eaf` was acknowledged and session status became `stopped`.
- `Confirmed`: realtime observations table loaded existing RT rows with dual-time metadata, and SSE connected when auth headers were not required.
- `Fixed in UI logic`: after disconnect, monitoring status now reports stopped instead of pending live proof, and closing the SSE stream updates the UI to `SSE disconnected`.
- `Boundary`: no live fresh finger press was available, so no new RT observation through this specific monitoring-session flow was collected. Full-history Sync button was not clicked during validation to avoid initiating a device history-drain implicitly.
- `Current status`: `BOSS_INTERFACE_PARTIAL` until a live office validation confirms one fresh RT observation through the monitoring-session flow and, if desired, a deliberate Sync Full History queue action.

## 2026-05-01 Product Interface Reset
- `Decision`: `/boss` is no longer the client-facing product operations path. It is retained only as an internal legacy/debug console.
- `Confirmed`: the client-facing product operations route is now `/app`.
- `Confirmed`: `/app` implements the simple product workflow only: Employer/Company -> Devices/Pointeuses -> Device Detail/Monitoring -> Live RT Events -> Sync Full History.
- `Confirmed`: `/app` browser validation loaded against the running backend, loaded companies, loaded devices, selected target device `zkteco:sn:BIND-QUEUE-c26a7486`, connected monitoring, reached session `active`, displayed realtime observations, and disconnected monitoring to session `stopped`.
- `Boundary`: this slice did not change K80 parser, full-history/history-drain protocol, RT protocol decoding/mapping, enrollment, backend command/session contracts, database rows, or CSS/design system.
- `Boundary`: Sync Full History was not clicked during validation to avoid initiating a device history-drain without an explicit runtime validation request.
- `Boundary`: add-company and add-device forms exist but were not mutation-tested during this reset to avoid creating product-test records.
- `Current status`: `PARTIAL_PRODUCT_INTERFACE_RESET` until a deliberate sync action and add/configure mutation test are run, and until an office validation confirms fresh RT observation proof through the product route.

## 2026-05-04 Boss Interface Retirement From Product Path
- `Decision`: `/boss` is retired from product usage. Requests to `/boss` now redirect to `/app/`.
- `Confirmed`: the old boss console remains available only as the explicitly internal/debug route `/internal/boss/`.
- `Confirmed`: `/app` is the client-facing product route and no longer shows dev controls such as Base URL, API Key, Environment, raw JSON dumps, loaded-at refresh/debug header state, old dashboard cards, or degraded/test panels.
- `Confirmed`: `/app` default device list filters to product-ready devices only: active company, `managed_status=managed`, provider present, host present, port present, and no candidate/test/incomplete/conflict/readiness/monitoring fixture identifiers.
- `Confirmed`: browser validation showed one product-ready device by default: `zkteco:sn:BIND-QUEUE-c26a7486` / `ZKTeco K80 Pro` / `192.168.22.201:4370` / `managed`, auto-selected.
- `Boundary`: no K80 parser, full-history/history-drain logic, RT protocol logic, enrollment, backend command/session APIs, CSS/design system, database rows, or device sync/live finger press were changed or run in this slice.
- `Do not repeat`: do not use `/boss` for client product workflows; use `/app` only. Keep `/internal/boss/` for diagnostics/debug workflows.
- `Current status`: `BOSS_RETIRED_PRODUCT_ROUTE_READY` for route/interface logic. Live RT and Sync actions still require explicit operator/runtime validation before claiming end-to-end product operation.

## 2026-05-04 Product App Device-First Simplification
- `Decision`: `/app` product structure should follow the simple ZKTime-style device-first workflow, not an admin/dashboard-first sequence.
- `Confirmed`: `/app` now leads with active employer context, product-ready pointeuse list, selected pointeuse status/actions, live punches, and sync attendance logs.
- `Confirmed`: employer/company creation and device configuration remain available but are collapsed into secondary setup details instead of dominating the page.
- `Confirmed`: primary labels now use operational copy: `Pointeuse`, `Connect`, `Disconnect`, `Sync attendance logs`, `Live punches`, and `Status`.
- `Confirmed`: browser validation showed the real K80 `ZKTeco K80 Pro` at `192.168.22.201:4370` visible and auto-selected, with Connect/Disconnect controls, Sync attendance logs button, and live punches table present.
- `Boundary`: no CSS/design/styling work, K80 parser changes, full-history/RT protocol changes, enrollment changes, backend API changes, live finger press, or sync run occurred in this slice.
- `Current status`: `PRODUCT_APP_STRUCTURE_SIMPLIFIED` for frontend structure/logic.

## 2026-05-04 Product App Visual Design Direction
- `Decision`: `/app` now uses an enterprise operational workspace visual direction inspired by VMware ESXi-style device operations, not a marketing landing page or generic dashboard.
- `Confirmed`: the layout is device-first: dark/purple left navigation rail for employer context and product-ready pointeuse list, central selected-pointeuse workspace, prominent Connect/Disconnect/Sync action bar, monitoring status, live punches table, sync status strip, and secondary collapsible technical details.
- `Confirmed`: visual palette follows the product direction: dominant purple, dark neutral workspace structure, and orange operational accent for sync/attention actions.
- `Confirmed`: browser validation showed the redesigned shell renders at `/app/`, real K80 `ZKTeco K80 Pro` at `192.168.22.201:4370` is visible and selected, Connect/Disconnect/Sync actions are present, live punches table loads rows, technical details are secondary, and Base URL/API Key/Environment/raw JSON debug controls are absent.
- `Boundary`: this visual slice did not change backend contracts, K80 parser/full-history logic, RT protocol logic, enrollment, database rows, sync runtime, or live finger-press validation.
- `Current status`: `DESIGN_IMPLEMENTATION_READY` for `/app` visual/product design implementation.

## 2026-05-04 Product App Workspace Restructure
- `Decision`: `/app` must use an ESXi-like selected-object workspace model: `Company -> Site -> Device -> Device workspace`.
- `Confirmed`: `/app` now uses a left object navigator/tree with Companies, a UI-only `Default Site`, and product-ready Devices under that site. The device list is no longer presented as a large card in the main workspace.
- `Confirmed`: the right workspace now shows breadcrumb, selected-object header, device action bar, status panel, live punches, sync/history, and collapsed technical details.
- `Confirmed`: browser validation showed Companies/Sites/Devices in the left navigator, `Default Site` fallback, real K80 `ZKTeco K80 Pro` at `192.168.22.201:4370` visible in the tree and selected in the workspace, Connect/Disconnect/Sync/Refresh actions present, live punches present, and no Base URL/API Key/Environment/raw JSON or marketing hero.
- `Boundary`: no backend APIs, site tables, K80 parser/full-history logic, RT protocol logic, enrollment, database rows, sync runtime, or live finger press were changed or run.
- `Corrected on 2026-05-05`: backend site model already exists. At the time of this entry, `/app` used a UI-only fallback because the real site model was not yet wired into the product app.
- `Current status`: `WORKSPACE_STRUCTURE_READY`.

## 2026-05-04 Product App Information Architecture
- `Decision`: `/app` is now structured as a SaaS operational app shell, not a one-device screen.
- `Confirmed`: main product navigation exists for `Operations`, `Employees`, `Attendance`, `Schedules`, `Rules`, `Reports`, and `Settings`.
- `Confirmed`: the Operations module owns the object navigator only: Company -> UI-only `Default Site` -> Devices.
- `Confirmed`: Operations workspace keeps the selected-device workflow: breadcrumb, selected object header, Connect, Disconnect, Sync attendance logs, Refresh, status, live punches, sync/history, and collapsed technical details.
- `Confirmed`: non-Operations modules are explicit placeholders only. They do not implement employee, attendance, schedule, rule, report, or settings engines yet.
- `Confirmed`: browser validation showed module navigation renders, Employees placeholder switches correctly, Operations switches back correctly, real K80 remains visible/selected under `Default Site`, live rows load, and no Base URL/API Key/Environment/raw JSON debug controls are present.
- `Boundary`: no backend APIs, backend routing, K80 parser/full-history logic, RT protocol logic, enrollment, database rows, sync runtime, live finger press, or CSS/design styling were changed or run.
- `Open`: direct `/app/operations`, `/app/employees`, etc. routes are not implemented yet; current implementation uses in-page module switching under `/app`. Add static/client routing later if needed.
- `Corrected on 2026-05-05`: backend site model already exists. At the time of this entry, `Default Site` remained UI-only because `/app` had not yet loaded/used real sites.
- `Current status`: `PRODUCT_APP_IA_READY`.

## 2026-05-04 Product App Navigation Cleanup
- `Decision`: Operations must be daily device work only; setup/configuration belongs in Settings.
- `Confirmed`: Operations sidebar no longer shows add-company, company setup, add-site, site setup, or add/configure-device forms.
- `Confirmed`: Operations object navigator now shows resource context only: active company node, UI-only `Default Site`, and product-ready devices. A secondary `Manage in Settings` link replaces always-visible setup forms.
- `Confirmed`: Settings now contains setup entry points/placeholders for Companies, Sites, Devices, and future device profiles/policies.
- `Confirmed`: browser validation showed Operations defaults to real K80 `ZKTeco K80 Pro` at `192.168.22.201:4370`, selected-device actions remain present, live punches rows load, Settings contains setup entry points, and Base URL/API Key/Environment/raw JSON debug controls are absent.
- `Boundary`: no backend APIs, K80 parser/full-history logic, RT protocol logic, enrollment, database rows, sync runtime, live finger press, or CSS/design polish were changed or run.
- `Current status`: `PRODUCT_NAV_CLEANUP_READY`.

## 2026-05-05 Product App Phase 0 Frontend Cleanup
- `Decision`: Phase 0 product frontend work split the `/app` JavaScript monolith into plain browser ES modules before any final visual design pass.
- `Confirmed`: `public/app/app.js` is now bootstrap-only, and responsibilities are separated into API client, shared state, module switching, Operations, Settings, realtime observations, monitoring sessions, sync commands, formatting helpers, and product policy helpers.
- `Confirmed`: centralized product policies now include product-ready device filtering, selected device/agent scoping, monitoring status labels, and realtime observation display labels.
- `Confirmed`: `/app` still loads companies, filters product-ready devices, auto-selects real K80 `ZKTeco K80 Pro` at `192.168.22.201:4370`, shows Operations by default, keeps Connect/Disconnect/Sync/Refresh actions, loads existing live punches, preserves Settings setup entry points, and keeps Base URL/API Key/raw JSON/debug panels absent.
- `Boundary`: no CSS/design/styling, backend APIs, K80 parser/full-history logic, RT protocol decoding/mapping, enrollment, database rows, sync runtime, or live finger press were changed or run.
- `Current status`: `PHASE_0_FRONTEND_CLEANUP_READY`.

## 2026-05-05 Product App Real Site Model Wiring
- `Decision`: `/app` must use the existing first-class site model instead of assuming backend sites are missing or using only a UI-only `Default Site`.
- `Confirmed`: the real site model exists in the repo and DB through `sites`, `devices.site_id`, `agent_nodes.site_id`, `site_agent_leases`, `services/sitesDb.js`, and existing `agent-admin` site APIs.
- `Confirmed`: the DEFAULT working K80 environment was aligned to a real active site without touching K80 parser/full-history/RT/enrollment logic or attendance/RT history tables.
- `Runtime alignment proof`:
  - site: `2fed1b7b-0503-4a19-bc00-f339fbb3749e`
  - company_id: `DEFAULT`
  - site_key: `default-site`
  - site_name: `Default Site`
  - device_uid: `zkteco:sn:BIND-QUEUE-c26a7486`
  - agent_id: `ddc32a87-0b42-4448-bdcd-297642c66ee6`
  - active site-agent lease: `ad9167fb-fa60-49a4-afaa-5788d35c4f52`
- `Confirmed`: the default-site helper is duplicate-safe by `(company_id, site_key)` and the site-agent lease helper reports `no_change` when the same active lease already exists.
- `Confirmed`: `/app` now loads real active product sites, groups product-ready devices by real `site_id`, shows real site names, and keeps an unassigned `Default Site` fallback so product-ready devices are not hidden during migration.
- `Boundary`: no new site table was created. No K80 parser, full-history protocol, RT protocol, enrollment, `device_events`, or `device_realtime_direction_observations` were changed.
- `Open`: Settings exposes site creation/reuse entry points but does not yet implement a full product-grade device-to-site assignment UI. Existing backend assignment APIs remain available under `agent-admin`.
- `Current status`: `SITE_MODEL_WIRED_READY`.

## 2026-05-05 Product App Phase 1B Operations Scoping
- `Decision`: Operations state is selected-device scoped. Monitoring session state, realtime rows, live-proof state, sync state, and technical details must not be shared globally across devices.
- `Confirmed`: selecting a device now closes the existing SSE stream, clears old selected-device RT/session/sync/proof state, validates the selected device/site, reloads selected-device evidence, refreshes RT rows for that device, and opens SSE only for the selected device.
- `Confirmed`: `/app` keeps real site grouping through the existing site model and now labels product-ready devices with no `site_id` as `Unassigned devices`, not `Default Site`. Real `Default Site` is reserved for actual site rows.
- `Confirmed`: product-safe status labels are centralized for monitoring and sync: `disconnected`, `connecting`, `active monitoring`/`pending live proof`, `live punches received`, `stopped`, `failed`, `sync idle`, `sync running`, `sync success`, and `sync failed`.
- `Confirmed`: sites/devices/evidence/realtime/monitoring/sync failures now have visible product-safe error states instead of being silently swallowed.
- `Boundary`: technical command/session/batch/agent IDs remain secondary technical details, not primary workspace status.
- `Boundary`: this slice did not change backend APIs, K80 parser/full-history logic, RT protocol decoding/mapping, enrollment, CSS/design/styling, database rows, sync runtime, or live finger-press behavior.
- `Current status`: `PHASE_1B_OPERATIONS_READY`.

## 2026-05-05 Product App Operations 1C Validation
- `Confirmed`: runtime preflight for Operations 1C found `server.js` running on port `3000` (PID `10916`), exactly one `agent/index.js` process (PID `5316`) with diagnostics port `4780`, active `agent_id=ddc32a87-0b42-4448-bdcd-297642c66ee6`, K80 reachable at `192.168.22.201:4370`, and K80 `zkteco:sn:BIND-QUEUE-c26a7486` managed under real `Default Site` (`site_id=2fed1b7b-0503-4a19-bc00-f339fbb3749e`).
- `Confirmed`: `/app` browser preflight loaded Operations with real K80 auto-selected, Connect/Disconnect/Sync actions visible, live punches table loaded, and no Base URL/API Key/raw JSON/debug panels.
- `Confirmed`: `/app` Connect validation is blocked before queuing `START_DEVICE_MONITORING` by backend execution gate `runtime_version_unsupported`; raw response details show agent reported version `1.0.0`, version support status `unsupported`, reason `below_minimum_supported_version`, policy profile `balanced`.
- `Confirmed`: frontend status hardening now preserves structured API error details and displays `Connect failed: runtime_version_unsupported` instead of generic `conflict`; the SSE status copy now says `Observation stream open; monitoring not active` when no monitoring session is active, avoiding false physical-streaming implication.
- `Boundary`: no K80 parser/full-history logic, RT protocol decoding/mapping, enrollment, backend command/session contracts, CSS/design/styling, live RT press, disconnect flow, or sync runtime validation was changed or run.
- `Open`: Operations 1C cannot proceed to fresh RT proof, disconnect proof, or product-route sync validation until the runtime version policy/runtime reported version mismatch is resolved safely.
- `Current status`: `OPERATIONS_1C_PARTIAL`.

## 2026-05-05 Runtime Version Governance Fix For Monitoring Connect
- `Decision`: keep runtime version governance enabled and resolve the `/app` Connect blocker by bumping the agent-reported runtime version to the supported target version rather than bypassing policy.
- `Confirmed`: root `package.json` and `package-lock.json` now report version `1.4.0`; `agent/index.js` reads root `package.json`, so fresh agent heartbeat reports `agent_reported_version=1.4.0`.
- `Confirmed`: active K80 agent `ddc32a87-0b42-4448-bdcd-297642c66ee6` heartbeat after agent restart reported `agent_reported_version=1.4.0`, `version_support_status=supported`, and `version_support_reason=meets_target_version` against DEFAULT policy `minimum_supported_version=1.2.3`, `target_version=1.4.0`.
- `Confirmed`: monitoring session start execution gating now evaluates command type `START_DEVICE_MONITORING`, not `PULL_DEVICE_EVENTS`; monitoring is a runtime lease/control command, not a fact pull.
- `Confirmed`: server restart was required to load the updated monitoring session service gate. After restart, `/app` Connect queued `START_DEVICE_MONITORING` command `0dd280a6-54a8-42b3-af14-a6fa7351718c`, the agent acknowledged it, and monitoring session `c94df159-01b0-4f6d-a9a5-a8ac0b795998` became `active`.
- `Confirmed`: the start result was OK with `runtime_monitoring_state=active`, `rt_subscriber_started=true`, and `rt_subscriber_already_running=false`.
- `Boundary`: no K80 parser/full-history logic, RT protocol decoding/mapping, enrollment, UI/CSS/design, pull command behavior, live finger press, disconnect validation, or sync validation was changed or run.
- `Open`: execution gate metadata still records `runtime_capability_unknown` as a warning for `command.start_device_monitoring` because reported capability state was missing/stale, but balanced policy allowed issuance and the agent successfully executed the command. A later capability-reporting cleanup may be needed if the warning should be eliminated.
- `Current status`: `VERSION_GOVERNANCE_FIXED`.

## 2026-05-05 RT Time Contract Display Fix
- `Decision`: `/app` Live punches must not use untrusted RT decoded device time as the primary product time when the row carries `rt_time_contract_version=dual_time_v1`, `rt_time_observed_trust=untrusted`, and `rt_time_chronology_source=server_ingest_clock`.
- `Confirmed`: fresh RT observation `846b06e0-123e-406e-a850-c4faca1501d0` for user `3` had correct direction evidence (`rt_state_code=00`, `direction_provisional=IN`) but untrusted decoded device time `observed_at_utc=2002-02-23T23:04:21Z`; the same row carried server chronology `rt_time_chronology_utc=2026-05-05T13:28:17.339Z`.
- `Fixed`: `/app` now displays server chronology (`rt_time_chronology_utc`, falling back to `created_at`) as the primary Live punches time for untrusted dual-time RT rows. The decoded device time remains visible only as secondary text labeled `Untrusted device time`.
- `Confirmed`: browser validation for `/app` showed the fresh row primary time as `05/05/2026 14:28:17`, with `Untrusted device time: 2002-02-24 00:04:21` secondary, while user `3`, direction `IN`, state `00`, and `dual_time_v1` remained visible.
- `Boundary`: no K80 parser, RT protocol decoder, full-history logic, enrollment, backend ingest semantics, DB rows, CSS/design, or direction mapping was changed.
- `Current status`: `RT_TIME_CONTRACT_PATCH_READY`.

## 2026-05-05 App Timezone Policy Patch
- `Decision`: `/app` product times must be formatted with the selected operational timezone, not the browser/computer timezone.
- `Policy`: selected timezone resolution order is selected site `metadata.timezone`, selected device/profile timezone if later present, active company `timezone`, then browser/UTC fallback only when no product timezone exists.
- `Confirmed`: DEFAULT company timezone is `Africa/Tunis`, real `Default Site` metadata timezone is `Africa/Tunis`, and current K80 fact/RT rows store `device_timezone=Africa/Tunis` as provenance.
- `Fixed`: `/app` Live punches primary times and selected-device sync/evidence times now call explicit `Intl`/`toLocaleString` formatting with the resolved selected timezone.
- `Fixed`: `/app` Sync attendance logs no longer hardcodes `device_timezone=Africa/Tunis`; sync command options use the resolved selected timezone.
- `Confirmed`: browser validation showed K80 under real `Default Site`; RT observation `846b06e0-123e-406e-a850-c4faca1501d0` still displays primary time `05/05/2026 14:28:17` in `Africa/Tunis`, while the 2002 decoded device time remains secondary untrusted evidence.
- `Boundary`: no K80 parser, RT protocol decoder, full-history protocol, enrollment, backend attendance engine/simulation/cache, DB rows, CSS/design, live finger press, or sync runtime execution was changed or run.
- `Open`: backend attendance/simulation/cache timezone policy still needs a separate review/patch; this entry covers `/app` display and sync-command timezone selection only.
- `Current status`: `APP_TIMEZONE_POLICY_READY`.

## 2026-05-05 Operations 1C Disconnect Green / Sync Blocked
- `Confirmed`: `/app` Operations runtime/app preflight remained healthy with `server.js` on port `3000`, one `agent/index.js` on diagnostics port `4780`, active agent `ddc32a87-0b42-4448-bdcd-297642c66ee6`, and K80 `zkteco:sn:BIND-QUEUE-c26a7486` reachable/managed under real `Default Site`.
- `Fixed`: `/app` now hydrates selected-device monitoring state from the latest acknowledged monitoring command result when the page reloads, so an active monitoring session is not shown as disconnected just because the in-memory session object was lost.
- `Confirmed`: fresh `/app` monitoring session `493f4991-0445-40f6-84de-983dcf5ff87b` started through `START_DEVICE_MONITORING` command `74911f8f-821c-44e2-b7be-6b924134009f`, then `/app` Disconnect queued `STOP_DEVICE_MONITORING` command `50366f8e-d2c2-4a7e-9539-088403a44427`.
- `Confirmed`: STOP command `50366f8e-d2c2-4a7e-9539-088403a44427` was acknowledged; result reported `runtime_monitoring_state=stopped` and `rt_subscriber_stopped=true`; session status became `stopped` with `stop_reason=operator_stop`.
- `Confirmed`: `/app` showed stopped/disconnected state after STOP and did not keep `pending live proof` or `live punches received` as the monitoring status after disconnect.
- `Confirmed`: `/app` Sync attendance logs attempts now surface the exact product-safe blocker `sync failed: runtime_capability_unknown`.
- `Blocked`: no new `PULL_DEVICE_EVENTS` command was queued from `/app` Sync because execution gating blocks `command.pull_device_events`; gate details show `runtime_capability_status=unknown`, `runtime_capability_reason=reported_state_stale`, `runtime_capability_reported_at=2026-03-23T08:30:28.039Z`, policy profile `balanced`, and policy level `unknown_runtime_capability=block`.
- `Boundary`: this validation did not touch K80 parser, full-history protocol, RT protocol decoder/mapping, enrollment, backend protocol logic, CSS/design, or DB event history. No live finger press was run.
- `Open`: Operations 1C cannot be GREEN until runtime capability reporting/gating for `command.pull_device_events` is corrected or refreshed, then one `/app` Sync validation queues and completes a fresh `PULL_DEVICE_EVENTS` command.
- `Current status`: `OPERATIONS_1C_PARTIAL`.

## 2026-05-06 Pull Capability Heartbeat Persistence Fix
- `Decision`: keep execution/capability governance enabled and fix heartbeat capability persistence instead of bypassing `unknown_runtime_capability=block`.
- `Root cause`: `parseCapabilityReportMap(...)` returned snake_case capability entries (`capability_key`, `capability_status`, `capability_reason`) while `mergeRuntimeCapabilityEntry(...)` in `services/agentBridgeDb.js` only read camelCase fields. Agent-declared command capabilities were therefore dropped before upsert.
- `Fixed`: `mergeRuntimeCapabilityEntry(...)` now accepts both snake_case and camelCase capability entry shapes.
- `Confirmed`: focused tests pass for heartbeat capability persistence and execution gating. Heartbeat now refreshes gate-readable `agent_runtime_capability_reported_state` rows for:
  - `command.pull_device_events`
  - `command.start_device_monitoring`
  - `command.stop_device_monitoring`
- `Runtime proof`: after server restart and normal agent heartbeat, active agent `ddc32a87-0b42-4448-bdcd-297642c66ee6` reported `agent_version=1.4.0`; `command.pull_device_events`, `command.start_device_monitoring`, and `command.stop_device_monitoring` were `supported` with fresh `reported_at=2026-05-06T07:48:25.976Z`.
- `Follow-on blocker`: `/app` Sync moved past `runtime_capability_unknown` but remained blocked before queueing by `device_path_capability_unknown`; gate details show `device_path.pull_device_events` is `reported_state_stale` with `reported_at=2026-05-05T08:09:22.786Z`, and balanced policy has `unknown_device_capability=block`.
- `Boundary`: no K80 parser, full-history protocol, RT protocol decoder/mapping, enrollment, CSS/design, DB manual mutation, or policy bypass was performed.
- `Current status`: `PULL_CAPABILITY_PERSISTENCE_FIXED`; Operations 1C Sync remains blocked on stale device-path capability evidence.

## 2026-05-06 Device Path Pull Capability Refresh Fix
- `Decision`: keep `unknown_device_capability=block` governance enabled and recover stale `device_path.pull_device_events` through a fresh evidence-producing probe, not by seeding data, extending stale windows, or bypassing `PULL_DEVICE_EVENTS` gating.
- `Root cause`: `device_path.pull_device_events` is device+agent+path evidence. It was refreshed by successful pulls, but once it became stale, normal `PULL_DEVICE_EVENTS` issuance was blocked before the command that would refresh it could run.
- `Fixed`: added `REFRESH_DEVICE_PATH_PULL_CAPABILITY` as a narrow agent command. Its execution gate requires normal site/runtime/version truth and fresh `command.pull_device_events`, but does not require the stale device-path capability it is explicitly proving.
- `Fixed`: the agent handles the refresh command by running a bounded existing pull-path probe with no event-batch submission. The backend only upserts `device_runtime_capability_reported_state.device_path.pull_device_events=supported` when the probe result reports success.
- `Fixed`: `/app` Sync now handles only stale `device_path.pull_device_events` by queuing the refresh command, waiting for acknowledgement, then retrying normal Sync once. It does not retry endlessly and does not bypass normal `PULL_DEVICE_EVENTS` governance.
- `Tests`: focused syntax checks passed for changed backend/agent/frontend modules. `node tests\services\executionGating.test.js` and `node tests\services\agentDeviceEventsService.test.js` passed.
- `Runtime proof`: after server and agent restart, refresh command `d70b8917-b092-4663-b21f-dda7b3529be4` was acknowledged with `fresh_pull_path_probe_succeeded`; diagnostics included `pull_ok=true`, `final_attlog_payload_bytes=5324`, and `final_parser_merged_candidates=132`.
- `Runtime proof`: `device_path.pull_device_events` became fresh/supported, and normal `PULL_DEVICE_EVENTS` then queued and acknowledged. Observed pull commands included `2ddf8d95-cd95-4278-8fbb-3d22da3426e9`, `529109b9-c71b-4ff6-a1cf-abd1767d85ea`, and `f7fde5a8-7dfc-4c6d-abba-28f4bc700427`; the final command produced accepted batch `ba9d4695-7b4a-44be-a7b3-49a3f904a939`.
- `Boundary`: the runtime validation used one Sync recovery action, but existing history-drain paging produced multiple acknowledged `PULL_DEVICE_EVENTS` commands. No K80 parser, full-history protocol, RT protocol decoder/mapping, enrollment, CSS/design, stale-window policy, or manual DB mutation was changed.
- `Current status`: `DEVICE_PATH_CAPABILITY_REFRESH_READY`; Operations 1C Sync can now recover from stale device-path pull capability evidence through the refresh probe path.

## 2026-05-06 Product App Settings V1
- `Decision`: `/app` Settings is now the product configuration surface for companies, real sites, devices, site/device assignment, managing-agent visibility, and read-only capability/policy status.
- `Confirmed`: Settings v1 keeps company list/add/select using existing company APIs and does not add company edit/deactivate yet.
- `Confirmed`: Settings v1 uses existing real site APIs to list, create, update site name/timezone/status, and set site active agent leases. Site timezone remains `metadata.timezone`.
- `Confirmed`: Settings v1 replaces the generic device upsert as the primary add-device path with existing manual onboarding -> candidate claim -> optional site assignment -> optional managing-agent binding APIs.
- `Confirmed`: Settings v1 shows product-ready devices, selected-device site assignment, onboarding/readiness evidence, active managing-agent binding, site active agent state, agent version/support summary, and read-only device path capability status where the backend exposes it.
- `Confirmed`: credential inputs are write-only/masked in the product UI; stored `auth_password` / `communication_key` values are not displayed.
- `Boundary`: this slice did not change K80 parser, full-history protocol, RT protocol decoding/mapping, enrollment, Employees, Attendance, Auth, Reports, backend command/session contracts, CSS/design/styling, or database rows.
- `Open`: company edit/deactivate, full Settings visual design, encrypted secret storage/rotation, DB-backed K80 policy toggles, lease history UI, and richer device profile policy editing remain future work.
- `Current status`: `SETTINGS_V1_READY` for bounded product Settings logic.

## 2026-05-06 Auth V1 Product Session Layer
- `Decision`: Auth v1 uses one human user assigned to exactly one company. Multi-company memberships and client-facing platform-admin behavior are deferred until after first-client needs are proven.
- `Confirmed`: Auth v1 adds server-side human sessions for `/app` while preserving separate bearer-token agent authentication for `/api/agent/*`. Human sessions must not authenticate agent reporting endpoints, and agent tokens must not authenticate browser/product endpoints.
- `Implemented`: Auth v1 schema adds `users` and `user_sessions`. Users carry `company_id`, normalized email, `scrypt_v1` password hash, role (`admin`, `operator`, `viewer`), active flag, and timestamps. Sessions store only a SHA-256 token hash plus expiry/revocation metadata.
- `Implemented`: `/api/auth/login`, `/api/auth/logout`, `/api/auth/me`, and env/secret-gated `/api/auth/bootstrap-admin` exist. Browser sessions use an HttpOnly SameSite cookie and do not expose the session token to frontend JavaScript.
- `Implemented`: `/app` is session-protected and `/login` is public. `/app` calls `/api/auth/me`, uses same-origin credentials, derives active company from the authenticated user, hides Settings for non-admins, and disables Operations actions for viewers.
- `Implemented`: existing API-key middleware remains compatible for intentional non-browser use when API auth is enabled, but can also resolve human sessions for product API calls. Cookie-auth unsafe methods enforce same-origin Origin/Referer checks as the v1 CSRF mitigation.
- `Role policy`: admin can use Settings mutations and Operations actions; operator can use Operations actions such as Connect, Disconnect, and Sync; viewer can read Operations/live-punch views only.
- `Boundary`: this slice did not change K80 parser, full-history protocol, RT protocol decoding/mapping, enrollment, Employees, Attendance, Reports, CSS/design, or agent auth semantics.
- `Open`: production deployment must run with API auth enabled for server-side API protection, and future hardening should add richer CSRF tokens, login throttling/lockout, password reset/invite flows, encrypted device-secret storage/rotation, and hashed API keys.
- `Current status`: `AUTH_V1_READY` for bounded product session authentication.

## 2026-05-06 Auth V1 Runtime Validation
- `Confirmed`: migration `20260506_auth_v1_users_sessions.sql` was applied and `public.users` / `public.user_sessions` exist.
- `Confirmed`: server runtime was restarted with `REQUIRE_AUTH=true`; agent runtime remained separate and running. After validation, the server was restarted again with bootstrap disabled.
- `Confirmed`: guarded bootstrap created one DEFAULT admin user through `/api/auth/bootstrap-admin` while `AUTH_BOOTSTRAP_ADMIN_ENABLED=true` and `AUTH_BOOTSTRAP_SECRET` were set. With bootstrap disabled, the same endpoint returns `403`.
- `Confirmed`: `/api/auth/login` succeeds for the DEFAULT admin, `/api/auth/me` returns `company_id=DEFAULT` and `role=admin`, bad password returns `401`, inactive user login returns `401`, and `/api/auth/logout` revokes the session so subsequent `/api/auth/me` returns `401`.
- `Confirmed`: unauthenticated `/app/` redirects to `/login/`; browser login succeeds; `/app/` loads with authenticated admin context, real K80 under real Default Site, Settings visible to admin, and no API Key/Base URL product controls.
- `Confirmed`: role validation passed: admin can mutate Settings, operator is blocked from Settings mutations but passes Operations sync role gate, viewer can read realtime observations but cannot Connect/Sync or mutate Settings.
- `Confirmed`: API-key compatibility remains for DB-backed API keys, and agent auth remains separate: human session cannot authenticate `/api/agent/heartbeat`, and bearer-only request cannot authenticate `/api/auth/me`.
- `Tests`: `node tests\auth\sessionAuth.primitives.test.js`, `node tests\auth\auth_v1_route_protection.test.js`, `tests\auth\auth_required.ps1`, `tests\auth\role_enforced.ps1`, and `tests\auth\tenant_scope_enforced.ps1` passed with Auth v1 runtime active.
- `Boundary`: no K80 parser, full-history protocol, RT protocol decoder/mapping, enrollment, Employees, Attendance, Reports, CSS/design, or agent auth semantics were changed during runtime validation.
- `Open`: validation created temporary Auth v1 runtime users/API key data. Future cleanup may remove validation-only users/keys if desired. Production hardening still needs CSRF tokens, login throttling, invite/password reset, encrypted device secrets, and hashed API keys.
- `Current status`: `AUTH_V1_READY`.

## 2026-05-06 Employees V1 Product Registry
- `Decision`: `/app` Employees v1 uses the existing `employees` and `identity_mappings` tables through a product-safe `/api/employee-management` wrapper. The mock `/api/employees` route remains legacy/mock and must not be used by the product Employees module.
- `Implemented`: Employees v1 supports company-scoped employee list/get/create/update/deactivate/reactivate with `person_id`, `employee_code`, `full_name`, `active`, and v1 metadata fields (`first_name`, `last_name`, `site_id`, `job_title`, `notes`). `person_id` is generated server-side when creating a new employee without one.
- `Implemented`: Employees v1 supports ZKTeco device-user mapping through `identity_mappings` using `provider=zkteco`, `identifier_type=device_user_id`, and a non-empty `identifier_value`. The product wrapper rejects mapping to inactive/nonexistent employees and rejects duplicate mappings to another employee.
- `Role policy`: viewer and operator can read Employees v1; only admin can create/update/deactivate/reactivate employees or create/update device-user mappings. Operator remains read-only for Employees v1 until explicitly approved later.
- `Frontend`: `/app` Employees module now has an employee list, selected employee profile form, device-user mapping panel, and read-only enrollment/biometric placeholder. Admin sees edit/map controls; operator/viewer are read-only through role enforcement.
- `Boundary`: no K80 parser, full-history protocol, RT protocol decoder/mapping, enrollment, Attendance calculations/results, departments/org_units schema, CSS/design/styling, Operations workflow, Settings workflow, or Auth semantics were changed.
- `Tests`: focused syntax checks passed; `node tests\contracts\employeeManagement.contract.test.js` and `node tests\auth\auth_v1_route_protection.test.js` passed with Auth v1 runtime active. Browser validation created an admin employee and mapped a device user ID through `/app` Employees, then confirmed Operations and Settings still load.
- `Open`: departments/org tree, CSV import/export, employee edit visual design, biometric/enrollment workflows, and linking existing K80 users `3` / `22` to real named employees remain future work.
- `Current status`: `EMPLOYEES_V1_READY`.

## 2026-05-06 Employees Product Filter
- `Decision`: `/app` Employees must show product-managed employees by default, not every historical row in the shared `employees` registry.
- `Confirmed`: DEFAULT had 2901 active employee rows, mostly historical test/dev/generated data. Most polluted rows had empty `{}` metadata, so filtering by legacy `metadata.source` alone is insufficient.
- `Implemented`: Employees created or updated through `/api/employee-management` are marked with `metadata.product_managed=true`, `metadata.source=product_ui`, and `metadata.employee_v1=true`.
- `Implemented`: default `GET /api/employee-management/employees` returns only rows with `metadata.product_managed=true`. Historical/test/generated rows remain in the database and are not deleted or mutated.
- `Implemented`: direct `GET /api/employee-management/employees/:personId` remains company-scoped and can still return legacy rows when explicitly requested.
- `Implemented`: `include_legacy=true` exists for the list endpoint but is admin-only; `/app` default does not use it.
- `Confirmed`: focused contract tests pass for default legacy exclusion, product-managed inclusion, create marker behavior, direct legacy access, and admin-only legacy inclusion. Browser validation showed the `/app` Employees list no longer displays fixture patterns like `1001_*`, `1002_*`, `autoreg_person_*`, `DEDUP_P1_*`, `Event Test User`, `Norm Test`, or `Preview Test`.
- `Boundary`: no DB rows were deleted, no historical rows were mutated, and no K80 parser/full-history/RT/enrollment, Attendance, CSS/design, Operations, Settings, or Auth semantics were changed.
- `Open`: a future internal cleanup/reporting tool can classify or archive historical fixture rows; production employee import needs an explicit product-managed ingestion path.
- `Current status`: `EMPLOYEE_PRODUCT_FILTER_READY`.

## 2026-05-06 Data Hygiene Isolation
- `Decision`: product data hygiene must be non-destructive. Historical rows remain evidence until a full backup exists and rows are classified by an explicit archive/cleanup process.
- `Backup prerequisite`: before any future cleanup or classification mutation, run a full custom-format PostgreSQL backup with `pg_dump -Fc`, then verify it with `pg_restore -l`. The detailed command is documented in `docs/DATA_HYGIENE_RUNBOOK.md`.
- `Implemented`: added read-only report script `scripts/data-hygiene/report.js`. It reports counts and examples for companies, sites, devices, employees, identity mappings, K80 facts/RT observations, agent commands, batches, monitoring sessions, auth tables, API keys, and capability reported-state tables.
- `Implemented`: added shared data hygiene classification helpers for `product_current`, `product_validation`, `test_fixture`, `legacy_test`, `autogenerated_test`, `vendor_import_test`, `protocol_evidence`, `auth_validation`, and `unknown_keep`. Unknown rows must remain `unknown_keep`, never deleted by inference.
- `Implemented`: product-surface filters now exist for backend device/site/identity-mapping reads when requested with `product_surface=true`; `/app` requests product-safe devices and sites for normal Operations/Settings surfaces. Employees default filtering continues to use `metadata.product_managed=true`.
- `Confirmed`: focused tests pass for classification, read-only report execution, and backend product filters. Browser validation showed `/app` Operations still shows real K80 under real Default Site, Settings hides obvious fixture sites/devices/agents, and Employees hides known historical fixture rows.
- `Preserve`: do not clean or mutate K80 `device_events`, `device_realtime_direction_observations`, `agent_commands`, `agent_device_event_batches`, `device_monitoring_sessions`, capability reported-state tables, or K80 device/site/agent binding evidence without a separate archive plan.
- `Boundary`: no rows were deleted, truncated, or mutated. No K80 parser, full-history protocol, RT protocol decoder, enrollment, Attendance, Reports, CSS/design, or runtime/protocol behavior was changed.
- `Open`: future Attendance/Reports must read product-safe views or classification-aware queries; an optional archive/purge script can come later only with dry-run, backup verification, and explicit allowlisted classifications.
- `Current status`: `DATA_HYGIENE_READY`.

## 2026-05-07 RT Backend Ingest Policy Regression
- `Confirmed`: `/app` monitoring could show an active K80 RT subscriber while fresh punches did not appear in Live punches because backend/server RT ingest policy was disabled after a plain `server.js` restart.
- `Runtime proof`: fresh batch `684a75b9-b537-49eb-a631-95748bc237d3` captured K80 user `3`, `rt_state_code=00`, direction `IN`, but inserted `0` rows with `k80_rt_ingest_policy_enabled=false`, `k80_rt_ingest_insert_path_skipped=true`, and `k80_rt_ingest_insert_path_skip_reason=k80_rt_ingest_policy_disabled`.
- `Root cause`: server-side `resolveK80Rt01f4RealtimePolicy(...)` in `services/agentDeviceEventsService.js` defaults `K80_RT_01F4_INGEST_ENABLED` to false and requires `K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST` to contain `zkteco:sn:BIND-QUEUE-c26a7486`. Restarting the backend without these flags disables persistence even when the agent RT subscriber remains armed.
- `Fixed locally`: `.env` and `.env.example` now include the known-good backend RT ingest flags:
  - `K80_RT_01F4_INGEST_ENABLED=true`
  - `K80_RT_01F4_INGEST_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`
  - `K80_RT_01F4_RECONCILE_WINDOW_MS=5000`
- `Validation proof`: after backend restart with the flags, fresh batch `eb6cb3c9-0b8b-4bbc-9af8-2a3590a72367` inserted RT observation `f9806d32-fd58-46bc-8f96-6ec0b0be6776` for device user `3`, `rt_state_code=01`, direction `OUT`; diagnostics showed `k80_rt_ingest_policy_enabled=true`, `k80_rt_ingest_insert_path_entered=true`, `k80_rt_ingest_insert_path_skipped=false`, and `inserted_count=1`.
- `Open`: `/app` Live punches refresh showed `unauthorized` after the DB row existed, so UI/API auth for realtime observation refresh/stream remains a separate secondary issue. Do not confuse this with backend RT ingest failure.
- `Do not repeat`: do not call RT broken when `agent_realtime` batches exist with `inserted_count=0`; inspect batch diagnostics first. If the skip reason is `k80_rt_ingest_policy_disabled`, restore backend RT ingest flags instead of touching parser, RT decoder, employee mapping, or enrollment.
- `Current status`: `RT_INGEST_POLICY_RESTORED` for backend persistence; `/app` realtime refresh auth/display needs a separate follow-up.

## 2026-05-07 App Live Punches Auth/UI Regression
- `Confirmed`: after RT ingest was restored, `/app` Live punches manual refresh still showed `unauthorized` even though DB observation `f9806d32-fd58-46bc-8f96-6ec0b0be6776` existed.
- `Root cause`: the browser human session was expired/invalid. In the same browser context, `/api/auth/me` returned `missing_or_invalid_session`, and the realtime list endpoint returned `missing_credentials`.
- `Confirmed`: realtime observation routes already accept human sessions through `requireApiKey -> resolveSessionFromRequest` and require only viewer role; frontend `fetch(...)` uses `credentials: 'same-origin'`. The issue was not role gating, missing fetch credentials, wrong device UID, or RT backend persistence.
- `Validation proof`: after logging back in as the DEFAULT admin, `/api/auth/me` returned `company_id=DEFAULT`, `role=admin`; `GET /api/agent-admin/devices/zkteco%3Asn%3ABIND-QUEUE-c26a7486/realtime-observations?company_id=DEFAULT&limit=5` returned observation `f9806d32-fd58-46bc-8f96-6ec0b0be6776`.
- `Validation proof`: `/app` Live punches displayed the fresh row as `07/05/2026 09:31:51`, user `3`, direction `OUT`, state `01`, source `dual_time_v1`, with untrusted device time shown only as secondary evidence.
- `Open`: improve `/app` behavior for expired sessions so product API calls redirect/show login instead of surfacing a local panel-level `unauthorized` state. Agent auth separation remains unchanged.
- `Current status`: `APP_LIVE_PUNCHES_AUTH_FIXED` for the current browser session; expired-session UX can be hardened separately.

## 2026-05-07 App Session And Monitoring State Hardening
- `Decision`: `/app` product API session expiry must be handled globally; product panels must not render raw `unauthorized` as if Live punches, monitoring, or K80 runtime failed.
- `Implemented`: `public/app/apiClient.js` now detects product API `401` session/auth envelopes such as `missing_or_invalid_session` and `missing_credentials`, dispatches a global `app:session-expired` event, and `/app` redirects to `/login/?reason=session_expired`.
- `Implemented`: `/app` realtime, monitoring, operations, and sync error paths no longer intentionally render literal `unauthorized`; session expiry is treated as a global app/session state.
- `Implemented`: monitoring state policy now evaluates `expires_at`, `active_lease`, terminal statuses, and runtime state before displaying the selected-device monitoring label. Stale `status=active` rows with past `expires_at` display as `expired monitoring session`, not connected/live.
- `Implemented`: backend adds `GET /api/agent-admin/devices/{deviceUid}/monitoring-sessions/current`, backed by the existing stale-session expiration service, so `/app` hydrates selected-device monitoring from device-scoped lease truth instead of relying only on the latest command result.
- `Implemented`: `/app` selected-device technical details summarize latest realtime batch persistence blockers when an `agent_realtime` batch received events but inserted zero rows with an RT ingest skip reason, e.g. `Live capture received, persistence disabled`.
- `Runtime proof`: after server restart with known-good auth and K80 RT ingest flags, `/app` loaded with admin session, real K80 under real `Default Site`, latest RT row `f9806d32-fd58-46bc-8f96-6ec0b0be6776`, and current monitoring session `1b16d3c6-9667-449a-aa0f-c8c099e9e11c` returned `status=expired`, `active_lease=false`, `expires_at=2026-05-06T15:47:22.195Z`; `/app` displayed `expired monitoring session`.
- `Confirmed`: human session still cannot authenticate agent runtime endpoints; `/api/agent/heartbeat` with only a human session returns `401` with `missing_bearer_token`.
- `Boundary`: no K80 parser, RT protocol decoder, full-history protocol, enrollment, Attendance, CSS/design, monitoring governance, RT ingest policy, or agent auth semantics were changed.
- `Open`: automated browser assertions for global 401 redirect are still limited; focused contract test execution with API-key auth requires `TEST_API_KEY_ADMIN` or `API_KEY` in the local test environment.
- `Current status`: `APP_STATE_HARDENING_READY`.

## 2026-05-07 K80 Real Employee Mappings
- `Decision`: real K80 device users are now represented as product-managed Employees v1 records in DEFAULT, with ZKTeco device-user identity mappings. This is employee registry/mapping work only, not enrollment or attendance calculation.
- `Confirmed`: created product-managed employees:
  - `EMP-K80-001` / `Amir` / `person_id=emp_emp-k80-001_4ed5fd38`
  - `EMP-K80-002` / `Sami` / `person_id=emp_emp-k80-002_f13b2218`
  - `EMP-K80-003` / `Houssem` / `person_id=emp_emp-k80-003_a94e1779`
  - `EMP-K80-022-TEST` / `Test User` / `person_id=emp_emp-k80-022-test_a34aaad1`
- `Confirmed`: each employee has `metadata.product_managed=true`, `metadata.source=product_ui`, and `metadata.employee_v1=true`; `EMP-K80-022-TEST` also has `metadata.validation_user=true` and `metadata.not_for_client_reports=true`.
- `Confirmed`: active identity mappings exist in DEFAULT:
  - `zkteco/device_user_id/1 -> emp_emp-k80-001_4ed5fd38`
  - `zkteco/device_user_id/2 -> emp_emp-k80-002_f13b2218`
  - `zkteco/device_user_id/3 -> emp_emp-k80-003_a94e1779`
  - `zkteco/device_user_id/22 -> emp_emp-k80-022-test_a34aaad1`
- `Fixed`: Employees v1 list summaries now load product-surface identity mappings, avoiding the legacy 1000-row mapping page problem that hid K80 mappings in `/app` despite correct DB rows.
- `Validation proof`: `/app` Employees shows `Amir`, `Sami`, `Houssem`, and `Test User` with `zkteco:1`, `zkteco:2`, `zkteco:3`, and `zkteco:22`; obvious historical fixture rows remain hidden from the normal product list. Operations and Settings still show the real K80.
- `Boundary`: no K80 parser, full-history protocol, RT protocol decoder, enrollment, Attendance, sync/full-history run, event/RT/batch history mutation, deletion, or historical fixture mutation was performed.
- `Current status`: `K80_REAL_EMPLOYEE_MAPPINGS_READY`.

## 2026-05-07 Attendance V1 Review
- `Decision`: Attendance V1 is ready for a bounded product patch, but the existing `/api/attendance` route is not product-safe as the primary `/app` attendance surface because it still uses mock employee fallback, computes one person/day, writes `attendance_days` during reads, and queries `device_events.person_id` directly.
- `Confirmed`: K80 full-history facts for `zkteco:sn:BIND-QUEUE-c26a7486` are stored in `device_events` under raw device user identifiers (`person_id` / `device_person_id` values such as `1`, `2`, `3`, `22`), while product employees use generated `emp_*` person IDs and are linked via `identity_mappings`.
- `Confirmed`: DEFAULT company timezone and real Default Site timezone are both `Africa/Tunis`; Attendance V1 must use selected site timezone for local day windows and display, not browser timezone or hardcoded `Asia/Riyadh` / UTC calendar grouping.
- `Required for patch`: add a product-safe Attendance V1 backend surface that reads trusted full-history `device_events`, filters to product-current devices/sites and product-managed employees, resolves ZKTeco `device_user_id` mappings, excludes `metadata.validation_user=true` / `metadata.not_for_client_reports=true` by default, and reports unmapped device users separately.
- `Scope`: initial `/app` Attendance module should show date/site/employee filters, daily first punch, last punch, event count, status/explanation, unmapped-user warnings, and optional validation-user inclusion only as an admin/secondary control. Reports/export/payroll/schedule editor remain out of scope.
- `Boundary`: no K80 parser, full-history protocol, RT protocol decoder, enrollment, reports/export, CSS/design, DB mutation, sync run, or live RT action was performed during this review.
- `Current status`: `READY_FOR_ATTENDANCE_V1_PATCH`.

## 2026-05-07 Attendance V1 Product Surface
- `Implemented`: added read-only product Attendance V1 route `GET /api/attendance-v1/daily` and `/app` Attendance module wiring. The route is company-scoped, viewer-readable under Auth v1, and does not write/update `attendance_days` during reads.
- `Data contract`: Attendance V1 reads trusted full-history `device_events` only, filters to product-current sites/devices, filters employees to `metadata.product_managed=true`, and resolves product employees through active `identity_mappings` (`provider=zkteco`, `identifier_type=device_user_id`, matched against `device_events.device_person_id` / `person_id`).
- `Validation handling`: employees marked `metadata.validation_user=true` or `metadata.not_for_client_reports=true` are excluded by default. Admin-only `include_validation=true` can include validation users; viewer attempts are rejected with `403`.
- `Confirmed`: browser/API validation showed `/app` Attendance loads after login, Amir and Houssem appear for selected K80 date ranges, Test User is excluded by default, unmapped K80 device user `4` appears in the unmapped warning section, Operations still shows real K80, Settings still shows real Default Site/K80, and Employees still shows K80 employee mappings.
- `Tests`: syntax checks passed for new backend/frontend modules; `node tests\attendance_v1\productDaily.service.test.js`, `node tests\contracts\attendanceV1.product.contract.test.js`, `node tests\contracts\employeeManagement.contract.test.js`, and `node tests\auth\auth_v1_route_protection.test.js` passed with local Auth v1 runtime active.
- `Boundary`: no K80 parser, full-history protocol, RT protocol decoder, enrollment, `device_events` mutation, historical-row mutation, reports/export, CSS/design, sync run, or live RT action was performed.
- `Open`: late/absent calculations remain deliberately conservative; Attendance V1 currently reports punch-evidence statuses and `late_minutes=null` until product rule/schedule evidence is configured per employee/site. Existing legacy `/api/attendance` remains separate and test/cache-oriented.
- `Current status`: `ATTENDANCE_V1_READY`.

## 2026-05-08 Attendance V1 Closeout / Runtime Auth Config
- `Confirmed`: local runtime was initially stopped; after restart with safe config, unauthenticated `/api/auth/me` returns `401`, unauthenticated `/app/` redirects to `/login/`, and `/login/` renders the email/password form.
- `Fixed`: local `.env` and `.env.example` now set `REQUIRE_AUTH=true` so a plain backend restart does not silently expose `/app` or product APIs. K80 RT ingest flags remain unchanged.
- `Confirmed`: `GET /api/attendance-v1/daily` is auth-protected, viewer/operator/admin readable, company-scoped by auth/API-key context, and remains separate from legacy `/api/attendance`; `/app` Attendance calls `/api/attendance-v1/daily`.
- `Confirmed`: Attendance V1 default results for the validated K80 date range include mapped product employees such as `Amir` and `Houssem`, exclude `EMP-K80-022-TEST` / `Test User` by default, expose unmapped device users in warnings, and contain no obvious historical fixture employee patterns.
- `Confirmed`: `include_validation=true` is admin-only; viewer attempts return `403`, while admin inclusion returns validation-user rows.
- `Confirmed`: K80 identity mappings remain active and company-scoped in DEFAULT for device users `1 -> Amir`, `2 -> Sami`, `3 -> Houssem`, and `22 -> Test User`.
- `Tests`: `node tests\attendance_v1\productDaily.service.test.js`, `node tests\contracts\attendanceV1.product.contract.test.js`, `node tests\auth\auth_v1_route_protection.test.js`, `node tests\contracts\employeeManagement.contract.test.js`, `node tests\services\dataHygieneClassification.test.js`, `node tests\services\dataHygieneProductFilters.test.js`, and `node tests\services\dataHygieneReportScript.test.js` passed.
- `Boundary`: no K80 parser, full-history protocol, RT protocol decoder, enrollment, Reports/export, Rules/Schedules, CSS/design, live RT, sync, event mutation, or historical-row mutation was performed.
- `Open`: logged-in browser walkthrough was not repeated because no admin password is stored in repo evidence and auth bypass/reset was intentionally avoided. Browser-level unauthenticated redirect was confirmed; API/runtime evidence covers the product Attendance contract.
- `Current status`: `ATTENDANCE_V1_CLOSEOUT_GREEN`; next recommended phase is Rules/Schedules v1 review.

## 2026-05-08 Product Surface Smoke Cleanup
- `Decision`: normal `/app` product surfaces should hide validation/test-created product rows and translate known operational/internal codes into product-safe labels before moving to Rules/Schedules review.
- `Fixed`: default `GET /api/employee-management/employees` now excludes product-managed rows marked `metadata.validation_user=true`, `metadata.test_record=true`, or `metadata.not_for_client_reports=true`, and also excludes known Employees v1 validation patterns such as `empv1-*`, `empv1-other-*`, and `filter-ui-*`. No DB rows were deleted or mutated.
- `Confirmed`: admin-only `include_validation=true` preserves diagnostic access to validation/test product employees. Viewer attempts return `403`.
- `Confirmed`: the DEFAULT product Employees list now returns only real K80 employees `Amir`, `Sami`, and `Houssem` by default. `Test User` and validation-created rows remain available through admin include paths and direct scoped access.
- `Fixed`: `/app` product error labels now translate known raw codes such as `runtime_reported_state_stale`, `runtime_capability_unknown`, `device_path_capability_unknown`, `missing_or_invalid_session`, and `missing_credentials` into product-safe messages while keeping raw details available in technical details where applicable.
- `Confirmed`: the active K80 Operations stale-connect symptom is caused by no running `agent/index.js`; the persisted active agent heartbeat/site runtime report is stale, so this remains governance-correct `AGENT_HEARTBEAT_STALE`, not a parser/RT/full-history issue.
- `Fixed`: `/app` Attendance status wording now maps raw `invalid` / `incomplete` into `Needs review`, `complete_day` into `Complete day`, and common explanations such as `non-alternating IN/OUT sequence` and `late calculation not configured` into product-safe wording while preserving raw details as secondary text.
- `Tests`: frontend module syntax checks passed in module mode; `node tests\product_surface\productSurfaceSmokeLabels.test.js`, `node tests\contracts\employeeManagement.contract.test.js`, `node tests\contracts\attendanceV1.product.contract.test.js`, and `node tests\attendance_v1\productDaily.service.test.js` passed.
- `Boundary`: no K80 parser, RT decoder, full-history protocol, enrollment, Rules/Schedules, Reports, CSS/design, DB deletion, historical evidence mutation, agent auto-start, execution-gate bypass, auth weakening, live RT, or sync action was performed.
- `Current status`: `PRODUCT_SURFACE_SMOKE_CLEANUP_READY`; next recommended phase remains Rules/Schedules v1 review.

## 2026-05-08 Minimal Agent Operator Baseline
- `Decision`: before moving to Rules/Schedules, keep the agent operational model simple and document/check the local baseline. Do not build a Windows service, installer, or agent architecture/security refactor yet.
- `Implemented`: added `docs/AGENT_OPERATOR_RUNBOOK.md` with the local/internal-demo procedure to start the server, start the agent, verify diagnostics, verify heartbeat freshness, verify K80 reachability, and recover from stale agent status.
- `Implemented`: added read-only PowerShell baseline checker `scripts/ops/check-agent-baseline.ps1`, exposed as `npm run ops:check-agent`. It reports `SERVER_OK/SERVER_DOWN`, `AUTH_PROBE_OK`, `AGENT_PROCESS_OK/AGENT_NOT_RUNNING`, `AGENT_DIAGNOSTICS_OK/AGENT_DIAGNOSTICS_DOWN`, `HEARTBEAT_FRESH/HEARTBEAT_STALE/HEARTBEAT_UNKNOWN`, and `K80_REACHABLE/K80_UNREACHABLE`.
- `Implemented`: added foreground local start helper `scripts/ops/start-agent-local.ps1`, exposed as `npm run agent:start:local`. It sets `SAAS_BASE_URL=http://127.0.0.1:3000` only when missing and then runs the existing `npm run agent:start`; it does not install a service or hide errors.
- `Do not repeat`: stale agent heartbeat is an operations/runtime condition, not a K80 parser, RT decoder, full-history protocol, or enrollment failure. RT captured but not inserted should first be checked against backend RT ingest policy diagnostics. Session expiry is an auth/login condition.
- `Future`: a managed Windows service, installer/update flow, local hardening/obfuscation, and thin-agent security refactor remain future productization work. The agent should stay a local LAN executor while SaaS/server keeps policy, permissions, command governance, and product value.
- `Boundary`: no K80 parser, RT decoder, full-history protocol, enrollment, Rules/Schedules, CSS/design, auth weakening, agent auto-start from browser/server, command queueing, live RT, sync, or DB mutation was performed.
- `Current status`: `MINIMAL_AGENT_RUNBOOK_READY`; next recommended phase can proceed to Rules/Schedules v1 review after operators use the runbook/checker for demos.

## 2026-05-08 Agent Local K80 Start Config
- `Confirmed`: starting the agent as a generic bridge can be insufficient for K80 live monitoring. Runtime logs showed the agent process, diagnostics, heartbeat, and command polling were healthy, but startup policy logged `k80_rt_subscriber_enabled=false` and `k80_rt_subscriber_device_uid=null`; `START_DEVICE_MONITORING` then failed. This is agent-side local K80 RT subscriber config, not K80 parser, RT decoder, backend RT ingest policy, full-history protocol, or enrollment.
- `Confirmed`: agent startup reads `K80_RT_SUBSCRIBER_ENABLED` and comma-separated `K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST`; `agent/index.js` uses the first allowlisted UID as startup `k80_rt_subscriber_device_uid` and blocks `START_DEVICE_MONITORING` when the subscriber is disabled or selected device UID is not allowlisted.
- `Implemented`: `scripts/ops/start-agent-local.ps1` now starts local/internal K80 mode by setting missing `SAAS_BASE_URL=http://127.0.0.1:3000`, `K80_RT_SUBSCRIBER_ENABLED=true`, and `K80_RT_SUBSCRIBER_DEVICE_UID_ALLOWLIST=zkteco:sn:BIND-QUEUE-c26a7486`, then running the existing `npm run agent:start` in the foreground. It prints non-secret effective config and remains non-service/non-daemon.
- `Implemented`: `scripts/ops/check-agent-baseline.ps1` now probes the actual diagnostics health path `/api/local-diagnostics/health` and reports `AGENT_RT_POLICY_ENABLED`, `AGENT_RT_POLICY_DISABLED`, or `AGENT_RT_POLICY_UNKNOWN` from available local diagnostics/command evidence without mutating runtime state.
- `Runbook`: `docs/AGENT_OPERATOR_RUNBOOK.md` now documents that agent process running is not enough for K80 live monitoring; operators must check startup logs for `k80_rt_subscriber_enabled=true` and `k80_rt_subscriber_device_uid=zkteco:sn:BIND-QUEUE-c26a7486`, then restart with `npm run agent:start:local` if needed.
- `Future`: production should move K80 live-monitoring policy to DB-backed device/profile/service configuration. The local helper is only a known-good internal/demo startup path.
- `Boundary`: no K80 parser, RT decoder, full-history protocol, enrollment, backend RT ingest logic, monitoring governance, Windows service/installer, agent architecture refactor, CSS/design, sync, live finger press, or DB mutation was performed.
- `Validation`: running `npm run agent:start:local` produced startup log fields `k80_rt_subscriber_enabled=true` and `k80_rt_subscriber_device_uid=zkteco:sn:BIND-QUEUE-c26a7486`; diagnostics server started on `127.0.0.1:4780`, heartbeat succeeded, and K80 TCP reachability remained healthy. `/app` Connect retry was not completed in this patch because an authenticated browser session was not available in repo/runtime evidence.
- `Current status`: `PARTIAL_AGENT_LOCAL_K80_START_FIX` until `/app` Connect is retried from an authenticated session and confirms `START_DEVICE_MONITORING` active/ok.

## 2026-05-08 Live Data Reliability
- `Decision`: `/app` Operations live-proof state must be scoped to the current monitoring session. Previously, old saved RT rows could make the UI say `live punches received` even when no row had been saved after the current session started.
- `Confirmed`: latest/current monitoring session `e0cb0868-1a80-41f7-ad3f-85eec79ce239` started at `2026-05-08T10:58:20.594Z`, while latest K80 RT observation `085f2a7f-b65b-4277-8bfb-0efdee3c4fdc` was created at `2026-05-07T11:24:56.400Z`; old rows were driving false live success.
- `Implemented`: `/app` now computes live proof from saved RT observation `created_at` relative to `selectedDeviceMonitoringSession.started_at`. Old RT rows remain visible as history but no longer set `selectedDeviceLiveProof`.
- `Implemented`: product live labels now distinguish `Waiting for new live punch`, `Old live punches only`, and `Live punch saved in current session`; SSE connection text now describes stream connectivity, not punch proof.
- `Implemented`: frontend SSE handling now listens for the backend's named `rt_observation` event as well as default messages, so saved RT observations can update the table without manual refresh.
- `Implemented`: agent realtime batch diagnostics are exposed as a safe `rt_diagnostics_summary` on batch listings, without raw payload dumps. `/app` can surface `Live capture received, not saved` or `Live capture received, persistence disabled` when realtime batches capture events but insert zero rows.
- `Boundary`: no K80 parser, RT protocol decoder, full-history protocol, enrollment, RT ingest policy, device events, RT observations, monitoring sessions, Rules/Schedules, or CSS/design behavior was changed.
- `Tests`: focused JS syntax and service/product-surface tests passed for session-scoped live proof, created-at proof semantics, persistence-disabled diagnostics, and safe RT batch diagnostic shape. Browser validation from an authenticated session remains pending.
- `Current status`: `PARTIAL_LIVE_DATA_RELIABILITY` until authenticated `/app` browser validation confirms the current screen shows no false live success for old rows and flips to current-session proof after a new persisted row.
