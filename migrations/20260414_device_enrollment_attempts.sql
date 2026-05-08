CREATE TABLE IF NOT EXISTS device_enrollment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  device_uid text NOT NULL,
  inventory_scope text NOT NULL DEFAULT 'zk_k80',
  person_id text NOT NULL,
  device_user_id integer NOT NULL,
  selected_finger text NOT NULL,
  preflight_decision_id uuid NOT NULL REFERENCES device_user_id_preflight_decisions(id) ON DELETE RESTRICT,
  attempt_status text NOT NULL CHECK (
    attempt_status IN (
      'pending',
      'starting',
      'in_progress',
      'success',
      'cancelled',
      'partial_or_failed',
      'blocked'
    )
  ),
  status_reason text NULL,
  protocol_session_ref text NULL,
  command_ref text NULL,
  evidence_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz NULL,
  created_by text NULL,
  audit_ref text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_enrollment_attempts_scope_time
  ON device_enrollment_attempts(company_id, device_uid, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_enrollment_attempts_preflight
  ON device_enrollment_attempts(company_id, preflight_decision_id);
