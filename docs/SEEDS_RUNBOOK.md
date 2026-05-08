# Seeds Runbook

## Purpose

Seeds are environment-scoped data bootstrap scripts, separate from migrations.

- Migrations: schema and mandatory reference data.
- Seeds: optional data for specific runtime profiles (dev/ci/prod).

## Seed Profiles

- `dev`
  - Applies `seeds/001_base.sql`
  - Does not include demo tenant/key data
- `ci`
  - Applies `seeds/001_base.sql`
  - Applies `seeds/010_demo_ci.sql` (creates `DEMO` company, `demo-operator-key`, and `demo-admin-key`)
- `prod`
  - Applies `seeds/001_base.sql` only

## Files

- `seeds/001_base.sql`
- `seeds/010_demo_ci.sql`
- `scripts/db/apply-seeds.ps1`

## How CI Uses Seeds

`tests/run-suite.ps1` applies seeds before server startup and before running tests.

- If CI is detected (`CI=true/1` or `GITHUB_RUN_ID` is set) and `SEED_PROFILE` is unset, it defaults to `ci`.
- It then runs:
  - `scripts/db/apply-seeds.ps1 -Profile <SEED_PROFILE>`

## Test-Safe Server

- `npm start` runs the normal server (no test endpoints).
- `pwsh -NoProfile -File .\scripts\run-test-server.ps1` starts the test-safe server for `/api/ops/test/mode` and `ALLOW_TEST_ENDPOINTS`.
- `pwsh -NoProfile -File .\tests\run-suite.ps1` runs the deterministic test suite flow.

## Existing Server Safety Guard

When running `tests/run-suite.ps1 -UseExistingServer`:

- If `SEED_PROFILE` is not explicitly set by the caller, seeds are skipped with a warning.
- This avoids seeding against an unknown existing server/database pairing.
- To opt in, set `SEED_PROFILE` explicitly (`dev`, `ci`, or `prod`) before running.

Examples:

- Seeds skipped:
  - `pwsh -NoProfile -File .\tests\run-suite.ps1 -UseExistingServer`
- Seeds applied (explicit opt-in):
  - `$env:SEED_PROFILE='dev' ; pwsh -NoProfile -File .\tests\run-suite.ps1 -UseExistingServer`

CI remains deterministic: CI runs always apply seeds, defaulting to `SEED_PROFILE=ci` when unset.

## Local Usage

1. Load DB env vars (optional if already set):
   - `.\scripts\db\load-env.ps1`
2. Apply seeds:
   - Dev profile: `pwsh -NoProfile -File .\scripts\db\apply-seeds.ps1 -Profile dev`
   - CI profile: `pwsh -NoProfile -File .\scripts\db\apply-seeds.ps1 -Profile ci`
   - Prod profile: `pwsh -NoProfile -File .\scripts\db\apply-seeds.ps1 -Profile prod`
3. Auth mode example (`REQUIRE_AUTH=1`):
   - `$env:REQUIRE_AUTH='1'`
   - `$env:COMPANY_ID='DEMO'`
   - `$env:TEST_API_KEY_OPERATOR='demo-operator-key'`
   - `$env:TEST_API_KEY_ADMIN='demo-admin-key'`
   - `/api/ops/test/mode` requires an admin key when `REQUIRE_AUTH=1`.
   - `pwsh -NoProfile -File .\tests\run-suite.ps1`

## Notes

- Seed scripts are idempotent and safe to run repeatedly.
- `apply-seeds.ps1` fails fast if:
  - `psql` is not available in `PATH`
  - required DB env vars (`PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`) are missing.
