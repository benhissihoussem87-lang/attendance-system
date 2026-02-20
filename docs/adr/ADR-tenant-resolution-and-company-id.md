# ADR: Tenant Resolution and company_id Source of Truth

## Status
Accepted

## Context
- The system is multi-tenant and all tenant-scoped operations are bounded by `company_id`.
- Ingestion can arrive from many vendors/devices and CSV formats; CSV payloads may not include `company_id`.
- Security and correctness require deterministic tenant resolution per request.

## Decision
- `company_id` MUST be determined from a trusted ingestion channel.
  - Preferred: authenticated context (API key / credential claims).
  - Fallback for non-auth mode: explicit request scoping (query param or header, based on endpoint contract).
- CSV-provided `company_id` MUST NOT be treated as authoritative by default.
- Any row-level inference (including mixed-company detection) is diagnostic/validation only and MUST NOT override request-scoped tenant context.
- Mixed-tenant ingestion MUST be rejected to prevent cross-tenant data leakage.

## Allowed Tenant-Resolution Sources (Best to Fallback)
1. Auth context (API key / claims)
2. Explicit request scoping (`company_id` query param or `x-company-id` header, depending on endpoint)
3. Device registry mapping (`device_uid -> company_id`) as a future hardening option
4. Row inference only as validation (never primary authority)

## Consequences
- Clear trust boundaries between transport/auth context and payload content.
- Safer defaults with lower data-poisoning and cross-tenant leakage risk.
- Better long-term stability across many vendors/devices and mixed ingestion formats.

## Notes
- Development and test flows currently use query `company_id` widely for tenant scoping.
- Future direction: enforce `REQUIRE_AUTH` in production and reduce/remove reliance on query-scoped tenant resolution.
