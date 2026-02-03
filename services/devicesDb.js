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

function buildListQuery({ companyId, provider, deviceUid, limit, offset }) {
  const whereParts = ['company_id = $1'];
  const params = [companyId];

  if (provider) {
    params.push(provider);
    whereParts.push(`provider = $${params.length}`);
  }
  if (deviceUid) {
    params.push(deviceUid);
    whereParts.push(`device_uid = $${params.length}`);
  }

  params.push(limit);
  params.push(offset);

  const query = `
    SELECT company_id, device_uid, provider, device_name, active, metadata, created_at, updated_at
    FROM devices
    WHERE ${whereParts.join(' AND ')}
    ORDER BY device_uid ASC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
  `;

  return { query, params };
}

async function listDevices(db, { companyId, provider, deviceUid, limit, offset }) {
  const normalizedProvider = normalizeLower(provider);
  const normalizedDeviceUid = normalizeText(deviceUid);
  const { query, params } = buildListQuery({
    companyId,
    provider: normalizedProvider || null,
    deviceUid: normalizedDeviceUid || null,
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
    SELECT company_id, device_uid, provider, device_name, active, metadata, created_at, updated_at
    FROM devices
    WHERE company_id = $1 AND device_uid = $2
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
      company_id, device_uid, provider, device_name, active, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    ON CONFLICT (company_id, device_uid) DO UPDATE
      SET provider = CASE WHEN $7 THEN EXCLUDED.provider ELSE devices.provider END,
          device_name = CASE WHEN $8 THEN EXCLUDED.device_name ELSE devices.device_name END,
          active = CASE WHEN $9 THEN EXCLUDED.active ELSE devices.active END,
          metadata = CASE WHEN $10 THEN EXCLUDED.metadata ELSE devices.metadata END,
          updated_at = now()
    RETURNING company_id, device_uid, provider, device_name, active, metadata, created_at, updated_at
  `, [
    companyId,
    normalizedDeviceUid,
    providerValue,
    deviceNameValue,
    activeValue,
    JSON.stringify(metadataValue || {}),
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
        company_id, device_uid, provider, active, metadata
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (company_id, device_uid) DO UPDATE
        SET provider = CASE WHEN $6 THEN $3 ELSE devices.provider END,
            metadata = CASE WHEN $7 THEN $5::jsonb ELSE devices.metadata END,
            updated_at = now()
      RETURNING company_id, device_uid, provider, device_name, active, metadata, created_at, updated_at
    `, [
      companyId,
      normalizedDeviceUid,
      providerValue,
      true,
      JSON.stringify(metadataValue || {}),
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
