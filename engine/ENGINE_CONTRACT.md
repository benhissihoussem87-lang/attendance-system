Attendance Engine Contract v1

Input
- work_date (YYYY-MM-DD)
- rule_set (validated)
- device events (UTC timestamps)

Output guarantees
- status: PRESENT/ABSENT/INCOMPLETE/INVALID
- metrics: worked_minutes, late_minutes
- first_in, last_out (if present)
- explanation: string[]
- engine_version
