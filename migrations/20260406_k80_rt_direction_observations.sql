BEGIN;

CREATE TABLE IF NOT EXISTS public.device_realtime_direction_observations (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  agent_id uuid NOT NULL,
  device_uid text NOT NULL,
  batch_id uuid NULL,
  command_id uuid NULL,
  vendor text NOT NULL DEFAULT 'zkteco',
  observed_at_utc timestamptz NOT NULL,
  observed_at_local text NULL,
  device_timezone text NULL,
  device_person_id text NULL,
  person_id text NULL,
  rt_state_code text NULL,
  rt_state_label_provisional text NULL,
  direction_provisional text NULL,
  confidence text NULL,
  source text NULL,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_realtime_direction_observations_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT device_realtime_direction_observations_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE CASCADE,
  CONSTRAINT device_realtime_direction_observations_batch_id_fkey
    FOREIGN KEY (batch_id) REFERENCES public.agent_device_event_batches(id) ON DELETE SET NULL,
  CONSTRAINT device_realtime_direction_observations_command_id_fkey
    FOREIGN KEY (command_id) REFERENCES public.agent_commands(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS device_realtime_direction_observations_uk
  ON public.device_realtime_direction_observations (
    company_id,
    batch_id,
    device_uid,
    observed_at_utc,
    device_person_id,
    rt_state_code
  );

CREATE INDEX IF NOT EXISTS idx_device_realtime_direction_observations_company_device_time
  ON public.device_realtime_direction_observations (company_id, device_uid, observed_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_device_realtime_direction_observations_company_agent_time
  ON public.device_realtime_direction_observations (company_id, agent_id, created_at DESC);

COMMIT;
