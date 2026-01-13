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
Every attendance event must have a deterministic device identity:
- Primary: device serial number (sn)
- Secondary: machine number (fallback)

Rows without device identity are rejected.

**Rationale**
- Required for forensic traceability
- Required for multi-device environments
- Prevents unverifiable events

**Status**  
LOCKED

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
- Each event includes: person_id, event_time_utc (ISO), direction (IN|OUT), device_uid (nullable)
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

## Decision 006 � Separation of Computed Facts and HR Policy Decisions

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
