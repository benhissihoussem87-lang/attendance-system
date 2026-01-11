Feature Flags

USE_COMPANY_CONFIG_DB
- Default: false
- Enables: reading company settings from company_config table.
- Must NOT change: fallback behavior to env values when disabled or missing.

ENABLE_DAY_BOUNDARY_DEBUG
- Default: false
- Enables: additive debug fields in attendance responses.
- Must NOT change: attendance computations or response shape when disabled.

USE_DERIVED_WORK_DATE (Reserved)
- Default: false
- Enables: future use of derived work_date for attendance computation.
- Must NOT change: current engine or CSV behavior.
