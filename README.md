Attendance System (Node.js + Express + PostgreSQL)

Setup
- npm install
- Copy `.env.example` to `.env` and update values for your database
- npm start

Required environment variables
- PGHOST
- PGUSER
- PGDATABASE
- PGPORT (optional, default 5432)
- PGPASSWORD (optional)
- PORT (optional, default 3000)

Local workflows

Bridge operations runbook
- `docs/BRIDGE_OPERATIONS_RUNBOOK.md`

Active roadmap: Device Lifecycle Coherence V2
- Problem: K80 real-device probe/runtime protocol path is proven, but that probe success is not yet equivalent to canonical managed operational onboarding in SaaS `/boss` lifecycle surfaces.
- Operational rule: probe success != managed lifecycle completion. Canonical onboarding requires coherent discovery/candidate/claim/managed/linkage/sync/batch visibility.
- Phases:
  - Phase 0: runtime evidence gathering + exact lifecycle break-point confirmation.
  - Phase 1: lifecycle/identity/binding/visibility contract codification.
  - Phase 2: minimal persistence/linkage foundation.
  - Phase 3: `/boss` operational coherence.
  - Phase 4: hardening/tests/contracts.
  - Phase 5: long-term cleanup + migration guardrails.
- Current execution focus for this track: Phase 5 long-term cleanup + migration guardrails.

Active architecture direction (next): Manual Device Onboarding + Agent Validation (Site Agent Model)
- SaaS operations UI direction: evolve `/boss` into the real product operations surface (not a throwaway console).
- Control-plane rule: SaaS UI is primary; any future Local Agent UI is secondary local diagnostics/support only.
- Discovery remains useful helper evidence, but not reliable primary onboarding truth for all real devices/firmware paths.
- One Local Agent per site/network remains the primary model.
- One site agent may manage multiple biometric devices in the same LAN/site.
- Manual per-device onboarding is first-class and must capture explicit connection metadata (provider/vendor, host/IP, port, auth/communication key, machine/device number, transport, protocol/profile/attlog sequence, optional model/firmware/label/notes).
- Device readiness/actionability must be proven by successful agent-side validation per device.
- Local Agent runtime defaults:
  - Windows/Windows Server: Windows Service
  - Linux: systemd service
  - Docker: optional/advanced only (not default)
- Planned phases:
  - Phase A: onboarding contract + per-device field model
  - Phase B: agent-side per-device validation flow
  - Phase C: operator onboarding/validation UX
  - Phase D: local agent operating-model hardening
  - Phase E: multi-device per-site operationalization

Active architecture direction (next): Control Plane & Site Runtime Architecture
- SaaS remains the primary and authoritative control plane for inventory, desired configuration, bindings, command ledger, lifecycle audit/history, and version policy.
- Local Agent remains the site runtime/execution plane (reports local/runtime truth and executes LAN operations) and is not the authoritative source of control-plane intent.
- Site is being formalized as a first-class operating entity with one active agent via explicit lease/ownership semantics; one site agent may manage multiple devices.
- Planned phases:
  - Architecture Phase 1: Site as first-class SaaS entity
  - Architecture Phase 2: Site Agent Lease / active runtime ownership
  - Architecture Phase 3: desired-state vs reported-state model
  - Architecture Phase 4: durable agent identity hardening
  - Architecture Phase 5: offline buffer / command truth hardening
  - Architecture Phase 6: version governance / rollout compatibility
- Current execution focus for this track: Architecture Phase 6 foundational governance truth (reported runtime version + minimum/target compatibility policy), without rollout/package automation yet.

Quickstart (development)
- Install dependencies:
  - `npm install`
- Start the server:
  - `npm start`
- Note: some behavior depends on env captured at server startup. For test-safe runs, use `.\scripts\run-test-server.ps1`.

DB smoke tests (Postgres-dependent tests)
- These DB smoke tests are skipped unless PG env vars are set.
- Details: `docs/db-tests.md`
- Minimal setup and run:
  - `Copy-Item .env.example .env`
  - `. .\scripts\db\load-env.ps1`
  - `.\tests\run-all.ps1`

Full test suite (canonical)
- `.\tests\run-all.ps1` is the canonical test runner.
- Recommended local flow:
  - `.\tests\run-suite.ps1` (deterministic local entrypoint)
    - Starts a test-safe server unless `-NoServer`
    - Loads PG env via `.\scripts\db\load-env.ps1` by default
    - Refuses to run if a server is already listening unless `-UseExistingServer`
  - or, if you want to manage the server yourself:
  - `.\scripts\run-test-server.ps1`
  - `.\tests\run-all.ps1`
- If you change env vars affecting server mode (e.g., `ZKTECO_CHECKTYPE_MAP`), restart the server.
- More details: `docs/TESTING.md`

Advanced: one-shot bootstrap (smoke.ps1)
- `.\smoke.ps1` is a local convenience helper (not the canonical CI entrypoint).
- It drops/creates the DB (unless `-SkipDrop`), applies migrations, checks invariants, optionally auto-starts the server, then runs `.\tests\run-all.ps1` and cleans up env/server state.
- Examples:
  - `.\smoke.ps1`
  - `.\smoke.ps1 -DbName attendance_tmp -SkipDrop`
  - `.\smoke.ps1 -AutoStartServer:$false`

PowerShell start
- `$env:PGHOST="localhost"; $env:PGUSER="postgres"; $env:PGDATABASE="attendance"; node .\\server.js`
- `npm start`

DB schema dump (PowerShell)
- `.\scripts\db\dump-schema.ps1`
- `db_schema.sql` is a local snapshot helper (git-ignored).
- Canonical schema truth is migration files under `migrations/` plus `tests/contracts/db.coreConstraints.contract.test.js`.

Quick smoke tests (PowerShell)
- `Invoke-RestMethod http://localhost:3000/api/ops/health`
- `Invoke-RestMethod http://localhost:3000/api/ops/ready`
- `Invoke-RestMethod "http://localhost:3000/api/attendance?date=YYYY-MM-DD"`

Testing (PowerShell, deterministic local workflow)
- Start a test-safe server (env captured at startup):
  - `.\scripts\run-test-server.ps1`
- Run the full suite:
  - `.\tests\run-all.ps1`
- If run-all fails on server mode mismatch:
  - Restart the server with `.\scripts\run-test-server.ps1`
  - Or set `ALLOW_SERVER_MODE_MISMATCH=true` for local debugging
- Note: if you set `ZKTECO_CHECKTYPE_MAP` after the server starts, it will not apply until a restart.
- More details: `docs/TESTING.md`

OpenAPI coverage (Windows/CRLF)
- The coverage test normalizes CRLF to LF so path blocks are detected reliably on Windows.
- Run it directly:
  - `node .\tests\contracts\openapi.coverage.test.js`

OpenAPI maintenance
- Build the endpoint inventory and report after route changes:
  - `node .\scripts\build-endpoint-inventory.js`
- Outputs:
  - `docs/openapi/endpoint-inventory.json` (generated local/CI artifact, git-ignored)
  - `docs/openapi/endpoint-inventory-report.md`
- Freshness check (fails if report is stale):
  - `node .\tests\contracts\openapi.inventoryFreshness.test.js`
- Expectation: `openapi/openapi.yaml` has a path + operationId for each implemented route.
- More details: `docs/openapi/WORKFLOW.md`

Recommended workflow (senior)
- Batch related changes, update docs/specs once, run tests, then push.
- Avoid pushing every tiny step; keep PRs/commits coherent.

Feature flags (keep off in production by default)
- USE_COMPANY_CONFIG_DB
- ENABLE_DAY_BOUNDARY_DEBUG
- USE_DERIVED_WORK_DATE
- ENABLE_CSV_TIME_INTERPRETATION

Device event dedup surfaces
- `device_events_dedup_company_uk` unique constraint must exist.
- `device_events_dedup_key_company_uk` partial unique index (`dedup_key IS NOT NULL`) must exist.

Device UID hardening migration
- Apply: `psql -d <db> -f migrations/20260114_device_uid_hardening.sql`
- Follow-up after cleanup: `ALTER TABLE device_events VALIDATE CONSTRAINT device_events_device_uid_nonempty;`

Companies registry migration
- Apply: `psql -U postgres -d attendance -f .\migrations\20260114_companies_registry.sql`
- Verify: `SELECT * FROM companies ORDER BY company_id;`

Policy layer schema migration
- Apply: `psql -U postgres -d attendance -f .\migrations\20260115_policy_layer_schema.sql`

Tenant scope migration
- Apply: `psql -U postgres -d attendance -f .\migrations\20260116_tenant_scope_core_tables.sql`
- Note: company_id defaults to DEFAULT when omitted
