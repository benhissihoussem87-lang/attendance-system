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
