CREATE TABLE IF NOT EXISTS historical_direction_artifacts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL REFERENCES companies(company_id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agent_nodes(id) ON DELETE CASCADE,
  device_uid text NOT NULL,
  derivation_run_id text NOT NULL,
  derivation_version text NOT NULL,
  lane_session_id text NOT NULL,
  lane_window_before_utc_exclusive timestamptz,
  lane_window_before_anchor_key text,
  fact_event_id uuid,
  fact_anchor_utc timestamptz NOT NULL,
  device_person_id text,
  person_id text,
  subject_key text NOT NULL,
  derived_direction text,
  artifact_outcome text NOT NULL CHECK (artifact_outcome IN ('usable', 'informational_only', 'unresolved')),
  confidence text NOT NULL,
  confidence_basis text NOT NULL,
  conflict_flag boolean NOT NULL DEFAULT false,
  source_hierarchy text NOT NULL,
  source_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  artifact_fingerprint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (
    company_id,
    device_uid,
    subject_key,
    fact_anchor_utc,
    derivation_version,
    artifact_fingerprint
  )
);

CREATE INDEX IF NOT EXISTS idx_historical_direction_artifacts_scope_time
  ON historical_direction_artifacts(company_id, device_uid, fact_anchor_utc DESC);

CREATE INDEX IF NOT EXISTS idx_historical_direction_artifacts_batching
  ON historical_direction_artifacts(company_id, agent_id, created_at DESC);
