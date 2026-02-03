BEGIN;

CREATE TABLE IF NOT EXISTS public.identity_mappings (
  company_id text NOT NULL,
  provider text NOT NULL,
  identifier_type text NOT NULL,
  identifier_value text NOT NULL,
  person_id text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT identity_mappings_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT identity_mappings_employee_fkey
    FOREIGN KEY (company_id, person_id) REFERENCES public.employees(company_id, person_id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, provider, identifier_type, identifier_value)
);

CREATE INDEX IF NOT EXISTS idx_identity_mappings_company_person
  ON public.identity_mappings (company_id, person_id);

CREATE INDEX IF NOT EXISTS idx_identity_mappings_company_provider
  ON public.identity_mappings (company_id, provider);

CREATE INDEX IF NOT EXISTS idx_identity_mappings_metadata_gin
  ON public.identity_mappings USING gin (metadata);

COMMIT;
