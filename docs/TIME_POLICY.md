Time Policy — Version 1

1. Purpose
Time handling must be explicit in attendance systems to avoid ambiguity, ensure
consistent calculations, and support auditability across timezones.

2. Canonical Time Storage
- All device events are stored in UTC.
- Column: device_events.event_time_utc (TIMESTAMPTZ)

3. Company Timezone (Authoritative for Interpretation)
- Each company has one official timezone (e.g. Africa/Tunis).
- This timezone is used to interpret timestamps that do not include timezone info.

4. Raw Event Preservation (Audit Trail)
- Original event time and inferred timezone are preserved in raw_payload.
- This is for audit/debug only and never used directly by the engine.

Example JSON snippet:
{
  "original_event_time": "2026-01-09 08:00:00",
  "inferred_timezone": "Africa/Tunis",
  "source": "device"
}

5. Engine Time Rules
- The attendance engine operates ONLY on UTC timestamps.
- The engine never performs timezone conversions.

6. Display Rules
- Conversion from UTC to company timezone is done only for presentation.

7. Non-Goals (Explicit)
- This policy does NOT yet change CSV import behavior.
- This policy does NOT yet modify engine logic.
- This policy does NOT add database columns.

Approved for implementation in future phases.
