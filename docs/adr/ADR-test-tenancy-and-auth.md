# ADR: Test Tenancy And Auth

Date: 2026-03-02

## Context

The test harness must run deterministically with `REQUIRE_AUTH=0` and `REQUIRE_AUTH=1`.
When auth is enabled, API keys are company-scoped and role-scoped, so hardcoded `company_id=DEFAULT` breaks tests when seeded demo keys are scoped to `DEMO`.

## Decision

- Test tenancy is env-driven: use `COMPANY_ID`, defaulting to `DEFAULT` only when unset.
- Contract tests and PowerShell test scripts must not hardcode `DEFAULT` except in explicit mismatch scenarios.
- Operator endpoints use `TEST_API_KEY_OPERATOR` (fallback `API_KEY`).
- Admin `/api/ops/test/*` endpoints use `TEST_API_KEY_ADMIN` (fallback `API_KEY`).
- Mismatch assertions are auth-aware:
  - `REQUIRE_AUTH=0`: validation error expectations
  - `REQUIRE_AUTH=1`: authz `company_mismatch` expectations when scope rejects earlier

## Consequences

- CI must seed `DEMO`, `demo-operator-key`, and `demo-admin-key`.
- Local deterministic auth runs must set:
  - `COMPANY_ID=DEMO`
  - `TEST_API_KEY_OPERATOR=demo-operator-key`
  - `TEST_API_KEY_ADMIN=demo-admin-key`
