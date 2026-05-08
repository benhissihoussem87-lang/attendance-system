BEGIN;

CREATE TABLE IF NOT EXISTS public.agent_runtime_version_reported_state (
  company_id text NOT NULL,
  agent_id uuid NOT NULL,
  site_id uuid NULL,
  reported_version text NOT NULL,
  rollout_channel text NULL,
  reported_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_runtime_version_reported_state_pkey PRIMARY KEY (company_id, agent_id),
  CONSTRAINT agent_runtime_version_reported_state_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT agent_runtime_version_reported_state_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE CASCADE,
  CONSTRAINT agent_runtime_version_reported_state_company_site_id_fkey
    FOREIGN KEY (company_id, site_id)
    REFERENCES public.sites(company_id, site_id) ON DELETE SET NULL,
  CONSTRAINT agent_runtime_version_reported_state_reported_version_nonempty_ck
    CHECK (length(btrim(reported_version)) > 0),
  CONSTRAINT agent_runtime_version_reported_state_rollout_channel_ck
    CHECK (
      rollout_channel IS NULL
      OR rollout_channel IN ('stable', 'beta')
    )
);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_version_reported_state_company_site_reported
  ON public.agent_runtime_version_reported_state (company_id, site_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_runtime_version_reported_state_company_reported
  ON public.agent_runtime_version_reported_state (company_id, reported_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_version_governance_policies (
  policy_id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  policy_scope text NOT NULL,
  company_id text NULL,
  minimum_supported_version text NOT NULL,
  target_version text NULL,
  rollout_channel text NOT NULL DEFAULT 'stable',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by_key_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_version_governance_policies_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT agent_version_governance_policies_scope_ck
    CHECK (policy_scope IN ('global', 'company')),
  CONSTRAINT agent_version_governance_policies_scope_company_ck
    CHECK (
      (policy_scope = 'global' AND company_id IS NULL)
      OR
      (policy_scope = 'company' AND company_id IS NOT NULL)
    ),
  CONSTRAINT agent_version_governance_policies_minimum_supported_version_nonempty_ck
    CHECK (length(btrim(minimum_supported_version)) > 0),
  CONSTRAINT agent_version_governance_policies_target_version_nonempty_ck
    CHECK (target_version IS NULL OR length(btrim(target_version)) > 0),
  CONSTRAINT agent_version_governance_policies_rollout_channel_ck
    CHECK (rollout_channel IN ('stable', 'beta'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_version_governance_policies_global
  ON public.agent_version_governance_policies (policy_scope)
  WHERE policy_scope = 'global';

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_version_governance_policies_company
  ON public.agent_version_governance_policies (company_id)
  WHERE policy_scope = 'company';

CREATE INDEX IF NOT EXISTS idx_agent_version_governance_policies_scope_updated
  ON public.agent_version_governance_policies (policy_scope, updated_at DESC);

INSERT INTO public.agent_runtime_version_reported_state (
  company_id,
  agent_id,
  site_id,
  reported_version,
  rollout_channel,
  reported_at,
  metadata
)
SELECT
  a.company_id,
  a.id,
  a.site_id,
  NULLIF(btrim(COALESCE(a.heartbeat_payload->>'agent_version', a.heartbeat_payload->>'version', '')), '') AS reported_version,
  CASE
    WHEN lower(btrim(COALESCE(a.heartbeat_payload->>'rollout_channel', ''))) IN ('stable', 'beta')
      THEN lower(btrim(a.heartbeat_payload->>'rollout_channel'))
    ELSE NULL
  END AS rollout_channel,
  COALESCE(a.last_heartbeat_at, a.last_seen_at, a.updated_at, a.created_at, now()) AS reported_at,
  jsonb_build_object(
    'source', 'migration.backfill.agent_heartbeat_payload',
    'heartbeat_payload_version_keys', ARRAY['agent_version', 'version']
  ) AS metadata
FROM public.agent_nodes a
WHERE NULLIF(btrim(COALESCE(a.heartbeat_payload->>'agent_version', a.heartbeat_payload->>'version', '')), '') IS NOT NULL
ON CONFLICT (company_id, agent_id) DO UPDATE
  SET site_id = COALESCE(EXCLUDED.site_id, public.agent_runtime_version_reported_state.site_id),
      reported_version = EXCLUDED.reported_version,
      rollout_channel = COALESCE(EXCLUDED.rollout_channel, public.agent_runtime_version_reported_state.rollout_channel),
      reported_at = GREATEST(public.agent_runtime_version_reported_state.reported_at, EXCLUDED.reported_at),
      metadata = public.agent_runtime_version_reported_state.metadata || EXCLUDED.metadata,
      updated_at = now();

INSERT INTO public.agent_version_governance_policies (
  policy_scope,
  company_id,
  minimum_supported_version,
  target_version,
  rollout_channel,
  metadata,
  updated_by_key_id
)
SELECT
  'global',
  NULL,
  '0.0.0',
  NULL,
  'stable',
  jsonb_build_object('source', 'migration.default.global_policy'),
  NULL
WHERE NOT EXISTS (
  SELECT 1
  FROM public.agent_version_governance_policies
  WHERE policy_scope = 'global'
)
ON CONFLICT DO NOTHING;

COMMIT;
