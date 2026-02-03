# ZKTeco CSV Ingestion — Locked Technical Policy

## Scope
This document describes the locked and audited technical decisions
for ingesting ZKTeco (ZKTime / ATT2000) CSV exports into the attendance system.

This policy applies to:
- CSV preview
- CSV commit
- Historical re-imports
- Simulation and recomputation logic

---

## Source Tables (ZKTeco)
- CHECKINOUT — attendance events (primary source)
- USERINFO — human identity mapping
- Machines — device metadata

---

## Identity Mapping Rules (LOCKED)

### person_id
- Mapped exclusively from `USERINFO.Badgenumber`
- `USERID` is considered vendor-internal and MUST NOT be exposed
- Rows without a valid Badgenumber are rejected

---

## Device Identity Policy (CRITICAL)

Each attendance event MUST be associated with a deterministic device identity.

### Accepted device_uid sources
1. `sn` (device serial number) — primary
2. `MachineNumber` — secondary fallback

### Rejected events
Any attendance row that contains neither `sn` nor `MachineNumber`
is considered INVALID and is rejected during CSV preview.

No synthetic or inferred device identifiers are ever created.

---

## CHECKTIME Handling

- CHECKTIME values are treated as local device time
- Local time is interpreted using a configured source timezone
  (default: Africa/Tunis)
- All times are converted to UTC before persistence
- Invalid or unparseable CHECKTIME values cause row rejection

---

## CHECKTYPE Handling

- CHECKTYPE semantics are NOT assumed
- CHECKTYPE values must be explicitly mapped via configuration
  (e.g. environment variable ZKTECO_CHECKTYPE_MAP)
- Unknown CHECKTYPE values result in row rejection

---

## Raw Payload Preservation

For every accepted event, the original vendor data is preserved
verbatim in `raw_payload`, including:
- Original CSV row values
- Source table name
- Source timezone
- CHECKTYPE mapping audit
- Device UID source (sn vs MachineNumber)

---

## Design Rationale

This policy is intentionally conservative in order to:
- Preserve auditability and traceability
- Prevent ambiguous or unverifiable attendance events
- Protect downstream analytics and payroll computations
- Align with enterprise compliance and forensic requirements

---

## Change Control

This behavior is LOCKED.

Any relaxation of these rules requires:
- Explicit business approval
- Updated documentation
- Versioned migration notes

Status: **LOCKED**
