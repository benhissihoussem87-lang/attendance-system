# OpenAPI Workflow

## Coverage test (Windows CRLF)
`tests/contracts/openapi.coverage.test.js` normalizes CRLF to LF before scanning path blocks so
OpenAPI checks remain reliable on Windows.

Run directly:
- `node .\tests\contracts\openapi.coverage.test.js`

## Endpoint inventory
When routes change, regenerate the inventory to spot spec drift:
- `node .\scripts\build-endpoint-inventory.js`
- `node .\tests\contracts\openapi.inventoryFreshness.test.js`

Artifacts:
- `docs/openapi/endpoint-inventory.json` (generated locally/CI; not committed because it includes a timestamp)
- `docs/openapi/endpoint-inventory-report.md` (committed; use this to review drift findings)

CI expectation:
- `docs/openapi/endpoint-inventory-report.md` must already be fresh in git.
- Freshness test fails if regeneration changes the committed report.

Expectation:
- `openapi/openapi.yaml` should contain a path block with an `operationId` for each route implemented under `api/*.routes.js`.
