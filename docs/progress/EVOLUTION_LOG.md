# Evolution Log

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
- Added OpenAPI skeleton, lint rules, and contract lint test:
  - `openapi/openapi.yaml`
  - `.spectral.yaml`
  - `tests/contracts/openapi.lint.test.js`
  - `docs/adr/ADR-openapi-skeleton.md`
- Tuned Spectral rules to reduce warning noise while keeping drift checks (operation IDs, unused components).

### Invariants confirmed/added
- Env booleans are interpreted only via `services/envBool.toBool()`.
- Preview responses maintain stable shape and counts.
- Identity mappings require an existing employee when registry is enabled.
- OpenAPI spec (skeleton) is linted to prevent contract drift.

### Test evidence
- `tests/run-all.ps1` PASS after fixes.
