Attendance Flow

Purpose
This document defines the end-to-end attendance computation flow and freezes the
responsibilities of policy, engine, storage, and cache.

Pipeline (Step-by-step)
1) Raw device_events ingestion
2) Day Boundary derivation (policy only)
3) Working day check
4) Leave check
5) Attendance engine computation
6) Persistence to attendance_days
7) Cache reuse on subsequent calls

Policy vs Engine vs Storage vs Cache
- Policy: Determines the work_date and evaluates working day and leave rules.
- Engine: Computes attendance for an already-resolved date; it NEVER decides the work_date.
- Storage: Persists computed attendance to attendance_days.
- Cache: Reuses stored attendance_days results on subsequent calls.

Explicit Statements
- The engine NEVER decides the work_date.
- The engine operates on an already-resolved date.
- Policies run before the engine.
