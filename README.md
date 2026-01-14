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

Quick smoke tests (PowerShell)
- `Invoke-RestMethod http://localhost:3000/api/ops/health`
- `Invoke-RestMethod http://localhost:3000/api/ops/ready`
- `Invoke-RestMethod "http://localhost:3000/api/attendance?date=YYYY-MM-DD"`

Feature flags (keep off in production by default)
- USE_COMPANY_CONFIG_DB
- ENABLE_DAY_BOUNDARY_DEBUG
- USE_DERIVED_WORK_DATE
- ENABLE_CSV_TIME_INTERPRETATION

Required DB tables
- device_events
- attendance_days

Dedup constraint
- device_events must have unique constraint named `ux_device_events_dedup`

Device UID hardening migration
- Apply: `psql -d <db> -f migrations/20260114_device_uid_hardening.sql`
- Follow-up after cleanup: `ALTER TABLE device_events VALIDATE CONSTRAINT device_events_device_uid_nonempty;`

Companies registry migration
- Apply: `psql -U postgres -d attendance -f .\migrations\20260114_companies_registry.sql`
- Verify: `SELECT * FROM companies ORDER BY company_id;`
