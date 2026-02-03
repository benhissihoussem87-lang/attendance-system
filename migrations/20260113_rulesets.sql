CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS rule_sets (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    version integer not null,
    created_at timestamptz not null default now(),
    unique(name, version)
);

CREATE TABLE IF NOT EXISTS rules (
    id uuid primary key default gen_random_uuid(),
    rule_set_id uuid not null references rule_sets(id) on delete cascade,
    type text not null,
    params jsonb not null default '{}'::jsonb,
    order_index integer not null,
    created_at timestamptz not null default now(),
    unique(rule_set_id, order_index)
);

ALTER TABLE attendance_days ADD COLUMN IF NOT EXISTS rule_set_id uuid null;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_attendance_days_rule_set_id'
  ) THEN
    CREATE INDEX idx_attendance_days_rule_set_id ON attendance_days(rule_set_id);
  END IF;
END$$;
