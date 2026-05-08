function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeLower(value) {
  const trimmed = normalizeText(value);
  return trimmed ? trimmed.toLowerCase() : '';
}

function buildListQuery({
  companyId,
  provider,
  deviceUid,
  siteId,
  managedStatus,
  manageabilityStatus,
  remediationManualStatus,
  lifecycleScope,
  productSurface,
  limit,
  offset
}) {
  const whereParts = ['d.company_id = $1'];
  const params = [companyId];

  if (provider) {
    params.push(provider);
    whereParts.push(`d.provider = $${params.length}`);
  }
  if (deviceUid) {
    params.push(deviceUid);
    whereParts.push(`d.device_uid = $${params.length}`);
  }
  if (siteId) {
    params.push(siteId);
    whereParts.push(`d.site_id = $${params.length}::uuid`);
  }
  if (managedStatus) {
    params.push(managedStatus);
    whereParts.push(`d.managed_status = $${params.length}`);
  }
  if (manageabilityStatus) {
    params.push(manageabilityStatus);
    whereParts.push(`d.manageability_status = $${params.length}`);
  }
  if (remediationManualStatus === '__null__') {
    whereParts.push('d.remediation_manual_status IS NULL');
  } else if (remediationManualStatus) {
    params.push(remediationManualStatus);
    whereParts.push(`d.remediation_manual_status = $${params.length}`);
  }
  if (lifecycleScope) {
    params.push(lifecycleScope);
    whereParts.push(`d.lifecycle_scope = $${params.length}`);
  }
  if (productSurface) {
    whereParts.push(`d.managed_status = 'managed'`);
    whereParts.push(`COALESCE(d.provider, '') <> ''`);
    whereParts.push(`COALESCE(d.metadata->'connection'->>'host', d.metadata->'network'->>'host', d.metadata->>'host', d.metadata->>'ip', '') <> ''`);
    whereParts.push(`COALESCE(d.metadata->'connection'->>'port', d.metadata->'network'->>'port', d.metadata->>'port', '') <> ''`);
    whereParts.push(`NOT (
      COALESCE(d.device_uid, '') ~* '(candidate|test|incomplete|conflict|readiness-|evt-|mon-|rt-|demo|dev-bulk)'
      OR COALESCE(d.device_name, '') ~* '(candidate|test|incomplete|conflict|readiness-|evt-|mon-|rt-|demo|dev-bulk)'
    )`);
  }

  params.push(limit);
  params.push(offset);

  const query = `
    SELECT d.company_id, d.device_uid, d.provider, d.device_name, d.active, d.metadata,
           d.site_id,
           s.site_key,
           s.site_name,
           s.status AS site_status,
           d.managed_status, d.discovery_status, d.discovered_by_agent_id, d.source,
           d.claimed_at, d.claimed_by_key_id, d.last_seen_at, d.discovery_metadata,
           d.manageability_status, d.manageability_reason, d.manageability_updated_at, d.manageability_last_proven_at,
           d.remediation_manual_status, d.remediation_manual_note, d.remediation_manual_owner,
           d.remediation_manual_updated_at, d.remediation_manual_updated_by_key_id,
           d.lifecycle_scope,
           d.created_at, d.updated_at
    FROM devices d
    LEFT JOIN sites s
      ON s.company_id = d.company_id
     AND s.site_id = d.site_id
    WHERE ${whereParts.join(' AND ')}
    ORDER BY d.device_uid ASC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
  `;

  return { query, params };
}

function normalizeRemediationManualStatus(value) {
  const normalized = normalizeLower(value);
  if (!normalized) {
    return '';
  }
  if (normalized === 'clear' || normalized === 'none' || normalized === 'null') {
    return '__null__';
  }
  return normalized;
}

async function listDevices(db, {
  companyId,
  provider,
  deviceUid,
  siteId,
  managedStatus,
  manageabilityStatus,
  remediationManualStatus,
  lifecycleScope,
  productSurface,
  limit,
  offset
}) {
  const normalizedProvider = normalizeLower(provider);
  const normalizedDeviceUid = normalizeText(deviceUid);
  const normalizedSiteId = normalizeText(siteId);
  const normalizedManagedStatus = normalizeLower(managedStatus);
  const normalizedManageabilityStatus = normalizeLower(manageabilityStatus);
  const normalizedRemediationManualStatus = normalizeRemediationManualStatus(remediationManualStatus);
  const normalizedLifecycleScope = normalizeLower(lifecycleScope);
  const { query, params } = buildListQuery({
    companyId,
    provider: normalizedProvider || null,
    deviceUid: normalizedDeviceUid || null,
    siteId: normalizedSiteId || null,
    managedStatus: normalizedManagedStatus || null,
    manageabilityStatus: normalizedManageabilityStatus || null,
    remediationManualStatus: normalizedRemediationManualStatus || null,
    lifecycleScope: normalizedLifecycleScope || null,
    productSurface: productSurface === true,
    limit,
    offset
  });
  const res = await db.query(query, params);
  return res.rows;
}

async function getDevice(db, companyId, deviceUid) {
  const normalizedDeviceUid = normalizeText(deviceUid);
  if (!normalizedDeviceUid) {
    return null;
  }
  const res = await db.query(`
    SELECT d.company_id, d.device_uid, d.provider, d.device_name, d.active, d.metadata,
           d.site_id,
           s.site_key,
           s.site_name,
           s.status AS site_status,
           d.managed_status, d.discovery_status, d.discovered_by_agent_id, d.source,
           d.claimed_at, d.claimed_by_key_id, d.last_seen_at, d.discovery_metadata,
           d.manageability_status, d.manageability_reason, d.manageability_updated_at, d.manageability_last_proven_at,
           d.remediation_manual_status, d.remediation_manual_note, d.remediation_manual_owner,
           d.remediation_manual_updated_at, d.remediation_manual_updated_by_key_id,
           d.lifecycle_scope,
           d.created_at, d.updated_at
    FROM devices d
    LEFT JOIN sites s
      ON s.company_id = d.company_id
     AND s.site_id = d.site_id
    WHERE d.company_id = $1 AND d.device_uid = $2
    LIMIT 1
  `, [companyId, normalizedDeviceUid]);

  return res.rows[0] || null;
}

function validateUpsertPayload(payload) {
  if (Object.prototype.hasOwnProperty.call(payload, 'metadata') && !isPlainObject(payload.metadata)) {
    throw { code: 'invalid_request', detail: 'metadata must be an object' };
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'active')
    && payload.active !== null
    && typeof payload.active !== 'boolean') {
    throw { code: 'invalid_request', detail: 'active must be boolean' };
  }
}

async function upsertDevice(db, companyId, deviceUid, payload) {
  const normalizedDeviceUid = normalizeText(deviceUid);
  if (!normalizedDeviceUid) {
    throw { code: 'invalid_request', detail: 'device_uid is required' };
  }
  const body = payload || {};
  validateUpsertPayload(body);

  const hasProvider = Object.prototype.hasOwnProperty.call(body, 'provider');
  const hasDeviceName = Object.prototype.hasOwnProperty.call(body, 'device_name');
  const hasActive = Object.prototype.hasOwnProperty.call(body, 'active');
  const hasMetadata = Object.prototype.hasOwnProperty.call(body, 'metadata');

  const providerValue = hasProvider ? normalizeLower(body.provider) : null;
  const deviceNameValue = hasDeviceName ? normalizeText(body.device_name) : null;
  const metadataValue = hasMetadata ? body.metadata : {};
  const activeValue = hasActive ? body.active : true;

  const res = await db.query(`
    INSERT INTO devices (
      company_id, device_uid, provider, device_name, active, metadata, source, lifecycle_scope
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
    ON CONFLICT (company_id, device_uid) DO UPDATE
      SET provider = CASE WHEN $9 THEN EXCLUDED.provider ELSE devices.provider END,
          device_name = CASE WHEN $10 THEN EXCLUDED.device_name ELSE devices.device_name END,
          active = CASE WHEN $11 THEN EXCLUDED.active ELSE devices.active END,
          metadata = CASE WHEN $12 THEN EXCLUDED.metadata ELSE devices.metadata END,
          source = COALESCE(NULLIF(devices.source, ''), EXCLUDED.source),
          lifecycle_scope = CASE
            WHEN devices.lifecycle_scope = 'bridge_ops' THEN devices.lifecycle_scope
            ELSE EXCLUDED.lifecycle_scope
          END,
          updated_at = now()
    RETURNING company_id, device_uid, provider, device_name, active, metadata,
              site_id,
              managed_status, discovery_status, discovered_by_agent_id, source,
              claimed_at, claimed_by_key_id, last_seen_at, discovery_metadata,
              manageability_status, manageability_reason, manageability_updated_at, manageability_last_proven_at,
              remediation_manual_status, remediation_manual_note, remediation_manual_owner,
              remediation_manual_updated_at, remediation_manual_updated_by_key_id,
              lifecycle_scope,
              created_at, updated_at
  `, [
    companyId,
    normalizedDeviceUid,
    providerValue,
    deviceNameValue,
    activeValue,
    JSON.stringify(metadataValue || {}),
    'ingest',
    'ingest_only',
    hasProvider,
    hasDeviceName,
    hasActive,
    hasMetadata
  ]);

  return res.rows[0];
}

async function upsertDeviceMinimal(db, companyId, deviceUid, payload) {
  const normalizedDeviceUid = normalizeText(deviceUid);
  if (!normalizedDeviceUid) {
    return null;
  }
  const body = payload || {};
  const hasProvider = Object.prototype.hasOwnProperty.call(body, 'provider');
  const hasMetadata = Object.prototype.hasOwnProperty.call(body, 'metadata')
    && isPlainObject(body.metadata);

  const providerValue = hasProvider ? normalizeLower(body.provider) : null;
  const metadataValue = hasMetadata ? body.metadata : {};

  try {
    const res = await db.query(`
      INSERT INTO devices (
        company_id, device_uid, provider, active, metadata, source, lifecycle_scope
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
      ON CONFLICT (company_id, device_uid) DO UPDATE
        SET provider = CASE WHEN $8 THEN $3 ELSE devices.provider END,
            metadata = CASE WHEN $9 THEN $5::jsonb ELSE devices.metadata END,
            source = COALESCE(NULLIF(devices.source, ''), EXCLUDED.source),
            lifecycle_scope = CASE
              WHEN devices.lifecycle_scope = 'bridge_ops' THEN devices.lifecycle_scope
              ELSE EXCLUDED.lifecycle_scope
            END,
            updated_at = now()
      RETURNING company_id, device_uid, provider, device_name, active, metadata,
                site_id,
                managed_status, discovery_status, discovered_by_agent_id, source,
                claimed_at, claimed_by_key_id, last_seen_at, discovery_metadata,
                manageability_status, manageability_reason, manageability_updated_at, manageability_last_proven_at,
                remediation_manual_status, remediation_manual_note, remediation_manual_owner,
                remediation_manual_updated_at, remediation_manual_updated_by_key_id,
                lifecycle_scope,
                created_at, updated_at
    `, [
      companyId,
      normalizedDeviceUid,
      providerValue,
      true,
      JSON.stringify(metadataValue || {}),
      'ingest',
      'ingest_only',
      hasProvider,
      hasMetadata
    ]);
    return res.rows[0];
  } catch (err) {
    console.error('DEVICE AUTO-REGISTER FAILED:', err);
    return null;
  }
}

module.exports = {
  listDevices,
  getDevice,
  upsertDevice,
  upsertDeviceMinimal
};
