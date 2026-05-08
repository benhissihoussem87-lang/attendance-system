BEGIN;

CREATE TABLE IF NOT EXISTS public.sites (
  site_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  site_key text NOT NULL,
  site_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sites_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT sites_site_key_nonempty_ck
    CHECK (length(btrim(site_key)) > 0),
  CONSTRAINT sites_site_name_nonempty_ck
    CHECK (length(btrim(site_name)) > 0),
  CONSTRAINT sites_status_ck
    CHECK (status IN ('active', 'inactive'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sites_company_site_key
  ON public.sites (company_id, site_key);

CREATE UNIQUE INDEX IF NOT EXISTS ux_sites_company_site_id
  ON public.sites (company_id, site_id);

CREATE INDEX IF NOT EXISTS idx_sites_company_status_name
  ON public.sites (company_id, status, site_name);

ALTER TABLE public.agent_nodes
  ADD COLUMN IF NOT EXISTS site_id uuid NULL;

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS site_id uuid NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_nodes_company_site_id_fkey'
  ) THEN
    ALTER TABLE public.agent_nodes
      ADD CONSTRAINT agent_nodes_company_site_id_fkey
      FOREIGN KEY (company_id, site_id)
      REFERENCES public.sites(company_id, site_id)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_company_site_id_fkey'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_company_site_id_fkey
      FOREIGN KEY (company_id, site_id)
      REFERENCES public.sites(company_id, site_id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_nodes_company_site_status_seen
  ON public.agent_nodes (company_id, site_id, status, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_devices_company_site_managed_status
  ON public.devices (company_id, site_id, managed_status, updated_at DESC);

COMMIT;
