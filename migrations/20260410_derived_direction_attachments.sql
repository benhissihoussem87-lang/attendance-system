CREATE TABLE IF NOT EXISTS derived_direction_attachments (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  agent_id uuid NOT NULL,
  device_uid text NOT NULL,
  fact_event_id uuid NOT NULL,
  fact_anchor_utc timestamptz NOT NULL,
  subject_key text NOT NULL,
  derived_direction text,
  artifact_outcome text NOT NULL CHECK (artifact_outcome IN ('usable', 'informational_only', 'unresolved')),
  confidence text NOT NULL,
  confidence_basis text NOT NULL,
  conflict_flag boolean NOT NULL DEFAULT false,
  source_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  derivation_version text NOT NULL,
  derivation_run_id text NOT NULL,
  lane_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fact_event_id)
);

CREATE INDEX IF NOT EXISTS idx_derived_direction_attachments_scope_time
  ON derived_direction_attachments(company_id, device_uid, fact_anchor_utc DESC);

