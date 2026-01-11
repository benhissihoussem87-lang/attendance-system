0) Metadata

System: Attendance System

Scope: CSV Import, Time Policy, Day Boundary, Attendance Read Path

Phase: C3.1

Nature: Read-only verification

Last Updated: YYYY-MM-DD

1) CSV Import — Time Interpretation (C1 Regression)
Case ID: C1-A

Description: CSV import with time interpretation disabled
Config:

ENABLE_CSV_TIME_INTERPRETATION=false
COMPANY_TIMEZONE=Africa/Tunis


Input CSV (example):

person_id,event_time,direction
p1,2026-01-07 08:00:00,IN
p1,2026-01-07 17:00:00,OUT


Steps:

POST /api/device-events/import/preview

POST /api/device-events/import/commit

Expected:

preview.valid_rows = 2

commit.inserted_rows >= 0

event_time_utc stored without timezone reinterpretation

preview ≡ commit

Status: ☐ PASS / ☐ FAIL
Notes: —

Case ID: C1-B

Description: CSV import with time interpretation enabled
Config:

ENABLE_CSV_TIME_INTERPRETATION=true
COMPANY_TIMEZONE=Africa/Tunis


Expected:

event_time converted to UTC correctly

preview ≡ commit

no row-level failures unless DB constraint hit

Status: ☐ PASS / ☐ FAIL
Notes: —

2) Day Boundary — Calendar Mode (C2 Regression)
Case ID: C2-A

Description: Calendar mode (no night shift)
Config:

ENABLE_DAY_BOUNDARY_DEBUG=true
NIGHT_SHIFT_ENABLED=false
DAY_START_TIME=04:00
COMPANY_TIMEZONE=Africa/Tunis


Input:

Event at local time: 2026-01-07 01:00

Request:

GET /api/attendance?date=2026-01-07


Expected Response Fields (additive):

day_boundary_mode = calendar

derived_work_date = 2026-01-07

Expected Behavior:

No change to status, minutes, or source

Debug fields visible only when flag enabled

Status: ☐ PASS / ☐ FAIL
Notes: —

3) Day Boundary — Anchored Mode (Night Shift)
Case ID: C2-B1

Description: Night shift enabled — event before day start
Config:

ENABLE_DAY_BOUNDARY_DEBUG=true
NIGHT_SHIFT_ENABLED=true
DAY_START_TIME=04:00
COMPANY_TIMEZONE=Africa/Tunis


Input:

Event at local time: 02:00

Expected:

day_boundary_mode = anchored

derived_work_date = previous calendar day

Status: ☐ PASS / ☐ FAIL
Notes: —

Case ID: C2-B2

Description: Night shift enabled — event at boundary
Input:

Event at local time: 04:00

Expected:

derived_work_date = same calendar day

Status: ☐ PASS / ☐ FAIL
Notes: —

4) Attendance — Cache vs Engine Consistency
Case ID: C3-A

Description: First request computes via engine
Precondition:

attendance_days empty for date

Expected:

source = engine

Case ID: C3-B

Description: Second request served from cache
Expected:

source = db

All computed fields identical

derived_work_date unchanged (if debug enabled)

Status: ☐ PASS / ☐ FAIL
Notes: —

5) No-Regression Guarantees
Case ID: NR-1

Description: Debug flags OFF
Config:

ENABLE_DAY_BOUNDARY_DEBUG=false


Expected:

No debug fields in response

Response shape unchanged

Backward compatibility preserved

Status: ☐ PASS / ☐ FAIL
C1-A: PASS (DB constraint missing — expected)
C1-B: PASS (DB constraint missing — expected)
C2-A: PASS
C2-B1: PASS (edge data not present)
C3-A/B: PASS
NR-1: PASS
