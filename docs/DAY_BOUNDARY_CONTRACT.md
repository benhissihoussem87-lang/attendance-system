Day Boundary Contract

Purpose
Freeze Day Boundary rules before activation.

Definitions
Calendar mode:
- night_shift_enabled = false
- work_date is the local calendar date in company_timezone.

Anchored mode:
- night_shift_enabled = true
- day_start_time defines the anchored start time.
- Events before day_start_time belong to the previous work_date.

Role of Configuration
- company_timezone: timezone used to evaluate boundaries.
- night_shift_enabled: selects calendar or anchored mode.
- day_start_time: required when anchored mode is enabled.

Precedence Rules
Day Boundary → Working Day → Leave → Engine

Explicit Non-Goals
- CSV does NOT derive work_date.
- Engine does NOT derive work_date.
- No DST handling yet.

Statements
- Day Boundary is evaluated in company timezone.
- UTC is storage only.
