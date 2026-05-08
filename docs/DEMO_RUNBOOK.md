# Demo Runbook

## Scope
API-only demo and golden-path contract test.

## Harness Path Used by CI
- Workflow: `.github/workflows/ci-smoke.yml`
- Linux smoke job runs:
  - `pwsh -NoProfile -File ./tests/run-suite.ps1 ...`
- `tests/run-suite.ps1` invokes `tests/run-all.ps1`.
- `tests/run-all.ps1` includes:
  - `Run-NodeTest 'contracts\demo_golden_path.contract.test.js'`

## Required Environment Variables
- `BASE_URL` (optional)
  - Default: `http://localhost:3000`
- `COMPANY_ID` (optional)
  - Demo script default: `DEMO`
  - Contract test default: `DEFAULT`
- `REQUIRE_AUTH` (optional)
  - `1/true` enables API key requirement
- API key (required when `REQUIRE_AUTH=1`)
  - Preferred: `API_KEY`
  - Also accepted by demo script/contract test: `TEST_API_KEY_OPERATOR`
  - Fallback accepted by demo script/contract test: `TEST_API_KEY_ADMIN`

## Commands
1. Start server:
```powershell
npm start
```
- `pwsh -NoProfile -File .\scripts\run-test-server.ps1`
- Use this when you need `/api/ops/test/mode` and `ALLOW_TEST_ENDPOINTS` behavior (instead of `npm start`).

2. Run API demo script:
```powershell
pwsh -NoProfile -File ./scripts/demo/run-demo.ps1
```

3. Run demo golden-path contract test:
```powershell
node ./tests/contracts/demo_golden_path.contract.test.js
```

## What Success Looks Like
- Demo script prints:
  - `DEMO PASS`
  - Attendance summary table with 3 rows (last 3 days).
- Contract test prints:
  - `demo golden path contract test passed`
