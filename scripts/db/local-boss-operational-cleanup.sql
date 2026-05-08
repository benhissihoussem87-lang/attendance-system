BEGIN;

CREATE SCHEMA IF NOT EXISTS local_cleanup_backup;

CREATE TABLE IF NOT EXISTS local_cleanup_backup.boss_cleanup_rows (
  id bigserial PRIMARY KEY,
  cleanup_run_id text NOT NULL,
  table_name text NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  row_data jsonb NOT NULL
);

CREATE TEMP TABLE tmp_candidate_agents ON COMMIT DROP AS
SELECT id
FROM agent_nodes
WHERE company_id = 'DEFAULT'
  AND (
    (metadata ? 'run_id')
    OR lower(agent_name) ~ '(phase3|event-agent|bridge-agent|filters-agent|ops-agent|ops-batch-agent|test|demo)'
  );

CREATE TEMP TABLE tmp_candidate_devices ON COMMIT DROP AS
SELECT company_id, device_uid
FROM devices
WHERE company_id = 'DEMO'
UNION
SELECT d.company_id, d.device_uid
FROM devices d
WHERE d.company_id = 'DEFAULT'
  AND (
    d.device_uid ILIKE 'DEMO-%'
    OR d.device_uid ILIKE 'autoRegTest:%'
    OR d.device_uid ILIKE 'DEV-%'
    OR d.device_uid ILIKE 'CSV-%'
    OR d.device_uid ILIKE 'device_contract_%'
    OR d.device_uid ILIKE '%TEST%'
    OR d.device_uid ILIKE 'zkteco:sn:OPS-BATCH-%'
    OR d.device_uid ILIKE 'zkteco:sn:PH3-%'
    OR d.device_uid ILIKE 'zkteco:sn:EVT-%'
    OR d.device_uid ILIKE 'zkteco:sn:BRIDGE-%'
    OR d.device_uid ILIKE 'zkteco:sn:FILTER-%'
    OR d.device_uid ILIKE 'zkteco:sn:REM-%'
    OR d.provider IN ('demo')
    OR (
      COALESCE(d.manageability_status, 'unknown') = 'unknown'
      AND NOT EXISTS (
        SELECT 1
        FROM agent_device_sync_states s
        WHERE s.company_id = d.company_id
          AND s.device_uid = d.device_uid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM agent_device_event_batches b
        WHERE b.company_id = d.company_id
          AND b.device_uid = d.device_uid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM agent_commands c
        WHERE c.company_id = d.company_id
          AND COALESCE(c.command_payload->>'device_uid', '') = d.device_uid
      )
    )
  )
  AND NOT (
    d.discovery_metadata::text ILIKE '%192.168.22.201%'
    OR d.metadata::text ILIKE '%192.168.22.201%'
    OR d.discovery_metadata::text ILIKE '%K80%'
    OR d.metadata::text ILIKE '%K80%'
    OR d.discovery_metadata::text ILIKE '%ZLM60_TFT%'
    OR d.metadata::text ILIKE '%ZLM60_TFT%'
  );

CREATE TEMP TABLE tmp_candidate_commands ON COMMIT DROP AS
SELECT c.id
FROM agent_commands c
LEFT JOIN tmp_candidate_devices d
  ON d.company_id = c.company_id
 AND d.device_uid = COALESCE(c.command_payload->>'device_uid', '')
WHERE c.company_id = 'DEFAULT'
  AND (
    c.agent_id IN (SELECT id FROM tmp_candidate_agents)
    OR d.device_uid IS NOT NULL
  );

CREATE TEMP TABLE tmp_candidate_sync_states ON COMMIT DROP AS
SELECT s.id
FROM agent_device_sync_states s
LEFT JOIN tmp_candidate_devices d
  ON d.company_id = s.company_id
 AND d.device_uid = s.device_uid
WHERE s.company_id = 'DEFAULT'
  AND (
    s.agent_id IN (SELECT id FROM tmp_candidate_agents)
    OR d.device_uid IS NOT NULL
  );

CREATE TEMP TABLE tmp_candidate_batches ON COMMIT DROP AS
SELECT b.id
FROM agent_device_event_batches b
LEFT JOIN tmp_candidate_devices d
  ON d.company_id = b.company_id
 AND d.device_uid = b.device_uid
WHERE b.company_id = 'DEFAULT'
  AND (
    b.agent_id IN (SELECT id FROM tmp_candidate_agents)
    OR d.device_uid IS NOT NULL
  );

CREATE TEMP TABLE tmp_candidate_reports ON COMMIT DROP AS
SELECT r.id
FROM device_discovery_reports r
WHERE r.company_id = 'DEFAULT'
  AND r.agent_id IN (SELECT id FROM tmp_candidate_agents);

INSERT INTO local_cleanup_backup.boss_cleanup_rows (cleanup_run_id, table_name, row_data)
SELECT 'boss_cleanup_20260317_realops_01', 'device_discovery_reports', to_jsonb(r)
FROM device_discovery_reports r
JOIN tmp_candidate_reports t ON t.id = r.id;

INSERT INTO local_cleanup_backup.boss_cleanup_rows (cleanup_run_id, table_name, row_data)
SELECT 'boss_cleanup_20260317_realops_01', 'agent_device_event_batches', to_jsonb(b)
FROM agent_device_event_batches b
JOIN tmp_candidate_batches t ON t.id = b.id;

INSERT INTO local_cleanup_backup.boss_cleanup_rows (cleanup_run_id, table_name, row_data)
SELECT 'boss_cleanup_20260317_realops_01', 'agent_device_sync_states', to_jsonb(s)
FROM agent_device_sync_states s
JOIN tmp_candidate_sync_states t ON t.id = s.id;

INSERT INTO local_cleanup_backup.boss_cleanup_rows (cleanup_run_id, table_name, row_data)
SELECT 'boss_cleanup_20260317_realops_01', 'agent_commands', to_jsonb(c)
FROM agent_commands c
JOIN tmp_candidate_commands t ON t.id = c.id;

INSERT INTO local_cleanup_backup.boss_cleanup_rows (cleanup_run_id, table_name, row_data)
SELECT 'boss_cleanup_20260317_realops_01', 'devices', to_jsonb(d)
FROM devices d
JOIN tmp_candidate_devices t
  ON t.company_id = d.company_id
 AND t.device_uid = d.device_uid;

INSERT INTO local_cleanup_backup.boss_cleanup_rows (cleanup_run_id, table_name, row_data)
SELECT 'boss_cleanup_20260317_realops_01', 'agent_nodes', to_jsonb(a)
FROM agent_nodes a
JOIN tmp_candidate_agents t ON t.id = a.id;

DELETE FROM device_discovery_reports r
USING tmp_candidate_reports t
WHERE r.id = t.id;

DELETE FROM agent_device_event_batches b
USING tmp_candidate_batches t
WHERE b.id = t.id;

DELETE FROM agent_device_sync_states s
USING tmp_candidate_sync_states t
WHERE s.id = t.id;

DELETE FROM agent_commands c
USING tmp_candidate_commands t
WHERE c.id = t.id;

DELETE FROM devices d
USING tmp_candidate_devices t
WHERE d.company_id = t.company_id
  AND d.device_uid = t.device_uid;

DELETE FROM agent_nodes a
USING tmp_candidate_agents t
WHERE a.id = t.id;

COMMIT;
