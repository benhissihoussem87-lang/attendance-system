# Contract-Driven OpenAPI Coverage

Status: Accepted
Date: 2026-01-29

## Context
The OpenAPI spec is at risk of drifting from the actual HTTP surface area because it
is easy to change code without updating the spec. We need a lightweight guardrail that
keeps the core paths aligned with reality while the spec evolves.

## Decision
Enforce minimal OpenAPI coverage via a contract test that asserts the presence of
core routes and operation IDs. The test reads the OpenAPI YAML as text to remain
offline, deterministic, and dependency-free.

## Consequences
- The spec stays aligned with core routes relied upon by tests.
- Coverage can grow incrementally without blocking future expansion.
