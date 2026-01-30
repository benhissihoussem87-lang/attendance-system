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

PowerShell start
- `$env:PGHOST="localhost"; $env:PGUSER="postgres"; $env:PGDATABASE="attendance"; node .\\server.js`
- `npm start`

DB schema dump (PowerShell)
- `.\scripts\db\dump-schema.ps1`
- `db_schema.sql` is generated and not committed.

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
  - `docs/openapi/endpoint-inventory.json` (current count: 39 endpoints)
  - `docs/openapi/endpoint-inventory-report.md`
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

Required DB tables
- device_events
- attendance_days

Dedup constraint
- device_events must have unique constraint named `device_events_dedup_company_uk`

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
