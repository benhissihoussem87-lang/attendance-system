E2 Activation — Derived Work Date Window

Feature Flag
- USE_DERIVED_WORK_DATE (default: false)

Behavior
- When disabled, attendance uses a UTC day window [00:00Z, next 00:00Z).
- When enabled, attendance uses a local window derived from company settings:
  - night_shift_enabled = false: [work_date 00:00, next day 00:00) in company timezone
  - night_shift_enabled = true: [work_date day_start_time, next day day_start_time) in company timezone
- Local window boundaries are converted to UTC instants for device_events querying.
- The work_date passed to the engine and stored in attendance_days remains the requested date.

Rollback
- Set USE_DERIVED_WORK_DATE=false to restore the previous UTC window behavior.
