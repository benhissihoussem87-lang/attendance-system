-- Effective-dated rule set assignments per employee (feature-flagged usage)

CREATE TABLE IF NOT EXISTS public.employee_assignments (
  company_id   TEXT NOT NULL,
  person_id    TEXT NOT NULL,
  rule_set_id  UUID NOT NULL,
  valid_from   DATE NOT NULL,
  valid_to     DATE NULL,
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, person_id, valid_from)
);

CREATE INDEX IF NOT EXISTS ix_employee_assignments_lookup
  ON public.employee_assignments (company_id, person_id, valid_from DESC);

-- Optional check constraint for valid_to >= valid_from when provided
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'employee_assignments_valid_range_ck'
  ) THEN
    ALTER TABLE public.employee_assignments
      ADD CONSTRAINT employee_assignments_valid_range_ck
      CHECK (valid_to IS NULL OR valid_to >= valid_from);
  END IF;
END $$;
