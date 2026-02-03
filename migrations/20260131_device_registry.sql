BEGIN;

CREATE TABLE IF NOT EXISTS public.devices (
  company_id text NOT NULL,
  device_uid text NOT NULL,
  provider text NULL,
  device_name text NULL,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, device_uid)
);

CREATE INDEX IF NOT EXISTS idx_devices_company_provider
  ON public.devices (company_id, provider);

COMMIT;
