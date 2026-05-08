BEGIN;

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS lifecycle_scope text NOT NULL DEFAULT 'ingest_only';
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS identity_status text NOT NULL DEFAULT 'canonical';
ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS superseded_by_device_uid text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_lifecycle_scope_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_lifecycle_scope_ck
      CHECK (lifecycle_scope IN ('bridge_ops', 'ingest_only'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_identity_status_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_identity_status_ck
      CHECK (identity_status IN ('canonical', 'superseded'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_superseded_by_uid_self_ck'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_superseded_by_uid_self_ck
      CHECK (superseded_by_device_uid IS NULL OR superseded_by_device_uid <> device_uid);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_superseded_by_device_uid_fkey'
  ) THEN
    ALTER TABLE public.devices
      ADD CONSTRAINT devices_superseded_by_device_uid_fkey
      FOREIGN KEY (company_id, superseded_by_device_uid)
      REFERENCES public.devices(company_id, device_uid)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_devices_company_lifecycle_scope_status
  ON public.devices (company_id, lifecycle_scope, managed_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_devices_company_superseded_uid
  ON public.devices (company_id, superseded_by_device_uid)
  WHERE superseded_by_device_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.device_identity_aliases (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  canonical_device_uid text NOT NULL,
  alias_kind text NOT NULL,
  vendor text NOT NULL DEFAULT '',
  alias_value_normalized text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_identity_aliases_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT device_identity_aliases_canonical_device_fkey
    FOREIGN KEY (company_id, canonical_device_uid)
    REFERENCES public.devices(company_id, device_uid) ON DELETE CASCADE,
  CONSTRAINT device_identity_aliases_alias_kind_ck
    CHECK (alias_kind IN ('device_uid', 'serial_number', 'mac', 'ip', 'legacy', 'manual')),
  CONSTRAINT device_identity_aliases_status_ck
    CHECK (status IN ('active', 'superseded', 'retired')),
  CONSTRAINT device_identity_aliases_alias_value_nonempty_ck
    CHECK (length(btrim(alias_value_normalized)) > 0),
  CONSTRAINT device_identity_aliases_seen_window_ck
    CHECK (last_seen_at >= first_seen_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_device_identity_aliases_company_alias_kind_vendor_value
  ON public.device_identity_aliases (company_id, alias_kind, vendor, alias_value_normalized);

CREATE INDEX IF NOT EXISTS idx_device_identity_aliases_company_canonical_status
  ON public.device_identity_aliases (company_id, canonical_device_uid, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.device_managing_agent_bindings (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  device_uid text NOT NULL,
  agent_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  bound_at timestamptz NOT NULL DEFAULT now(),
  unbound_at timestamptz NULL,
  bound_by_key_id text NULL,
  reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_managing_agent_bindings_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT device_managing_agent_bindings_device_uid_fkey
    FOREIGN KEY (company_id, device_uid) REFERENCES public.devices(company_id, device_uid) ON DELETE CASCADE,
  CONSTRAINT device_managing_agent_bindings_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE CASCADE,
  CONSTRAINT device_managing_agent_bindings_status_ck
    CHECK (status IN ('active', 'inactive', 'superseded')),
  CONSTRAINT device_managing_agent_bindings_unbound_window_ck
    CHECK (unbound_at IS NULL OR unbound_at >= bound_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_device_managing_agent_bindings_one_active
  ON public.device_managing_agent_bindings (company_id, device_uid)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_device_managing_agent_bindings_company_agent_status
  ON public.device_managing_agent_bindings (company_id, agent_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_managing_agent_bindings_company_device_status
  ON public.device_managing_agent_bindings (company_id, device_uid, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.device_lifecycle_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  device_uid text NOT NULL,
  lifecycle_event text NOT NULL,
  actor_type text NOT NULL,
  actor_ref text NULL,
  agent_id uuid NULL,
  from_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  to_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NULL,
  correlation_id text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_lifecycle_events_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT device_lifecycle_events_device_uid_fkey
    FOREIGN KEY (company_id, device_uid) REFERENCES public.devices(company_id, device_uid),
  CONSTRAINT device_lifecycle_events_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE SET NULL,
  CONSTRAINT device_lifecycle_events_event_ck
    CHECK (
      lifecycle_event IN (
        'candidate_created',
        'candidate_updated',
        'candidate_claimed',
        'identity_alias_added',
        'identity_superseded',
        'managing_agent_bound',
        'managing_agent_rebound',
        'managed_deactivated',
        'managed_reactivated',
        'managed_retired'
      )
    ),
  CONSTRAINT device_lifecycle_events_actor_type_ck
    CHECK (actor_type IN ('system', 'agent', 'operator', 'admin', 'migration'))
);

CREATE INDEX IF NOT EXISTS idx_device_lifecycle_events_company_device_time
  ON public.device_lifecycle_events (company_id, device_uid, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_lifecycle_events_company_event_time
  ON public.device_lifecycle_events (company_id, lifecycle_event, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_lifecycle_events_company_correlation
  ON public.device_lifecycle_events (company_id, correlation_id, occurred_at DESC)
  WHERE correlation_id IS NOT NULL;

UPDATE public.devices d
SET lifecycle_scope = 'bridge_ops'
WHERE d.lifecycle_scope <> 'bridge_ops'
  AND (
    d.source = 'agent_discovery'
    OR d.managed_status = 'candidate'
    OR d.discovered_by_agent_id IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM public.agent_device_sync_states s
      WHERE s.company_id = d.company_id
        AND s.device_uid = d.device_uid
    )
    OR EXISTS (
      SELECT 1
      FROM public.agent_device_event_batches b
      WHERE b.company_id = d.company_id
        AND b.device_uid = d.device_uid
    )
  );

INSERT INTO public.device_identity_aliases (
  company_id,
  canonical_device_uid,
  alias_kind,
  vendor,
  alias_value_normalized,
  status,
  first_seen_at,
  last_seen_at,
  metadata
)
SELECT
  d.company_id,
  d.device_uid,
  'device_uid' AS alias_kind,
  COALESCE(lower(d.provider), '') AS vendor,
  d.device_uid AS alias_value_normalized,
  'active' AS status,
  COALESCE(d.created_at, now()) AS first_seen_at,
  GREATEST(COALESCE(d.updated_at, d.created_at, now()), COALESCE(d.created_at, now())) AS last_seen_at,
  jsonb_build_object('seeded_from_devices', true) AS metadata
FROM public.devices d
WHERE COALESCE(d.device_uid, '') <> ''
  AND d.identity_status <> 'superseded'
ON CONFLICT (company_id, alias_kind, vendor, alias_value_normalized) DO NOTHING;

COMMIT;
