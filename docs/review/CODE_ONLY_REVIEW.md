# CODE ONLY TECHNICAL REVIEW

Scope: code inspection only. No `.md` docs used as source of truth.  
Evidence format: `file:line-range`.

## A) Repository map (entrypoints, routes, services, engine, db, tests)

- Primary server entrypoint is `server.js`, which constructs Express, mounts API routers, and starts listener via `start()` -> `app.listen(...)` (`server.js:L9-L12`, `server.js:L30-L49`, `server.js:L65-L75`).
- DB connection layer is `db.js` (single `pg.Pool`, required env guard) (`db.js:L4-L9`, `db.js:L12-L23`).
- Config/env loader is `config/env.js` (port + DB vars + feature flags) (`config/env.js:L3-L8`, `config/env.js:L13-L27`).
- Route surface is split across `api/*.routes.js`, mounted in `server.js` under `/api/*` and `/api` prefixes (`server.js:L30-L49`).
- Attendance engine used by runtime routes is `engine/AttendanceEngine.js` with phase executor `engine/RuleExecutor.js` and rule phases in `engine/rules/*` (`engine/AttendanceEngine.js:L5-L15`, `engine/RuleExecutor.js:L13-L23`, `engine/rules/index.js:L8-L14`).
- Data contracts are defined by SQL schema + migrations (`db_schema.sql:L58-L315`, `migrations/20260101_core_baseline.sql:L6-L73`, `migrations/20260116_tenant_scope_core_tables.sql:L3-L116`).
- Test harness entry is PowerShell (`tests/run-suite.ps1` -> `tests/run-all.ps1`) and direct Node invocations (`tests/run-suite.ps1:L260-L264`, `tests/run-all.ps1:L142-L249`).

## B) Runtime wiring: startup, middleware chain, route mounting

- Global middleware chain is `cors`, JSON body parser, URL-encoded parser (`server.js:L10-L12`).
- Pre-start guard checks `employee_assignments` table only when `USE_EMPLOYEE_ASSIGNMENTS` is enabled; startup hard-fails if missing (`server.js:L16-L27`, `server.js:L65-L75`).
- Route mounting order is explicit in `server.js`; test-only router `/api/ops/test` is gated by `ALLOW_TEST_ENDPOINTS` (`server.js:L30-L49`, `server.js:L40-L42`).
- Auth middleware behavior:
  - API key requirement is conditional on `REQUIRE_AUTH` (`api/lib/auth.js:L11-L13`, `api/lib/auth.js:L70-L77`).
  - Company scope enforcement compares body/query/header company IDs against authenticated tenant (`api/lib/auth.js:L49-L68`).
  - Role enforcement is rank-based (`viewer < operator < admin`) (`api/lib/auth.js:L5-L9`, `api/lib/auth.js:L99-L114`).
- Error responses are normalized through a common envelope builder/sender (`api/lib/errorEnvelope.js:L8-L34`).

## C) Data model contracts (tables + constraints relied on by code)

- `attendance_days`
  - Used as compute cache and persistence target in attendance route (`api/attendance.routes.js:L262-L274`, `api/attendance.routes.js:L391-L447`).
  - Unique per `(company_id, person_id, work_date)` (`db_schema.sql:L337-L339`).
  - FK to `companies` and optional FK to `rule_sets` (`db_schema.sql:L602-L611`).
- `device_events`
  - Insert target for JSON ingest + CSV commit (`api/deviceEvents.routes.js:L290-L307`, `api/deviceEvents.routes.js:L831-L840`, `api/deviceEvents.routes.js:L1063-L1072`).
  - Dedup unique constraint `(company_id, person_id, event_time_utc, direction, device_uid)` (`db_schema.sql:L385-L387`).
  - `device_uid` non-empty check + direction check (`db_schema.sql:L162-L164`).
  - Company FK (`db_schema.sql:L626-L627`).
- `attendance_day_resolutions`
  - Manual + auto policy resolution writes (`services/policy/manualResolutionService.js:L30-L47`, `services/policy/persistAutoPolicyResolution.js:L78-L95`).
  - FK to `attendance_days(id)` and unique active index per day (`db_schema.sql:L594-L596`, `db_schema.sql:L580-L580`).
- `employees` + `identity_mappings`
  - Employee upsert/list APIs use `employees` (`services/employeesDb.js:L31-L47`, `services/employeesDb.js:L66-L96`).
  - Mapping APIs use `identity_mappings` and enforce existing employee in upsert path (`services/identityMappingsDb.js:L139-L146`, `services/identityMappingsDb.js:L187-L205`).
  - `identity_mappings` PK and employee FK (`db_schema.sql:L433-L435`, `db_schema.sql:L674-L675`).
  - Partial unique employee code index (`db_schema.sql:L587-L587`).
- `employee_assignments`
  - Assignment resolution query for attendance uses range overlap semantics (`services/employeeAssignmentsService.js:L2-L11`).
  - Valid range check constraint exists (`db_schema.sql:L195-L195`).
- `company_config` + `company_working_days` + `employee_leaves`
  - Non-working day/leave policy context reads these tables (`services/policy/policyContextProvider.js:L1-L8`, `services/policy/policyContextProvider.js:L41-L49`).
  - `company_working_days` weekday check (`db_schema.sql:L140-L145`).
  - `employee_leaves.affects_attendance` column exists via migration (`migrations/20260130_employee_leaves_affects_attendance.sql:L3-L8`).

## D) Ingestion flows (JSON ingest, CSV preview, CSV commit)

### JSON ingest (`POST /api/device-events`)

- Required inputs enforced: `person_id`, `event_time_utc`, `direction` (`api/deviceEvents.routes.js:L162-L173`).
- Direction must be `IN|OUT` (`api/deviceEvents.routes.js:L175-L186`).
- `device_uid` is required via `requireDeviceUid` (`api/deviceEvents.routes.js:L205-L223`, `services/validators/deviceIdentity.js:L1-L9`).
- Company resolution order: auth context -> body/query/header -> default (`api/deviceEvents.routes.js:L224-L224`, `api/deviceEvents.routes.js:L71-L80`).
- Optional identity mapping path can override `person_id` when enabled (`api/deviceEvents.routes.js:L227-L262`, `services/identityResolver.js:L18-L74`, `services/identityMappingPolicy.js:L18-L33`).
- Dedup/idempotency behavior: `INSERT ... ON CONFLICT ON CONSTRAINT device_events_dedup_company_uk DO NOTHING`; duplicate returns `200 {status:'ok', dedup:true}` (`api/deviceEvents.routes.js:L290-L311`, `db_schema.sql:L385-L387`).
- Cache invalidation is triggered only after inserted row (`api/deviceEvents.routes.js:L313-L315`, `services/cacheInvalidation.js:L33-L41`).

### CSV preview (`POST /api/device-events/import/preview`)

- Accepts raw body (`express.raw`) and rejects empty CSV (`api/deviceEvents.routes.js:L331-L337`, `api/deviceEvents.routes.js:L344-L354`).
- Vendor/delimiter selection from query/header (`api/deviceEvents.routes.js:L35-L52`, `api/deviceEvents.routes.js:L54-L64`, `api/deviceEvents.routes.js:L356-L367`).
- Parses with adapter dispatch; unknown vendor returns import error (`api/deviceEvents.routes.js:L369-L383`, `services/deviceEventsCsvValidator.js:L256-L272`, `adapters/vendors/registry.js:L33-L51`).
- Company consistency checks: mixed `company_id` and auth/request mismatch rejected (`api/deviceEvents.routes.js:L384-L409`).
- Identity mapping is attempted per valid row and can mark row invalid (`api/deviceEvents.routes.js:L410-L454`).
- Preview contract includes totals, errors, intelligence, sample rows (`api/deviceEvents.routes.js:L494-L507`).
- No write SQL statements are present in this handler block; helper calls include read queries (identity resolver `SELECT`) (`api/deviceEvents.routes.js:L331-L543`, `services/identityResolver.js:L47-L56`).  
  Unknown: full side-effect guarantees of all helper functions not proven beyond inspected code.

### CSV commit (`POST /api/device-events/import/commit`)

- Same vendor/delimiter handling and CSV parse pipeline (`api/deviceEvents.routes.js:L648-L660`).
- Rejects missing required columns (`api/deviceEvents.routes.js:L675-L689`).
- Company consistency checks repeated (`api/deviceEvents.routes.js:L691-L716`).
- Identity mapping pre-resolution occurs before row insert loops (`api/deviceEvents.routes.js:L717-L756`).
- Insert/dedup logic in both branches (zkteco + generic):
  - `ON CONFLICT ... DO NOTHING` (`api/deviceEvents.routes.js:L833-L840`, `api/deviceEvents.routes.js:L1065-L1072`).
  - Inserted rows invalidate attendance cache (`api/deviceEvents.routes.js:L866-L869`, `api/deviceEvents.routes.js:L1098-L1101`).
  - Returns `inserted_rows/skipped_rows/failed_rows` summary (`api/deviceEvents.routes.js:L915-L930`, `api/deviceEvents.routes.js:L1147-L1162`).

### CSV request contracts inferred from parser code

- Generic parser requires `person_id,event_time,direction` (`services/deviceEventsCsvValidator.js:L174-L180`).
- `generic_punchlog` requires `employee_id,timestamp,device_serial`; direction is mapped from optional `event` (`adapters/vendors/generic_punchlog/index.js:L182-L197`, `adapters/vendors/generic_punchlog/index.js:L250-L271`).
- `zkteco` requires `badgenumber|userid`, `checktime`, `checktype`, `sn|MachineNumber` (`adapters/vendors/zkteco/index.js:L336-L357`, `adapters/vendors/zkteco/index.js:L390-L438`).

## E) Attendance engine: day computation, assumptions, edge cases

- Runtime routes call `engine/AttendanceEngine.computeDay` (`api/attendance.routes.js:L366-L371`, `api/simulate.routes.js:L315-L320`).
- Engine pipeline is fixed phase order: workday -> schedule -> events -> metrics -> decision (`engine/RuleExecutor.js:L14-L19`, `engine/rules/index.js:L8-L14`).
- Event pairing model is first `IN` + last `OUT` only (`engine/TimelineBuilder.js:L3-L21`).
- Completeness status logic:
  - no events => `ABSENT`
  - only IN or only OUT => `INCOMPLETE`
  - otherwise `PRESENT` (`engine/deriveDayStatus.js:L6-L25`).
- Schedule application:
  - `FIXED_SHIFT` uses `start/end`
  - `FLEX_SHIFT` uses `window_start/window_end/required_work_minutes` (`engine/rules/schedule.js:L8-L27`).
- Metrics:
  - worked minutes = max(0, last_out - first_in)
  - late minutes from schedule start and threshold precedence (`grace_minutes` > `late_after_minutes` > fallback threshold)
  - net worked = worked - break deduction (`engine/rules/metrics.js:L80-L91`, `engine/rules/metrics.js:L119-L137`, `engine/rules/metrics.js:L147-L147`).
- Decision:
  - `ABSENT` and `INCOMPLETE` are derived before status rules
  - status rules can apply `LATE` flag and set `PRESENT`/fallback statuses (`engine/rules/decision.js:L78-L97`, `engine/rules/decision.js:L102-L141`).
- Edge cases explicitly surfaced in runtime path:
  - invalid/missing rule-set constructs become `INVALID` via validator (`engine/RuleSetValidator.js:L46-L49`, `engine/RuleSetValidator.js:L148-L153`).
  - invalid late context can return `INVALID` (`engine/rules/metrics.js:L105-L117`).

## F) Simulation: differences vs persisted computation, no-persist confirmation

- `/api/simulate/day` and `/api/simulate/range`:
  - Use same engine and policy evaluation stack (`api/simulate.routes.js:L315-L351`, `api/simulate.routes.js:L588-L627`).
  - Return `source: 'simulation'` and `attendance_day_id = null` (`api/simulate.routes.js:L369-L370`, `api/simulate.routes.js:L400-L408`, `api/simulate.routes.js:L636-L643`).
  - Code path reads events via `SELECT ... FROM device_events` and does not issue insert/update/delete statements (`api/simulate.routes.js:L298-L306`, `api/simulate.routes.js:L557-L566`).
  - No-persist behavior is asserted in tests using attendance_days count checks before/after simulation (`tests/rulesets/simulation_no_persist.ps1:L32-L58`, `tests/rulesets/simulation_range_no_persist.ps1:L33-L75`).
- `/api/simulation/run` is a separate simulation endpoint:
  - Reads baseline from `attendance_days` and compares with recomputed outcomes (`api/simulation.routes.js:L35-L46`, `api/simulation.routes.js:L86-L132`).
  - Skips simulation for days with no events (`api/simulation.routes.js:L90-L113`).
  - No write SQL in handler (`api/simulation.routes.js:L25-L189`).

## G) Cache and invalidation

- Cache store is `attendance_days` row keyed by `(company_id, person_id, work_date)` (`api/attendance.routes.js:L262-L274`, `db_schema.sql:L337-L339`).
- Cache validity uses computation signature fields:
  - `use_derived_work_date`, timezone, night-shift flag, day-start (`services/cacheSignature.js:L1-L7`, `services/cacheSignature.js:L10-L19`).
- Cache hit path returns DB-sourced attendance record (`api/attendance.routes.js:L297-L338`).
- Cache miss path recomputes and upserts cache (`api/attendance.routes.js:L346-L377`, `api/attendance.routes.js:L391-L447`).
- Invalidation deletes `attendance_days` for UTC date plus derived work_date (if enabled) (`services/cacheInvalidation.js:L14-L31`, `services/cacheInvalidation.js:L33-L41`).
- Invalidation is invoked from JSON ingest and CSV commit insert success paths (`api/deviceEvents.routes.js:L313-L315`, `api/deviceEvents.routes.js:L866-L869`, `api/deviceEvents.routes.js:L1098-L1101`).

## H) Test harness: existing coverage and gaps

### Runnable harness wiring

- `tests/run-suite.ps1` prepares env, can start server, checks `/api/ops/test/mode`, then executes `tests/run-all.ps1` (`tests/run-suite.ps1:L159-L167`, `tests/run-suite.ps1:L237-L257`, `tests/run-suite.ps1:L260-L264`).
- `tests/run-all.ps1` executes:
  - PowerShell endpoint/integration scripts in `scriptList` (`tests/run-all.ps1:L142-L190`, `tests/run-all.ps1:L239-L246`).
  - Node contract tests via direct `node` execution (`tests/run-all.ps1:L5-L15`, `tests/run-all.ps1:L198-L238`).

### Coverage mapped to flows/endpoints (sample, not exhaustive)

- JSON ingest dedup/idempotency: `tests/device_events/json_ingest_dedup_idempotent.ps1` -> `/api/device-events` (`tests/device_events/json_ingest_dedup_idempotent.ps1:L144-L158`).
- CSV dedup: `tests/csv/csv_dedup.ps1` -> `/api/device-events/import/commit` (`tests/csv/csv_dedup.ps1:L12-L27`).
- Cache behavior: `tests/attendance/cache.ps1` -> `/api/attendance` first engine then db cache (`tests/attendance/cache.ps1:L31-L40`, `tests/attendance/cache.ps1:L52-L71`).
- Anchored invalidation regression: `tests/attendance/cache_invalidation_anchored.ps1` -> ingest + attendance recompute (`tests/attendance/cache_invalidation_anchored.ps1:L22-L40`).
- Simulation no-persist: `tests/rulesets/simulation_no_persist.ps1` + range variant (`tests/rulesets/simulation_no_persist.ps1:L37-L58`, `tests/rulesets/simulation_range_no_persist.ps1:L40-L75`).
- Manual resolution overlay: `tests/attendance/manual_resolution_overlay.ps1` (`tests/attendance/manual_resolution_overlay.ps1:L39-L88`).
- Auth scope/role checks: `tests/auth/*.ps1` (`tests/auth/auth_required.ps1:L35-L47`, `tests/auth/role_enforced.ps1:L42-L47`, `tests/auth/tenant_scope_enforced.ps1:L31-L36`).
- OpenAPI route coverage checks: `tests/contracts/openapi.fullCoverage.test.js` + route inventory (`tests/contracts/openapi.fullCoverage.test.js:L69-L111`, `tests/contracts/openapi.routeInventory.js:L66-L91`).

### Gaps observed in code

- Jest-style unit tests exist (`describe/test/expect`) but are not listed in `run-all.ps1` node invocations; package has no `test` script and no Jest dependency in `package.json` (`tests/run-all.ps1:L198-L238`, `package.json:L6-L8`, `package.json:L22-L24`, `tests/attendance/engine.contract.test.js:L1-L3`).
- Runtime engine in routes is `engine/AttendanceEngine`, but some test suites target `services/attendanceEngine` (different module) (`api/attendance.routes.js:L4-L4`, `tests/attendance/engine.contract.test.js:L1-L1`, `tests/attendance/engine.validation.test.js:L1-L1`).
- Coverage for `/api/simulation/run` is unknown in harness list (route exists, but no explicit run-all script entry references it) (`api/simulation.routes.js:L21-L25`, `tests/run-all.ps1:L142-L190`).

## I) Critical risks (correctness/data integrity first; security last)

1. **Cross-tenant/manual resolution integrity risk (high)**  
   Resolution APIs accept `attendance_day_id` and write/list by that ID without validating that target attendance day belongs to caller company.  
   Evidence: `api/resolutions.routes.js:L58-L88`, `services/policy/manualResolutionService.js:L15-L20`, `services/policy/manualResolutionService.js:L66-L73`.  
   Minimal fix approach: In resolution create/list/get-active paths, join `attendance_days` on `attendance_day_id` and enforce `attendance_days.company_id == req.ctx.company_id` before read/write.

2. **`affects_attendance` is ignored in leave policy (high)**  
   Schema/migration adds `employee_leaves.affects_attendance`, but leave check treats any matching leave row as attendance-affecting.  
   Evidence: `migrations/20260130_employee_leaves_affects_attendance.sql:L3-L8`, `services/policy/policyContextProvider.js:L41-L49`.  
   Minimal fix approach: Add `AND affects_attendance = true` to leave existence query (with backward-compatible column check if needed).

3. **Runtime engine lacks event-sequence validation (high)**  
   Runtime computation uses first IN / last OUT and completeness-only status derivation, with no invalid-sequence checks (OUT-first, non-alternating).  
   Evidence: `engine/TimelineBuilder.js:L3-L21`, `engine/deriveDayStatus.js:L12-L24`, `engine/rules/decision.js:L78-L97`.  
   Minimal fix approach: Add sequence validation stage in runtime engine (or reuse validated sequence utility) and emit `INVALID` with explicit flags when violated.

4. **CSV preview/commit mismatch for direction handling (medium-high)**  
   `generic_punchlog` parser can mark rows valid when direction is missing (maps to `null`), but commit path rejects direction not IN/OUT during canonical validation.  
   Evidence: `adapters/vendors/generic_punchlog/index.js:L250-L271`, `api/deviceEvents.routes.js:L999-L1018`, `services/validators/deviceEventValidator.js:L29-L31`.  
   Minimal fix approach: Align preview validity with commit rules (either require direction in adapter or downgrade such preview rows to invalid with explicit error).

5. **Nullable `device_events.direction` weakens ingestion/data guarantees (medium)**  
   DB schema allows `direction` null; runtime engine only considers IN/OUT events, so null-direction rows silently drop from timeline outcomes.  
   Evidence: `db_schema.sql:L156-L164`, `engine/TimelineBuilder.js:L3-L5`.  
   Minimal fix approach: Make `device_events.direction` `NOT NULL` at schema level and backfill/clean existing null rows before enforcing.

Additional security observation (not in top 5 correctness): several business routes have no auth middleware (`company-profile`, `devices`, `employee-assignments`, `simulate`, `simulation`) (`api/companyProfile.routes.js:L66-L84`, `api/devices.routes.js:L40-L125`, `api/employeeAssignments.routes.js:L88-L126`, `api/simulate.routes.js:L192-L417`, `api/simulation.routes.js:L25-L25`).

## J) Definition of Done checklist for “reviewed” (code-only)

- [x] Server startup + middleware + route mounting mapped from code (`server.js:L10-L12`, `server.js:L30-L49`, `server.js:L65-L75`).
- [x] Data contracts extracted from SQL schema/migrations with explicit constraints (`db_schema.sql:L337-L339`, `db_schema.sql:L385-L387`, `db_schema.sql:L594-L596`).
- [x] Ingestion contracts and idempotency behavior traced from handlers/parsers (`api/deviceEvents.routes.js:L146-L324`, `api/deviceEvents.routes.js:L623-L1172`, `services/deviceEventsCsvValidator.js:L174-L180`).
- [x] Attendance/simulation/cache behaviors traced from runtime code paths (`api/attendance.routes.js:L262-L447`, `api/simulate.routes.js:L192-L659`, `services/cacheInvalidation.js:L33-L41`).
- [x] Test harness inventory mapped from executable scripts (`tests/run-suite.ps1:L260-L264`, `tests/run-all.ps1:L142-L249`).
- [x] Risks listed with evidence and minimal remediation directions (Section I).
- [ ] Unknowns explicitly called out where evidence is missing:
  - Full helper side effects for all imported modules not exhaustively proven beyond inspected files (no global static call graph available from inspected code alone).
