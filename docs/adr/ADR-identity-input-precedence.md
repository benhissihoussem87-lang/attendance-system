# ADR — Identity Inputs: provider vs vendor precedence (JSON ingestion)

## Context
Identity mappings resolve person_id using keys: (company_id, provider, identifier_type, identifier_value).

## Decision (Contract)
1) For JSON ingestion (POST /api/device-events):
   - If `provider` is provided (non-empty string), it is used for identity mapping resolution.
   - Else, if `vendor` is provided (non-empty string), it is used as the fallback provider.
   - Else, provider defaults to "generic".
2) Normalization:
   - provider: trim + lowercase
   - identifier_type: trim + lowercase
   - identifier_value: trim (case-preserving)

## Rationale
- provider is explicit and stable for SDK/gateway integrations
- vendor can be missing/label-like and should not override an explicit provider
- ensures deterministic behavior and prevents accidental mismaps

## Consequences
- clients may send both; provider wins
- tests enforce this contract
