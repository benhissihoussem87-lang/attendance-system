Day Boundary Policy — Version 1

1. Purpose
Defining the day boundary is critical for correct attendance computation,
reporting, caching, and simulation because it determines which events belong
to a work date.

2. Relationship to Time Policy
- This policy builds on TIME_POLICY.md.
- All day boundaries are evaluated in Company Timezone.
- UTC is used only for storage and computation, not for defining the day.

3. Default Behavior (No Night Shift)
- Night shift is disabled by default.
- A day is a calendar day in Company Timezone.
- Day start: 00:00
- Day end: 23:59:59
- Suitable for most office-based companies.

4. Night Shift Enabled (Optional)
- Night shift must be explicitly enabled by the company.
- When enabled, the day uses an anchored start time.
- Example default anchored start time: 04:00 (Company Timezone).
- Any event occurring before the anchored start time belongs to the previous work day.

5. Configuration Concept (Design Only)
{
  "company_timezone": "Africa/Tunis",
  "night_shift_enabled": false,
  "day_start_time": "04:00"
}

Rules:
- If night_shift_enabled = false → day_start_time is ignored.
- If night_shift_enabled = true → day_start_time is required.

6. Work Date Derivation (Conceptual)
- Convert event_time_utc to Company Timezone.
- Compare local time with day_start_time.
- Assign work_date accordingly.
- This derivation happens outside the attendance engine.

7. Engine and Cache Implications
- The attendance engine receives a resolved work_date.
- The engine never decides day boundaries.
- attendance_days.work_date is derived using this policy.
- Cache consistency depends on a stable day boundary policy.

8. Non-Goals (Explicit)
- This policy does NOT implement night shift logic yet.
- This policy does NOT change CSV import behavior yet.
- This policy does NOT modify the attendance engine.
- This policy does NOT add database fields.

Approved as the official Day Boundary Policy for future implementation.
