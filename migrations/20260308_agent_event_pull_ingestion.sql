BEGIN;

ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS source_agent_id uuid NULL;
ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS ingest_method text NOT NULL DEFAULT 'api_json';
ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS dedup_key text NULL;
ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS received_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS event_time_local text NULL;
ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS device_timezone text NULL;
ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS device_person_id text NULL;
ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS verify_state text NULL;
ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS verify_method text NULL;
ALTER TABLE public.device_events
  ADD COLUMN IF NOT EXISTS source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_events_source_agent_id_fkey'
  ) THEN
    ALTER TABLE public.device_events
      ADD CONSTRAINT device_events_source_agent_id_fkey
      FOREIGN KEY (source_agent_id) REFERENCES public.agent_nodes(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'device_events_ingest_method_ck'
  ) THEN
    ALTER TABLE public.device_events
      ADD CONSTRAINT device_events_ingest_method_ck
      CHECK (ingest_method IN ('api_json', 'csv_import', 'agent_pull', 'agent_realtime', 'agent_push'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS device_events_dedup_key_company_uk
  ON public.device_events (company_id, dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_device_events_company_device_time
  ON public.device_events (company_id, device_uid, event_time_utc DESC);

CREATE INDEX IF NOT EXISTS idx_device_events_company_agent_received
  ON public.device_events (company_id, source_agent_id, received_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_device_sync_states (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  agent_id uuid NOT NULL,
  device_uid text NOT NULL,
  vendor text NOT NULL DEFAULT 'zkteco',
  sync_mode text NOT NULL DEFAULT 'pull',
  status text NOT NULL DEFAULT 'idle',
  cursor_event_time_utc timestamptz NULL,
  safety_window_seconds integer NOT NULL DEFAULT 300,
  last_sync_started_at timestamptz NULL,
  last_sync_completed_at timestamptz NULL,
  last_event_time_utc timestamptz NULL,
  last_event_time_local text NULL,
  last_pull_count integer NOT NULL DEFAULT 0,
  last_submit_count integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  failure_reason text NULL,
  last_error_at timestamptz NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_device_sync_states_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT agent_device_sync_states_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE CASCADE,
  CONSTRAINT agent_device_sync_states_device_uid_fkey
    FOREIGN KEY (company_id, device_uid) REFERENCES public.devices(company_id, device_uid) ON DELETE CASCADE,
  CONSTRAINT agent_device_sync_states_status_ck
    CHECK (status IN ('idle', 'syncing', 'error', 'paused')),
  CONSTRAINT agent_device_sync_states_sync_mode_ck
    CHECK (sync_mode IN ('pull', 'realtime', 'push'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_device_sync_states_scope
  ON public.agent_device_sync_states (company_id, agent_id, device_uid);

CREATE INDEX IF NOT EXISTS idx_agent_device_sync_states_company_status
  ON public.agent_device_sync_states (company_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.agent_device_event_batches (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  agent_id uuid NOT NULL,
  device_uid text NOT NULL,
  command_id uuid NULL,
  vendor text NOT NULL DEFAULT 'zkteco',
  ingest_method text NOT NULL DEFAULT 'agent_pull',
  requested_since_utc timestamptz NULL,
  latest_event_time_utc timestamptz NULL,
  pull_started_at timestamptz NULL,
  pull_completed_at timestamptz NOT NULL,
  events_received_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  deduped_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'accepted',
  failure_reason text NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_device_event_batches_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT agent_device_event_batches_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE CASCADE,
  CONSTRAINT agent_device_event_batches_command_id_fkey
    FOREIGN KEY (command_id) REFERENCES public.agent_commands(id) ON DELETE SET NULL,
  CONSTRAINT agent_device_event_batches_status_ck
    CHECK (status IN ('accepted', 'partial', 'rejected')),
  CONSTRAINT agent_device_event_batches_ingest_method_ck
    CHECK (ingest_method IN ('agent_pull', 'agent_realtime', 'agent_push'))
);

CREATE INDEX IF NOT EXISTS idx_agent_device_event_batches_company_time
  ON public.agent_device_event_batches (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_device_event_batches_scope
  ON public.agent_device_event_batches (company_id, agent_id, device_uid, created_at DESC);

COMMIT;
