# ZKTeco Attendance Ingestion — Operational Runbook

## Purpose

This document describes the operational procedure for ingesting
ZKTeco (ZKTime / ATT2000) attendance data into the system.

It is intended for:
- IT administrators
- System integrators
- Technical support staff

This runbook explains WHAT to do and WHEN — not HOW the code works.

---

## Supported Input Sources

ZKTeco data must be provided using one of the following sources:

- CSV exports from ZKTeco software
- CSV files generated from ZKTeco Access (.mdb) databases

Direct database connections are NOT supported.

---

## Required Source Tables

The following logical data must be present:

1. Attendance events  
   - Source: CHECKINOUT

2. User identity mapping  
   - Source: USERINFO

3. Device metadata  
   - Source: Machines

---

## Mandatory Columns (Logical)

Each attendance row MUST resolve to the following logical fields:

- person_id  
  - Derived from USERINFO.Badgenumber

- event_time (local device time)  
  - Derived from CHECKTIME

- direction  
  - Derived from CHECKTYPE via explicit mapping

- device_uid  
  - Derived from device serial number (sn) or MachineNumber

Rows missing any of these are rejected.

---

## Ingestion Workflow (Step-by-Step)

### Step 1 — Collect Source Files

Request from the client:
- Attendance CSV (CHECKINOUT)
- User CSV (USERINFO)
- Device CSV (Machines)

All files must originate from the same export period.

---

### Step 2 — Preprocessing (If Needed)

If the attendance CSV:
- Does not include Badgenumber
- Does not include device identifiers
- Uses non-standard time formats

Then preprocessing scripts must be applied BEFORE ingestion.

No preprocessing occurs inside the system.

---

### Step 3 — Preview Validation

Send the attendance CSV to:

POST /api/device-events/import/preview?vendor=zkteco

This step:
- Validates structure and data
- Produces NO database writes
- Returns detailed error diagnostics

---

### Step 4 — Analyze Preview Results

#### If valid_rows > 0 AND invalid_rows = 0
- The CSV is eligible for commit

#### If invalid_rows > 0
- Review error_intelligence
- Export error CSV if needed
- Fix source data
- Repeat preview

Never proceed to commit with unresolved errors.

---

### Step 5 — Error Interpretation Guidelines

Common error categories:

- MISSING_DEVICE_UID  
  → Device information missing in source export

- UNKNOWN_CHECKTYPE  
  → CHECKTYPE mapping not configured

- INVALID_CHECKTIME  
  → Time format not supported

Each error includes a recommendation explaining corrective action.

---

### Step 6 — Commit Ingestion

Only after a successful preview:

POST /api/device-events/import/commit

This step:
- Writes validated events to the database
- Applies deduplication rules
- Preserves raw vendor payloads for audit

---

## Operational Rules (STRICT)

- Preview is mandatory before commit
- Commit is forbidden if preview has errors
- No data correction is performed automatically
- All fixes must occur at the source or preprocessing stage

---

## Audit and Compliance

For each committed event, the system preserves:
- Original vendor row
- Source timezone
- CHECKTYPE mapping
- Device UID source

This ensures full traceability for audits and payroll reviews.

---

## Change Control

This runbook is versioned.

Any change requires:
- Updated documentation
- Validation review
- Explicit approval

Status: ACTIVE
