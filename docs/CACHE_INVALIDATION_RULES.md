Cache Invalidation Rules

Purpose
Define cache safety guarantees for attendance_days.

What attendance_days Represents
- Stored attendance results for a person_id and work_date.
- Represents a previously computed engine output.

When Cache Is Reused
- When attendance_days has a record for the requested person_id and work_date.
- The cached record is returned without recomputation.

When Cache Must Be Invalidated
- When device events are inserted or changed for the affected person_id and time range.
- When attendance is recomputed and a new result is persisted.

What Events Invalidate Cache
- Device event inserts for a person_id that could change that person's work_date.
- Any explicit cache invalidation hook invoked by the system.

What Does NOT Invalidate Cache
- Read-only requests with no data changes.
- Operations unrelated to attendance_days or device_events.

Explicit Rules
- Cache never changes business logic.
- Cache never decides correctness.
- Cache is disposable.
