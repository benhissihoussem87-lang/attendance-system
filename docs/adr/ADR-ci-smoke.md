# CI Smoke Workflow Split

Status: Accepted
Date: 2026-02-03

## Context
Windows CI runs were slow and flaky when trying to provision Postgres locally or via Docker.
GitHub-hosted Windows runners also face Linux container limitations, which made the
integration-style smoke job unreliable.

## Decision
`linux-smoke` remains the integration truth (Postgres + migrations + run-suite).
`windows-smoke` is a fast, non-integration job focused on quick checks only.

## Implementation
- Runner pin: `linux-smoke` uses `ubuntu-24.04`.
- Dependency install: `actions/setup-node` enables npm cache and CI enforces `npm ci`.
- Lockfile requirement: CI fails fast if `package-lock.json` is missing.
- Diagnostics: debug logs run always; logs are uploaded on failure where applicable.

## Alternatives considered
- Run Postgres via Docker in `windows-smoke` (failed due to manifest and Linux engine limits).
- Install Postgres via Chocolatey (too slow and unreliable for CI).

## Consequences / Follow-ups
- `linux-smoke` must stay green to merge.
- Keep `package-lock.json` committed and up to date.
