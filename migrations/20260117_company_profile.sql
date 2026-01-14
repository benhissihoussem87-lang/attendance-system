BEGIN;

CREATE TABLE IF NOT EXISTS public.company_profile (
  company_id text PRIMARY KEY,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_profile_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS company_profile_metadata_gin
  ON public.company_profile USING gin (metadata);

COMMIT;
