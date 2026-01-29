# Preview Output Contract

Date: 2026-01-29
Status: Draft (to be kept in sync with server outputs)

## Endpoints
- `POST /api/device-events/import/preview`
  - CSV preview (no DB writes). Returns normalized rows, counts, and errors.
- `POST /api/device-events/import/preview/export-errors.csv`
  - CSV export of preview errors (non-JSON). Out of scope for JSON contract assertions.
- `GET /api/ops/test/mode`
  - Environment mode snapshot (used by tests to decide expectations).

## Response: `/api/device-events/import/preview`

### Top-level fields
Required:
- `system_version` (string)
- `contract` (string)
- `import_version` (string)
- `total_rows` (number)
- `valid_rows` (number)
- `invalid_rows` (number)
- `errors` (array of error objects)
- `sample_valid_rows` (array of sample rows)
- `sample_rows` (array of sample rows; alias of `sample_valid_rows` for backward compatibility)

Optional:
- `error_intelligence` (object; human/UX hints, may evolve)
- `sample_invalid_rows` (array of sample rows; not always present)

### Error object
Required fields:
- `code` (string)
- `message` (string)

Optional fields:
- `row_number` (number, 1-based; present when error is tied to a specific row)

### Sample row object
Required fields:
- `row_number` (number, 1-based)
- `data` (object, normalized row payload)

### Row data fields (when present)
Normalization is vendor-dependent. The following keys are expected when identity mapping is enabled:
- `resolved_person_id` (string)
- `identity_mapping_applied` (boolean)
- `identity_mapping_reason` (string; e.g., `mapped`, `missing`, `disabled`)

Vendor/provider identity fields (when present):
- `vendor` (string)
- `provider` (string)
- `device_uid` (string)

Raw payload identity audit (when present):
- `raw_payload.identity.provider` (string)
- `raw_payload.identity.identifier_type` (string)
- `raw_payload.identity.identifier_value` (string)
- `raw_payload.identity.mapping_applied` (boolean)

## Response: `/api/ops/test/mode`
Required fields:
- `allow_test_endpoints` (boolean)
- `use_identity_mappings` (boolean)
- `require_identity_mappings` (boolean)
- `identity_mapping_policy` (string)
- `use_employees_registry` (boolean)
- `use_employee_assignments` (boolean)

## Invariants
- `valid_rows + invalid_rows == total_rows`.
- `errors` must be empty when `invalid_rows == 0`.
- When `REQUIRE_IDENTITY_MAPPINGS` is enabled and policy requires mapping,
  rows missing mappings must be marked invalid with `identity_mapping_missing`.
- `sample_rows` is present and mirrors `sample_valid_rows` when valid rows exist.

## Preconditions
- When creating identity mappings, the referenced employee (`person_id`) must already exist
  in the employees registry/employees table; otherwise the API returns `employee_not_found` (400).

## Notes
- `sample_rows` exists for backward compatibility with clients that used the older
  `sample_rows` name. New clients should prefer `sample_valid_rows`.
