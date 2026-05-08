\set ON_ERROR_STOP on

BEGIN;
SET TRANSACTION READ ONLY;

\echo ''
\echo '== Device Lifecycle Coherence Integrity Report =='
\echo ''

\echo '[1] Required lifecycle migrations (expected: all applied)'
WITH required(filename) AS (
  VALUES
    ('20260318_device_lifecycle_coherence_phase2_slice21.sql'),
    ('20260318_device_lifecycle_coherence_phase2_slice25.sql')
)
SELECT
  r.filename,
  CASE WHEN sm.filename IS NULL THEN 'missing' ELSE 'applied' END AS status
FROM required r
LEFT JOIN public.schema_migrations sm
  ON sm.filename = r.filename
ORDER BY r.filename;

\echo ''
\echo '[2] Device lifecycle summary'
SELECT
  d.company_id,
  d.lifecycle_scope,
  d.managed_status,
  d.identity_status,
  COUNT(*) AS row_count
FROM public.devices d
GROUP BY d.company_id, d.lifecycle_scope, d.managed_status, d.identity_status
ORDER BY d.company_id, d.lifecycle_scope, d.managed_status, d.identity_status;

\echo ''
\echo '[3] Integrity check counts (strict checks should be zero)'
WITH checks AS (
  SELECT
    'superseded_without_canonical'::text AS check_name,
    COUNT(*)::bigint AS issue_count
  FROM public.devices d
  WHERE d.identity_status = 'superseded'
    AND d.superseded_by_device_uid IS NULL

  UNION ALL

  SELECT
    'canonical_with_superseded_pointer',
    COUNT(*)::bigint
  FROM public.devices d
  WHERE d.identity_status <> 'superseded'
    AND d.superseded_by_device_uid IS NOT NULL

  UNION ALL

  SELECT
    'managed_bridge_missing_active_binding',
    COUNT(*)::bigint
  FROM public.devices d
  WHERE d.lifecycle_scope = 'bridge_ops'
    AND d.managed_status = 'managed'
    AND NOT EXISTS (
      SELECT 1
      FROM public.device_managing_agent_bindings b
      WHERE b.company_id = d.company_id
        AND b.device_uid = d.device_uid
        AND b.status = 'active'
    )

  UNION ALL

  SELECT
    'active_binding_on_non_bridge_or_non_managed_device',
    COUNT(*)::bigint
  FROM public.device_managing_agent_bindings b
  JOIN public.devices d
    ON d.company_id = b.company_id
   AND d.device_uid = b.device_uid
  WHERE b.status = 'active'
    AND (d.lifecycle_scope <> 'bridge_ops' OR d.managed_status <> 'managed')

  UNION ALL

  SELECT
    'canonical_device_missing_active_device_uid_alias',
    COUNT(*)::bigint
  FROM public.devices d
  WHERE d.identity_status <> 'superseded'
    AND NOT EXISTS (
      SELECT 1
      FROM public.device_identity_aliases a
      WHERE a.company_id = d.company_id
        AND a.canonical_device_uid = d.device_uid
        AND a.alias_kind = 'device_uid'
        AND lower(a.alias_value_normalized) = lower(d.device_uid)
        AND a.status = 'active'
    )

  UNION ALL

  SELECT
    'active_alias_points_to_superseded_canonical',
    COUNT(*)::bigint
  FROM public.device_identity_aliases a
  JOIN public.devices d
    ON d.company_id = a.company_id
   AND d.device_uid = a.canonical_device_uid
  WHERE a.status = 'active'
    AND d.identity_status = 'superseded'

  UNION ALL

  SELECT
    'ingest_only_with_bridge_evidence_advisory',
    COUNT(*)::bigint
  FROM public.devices d
  WHERE d.lifecycle_scope = 'ingest_only'
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
    )

  UNION ALL

  SELECT
    'active_serial_alias_multi_canonical_advisory',
    COUNT(*)::bigint
  FROM (
    SELECT
      a.company_id,
      lower(a.alias_value_normalized) AS alias_value,
      COUNT(DISTINCT a.canonical_device_uid) AS canonical_count
    FROM public.device_identity_aliases a
    WHERE a.status = 'active'
      AND a.alias_kind = 'serial_number'
    GROUP BY a.company_id, lower(a.alias_value_normalized)
    HAVING COUNT(DISTINCT a.canonical_device_uid) > 1
  ) t

  UNION ALL

  SELECT
    'active_mac_alias_multi_canonical_advisory',
    COUNT(*)::bigint
  FROM (
    SELECT
      a.company_id,
      lower(a.alias_value_normalized) AS alias_value,
      COUNT(DISTINCT a.canonical_device_uid) AS canonical_count
    FROM public.device_identity_aliases a
    WHERE a.status = 'active'
      AND a.alias_kind = 'mac'
    GROUP BY a.company_id, lower(a.alias_value_normalized)
    HAVING COUNT(DISTINCT a.canonical_device_uid) > 1
  ) t
)
SELECT check_name, issue_count
FROM checks
ORDER BY check_name;

\echo ''
\echo '[4] Detail: superseded rows missing canonical redirect (strict)'
SELECT
  d.company_id,
  d.device_uid,
  d.identity_status,
  d.superseded_by_device_uid,
  d.updated_at
FROM public.devices d
WHERE d.identity_status = 'superseded'
  AND d.superseded_by_device_uid IS NULL
ORDER BY d.updated_at DESC
LIMIT 200;

\echo ''
\echo '[5] Detail: managed bridge devices missing active managing-agent binding (strict)'
SELECT
  d.company_id,
  d.device_uid,
  d.managed_status,
  d.lifecycle_scope,
  d.updated_at
FROM public.devices d
WHERE d.lifecycle_scope = 'bridge_ops'
  AND d.managed_status = 'managed'
  AND NOT EXISTS (
    SELECT 1
    FROM public.device_managing_agent_bindings b
    WHERE b.company_id = d.company_id
      AND b.device_uid = d.device_uid
      AND b.status = 'active'
  )
ORDER BY d.updated_at DESC, d.device_uid ASC
LIMIT 200;

\echo ''
\echo '[6] Detail: active bindings attached to non-bridge/non-managed device (strict)'
SELECT
  b.company_id,
  b.device_uid,
  b.agent_id,
  b.status AS binding_status,
  d.managed_status,
  d.lifecycle_scope,
  b.updated_at
FROM public.device_managing_agent_bindings b
JOIN public.devices d
  ON d.company_id = b.company_id
 AND d.device_uid = b.device_uid
WHERE b.status = 'active'
  AND (d.lifecycle_scope <> 'bridge_ops' OR d.managed_status <> 'managed')
ORDER BY b.updated_at DESC, b.device_uid ASC
LIMIT 200;

\echo ''
\echo '[7] Detail: canonical device missing active self-alias (strict)'
SELECT
  d.company_id,
  d.device_uid,
  d.identity_status,
  d.updated_at
FROM public.devices d
WHERE d.identity_status <> 'superseded'
  AND NOT EXISTS (
    SELECT 1
    FROM public.device_identity_aliases a
    WHERE a.company_id = d.company_id
      AND a.canonical_device_uid = d.device_uid
      AND a.alias_kind = 'device_uid'
      AND lower(a.alias_value_normalized) = lower(d.device_uid)
      AND a.status = 'active'
  )
ORDER BY d.updated_at DESC, d.device_uid ASC
LIMIT 200;

\echo ''
\echo '[8] Detail: active alias pointing to superseded canonical (strict)'
SELECT
  a.company_id,
  a.alias_kind,
  a.vendor,
  a.alias_value_normalized,
  a.status AS alias_status,
  a.canonical_device_uid,
  d.identity_status,
  d.superseded_by_device_uid,
  a.updated_at
FROM public.device_identity_aliases a
JOIN public.devices d
  ON d.company_id = a.company_id
 AND d.device_uid = a.canonical_device_uid
WHERE a.status = 'active'
  AND d.identity_status = 'superseded'
ORDER BY a.updated_at DESC
LIMIT 200;

\echo ''
\echo '[9] Detail: ingest_only rows with bridge evidence (advisory)'
SELECT
  d.company_id,
  d.device_uid,
  d.lifecycle_scope,
  d.managed_status,
  d.source,
  d.discovered_by_agent_id,
  d.updated_at
FROM public.devices d
WHERE d.lifecycle_scope = 'ingest_only'
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
  )
ORDER BY d.updated_at DESC, d.device_uid ASC
LIMIT 200;

ROLLBACK;
