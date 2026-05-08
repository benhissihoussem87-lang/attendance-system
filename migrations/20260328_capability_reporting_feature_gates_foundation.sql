BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_runtime_capability_reported_state (
  company_id text NOT NULL,
  agent_id uuid NOT NULL,
  site_id uuid NULL,
  capability_key text NOT NULL,
  capability_status text NOT NULL,
  capability_reason text NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runtime_capability_reported_state_pkey
    PRIMARY KEY (company_id, agent_id, capability_key),
  CONSTRAINT agent_runtime_capability_reported_state_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT agent_runtime_capability_reported_state_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE CASCADE,
  CONSTRAINT agent_runtime_capability_reported_state_company_site_id_fkey
    FOREIGN KEY (company_id, site_id)
    REFERENCES public.sites(company_id, site_id) ON DELETE SET NULL,
  CONSTRAINT agent_runtime_capability_reported_state_capability_key_nonempty_ck
    CHECK (length(btrim(capability_key)) > 0),
  CONSTRAINT agent_runtime_capability_reported_state_capability_status_ck
    CHECK (capability_status IN ('supported', 'unsupported', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_capability_state_company_agent_reported
  ON public.agent_runtime_capability_reported_state (company_id, agent_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_capability_state_company_site_capability
  ON public.agent_runtime_capability_reported_state (company_id, site_id, capability_key);

CREATE TABLE IF NOT EXISTS public.device_runtime_capability_reported_state (
  company_id text NOT NULL,
  device_uid text NOT NULL,
  site_id uuid NULL,
  reporting_agent_id uuid NULL,
  capability_key text NOT NULL,
  capability_status text NOT NULL,
  capability_reason text NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_runtime_capability_reported_state_pkey
    PRIMARY KEY (company_id, device_uid, capability_key),
  CONSTRAINT device_runtime_capability_reported_state_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT device_runtime_capability_reported_state_company_device_uid_fkey
    FOREIGN KEY (company_id, device_uid)
    REFERENCES public.devices(company_id, device_uid) ON DELETE CASCADE,
  CONSTRAINT device_runtime_capability_reported_state_company_site_id_fkey
    FOREIGN KEY (company_id, site_id)
    REFERENCES public.sites(company_id, site_id) ON DELETE SET NULL,
  CONSTRAINT device_runtime_capability_reported_state_reporting_agent_id_fkey
    FOREIGN KEY (reporting_agent_id) REFERENCES public.agent_nodes(id) ON DELETE SET NULL,
  CONSTRAINT device_runtime_capability_reported_state_capability_key_nonempty_ck
    CHECK (length(btrim(capability_key)) > 0),
  CONSTRAINT device_runtime_capability_reported_state_capability_status_ck
    CHECK (capability_status IN ('supported', 'unsupported', 'disabled'))
);

CREATE INDEX IF NOT EXISTS idx_device_runtime_capability_state_company_device_reported
  ON public.device_runtime_capability_reported_state (company_id, device_uid, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_runtime_capability_state_company_site_capability
  ON public.device_runtime_capability_reported_state (company_id, site_id, capability_key);

CREATE INDEX IF NOT EXISTS idx_device_runtime_capability_state_company_reporting_agent
  ON public.device_runtime_capability_reported_state (company_id, reporting_agent_id, reported_at DESC);

INSERT INTO public.agent_runtime_capability_reported_state (
  company_id,
  agent_id,
  site_id,
  capability_key,
  capability_status,
  capability_reason,
  reported_at,
  metadata
)
SELECT
  s.company_id,
  s.reporting_agent_id,
  s.site_id,
  'runtime.heartbeat_reporting'::text AS capability_key,
  'supported'::text AS capability_status,
  'heartbeat_report_observed'::text AS capability_reason,
  COALESCE(s.reported_at, s.last_heartbeat_at, now()) AS reported_at,
  jsonb_build_object(
    'source', 'migration.backfill.site_runtime_reported_state',
    'migration', '20260328_capability_reporting_feature_gates_foundation.sql'
  ) AS metadata
FROM public.site_runtime_reported_state s
WHERE s.reporting_agent_id IS NOT NULL
ON CONFLICT (company_id, agent_id, capability_key) DO UPDATE
  SET site_id = COALESCE(EXCLUDED.site_id, public.agent_runtime_capability_reported_state.site_id),
      reported_at = GREATEST(public.agent_runtime_capability_reported_state.reported_at, EXCLUDED.reported_at),
      metadata = public.agent_runtime_capability_reported_state.metadata || EXCLUDED.metadata,
      updated_at = now();

INSERT INTO public.agent_runtime_capability_reported_state (
  company_id,
  agent_id,
  site_id,
  capability_key,
  capability_status,
  capability_reason,
  reported_at,
  metadata
)
SELECT
  v.company_id,
  v.agent_id,
  v.site_id,
  'runtime.version_reporting'::text AS capability_key,
  'supported'::text AS capability_status,
  'version_report_observed'::text AS capability_reason,
  COALESCE(v.reported_at, now()) AS reported_at,
  jsonb_build_object(
    'source', 'migration.backfill.agent_runtime_version_reported_state',
    'migration', '20260328_capability_reporting_feature_gates_foundation.sql'
  ) AS metadata
FROM public.agent_runtime_version_reported_state v
ON CONFLICT (company_id, agent_id, capability_key) DO UPDATE
  SET site_id = COALESCE(EXCLUDED.site_id, public.agent_runtime_capability_reported_state.site_id),
      reported_at = GREATEST(public.agent_runtime_capability_reported_state.reported_at, EXCLUDED.reported_at),
      metadata = public.agent_runtime_capability_reported_state.metadata || EXCLUDED.metadata,
      updated_at = now();

INSERT INTO public.agent_runtime_capability_reported_state (
  company_id,
  agent_id,
  site_id,
  capability_key,
  capability_status,
  capability_reason,
  reported_at,
  metadata
)
SELECT
  c.company_id,
  c.agent_id,
  a.site_id,
  'command.validate_device_candidate'::text AS capability_key,
  'supported'::text AS capability_status,
  'command_acknowledged'::text AS capability_reason,
  COALESCE(MAX(c.acknowledged_at), MAX(c.created_at), now()) AS reported_at,
  jsonb_build_object(
    'source', 'migration.backfill.agent_commands',
    'migration', '20260328_capability_reporting_feature_gates_foundation.sql',
    'command_type', 'VALIDATE_DEVICE_CANDIDATE'
  ) AS metadata
FROM public.agent_commands c
LEFT JOIN public.agent_nodes a
  ON a.company_id = c.company_id
 AND a.id = c.agent_id
WHERE c.command_type = 'VALIDATE_DEVICE_CANDIDATE'
  AND c.status = 'acknowledged'
GROUP BY c.company_id, c.agent_id, a.site_id
ON CONFLICT (company_id, agent_id, capability_key) DO UPDATE
  SET site_id = COALESCE(EXCLUDED.site_id, public.agent_runtime_capability_reported_state.site_id),
      reported_at = GREATEST(public.agent_runtime_capability_reported_state.reported_at, EXCLUDED.reported_at),
      metadata = public.agent_runtime_capability_reported_state.metadata || EXCLUDED.metadata,
      updated_at = now();

INSERT INTO public.agent_runtime_capability_reported_state (
  company_id,
  agent_id,
  site_id,
  capability_key,
  capability_status,
  capability_reason,
  reported_at,
  metadata
)
SELECT
  c.company_id,
  c.agent_id,
  a.site_id,
  'command.pull_device_events'::text AS capability_key,
  'supported'::text AS capability_status,
  'command_acknowledged'::text AS capability_reason,
  COALESCE(MAX(c.acknowledged_at), MAX(c.created_at), now()) AS reported_at,
  jsonb_build_object(
    'source', 'migration.backfill.agent_commands',
    'migration', '20260328_capability_reporting_feature_gates_foundation.sql',
    'command_type', 'PULL_DEVICE_EVENTS'
  ) AS metadata
FROM public.agent_commands c
LEFT JOIN public.agent_nodes a
  ON a.company_id = c.company_id
 AND a.id = c.agent_id
WHERE c.command_type = 'PULL_DEVICE_EVENTS'
  AND c.status = 'acknowledged'
GROUP BY c.company_id, c.agent_id, a.site_id
ON CONFLICT (company_id, agent_id, capability_key) DO UPDATE
  SET site_id = COALESCE(EXCLUDED.site_id, public.agent_runtime_capability_reported_state.site_id),
      reported_at = GREATEST(public.agent_runtime_capability_reported_state.reported_at, EXCLUDED.reported_at),
      metadata = public.agent_runtime_capability_reported_state.metadata || EXCLUDED.metadata,
      updated_at = now();

INSERT INTO public.device_runtime_capability_reported_state (
  company_id,
  device_uid,
  site_id,
  reporting_agent_id,
  capability_key,
  capability_status,
  capability_reason,
  reported_at,
  metadata
)
SELECT
  d.company_id,
  d.device_uid,
  d.site_id,
  d.reporting_agent_id,
  'device_path.validate_device_candidate'::text AS capability_key,
  'supported'::text AS capability_status,
  'validation_succeeded'::text AS capability_reason,
  COALESCE(d.reported_at, now()) AS reported_at,
  jsonb_build_object(
    'source', 'migration.backfill.device_runtime_reported_state',
    'migration', '20260328_capability_reporting_feature_gates_foundation.sql',
    'signal', 'last_validation_status=succeeded'
  ) AS metadata
FROM public.device_runtime_reported_state d
WHERE d.last_validation_status = 'succeeded'
ON CONFLICT (company_id, device_uid, capability_key) DO UPDATE
  SET site_id = COALESCE(EXCLUDED.site_id, public.device_runtime_capability_reported_state.site_id),
      reporting_agent_id = COALESCE(EXCLUDED.reporting_agent_id, public.device_runtime_capability_reported_state.reporting_agent_id),
      reported_at = GREATEST(public.device_runtime_capability_reported_state.reported_at, EXCLUDED.reported_at),
      metadata = public.device_runtime_capability_reported_state.metadata || EXCLUDED.metadata,
      updated_at = now();

INSERT INTO public.device_runtime_capability_reported_state (
  company_id,
  device_uid,
  site_id,
  reporting_agent_id,
  capability_key,
  capability_status,
  capability_reason,
  reported_at,
  metadata
)
SELECT
  d.company_id,
  d.device_uid,
  d.site_id,
  d.reporting_agent_id,
  'device_path.pull_device_events'::text AS capability_key,
  'supported'::text AS capability_status,
  'pull_succeeded'::text AS capability_reason,
  COALESCE(d.reported_at, now()) AS reported_at,
  jsonb_build_object(
    'source', 'migration.backfill.device_runtime_reported_state',
    'migration', '20260328_capability_reporting_feature_gates_foundation.sql',
    'signal', 'last_pull_status in accepted/partial'
  ) AS metadata
FROM public.device_runtime_reported_state d
WHERE d.last_pull_status IN ('accepted', 'partial')
ON CONFLICT (company_id, device_uid, capability_key) DO UPDATE
  SET site_id = COALESCE(EXCLUDED.site_id, public.device_runtime_capability_reported_state.site_id),
      reporting_agent_id = COALESCE(EXCLUDED.reporting_agent_id, public.device_runtime_capability_reported_state.reporting_agent_id),
      reported_at = GREATEST(public.device_runtime_capability_reported_state.reported_at, EXCLUDED.reported_at),
      metadata = public.device_runtime_capability_reported_state.metadata || EXCLUDED.metadata,
      updated_at = now();

COMMIT;
