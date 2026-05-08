BEGIN;

CREATE TABLE IF NOT EXISTS public.device_monitoring_sessions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  device_uid text NOT NULL,
  agent_id uuid NULL,
  status text NOT NULL DEFAULT 'starting',
  rt_enabled boolean NOT NULL DEFAULT true,
  started_by_key_id text NULL,
  started_by_role text NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NULL,
  expires_at timestamptz NULL,
  stopped_at timestamptz NULL,
  stop_reason text NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_monitoring_sessions_company_id_fkey
    FOREIGN KEY (company_id) REFERENCES public.companies(company_id) ON DELETE CASCADE,
  CONSTRAINT device_monitoring_sessions_device_uid_fkey
    FOREIGN KEY (company_id, device_uid) REFERENCES public.devices(company_id, device_uid) ON DELETE CASCADE,
  CONSTRAINT device_monitoring_sessions_agent_id_fkey
    FOREIGN KEY (agent_id) REFERENCES public.agent_nodes(id) ON DELETE SET NULL,
  CONSTRAINT device_monitoring_sessions_status_ck
    CHECK (status IN ('starting', 'active', 'stopping', 'stopped', 'expired', 'failed')),
  CONSTRAINT device_monitoring_sessions_active_expiry_ck
    CHECK (
      status NOT IN ('starting', 'active')
      OR expires_at IS NOT NULL
    ),
  CONSTRAINT device_monitoring_sessions_stopped_window_ck
    CHECK (stopped_at IS NULL OR stopped_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_device_monitoring_sessions_one_active
  ON public.device_monitoring_sessions (company_id, device_uid)
  WHERE status IN ('starting', 'active');

CREATE INDEX IF NOT EXISTS idx_device_monitoring_sessions_company_device_status
  ON public.device_monitoring_sessions (company_id, device_uid, status, expires_at DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_monitoring_sessions_company_agent_status
  ON public.device_monitoring_sessions (company_id, agent_id, status, updated_at DESC);

COMMIT;
