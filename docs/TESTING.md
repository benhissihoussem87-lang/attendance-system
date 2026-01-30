# Testing (Windows-first workflow)

## Deterministic local run
- Server environment is captured at **startup**, not when `run-all.ps1` executes.
- Recommended flow:
  1) Start the test-safe server:
     - `.\scripts\run-test-server.ps1`
  2) Run the suite:
     - `.\tests\run-all.ps1`

## Server mode guard
- `tests/run-all.ps1` reads `GET /api/ops/test/mode` before contract tests.
- If the mode does not match **expected** values, the run fails early.
- Fix by restarting the server using `.\scripts\run-test-server.ps1`.
- For local debugging only:
  - `ALLOW_SERVER_MODE_MISMATCH=true`

## ZKTECO_CHECKTYPE_MAP note
- If `ZKTECO_CHECKTYPE_MAP` is set **after** the server starts, it will not affect the running server.
- Restart the server to apply changes.
