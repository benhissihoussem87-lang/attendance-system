CREATE TABLE IF NOT EXISTS device_user_inventory_snapshots (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id text NOT NULL,
  device_uid text NOT NULL,
  inventory_scope text NOT NULL DEFAULT 'zk_k80',
  snapshot_taken_at timestamptz NOT NULL DEFAULT now(),
  raw_evidence_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  parsed_device_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  parsed_user_count integer,
  inventory_confidence_status text NOT NULL CHECK (
    inventory_confidence_status IN ('high', 'medium', 'low', 'unknown')
  ) DEFAULT 'unknown',
  inventory_completeness_status text NOT NULL CHECK (
    inventory_completeness_status IN ('complete', 'partial', 'unknown')
  ) DEFAULT 'unknown',
  next_candidate_device_user_id integer,
  allocation_strategy text,
  strategy_version text,
  notes text,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  superseded_by_snapshot_id uuid,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_device_user_inventory_snapshots_scope_time
  ON device_user_inventory_snapshots(company_id, device_uid, snapshot_taken_at DESC);

CREATE INDEX IF NOT EXISTS idx_device_user_inventory_snapshots_scope_inventory_scope
  ON device_user_inventory_snapshots(company_id, inventory_scope, snapshot_taken_at DESC);

