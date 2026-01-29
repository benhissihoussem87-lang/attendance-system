# OpenAPI Skeleton

Status: Accepted
Date: 2026-01-29

## Context
We need a stable, shareable HTTP contract for ERP integrations, multi-device expansion,
and external tooling. Documentation alone is not enough; we need a spec that can be linted
and evolved in lock-step with implementation.

## Decision
Adopt an OpenAPI 3.1 skeleton as the source of truth for HTTP contracts.
The skeleton focuses on core endpoints and schemas, is multi-tenant aware via `company_id`,
and is kept minimal to reduce maintenance overhead.

## Consequences
- Easier integration planning and client onboarding.
- A lint gate to catch accidental contract drift.
- A foundation for future client generation and API coverage expansion.
