# Device Registry

Status: Accepted
Date: 2026-01-29

## Context
Multi-device deployments require a stable device identity surface. We need consistent
device_uid semantics, vendor/provider metadata, and a place to evolve device records
for future integrations and diagnostics.

## Decision
Create a contract-first Device Registry surface in OpenAPI and evolve it incrementally
with tests.

## Invariants
- device_uid is a stable, opaque identifier (string) scoped by company_id.
- Device records are facts about devices (metadata), not attendance policy.
- Device Registry is multi-tenant: company_id (query) and x-company-id (header) are supported.

## Consequences
Enables device onboarding, diagnostics, and future ERP/integration mapping without
breaking changes.
