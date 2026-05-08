BEGIN;

CREATE TABLE IF NOT EXISTS public.site_runtime_reported_state (
  company_id text NOT NULL,
  site_id uuid NOT NULL,
  reporting_agent_id uuid NULL,
  last_heartbeat_at timestamptz NULL,
  last_poll_at timestamptz NULL,
  runtime_health_status text NOT NULL DEFAULT 'unknown',
  runtime_health_reason text NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT site_runtime_reported_state_pkey PRIMARY KEY (company_id, site_id),
  CONSTRAINT site_runtime_reported_state_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT site_runtime_reported_state_company_site_id_fkey
    FOREIGN KEY (company_id, site_id)
    REFERENCES public.sites(company_id, site_id) ON DELETE CASCADE,
  CONSTRAINT site_runtime_reported_state_reporting_agent_id_fkey
    FOREIGN KEY (reporting_agent_id) REFERENCES public.agent_nodes(id) ON DELETE SET NULL,
  CONSTRAINT site_runtime_reported_state_runtime_health_status_ck
    CHECK (runtime_health_status IN ('healthy', 'degraded', 'blocked', 'offline', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_site_runtime_reported_state_company_reporting_agent
  ON public.site_runtime_reported_state (company_id, reporting_agent_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_site_runtime_reported_state_company_reported_at
  ON public.site_runtime_reported_state (company_id, reported_at DESC);

CREATE TABLE IF NOT EXISTS public.device_runtime_reported_state (
  company_id text NOT NULL,
  device_uid text NOT NULL,
  site_id uuid NULL,
  reporting_agent_id uuid NULL,
  last_validation_status text NULL,
  last_validation_reason text NULL,
  last_pull_status text NULL,
  last_pull_reason text NULL,
  last_successful_pull_at timestamptz NULL,
  last_local_contact_at timestamptz NULL,
  reported_health_status text NOT NULL DEFAULT 'unknown',
  reported_health_reason text NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_runtime_reported_state_pkey PRIMARY KEY (company_id, device_uid),
  CONSTRAINT device_runtime_reported_state_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT device_runtime_reported_state_company_device_uid_fkey
    FOREIGN KEY (company_id, device_uid)
    REFERENCES public.devices(company_id, device_uid) ON DELETE CASCADE,
  CONSTRAINT device_runtime_reported_state_company_site_id_fkey
    FOREIGN KEY (company_id, site_id)
    REFERENCES public.sites(company_id, site_id) ON DELETE SET NULL,
  CONSTRAINT device_runtime_reported_state_reporting_agent_id_fkey
    FOREIGN KEY (reporting_agent_id) REFERENCES public.agent_nodes(id) ON DELETE SET NULL,
  CONSTRAINT device_runtime_reported_state_last_validation_status_ck
    CHECK (
      last_validation_status IS NULL
      OR last_validation_status IN ('never_run', 'queued', 'in_progress', 'failed', 'succeeded')
    ),
  CONSTRAINT device_runtime_reported_state_last_pull_status_ck
    CHECK (
      last_pull_status IS NULL
      OR last_pull_status IN ('queued', 'sent', 'acknowledged', 'failed', 'expired', 'accepted', 'partial', 'rejected', 'idle', 'error', 'unknown')
    ),
  CONSTRAINT device_runtime_reported_state_reported_health_status_ck
    CHECK (reported_health_status IN ('healthy', 'degraded', 'blocked', 'offline', 'unknown'))
);

CREATE INDEX IF NOT EXISTS idx_device_runtime_reported_state_company_site
  ON public.device_runtime_reported_state (company_id, site_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_runtime_reported_state_company_reporting_agent
  ON public.device_runtime_reported_state (company_id, reporting_agent_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_runtime_reported_state_company_health
  ON public.device_runtime_reported_state (company_id, reported_health_status, reported_at DESC);

COMMIT;
