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
