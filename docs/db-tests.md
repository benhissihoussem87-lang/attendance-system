# DB Smoke Tests

These two tests are skipped unless PG env vars are set:
- `tests/contracts/db.devicesTable.smoke.test.js`
- `tests/device_events/device_autoregister_from_ingest.test.js`

Quick setup:
1) Ensure Postgres is running and reachable.
2) Copy `.env.example` to `.env` and edit the PG* values.
3) Dot-source the loader to set env vars in the current shell:
   - `. .\scripts\db\load-env.ps1`
4) Run tests:
   - `.\tests\run-all.ps1`
   - or run the specific DB tests above.
