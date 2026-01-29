# Architectural Decisions — Attendance System

This document records the critical, non-obvious architectural decisions
made during the implementation of the ZKTeco CSV ingestion pipeline.

These decisions are binding unless explicitly revised.

---

## Decision 001 — Preview-Only CSV Ingestion

**Decision**  
All CSV imports are split into two phases:
- Preview (validation only, no DB writes)
- Commit (explicit persistence)

**Rationale**
- Prevents accidental data corruption
- Enables safe validation of vendor exports
- Allows clients to correct data before persistence

**Status**
LOCKED

---

## Decision 011 ? Company Registry (Company Anchor)

**Decision**
- Introduce a `companies` table keyed by `company_id` (TEXT) to serve as the stable tenant/company anchor.
- `company_id` remains the existing identifier used across config/policy; this decision does not change existing API contracts.
- This is a minimal registry (display_name, timezone, status). It is not the full employer/org hierarchy.

**Rationale**
- Prevents semantic drift around company_id.
- Enables multi-company scale safely.
- Central place for company metadata (timezone/display name) without touching the engine.

**Evidence (Repo)**
- migrations/20260114_companies_registry.sql

**Status**
Implemented

---

## Decision 012 ? Tenant scoping of core facts (company_id required)

**Decision**
- company_id is required at the storage boundary for device_events, attendance_days, and employee_leaves.
- Default remains DEFAULT for backward compatibility when company_id is omitted.
- Deduplication and cache keys are tenant-scoped.
- Attendance uniqueness is tenant-scoped (company_id, person_id, work_date).

**Rationale**
- Prevents cross-tenant collisions in dedup/cache.
- Enables safe multi-company operation without rewriting core identifiers.

**Evidence (Repo)**
- migrations/20260116_tenant_scope_core_tables.sql
- tests/attendance/policy_always_computes.ps1
- tests/attendance/manual_resolution_overlay.ps1

**Status**
Implemented (Phase A)

---


## Decision 013 ? Company profile metadata is stored in company_profile (1:1)

**Decision**
- Keep companies as the tenant anchor (company_id).
- Store optional legal/contact/company metadata in company_profile (1:1) with metadata jsonb.
- This must not affect attendance engine, computed facts, or simulation.

**Rationale**
- Avoid bloating companies with volatile fields while enabling enterprise metadata.
- Preserve fact-vs-policy and keep engine stable.

**Evidence (Repo)**
- migrations/20260117_company_profile.sql
- api/companyProfile.routes.js
- services/companyProfileDb.js
- tests/company/company_profile.ps1

**Status**
Implemented

SQL Run Instructions (Do Not Run in Codex)
- psql -h $env:PGHOST -U $env:PGUSER -d $env:PGDATABASE -f .\migrations\20260117_company_profile.sql

---

## Decision 018 ? Employees Registry Phase 1 (tenant-scoped)

**Decision**
- Add an employees registry scoped by company_id (tenant).
- This is additive only and does not change attendance facts, policy evaluation, or simulation behavior.
- Future: effective-dated employee_assignments can be layered later.

**Rationale**
- Introduces a canonical employee registry without touching the attendance engine or existing contracts.
- Supports tenant-aware HR data lookups for reporting and future admin workflows.

**Evidence (Repo)**
- migrations/20260118_employees_registry.sql
- api/employeesRegistry.routes.js
- services/employeesDb.js
- tests/hr/employees_registry.ps1

**Status**
Implemented (Phase 1)

---

## Decision 019 ? Identity Mappings Registry Phase 1 (tenant-scoped)

**Decision**
- Add identity_mappings to map external/vendor identifiers to canonical person_id per company_id.
- Enforce FK to employees to avoid orphan mappings.
- No silent reassignment; conflicts return 409. Explicit reassign/audit can come later.

**Rationale**
- Supports vendor-specific identifiers without touching ingestion or attendance semantics.
- Keeps identity management auditable and tenant-scoped.

**Evidence (Repo)**
- migrations/20260123_identity_mappings.sql
- api/identityMappings.routes.js
- services/identityMappingsDb.js
- tests/hr/identity_mappings.ps1

**Status**
Implemented (Phase 1)

---

## Decision 020 ? Identity Mappings Phase 2 (ingestion resolution)

**Decision**
- Device event ingestion may resolve external identifiers to canonical person_id using identity_mappings when enabled.
- Controlled by flags: USE_IDENTITY_MAPPINGS (off by default) and REQUIRE_IDENTITY_MAPPINGS (strict mode).
- Preview remains no-write and surfaces identity resolution status; commit persists resolved person_id and identity metadata.

**Rationale**
- Enables vendor interoperability without changing attendance semantics or engine behavior.
- Keeps provenance by preserving raw identity evidence in metadata.

**Evidence (Repo)**
- services/identityResolver.js
- api/deviceEvents.routes.js
- tests/hr/identity_mappings_ingestion_mode.ps1

**Status**
Implemented (Phase 2)

---

## DECISION 017 — Effective-Dated Rule Set Assignments (Feature-Flagged)

**Date:** 2026-01-25  
**Context:**  
Employees may change policies mid-month (e.g., switch from fixed to flexible schedule). Using a single rule_set_id in `employees` is insufficient.

**Decision:**  
Introduce employee_assignments(company_id, person_id, rule_set_id, valid_from, valid_to) and resolve for work_date.

**Safety:**  
- Gated behind USE_EMPLOYEE_ASSIGNMENTS; default semantics unchanged.
- Legacy fallback preserved when no assignment matches.

**Verification:**  
- New PowerShell test for effective assignment resolution.
- Ops test mode reports USE_EMPLOYEE_ASSIGNMENTS.

---

## Decision 014 ? DB Schema Must Be Migration-Managed

**Decision**
Any database table/column used by runtime code must be created/maintained via idempotent migrations in /migrations.
No manual DB setup is allowed as a dependency for correctness.

**Rationale**
Prevents schema drift, ensures reproducible installs, supports long-term stability.

**Evidence (Repo)**
- migrations/20260115_policy_layer_schema.sql

**Status**
LOCKED (Implemented)

---

## Decision 015 ? Tenant context propagation into API (Phase A)

**Decision**
- company_id may be provided via query param and/or header x-company-id where applicable.
- Default remains DEFAULT for backward compatibility.
- Tenant scoping is applied to core data access for these endpoint families:
  - /api/attendance
  - /api/device-events (ingest + CSV commit)
  - /api/simulate/day and /api/simulate/range
  - /api/ops/test/*

**Rationale**
- Ensures storage and retrieval honor tenant boundaries.
- Enables gradual rollout without breaking existing integrations.

**Evidence (Repo)**
- api/attendance.routes.js
- api/deviceEvents.routes.js
- api/simulate.routes.js
- api/opsTest.routes.js

**Status**
Implemented (Phase A)

---

## Decision 016 ? Simulation overrides for ?what-if? analysis (rule-set + policy)

**Decision**
- Simulation must never persist to attendance_days or attendance_day_resolutions.
- Range simulation exists for what-if analysis and always computes facts before applying policy.
- late_minutes penalty respects grace/threshold (e.g., arrival 08:10 with grace 15 => late_minutes 0).
- LATE flag/status uses raw lateness versus threshold, not late_minutes alone.

**Rationale**
- Enables safe experiments without mutating history.
- Keeps Decision 008 semantics intact (flags/metrics drive policy, not status mutations).

**Evidence (Repo)**
- tests/rulesets/simulation_range_no_persist.ps1
- tests/rulesets/simulation_late_threshold_whatif.ps1
- engine/rules/metrics.js
- engine/rules/decision.js

**Status**
Implemented

---

## Decision 017 ? Manual resolution overlay (immutability + audit)

**Decision**
- Computed facts are immutable; manual resolutions override effective outcome only.
- One active resolution per attendance_day_id is enforced.

**Rationale**
- Preserves auditability while allowing HR corrections.
- Ensures deterministic resolution history with a single active record.

**Evidence (Repo)**
- tests/attendance/manual_resolution_overlay.ps1
- migrations/20260115_policy_layer_schema.sql (ux_attendance_day_resolutions_one_active)
- api/attendance.routes.js

**Status**
Implemented

---

## Decision 002 — No Automatic Data Correction

**Decision**  
Invalid or ambiguous attendance rows are rejected.
The system never auto-corrects vendor data.

**Rationale**
- Attendance data affects payroll and compliance
- Silent fixes destroy auditability
- Responsibility for data quality remains explicit

**Status**  
LOCKED

---

## Decision 003 — Explicit CHECKTYPE Mapping

**Decision**  
CHECKTYPE semantics are never assumed.
All mappings must be explicitly configured.

**Rationale**
- Vendor semantics differ across firmware and regions
- Prevents misclassification of IN/OUT events
- Makes behavior predictable and auditable

**Status**  
LOCKED

---

## Decision 004 — Mandatory Device Identity

**Decision**  
Every canonical attendance event must include a deterministic, non-empty device_uid.
For ZKTeco CSV imports: device_uid is derived from serial number (sn), with MachineNumber as fallback.

Rows without device identity are rejected.

### Rationale (Why refusal is better than accepting missing device identity)
- Auditability: without device identity we cannot trace source terminal, location, troubleshooting, or legal evidence chain.
- Deterministic dedup: our unique key uses (person_id, event_time_utc, direction, device_uid); empty/unknown device_uid causes collisions and silent data loss or silent duplication.
- Multi-device/multi-site reality: policies and device metadata may vary by device; unknown device breaks correctness.

### Implementation Status (As Implemented)
- API enforcement: POST /api/device-events rejects empty device_uid with HTTP 400 { error: "DEVICE_ID_REQUIRED" }.
- CSV commit enforcement: rows missing device_uid are rejected (test asserts this).
- Test-only behavior: /api/ops/test/reset defaults device_uid to TEST-DEVICE-1 when absent/empty (test harness only).
- DB hardening: migrations/20260114_device_uid_hardening.sql drops DEFAULT '' and adds CHECK (btrim(device_uid) <> '').
- Constraint is validated in dev/test after cleanup; suite .\tests\run-all.ps1 passes.
- Regression test: tests/device_events/device_identity_required.ps1
- DB constraint validated in dev/test: device_events_device_uid_nonempty (convalidated=true).

**Status**  
LOCKED (Implemented)

---

## Decision 004A — Handling Missing Device UID Without Breaking HR Flexibility

**Decision**  
- Rule (LOCKED): Raw device evidence ingestion MUST refuse missing/empty device_uid. No silent correction.
- HR flexibility must NOT be achieved by weakening device evidence; it must be achieved in the policy/resolution layer.
See Decisions 006/007/010 for computed vs effective layering.

### Explicit Batch Override (Planned)
- CSV commit MAY support an explicit operator-supplied device_uid_override (e.g., query param or header) to attach a deterministic identity when the vendor file lacks it.
- Must be explicit and audited: response + stored audit must record device_uid_source="override" and preserve raw_payload.
- Must never default silently; preview must surface this as a blocking issue unless override provided.

**Status**  
PLANNED (Not Implemented)

### Manual / HR Adjustments (Locked Concept)
- HR corrections and exceptions belong to policy profiles and manual resolutions (effective layer) and must not mutate the computed facts.
- Device evidence remains immutable; effective outcome can reflect approved HR decisions.

**Status**  
LOCKED (Concept; implemented elsewhere)

**Validation Note**  
After doc update: run .\tests\run-all.ps1 (should remain PASS).

---

## Decision 005 — Full Raw Payload Preservation

**Decision**  
Original vendor data is preserved verbatim in raw_payload.

**Rationale**
- Enables post-hoc audits
- Enables reprocessing under new rules
- Protects against vendor disputes

**Status**  
LOCKED

---

## Change Control

Any modification to these decisions requires:
- Explicit documentation update
- Versioned migration notes
- Business approval where applicable
Attendance Engine Vendor Boundary
## Decision: Attendance Engine I/O Contracts (Locked)

### Context
Phase 4 introduces deterministic, vendor-agnostic attendance rules.
Rules must operate only on a pre-resolved attendance day input and must not see vendor-specific metadata.

### Decision
We lock the engine contracts as follows:

**AttendanceDayInput**
- Contains person_id, day (YYYY-MM-DD), window_start_utc, window_end_utc
- Contains an ordered list of sanitized events within the window
- Each event includes: person_id, event_time_utc (ISO), direction (IN|OUT), device_uid (non-empty string)
- Vendor metadata and raw payload are not allowed at the rules boundary

**AttendanceDayResult**
- Includes derived facts: first_in_utc, last_out_utc, total_events
- Includes metrics: minutes_late, minutes_early_leave, work_minutes (nullable)
- Includes decision: status (PRESENT|ABSENT|INCOMPLETE|INVALID)
- Includes machine-readable flags
- Includes bounded audit trace: rule_set_id, computed_at_utc, notes[]

### Rationale
Locking contracts ensures determinism, auditability, testability, and strict vendor isolation.
It enables later simulation (what-if) without changing ingestion or event normalization.

---

## Decision 006 — Separation of Computed Facts and HR Policy Decisions

**Context**  
As the attendance system evolves to support companies of different sizes,
it must balance strict data correctness with operational flexibility.

Attendance computation produces factual results derived from device events
(e.g. ABSENT, INCOMPLETE, INVALID) along with machine-readable flags and audit notes.
However, companies may require human or policy-based resolution of certain anomalies
without altering the underlying facts.

**Decision**  
The system SHALL strictly separate:

1. **Computed Attendance Facts**  
   - Produced exclusively by the Attendance Engine  
   - Deterministic, vendor-agnostic, and non-configurable  
   - Derived solely from normalized device events and locked rules  
   - Includes status, flags, metrics, and audit trace  
   - Must never be modified by HR or company configuration  

2. **Policy / Resolution Decisions**  
   - Applied AFTER computation  
   - Configurable per company or policy profile  
   - May reinterpret or override the effective outcome  
   - Must never alter the computed facts  
   - Must be fully auditable and attributable to a human or policy  

The Attendance Engine is a fact engine, not a decision engine.
All flexibility and human judgment MUST live outside the engine.

**Rationale**  
- Preserves auditability and legal defensibility  
- Prevents silent data corruption  
- Allows operational flexibility without weakening core logic  
- Enables long-term evolution without rewriting historical computations  

**Status**  
LOCKED


## Decision 007 - Policy Engine Architecture (Computed Facts vs Effective Outcome)

**Context**
Phase 4 introduced a deterministic, vendor-agnostic Attendance Engine that produces computed attendance facts
(status/flags/metrics/audit) from normalized device events.
In real operations, companies must apply HR policy and human resolution workflows (excused absence, approved remote work,
manual corrections) without modifying the computed facts.
Enterprise-grade systems (e.g., UKG/Kronos, ADP, SAP, Workday patterns) consistently separate:
- immutable computed facts (system truth)
- mutable policy/resolution outcomes (HR decision layer) with auditability and approvals

We must support small companies (simple workflow) and large factories (high volume, delegation, bulk actions)
while preserving determinism, auditability, and long-term maintainability (10+ years).

**Decision**
We introduce a separate **Policy Engine** layer that evaluates computed facts and produces an **Effective Outcome**
used for payroll and operational reporting, without altering the computed facts.

1) **Computed Facts (Immutable)**
- Source: Attendance Engine output saved in `attendance_days` (or equivalent).
- Includes:
  - computed_status (PRESENT|ABSENT|INCOMPLETE|INVALID)
  - computed_flags[] (machine-readable)
  - computed_metrics (late/early/work minutes, nullable)
  - computed_audit (rule_set_id, computed_at_utc, notes/context)
- MUST NOT be modified by HR actions or policy configuration.

2) **Effective Outcome (Mutable, Audited)**
- Produced by Policy Engine and/or HR manual resolution.
- Represents how the organization chooses to treat the day for payroll/compliance.
- Stored separately as **policy/resolution records**, not as edits to computed facts.
- Effective outcome MAY differ from computed status (e.g., INVALID -> NEEDS_REVIEW -> EXCUSED).

3) **Policy Profiles (Company-configurable)**
- Each company selects a policy profile version (e.g., `factory-standard-v1`).
- A policy profile defines:
  - mappings from computed_status to effective_status
  - overrides triggered by specific flags (e.g., NO_EVENTS, MISSING_OUT, FIRST_EVENT_OUT)
  - whether a computed condition requires review/approval
  - guardrails and permissions (who can override what)
- Policy profiles are versioned. Changing a policy profile MUST NOT rewrite history silently.

4) **Manual Resolutions (HR/Supervisor Actions)**
- Manual resolution is a first-class entity:
  - who (actor_id / role)
  - when (timestamp)
  - what changed (effective_status and/or effective_metrics)
  - why (reason_code + free-text note)
  - optional attachments/references (leave request, mission order, etc.)
- Manual resolutions do not mutate computed facts. They produce or replace the effective outcome for that day.
- Manual resolutions may be subject to approval workflow depending on policy profile.
- TODO (Concurrency hardening, not required now): inside createManualResolution(), lock the current active resolution row (if any) for the same attendance_day_id using `SELECT ... FOR UPDATE` within the transaction before deactivating/inserting, to prevent rare race conditions under high load (10+ year robustness). If a UNIQUE violation occurs on the one-active constraint, retry once.

5) **Workflow States**
The Policy Engine SHALL support operational states that enable queue-based review:
- `AUTO_APPLIED`: policy applied automatically, no human review required
- `NEEDS_REVIEW`: human action required before payroll finalization
- `APPROVED`: resolved and approved (if approvals enabled)
- `REJECTED`: resolution rejected (requires follow-up)

6) **Effective Status Model**
We distinguish between computed statuses and effective statuses.
Computed statuses remain the engine’s 4-valued set.
Effective statuses SHALL include at minimum:
- `PRESENT`
- `ABSENT`
- `INCOMPLETE`
- `INVALID`
and MAY include policy-only operational statuses:
- `NEEDS_REVIEW`
- `EXCUSED`
- `MANUAL_ADJUSTED`
(Exact list is controlled by policy profile versioning; computed statuses remain unchanged.)

7) **Precedence Rules**
When producing effective outcome for a day:
- Base: computed facts from attendance engine
- Apply: company policy profile rules to produce default effective outcome + workflow state
- Override: apply the latest active manual resolution (if any) with audit trace
- Incorporate: administrative sources (approved leaves, missions) as policy inputs, not as computed fact mutations

**Rationale**
- **Auditability & Legal Defensibility**: computed facts are preserved; policy decisions are explicit, attributable, and reviewable.
- **Operational Flexibility**: HR can handle real-world exceptions without weakening engine correctness.
- **Maintainability**: policy changes evolve independently from ingestion and engine logic; safer upgrades over 10+ years.
- **Scalability**: factories need review queues and bulk operations; small companies can keep defaults with minimal configuration.
- **Future Simulation**: policy profile versioning enables what-if simulations without rewriting raw event history.

**Consequences**
- We must add separate persistence for policy profiles and day resolutions.
- Reporting must clearly distinguish:
  - computed_* (engine truth)
  - effective_* (policy/HR outcome)
- Tests must enforce that:
  - engine output is unchanged by policy updates
  - policy updates do not mutate device events or computed facts
  - resolutions are auditable and permission-guarded
- Any future UI must expose both layers to avoid confusion.

**Status**
LOCKED

**Change Control**
Modifying this decision requires:
- updating this document
- introducing a new policy profile version (no silent mutation of prior outcomes)
- migration notes if storage structures change
- business approval for payroll-impacting behavior

Decision 008 — Fact Layer Semantics (LOCKED)

ComputedStatus (day classification; exactly one per day):
- PRESENT
- ABSENT
- INCOMPLETE
- INVALID

Rule: "LATE" is NEVER a ComputedStatus.
Late/early are exceptions expressed as flags + metrics.

Flag model (exceptions/anomalies/policy signals; extensible):
- NO_EVENTS
- MISSING_IN
- MISSING_OUT
- LATE
- LEFT_EARLY
- FIRST_EVENT_OUT
- NON_ALTERNATING_SEQUENCE
- EVENTS_UNSORTED
- INVALID_DIRECTION
... (extensible with versioned reason codes)

Metrics (quantitative; nullable when not computable):
- minutes_late: number | null
- minutes_early_leave: number | null
- work_minutes: number | null

Classification precedence (MUST be deterministic):
1) If sequence is structurally invalid (unsorted / invalid direction / non-alternating):
   -> ComputedStatus = INVALID + corresponding flags/reason codes
2) Else if event_count == 0:
   -> ComputedStatus = ABSENT + NO_EVENTS
3) Else if missing IN or missing OUT:
   -> ComputedStatus = INCOMPLETE + (MISSING_IN and/or MISSING_OUT) (+ FIRST_EVENT_OUT when applicable)
4) Else:
   -> ComputedStatus = PRESENT
Additional flags (LATE/LEFT_EARLY) are derived after classification from computed metrics.

**Implementation**
- Engine completeness gate: engine/deriveDayStatus.js and engine/rules/decision.js
- Regression test: tests/attendance/incomplete.ps1

**Status**
LOCKED (Implemented)


Decision 009 — Attendance endpoint behavior under policy conditions (TEMPORARY)

Current behavior:
- /api/attendance returns policy-only results for NON_WORKING_DAY and ON_LEAVE with source='policy'
  before attempting DB cache or engine computation.

Impact:
- Cache tests may SKIP when policy results are returned, because no computed facts are produced for that day.

Plan:
- Short-term: stabilize tests by ensuring test reset clears leave data for the test person/date (test-only).
- Phase 5: refactor outputs to always produce computed facts, then apply policy to produce an effective outcome,
  returning both layers explicitly (computed_* vs effective_*), without mutating computed facts.
**Note: Test reset clears policy-related artifacts (e.g. leave rows) to ensure deterministic cache testing. This does not affect production behavior.**

## Decision 010 — Attendance API Outputs Include Computed + Effective Layers

**Decision**
The /api/attendance endpoint SHALL return:
- `computed`: immutable attendance facts produced by the engine (status ∈ PRESENT|ABSENT|INCOMPLETE|INVALID, flags, metrics, audit)
- `effective`: policy/resolution outcome used operationally (e.g., ON_LEAVE, NON_WORKING_DAY, NEEDS_REVIEW), sourced from AUTO_POLICY and/or manual resolutions

Computed facts MUST NOT be replaced or mutated by policy decisions.

**Rationale**
- Preserves auditability and legal defensibility
- Prevents semantic drift (facts vs HR decisions)
- Enables policy evolution and simulation without rewriting history
- Supports enterprise workflows (review queues, approvals)

**Status**
LOCKED


---

## Decision 021 - Migrations Are the Source of Truth; Apply via Script

**Decision**
We apply all SQL migrations in filename order using scripts/db/apply-migrations.ps1.
The schema_migrations table tracks applied files to keep deployment deterministic and idempotent.

**Rationale**
- Ensures any database can be rebuilt consistently from migrations.
- Prevents drift and ambiguous runtime failures when migrations are missing.
- Feature preflight checks fail fast when required tables are absent.

**Status**
Implemented

---

## Decision 022 - Real-Time Device Event Ingestion (Live Push)

**Decision**
Introduce a live push ingestion path for device events (SDK/HTTP push). Live events MUST flow through the same normalization and idempotency guarantees as batch imports, including identity mappings, normalization, and provider > vendor precedence. Simulation remains no-persist.

**Rationale**
- Eliminates lag from batch imports while preserving deterministic contracts.
- Enables near real-time operational visibility without changing engine semantics.

**Status**
Planned

---

## Decision 023 - REST API Layer for External Integration

**Decision**
Provide a stable REST API for external systems to ingest and query attendance data. All endpoints MUST enforce tenant scoping, identity mapping policy, and fact vs policy separation; no endpoint may bypass normalization or migrations.

**Rationale**
- Enables integration with HR/payroll/ERP and mobile clients safely.
- Preserves invariants while expanding integration surface area.

**Status**
Planned

---

## Decision 024 - Attendance Reports Module

**Decision**
Introduce a reporting module that derives daily/monthly summaries from computed facts and effective outcomes. Reports MUST be read-only, deterministic, and derived from migration-backed tables; no report may mutate facts or policy state.

**Rationale**
- Converts raw facts into enterprise reporting outputs.
- Keeps audits clean by separating reporting from core computation.

**Status**
Planned

---

## Decision 025 - Shift Template and Work Schedule Management

**Decision**
Add shift templates and schedule assignments as policy-layer inputs. Schedule data MUST be stored via migrations and MUST NOT alter computed facts; it influences effective outcomes and reporting only.

**Rationale**
- Required for accurate late/absence/overtime interpretation at scale.
- Keeps policy decisions separate from deterministic fact computation.

**Status**
Planned

---

## Decision 026 - Biometric/RFID Device Adapter Layer

**Decision**
Create an adapter layer for biometric/RFID devices that normalizes vendor protocols into the ingestion contract. Adapters MUST preserve raw payloads, enforce identity mapping policy, and respect provider > vendor precedence.

**Rationale**
- Decouples vendor-specific protocols from core ingestion.
- Supports multiple device types without changing engine logic.

**Status**
Planned

---

## Decision 027 - Unified Reporting API + CSV Export

**Decision**
Expose unified reporting endpoints and CSV exports backed by the reporting module. Outputs MUST include computed vs effective layers and remain read-only with deterministic, migration-backed data sources.

**Rationale**
- Provides consistent export formats across integrations.
- Avoids direct SQL usage and preserves auditability.

**Status**
Planned

---

## Decision 028 - Test Coverage Enforcement in CI

**Decision**
All regression-critical tests (PowerShell + Node) MUST run via tests/run-all.ps1 and therefore in CI smoke. No orphan tests are allowed outside the suite.

**Rationale**
- Prevents drift in identity/ingestion contracts.
- Ensures deterministic coverage across Windows and GitHub Actions.

**Status**
In Progress

---

## Decision 029 - Progressive Engine Expansion for Sessions and Gaps

**Decision**
Extend the attendance engine to support multiple sessions, gaps, and richer pairing rules while preserving existing semantics behind feature gates. Computed facts remain deterministic; simulation stays no-persist.

**Rationale**
- Handles complex real-world punch patterns without weakening core rules.
- Enables future overtime and compliance logic safely.

**Status**
Planned

---

## Decision 030 - Manual Device-Free Attendance via Mobile App (Optional)

**Decision**
Allow optional device-free check-in/out via mobile (GPS + selfie) as policy-layer inputs. These events MUST be auditable, must not mutate computed facts, and must follow identity mapping and normalization rules.

**Rationale**
- Supports field and remote work while preserving auditability.
- Keeps device evidence and HR policy cleanly separated.

**Status**
Planned

---

## OPEN ITEMS (NEXT STEPS) ? NOT IMPLEMENTED YET

- Employee master data table (canonical employee/person registry) to unify identity, HR attributes, and reporting across devices. Evidence gap: no migration or schema for a canonical employee table.
- Device registry table for device_uid metadata (vendor, location, site) to preserve auditability and multi-device fleet management. Evidence gap: no migration or schema for a device registry.
- Tenant scoping Phase B for remaining tenant-bound tables (e.g., rule_sets, rules). Evidence gap: migrations/20260113_rulesets.sql shows no company_id columns on rule_sets or rules.
- Authentication/authorization tenancy enforcement to prevent cross-company access. Evidence gap: no auth layer or tenancy guard middleware in the API.
- Admin UI/API for managing companies, policies, rule sets, working days, and holidays. Evidence gap: no dedicated admin endpoints or UI flows.



