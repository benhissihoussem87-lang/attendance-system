CREATE TABLE IF NOT EXISTS device_user_id_preflight_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  device_uid text NOT NULL,
  inventory_scope text NOT NULL DEFAULT 'zk_k80',
  source_inventory_snapshot_id uuid NULL REFERENCES device_user_inventory_snapshots(id) ON DELETE SET NULL,
  source_candidate_evaluation jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected_candidate_device_user_id integer NULL,
  selected_source text NULL,
  preflight_readiness_status text NOT NULL,
  blocked_reason_code text NULL,
  manual_override_used boolean NOT NULL DEFAULT false,
  manual_override_actor text NULL,
  manual_override_reason text NULL,
  manual_override_note text NULL,
  manual_override_required boolean NOT NULL DEFAULT true,
  audit_ref text NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_user_id_preflight_decisions_scope_time
  ON device_user_id_preflight_decisions(company_id, device_uid, evaluated_at DESC);
