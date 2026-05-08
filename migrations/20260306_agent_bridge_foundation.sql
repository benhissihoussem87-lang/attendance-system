BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_provisioning_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  token_hash text NOT NULL,
  token_prefix text NOT NULL,
  created_by_key_id text NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz NULL,
  revoked_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_provisioning_tokens_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_provisioning_tokens_hash
  ON public.agent_provisioning_tokens (token_hash);

CREATE INDEX IF NOT EXISTS idx_agent_provisioning_tokens_company_created
  ON public.agent_provisioning_tokens (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_nodes (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  agent_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  auth_secret_hash text NOT NULL,
  auth_secret_prefix text NOT NULL,
  credential_version integer NOT NULL DEFAULT 1,
  provisioned_from_token_id uuid NULL,
  registered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NULL,
  last_heartbeat_at timestamptz NULL,
  heartbeat_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_nodes_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT agent_nodes_provisioned_token_fkey
    FOREIGN KEY (provisioned_from_token_id) REFERENCES public.agent_provisioning_tokens(id) ON DELETE SET NULL,
  CONSTRAINT agent_nodes_status_ck
    CHECK (status IN ('active', 'inactive', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_nodes_company_agent_name
  ON public.agent_nodes (company_id, agent_name);

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_nodes_secret_hash
  ON public.agent_nodes (auth_secret_hash);

CREATE INDEX IF NOT EXISTS idx_agent_nodes_company_status_seen
  ON public.agent_nodes (company_id, status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_commands (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  agent_id uuid NOT NULL,
  command_type text NOT NULL,
  command_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NULL,
  created_by_key_id text NULL,
  sent_at timestamptz NULL,
  acknowledged_at timestamptz NULL,
  failure_reason text NULL,
  result_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_commands_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT agent_commands_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE CASCADE,
  CONSTRAINT agent_commands_status_ck
    CHECK (status IN ('queued', 'sent', 'acknowledged', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_agent_commands_agent_queue
  ON public.agent_commands (company_id, agent_id, status, available_at, created_at);

CREATE TABLE IF NOT EXISTS public.device_discovery_reports (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  agent_id uuid NOT NULL,
  command_id uuid NULL,
  adapter_id text NOT NULL,
  subnet_targets jsonb NOT NULL DEFAULT '[]'::jsonb,
  report_payload jsonb NOT NULL,
  reported_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_reports_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT discovery_reports_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE CASCADE,
  CONSTRAINT discovery_reports_command_id_fkey
    FOREIGN KEY (command_id) REFERENCES public.agent_commands(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_reports_company_agent_time
  ON public.device_discovery_reports (company_id, agent_id, reported_at DESC);

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS managed_status text NOT NULL DEFAULT 'managed';
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS discovery_status text NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS discovered_by_agent_id uuid NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS source text NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS claimed_by_key_id text NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NULL;
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS discovery_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_managed_status_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_managed_status_ck
      CHECK (managed_status IN ('candidate', 'managed', 'inactive', 'unreachable'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_discovered_by_agent_id_fkey'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_discovered_by_agent_id_fkey
      FOREIGN KEY (discovered_by_agent_id) REFERENCES public.agent_nodes(id) ON DELETE SET NULL;
  END IF;
END $$;

UPDATE public.devices
SET source = COALESCE(source, 'ingest'),
    managed_status = COALESCE(managed_status, 'managed')
WHERE source IS NULL OR managed_status IS NULL;

CREATE INDEX IF NOT EXISTS idx_devices_company_managed_status
  ON public.devices (company_id, managed_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_devices_company_discovered_agent
  ON public.devices (company_id, discovered_by_agent_id, updated_at DESC);

COMMIT;
