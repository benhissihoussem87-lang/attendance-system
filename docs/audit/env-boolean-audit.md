# Env Boolean Audit

Date: 2026-01-29

## Summary of findings
Counts by pattern (code only, excludes docs):
- `process.env.X === 'true'`: 15
- `process.env.X !== 'true'`: 1
- `process.env.X === '1'`: 0
- `process.env.X !== '1'`: 0
- Comparisons to `'0'` / `'false'`: 0
- Custom env-bool helpers outside `services/envBool.js`: 0

High-risk mismatches fixed during this audit:
- `USE_EMPLOYEE_ASSIGNMENTS` gate in `api/attendance.routes.js` now uses `toBool()`.
- `ALLOW_TEST_ENDPOINTS` cache override in `api/attendance.routes.js` now uses `toBool()`.
- `USE_EMPLOYEES_REGISTRY` gate in `services/employeeDirectory.js` now uses `toBool()`.

## Findings

| File | Line | Env var | Current logic | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `config/env.js` | ~21 | `USE_COMPANY_CONFIG_DB` | `process.env.USE_COMPANY_CONFIG_DB === 'true'` | MED: env `"1"` won't enable DB config; diverges from ADR | Change to `toBool()` for consistency |
| `config/env.js` | ~22 | `ENABLE_DAY_BOUNDARY_DEBUG` | `process.env.ENABLE_DAY_BOUNDARY_DEBUG === 'true'` | LOW: debug-only | Change to `toBool()` when touching debug flags |
| `config/env.js` | ~23 | `USE_DERIVED_WORK_DATE` | `process.env.USE_DERIVED_WORK_DATE === 'true'` | MED: feature flag ignored when set to `"1"` | Change to `toBool()` |
| `config/env.js` | ~24 | `ENABLE_CSV_TIME_INTERPRETATION` | `process.env.ENABLE_CSV_TIME_INTERPRETATION === 'true'` | MED: feature flag ignored when set to `"1"` | Change to `toBool()` |
| `api/simulate.routes.js` | ~25 | `USE_DERIVED_WORK_DATE` | `process.env.USE_DERIVED_WORK_DATE === 'true'` | MED: simulation behavior diverges if `"1"` used | Change to `toBool()` |
| `api/attendance.routes.js` | ~32 | `ENABLE_DAY_BOUNDARY_DEBUG` | `process.env.ENABLE_DAY_BOUNDARY_DEBUG === 'true'` | LOW: debug-only | Change to `toBool()` when touching debug flags |
| `api/attendance.routes.js` | ~33 | `ENABLE_CACHE_DIAGNOSTIC` | `process.env.ENABLE_CACHE_DIAGNOSTIC === 'true'` | LOW: debug-only | Change to `toBool()` when touching debug flags |
| `api/attendance.routes.js` | ~34 | `USE_DERIVED_WORK_DATE` | `process.env.USE_DERIVED_WORK_DATE === 'true'` | MED: derived work date ignored when set to `"1"` | Change to `toBool()` |
| `services/cacheInvalidation.js` | ~18 | `USE_DERIVED_WORK_DATE` | `process.env.USE_DERIVED_WORK_DATE === 'true'` | MED: cache invalidation differs if `"1"` used | Change to `toBool()` |
| `services/companyConfig.js` | ~4 | `NIGHT_SHIFT_ENABLED` | `process.env.NIGHT_SHIFT_ENABLED === 'true'` | MED: feature flag ignored when set to `"1"` | Change to `toBool()` |
| `services/dayBoundary.js` | ~2 | `ENABLE_DAY_BOUNDARY_DEBUG` | `process.env.ENABLE_DAY_BOUNDARY_DEBUG === 'true'` | LOW: debug-only | Change to `toBool()` when touching debug flags |
| `services/timeInterpreter.js` | ~2 | `ENABLE_CSV_TIME_INTERPRETATION` | `process.env.ENABLE_CSV_TIME_INTERPRETATION === 'true'` | MED: CSV parsing behavior ignored when `"1"` used | Change to `toBool()` |
| `services/companyConfigProvider.js` | ~6 | `USE_COMPANY_CONFIG_DB` | `process.env.USE_COMPANY_CONFIG_DB !== 'true'` | MED: `"1"` won't enable DB config | Change to `toBool()` |
| `db.js` | ~17 | `PGSSL` | `process.env.PGSSL === 'true'` | MED: SSL won't enable if `"1"` used | Change to `toBool()` |
| `tests/policy/reviewQueue.test.js` | ~5 | `ALLOW_TEST_ENDPOINTS` | `process.env.ALLOW_TEST_ENDPOINTS === 'true'` | LOW: test-only | Optional: change to `toBool()` |
| `tests/policy/manualResolution.workflow.test.js` | ~5 | `ALLOW_TEST_ENDPOINTS` | `process.env.ALLOW_TEST_ENDPOINTS === 'true'` | LOW: test-only | Optional: change to `toBool()` |

## Recommended follow-up
Fix now (non-breaking, aligns with ADR):
- Convert `USE_DERIVED_WORK_DATE` checks in `api/attendance.routes.js`, `api/simulate.routes.js`, and `services/cacheInvalidation.js` to `toBool()`.
- Convert `USE_COMPANY_CONFIG_DB` checks in `config/env.js` and `services/companyConfigProvider.js` to `toBool()`.
- Convert `ENABLE_CSV_TIME_INTERPRETATION` and `NIGHT_SHIFT_ENABLED` checks to `toBool()`.
- Convert `PGSSL` to `toBool()` if you want `"1"` to enable SSL consistently.

Leave intentionally strict (none identified):
- No findings require a literal `'true'` for security or compatibility; if such a case exists, document it explicitly in code.
