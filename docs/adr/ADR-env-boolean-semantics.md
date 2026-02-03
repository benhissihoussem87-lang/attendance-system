# Env Boolean Semantics

Status: Accepted
Date: 2026-01-29

## Context
We observed inconsistent behavior across environments when parsing boolean environment variables.
For example, `/api/ops/test/mode` reported `allow_test_endpoints=true` while request enforcement
and identity-mapping gates behaved as if disabled. The root cause was divergent parsing logic
(`=== '1'` in some places, `=== 'true'` in others), which created mismatches between what the
system reported and what it enforced.

## Decision
Boolean environment values must be parsed using a single, shared helper:
`services/envBool.toBool()`.

Truthiness rules are:
- **Truthy**: string values that, after `trim().toLowerCase()`, equal `"1"` or `"true"`.
- **Falsey**: unset, empty, `"0"`, `"false"`, or any other value.

## Implementation
- All runtime code MUST call `services/envBool.toBool()` when interpreting env booleans.
- Do not add local parsers or helpers for env boolean checks.
- Do not use strict comparisons like `process.env.X === '1'` or `=== 'true'` to express
  boolean semantics.

## Consequences
- Stable, predictable behavior across Windows/Linux shells and `.env` files.
- Reduced debugging loops caused by "mode says enabled, enforcement says disabled" mismatches.
- More consistent CI and local test runs.

## Examples
- `toBool('1')` => `true`
- `toBool('true')` => `true`
- `toBool('0')` => `false`
- `toBool(undefined)` => `false`
