BEGIN;

CREATE TABLE IF NOT EXISTS public.site_agent_leases (
  lease_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  site_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  leased_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz NULL,
  leased_by_key_id text NULL,
  released_by_key_id text NULL,
  superseded_by_lease_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_agent_leases_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT site_agent_leases_company_site_id_fkey
    FOREIGN KEY (company_id, site_id)
    REFERENCES public.sites(company_id, site_id) ON DELETE CASCADE,
  CONSTRAINT site_agent_leases_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE RESTRICT,
  CONSTRAINT site_agent_leases_superseded_by_lease_id_fkey
    FOREIGN KEY (superseded_by_lease_id)
    REFERENCES public.site_agent_leases(lease_id) ON DELETE SET NULL,
  CONSTRAINT site_agent_leases_status_ck
    CHECK (status IN ('active', 'superseded', 'released')),
  CONSTRAINT site_agent_leases_released_at_status_ck
    CHECK (
      (status = 'active' AND released_at IS NULL)
      OR
      (status IN ('superseded', 'released') AND released_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_site_agent_leases_one_active_per_site
  ON public.site_agent_leases (company_id, site_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_site_agent_leases_company_site_leased_at
  ON public.site_agent_leases (company_id, site_id, leased_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_site_agent_leases_company_agent_status
  ON public.site_agent_leases (company_id, agent_id, status, leased_at DESC);

COMMIT;
