BEGIN;

CREATE TABLE IF NOT EXISTS public.employees (
  company_id text NOT NULL,
  person_id text NOT NULL,
  employee_code text NULL,
  full_name text NULL,
  default_rule_set_id uuid NULL,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT employees_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT employees_default_rule_set_id_fkey
    FOREIGN KEY (default_rule_set_id) REFERENCES public.rule_sets(id) ON DELETE SET NULL,
  PRIMARY KEY (company_id, person_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_employees_company_employee_code
  ON public.employees (company_id, employee_code)
  WHERE employee_code IS NOT NULL AND btrim(employee_code) <> '';

CREATE INDEX IF NOT EXISTS idx_employees_company_id
  ON public.employees (company_id);

CREATE INDEX IF NOT EXISTS idx_employees_metadata_gin
  ON public.employees USING gin (metadata);

COMMIT;
