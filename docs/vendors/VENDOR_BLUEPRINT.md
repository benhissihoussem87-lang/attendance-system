# Vendor Blueprint — CSV Ingestion (Vendor-Agnostic)

## Purpose
This document defines the canonical ingestion blueprint for any device vendor.
Vendors are integrated ONLY via adapters. Core attendance logic is never vendor-specific.

Status: LOCKED BLUEPRINT

---

## Canonical Event Contract (Target)
Every accepted row must become a canonical device event with:

- person_id (string) — stable human identifier
- event_time_utc (ISO string) — UTC timestamp
- direction (IN | OUT)
- vendor (string)
- device_uid (string) — deterministic device identity
- raw_payload (json) — full original row + audit metadata

---

## Vendor Adapter Responsibilities (STRICT)
A vendor adapter MUST:
1. Parse vendor CSV export format.
2. Validate required fields (reject invalid rows).
3. Map vendor-specific values into canonical fields.
4. Preserve full vendor row in raw_payload.
5. Never infer missing identity or timestamps.

A vendor adapter MUST NOT:
- Change attendance rule engine behavior
- Compute attendance metrics
- Guess missing device identity
- Guess in/out semantics without explicit mapping

---

## Identity Rules (LOCKED)

### person_id
A vendor must provide a stable person identifier.
Allowed sources (in order of preference):
1. BadgeNumber / EmployeeCode (portable)
2. NationalID / HR identifier (portable)
3. Vendor internal numeric USERID is NOT portable and MUST NOT be used as person_id

If person_id cannot be reliably derived, the row is rejected.

### device_uid
Each event MUST have deterministic device identity.
Allowed sources (in order of preference):
1. Device serial number (sn / serial / device_sn)
2. Device machine number ONLY if it is stable and unique in the client environment

If no device identity is available, the row is rejected.
No synthetic IDs are created.

---

## Time Rules (LOCKED)

### Source time
Most devices export local time without timezone.
Therefore:
- The adapter interprets vendor time as "local device time" in a configured source timezone.
- The adapter converts it to UTC before persistence.

Rules:
- A valid source timezone MUST be configured (IANA name).
- Invalid or unparseable timestamps cause row rejection.
- DO NOT treat vendor timestamps as UTC unless the vendor explicitly states UTC.

---

## Direction Rules (LOCKED)

Device exports commonly encode direction with numeric/letters.
Therefore:
- Direction MUST be mapped explicitly via configuration.
- Unknown values are rejected.

No assumptions:
- Do not assume 0/1 == IN/OUT without explicit mapping.
- Do not assume I/O == IN/OUT without explicit mapping (case-insensitive mapping is allowed only if configured).

---

## Raw Payload (AUDIT)
For every accepted canonical event, raw_payload MUST include:
- original_row: full vendor row values
- source_table or export_name (if known)
- source_timezone used
- original_time_string
- mapping_audit:
  - direction_raw
  - direction_mapped
  - device_uid_source
  - device_uid_fallback (true/false)

---

## Change Control
This blueprint is LOCKED.
Any change requires:
- Explicit decision record in docs/DECISIONS.md
- Adapter version bump (or new tag)
- Backward compatibility review
