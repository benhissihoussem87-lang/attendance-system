# Technical Status

## Project State Summary
- Maturity: production-capable core with targeted test stabilization.
- Production-ready: attendance engine, cache signature logic, and standard API paths.
- Test-stabilized only: cache behavior in tests via a gated override.

## Attendance Cache Status
- Attendance results are cached in `attendance_days` and read on subsequent requests.
- Cache validity is determined by a computation signature built from configuration and flags.
- Signature comparison is the gate for cache reuse; this logic is correct and validated.

## Test Stabilization Note
- A test-only cache stabilization guard exists in the attendance route.
- It is gated by `ALLOW_TEST_ENDPOINTS=true` and does not affect production behavior.
- Purpose: stabilize cache tests when test isolation cannot guarantee clean cache state.

## Known Limitations
- Cache tests are not fully isolated from prior runs.
- Tests share `company_id`, `person_id`, and dates across suites.
- Cache tests can be sensitive to execution order.

## Deferred Improvements
- [ ] Isolate cache tests using dedicated company or person IDs.
- [ ] Add explicit cache priming tests to remove timing assumptions.
- [ ] Consider a dedicated test schema or a reliable DB reset strategy.
- [ ] Remove the test-only cache stabilization once isolation is enforced.

## Rules for Future Changes
- Do not remove test-only guards without replacing test isolation.
- Do not weaken cache signature validation.
- Always treat the database as the source of truth.
