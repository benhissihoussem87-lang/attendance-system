# Evolution Log

## 2026-01-30

### Changes
- Added deterministic test server runner: `scripts/run-test-server.ps1`.
- Hardened `tests/run-all.ps1` with server-mode gating and a clearer ZKTECO env warning.
- Expanded OpenAPI docs for ops health/ready.
- Made OpenAPI coverage robust to Windows CRLF.
- Added OpenAPI endpoint inventory generator and report artifacts.
- Ignored the generated endpoint inventory JSON to avoid timestamp-only churn; documented inventory/report expectations.
- Rolling out ErrorEnvelope gradually; 4xx errors require details.kind and endpoints migrate one-by-one.

## 2026-01-29

### Goals
- Standardize environment boolean semantics across the codebase.
- Document preview output contract and add a contract test.
- Align contract test with employee existence invariant for identity mappings.
- Introduce an OpenAPI skeleton and lint gate.

### Changes
- Adopted `services/envBool.toBool()` as the single source of truth for env booleans.
- Added ADR and audit:
  - `docs/adr/ADR-env-boolean-semantics.md`
  - `docs/audit/env-boolean-audit.md`
- Added preview output contract and test:
  - `docs/contracts/preview-output-contract.md`
  - `tests/contracts/previewOutput.contract.test.js`
- Updated contract test to upsert employee before identity mapping to avoid `employee_not_found`.
- Added OpenAPI skeleton, lint rules, and contract lint tests:
  - `openapi/openapi.yaml`
  - `.spectral.yaml`
  - `tests/contracts/openapi.lint.test.js`
  - `tests/contracts/openapi.coverage.test.js`
  - `docs/adr/ADR-openapi-skeleton.md`
  - `docs/adr/ADR-contract-driven-openapi.md`
- Added Device Registry contract-first skeleton (ADR, OpenAPI paths/schemas, offline coverage test).
- Tuned Spectral rules to reduce warning noise while keeping drift checks (operation IDs, unused components).

### Invariants confirmed/added
- Env booleans are interpreted only via `services/envBool.toBool()`.
- Preview responses maintain stable shape and counts.
- Identity mappings require an existing employee when registry is enabled.
- OpenAPI spec (skeleton) is linted to prevent contract drift.

### Test evidence
- `tests/run-all.ps1` PASS after fixes.
