# ZKTime 5.0 Data Model (ZKTeco)

This document captures the verified ZKTime 5.0 Access data model used by the
ZKTeco adapter and the locked mapping decisions for CSV ingestion.

## Tables Used
- CHECKINOUT: attendance events source.
- USERINFO: user identity source (person mapping).
- Machines: device identity source (serial number).

## Column Meanings (Verified)

### CHECKINOUT
- USERID: internal ZKTeco identifier (not portable).
- CHECKTIME: local device timestamp (no timezone).
- CHECKTYPE: device-reported event type (semantics not guaranteed).
- VERIFYCODE: verification method (raw).
- SENSORID: device sensor id (raw).
- Memoinfo: memo field (raw).
- WorkCode: work code (raw).
- sn: device serial number (may be missing).
- UserExtFmt: vendor extension (raw).
- mask_flag: mask status (raw).
- temperature: temperature reading (raw).

### USERINFO
- USERID: internal ZKTeco identifier.
- Badgenumber: human identity (portable).

### Machines
- sn: device serial number.

## Locked Decisions
- person_id is mapped from USERINFO.Badgenumber.
- USERID must never be exposed outside raw_payload.
- CHECKTIME is interpreted as local time in a configured source timezone
  (default Africa/Tunis) and converted to UTC for event_time_utc.
- device_uid is "zkteco:" + sn when sn is present.
- device_uid fallback is "zkteco:machine:<MachineNumber>" when sn is missing.
  The fallback is documented in raw_payload.
- Unknown CHECKTYPE values are invalid until an explicit mapping is configured.
- CHECKTYPE mappings are configured externally (for example via ZKTECO_CHECKTYPE_MAP).
- raw_payload always includes:
  - original_row (raw column values)
  - source_table = CHECKINOUT
  - source_timezone
  - original_checktime_string
  - mapping_audit

## DO NOT ASSUME
- DO NOT assume CHECKTYPE meaning without an explicit, configured mapping.
- DO NOT treat CHECKTIME as UTC or timezone-aware.
- DO NOT use USERID as person_id or expose it outside raw_payload.
- DO NOT drop vendor-provided columns from raw_payload.
- DO NOT infer device identity if both sn and MachineNumber are missing.
