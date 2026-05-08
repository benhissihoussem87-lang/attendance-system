function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function normalizeSiteStatus(value, fallback = 'active') {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'active' || normalized === 'inactive') {
    return normalized;
  }
  throw { code: 'invalid_request', detail: 'status must be one of active, inactive' };
}

function normalizeSiteKey(value) {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) {
    return '';
  }
  const slug = raw
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

function deriveSiteKey(siteName) {
  const normalizedName = normalizeText(siteName).toLowerCase();
  if (!normalizedName) {
    return '';
  }
  const slug = normalizedName
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug;
}

function normalizeUuidOrNull(value) {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw { code: 'invalid_request', detail: 'site_id must be a valid UUID' };
  }
  return raw;
}

function normalizeMetadata(value) {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw { code: 'invalid_request', detail: 'metadata must be an object' };
  }
  return value;
}

async function getSiteLeaseByIdTx(db, { companyId, leaseId }) {
  if (!leaseId) {
    return null;
  }
  const res = await db.query(
    `
    SELECT
      l.lease_id,
      l.company_id,
      l.site_id,
      l.agent_id,
      l.status,
      l.leased_at,
      l.released_at,
      l.leased_by_key_id,
      l.released_by_key_id,
      l.superseded_by_lease_id,
      l.metadata,
      l.created_at,
      l.updated_at,
      a.agent_name,
      a.status AS agent_status,
      a.last_seen_at AS agent_last_seen_at,
      a.last_heartbeat_at AS agent_last_heartbeat_at,
      a.site_id AS agent_site_id
    FROM site_agent_leases l
    LEFT JOIN agent_nodes a
      ON a.company_id = l.company_id
     AND a.id = l.agent_id
    WHERE l.company_id = $1
      AND l.lease_id = $2
    LIMIT 1
    `,
    [companyId, leaseId]
  );
  return res.rows[0] || null;
}

async function getSiteById(db, { companyId, siteId }) {
  const normalizedSiteId = normalizeUuidOrNull(siteId);
  if (!normalizedSiteId) {
    return null;
  }
  const res = await db.query(
    `
    SELECT
      s.site_id,
      s.company_id,
      s.site_key,
      s.site_name,
      s.status,
      s.metadata,
      s.created_at,
      s.updated_at,
      l.lease_id AS active_lease_id,
      l.agent_id AS active_agent_id,
      l.leased_at AS active_leased_at,
      a.agent_name AS active_agent_name,
      a.status AS active_agent_status,
      a.last_seen_at AS active_agent_last_seen_at,
      a.last_heartbeat_at AS active_agent_last_heartbeat_at
    FROM sites s
    LEFT JOIN site_agent_leases l
      ON l.company_id = s.company_id
     AND l.site_id = s.site_id
     AND l.status = 'active'
    LEFT JOIN agent_nodes a
      ON a.company_id = l.company_id
     AND a.id = l.agent_id
    WHERE s.company_id = $1
      AND s.site_id = $2
    LIMIT 1
    `,
    [companyId, normalizedSiteId]
  );
  return res.rows[0] || null;
}

async function listSites(db, { companyId, status, productSurface, limit, offset }) {
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
  const safeOffset = Number.isInteger(offset) ? Math.max(offset, 0) : 0;
  const params = [companyId];
  const where = ['company_id = $1'];
  const normalizedStatus = normalizeText(status).toLowerCase();
  if (normalizedStatus) {
    if (normalizedStatus !== 'active' && normalizedStatus !== 'inactive') {
      throw { code: 'invalid_request', detail: 'status must be one of active, inactive' };
    }
    params.push(normalizedStatus);
    where.push(`status = $${params.length}`);
  }
  if (productSurface) {
    where.push(`status = 'active'`);
    where.push(`NOT (
      COALESCE(s.site_key, '') ~* '(lease-site-|hq-[0-9a-f]{8}|contract|test)'
      OR COALESCE(s.site_name, '') ~* '(lease-site-|hq-[0-9a-f]{8}|contract|test)'
      OR COALESCE(s.metadata->>'purpose', '') ~* '(contract_test|test_fixture|demo)'
    )`);
  }

  params.push(safeLimit);
  params.push(safeOffset);

  const res = await db.query(
    `
    SELECT
      s.site_id,
      s.company_id,
      s.site_key,
      s.site_name,
      s.status,
      s.metadata,
      s.created_at,
      s.updated_at,
      l.lease_id AS active_lease_id,
      l.agent_id AS active_agent_id,
      l.leased_at AS active_leased_at,
      a.agent_name AS active_agent_name,
      a.status AS active_agent_status,
      a.last_seen_at AS active_agent_last_seen_at,
      a.last_heartbeat_at AS active_agent_last_heartbeat_at
    FROM sites s
    LEFT JOIN site_agent_leases l
      ON l.company_id = s.company_id
     AND l.site_id = s.site_id
     AND l.status = 'active'
    LEFT JOIN agent_nodes a
      ON a.company_id = l.company_id
     AND a.id = l.agent_id
    WHERE ${where.map(part => part.replace(/\bcompany_id\b/g, 's.company_id').replace(/\bstatus\b/g, 's.status')).join(' AND ')}
    ORDER BY s.site_name ASC, s.site_key ASC, s.created_at ASC
    LIMIT $${params.length - 1}
    OFFSET $${params.length}
    `,
    params
  );
  return res.rows;
}

async function createSite(db, { companyId, siteKey, siteName, status, metadata }) {
  const normalizedSiteName = normalizeText(siteName);
  if (!normalizedSiteName) {
    throw { code: 'invalid_request', detail: 'site_name is required' };
  }
  if (normalizedSiteName.length > 255) {
    throw { code: 'invalid_request', detail: 'site_name max length is 255' };
  }

  const providedKey = normalizeSiteKey(siteKey);
  const derivedKey = deriveSiteKey(normalizedSiteName);
  const normalizedSiteKey = providedKey || derivedKey;
  if (!normalizedSiteKey) {
    throw { code: 'invalid_request', detail: 'site_key is required or must be derivable from site_name' };
  }
  if (normalizedSiteKey.length < 2 || normalizedSiteKey.length > 120) {
    throw { code: 'invalid_request', detail: 'site_key length must be between 2 and 120' };
  }

  const normalizedStatus = normalizeSiteStatus(status, 'active');
  const normalizedMetadata = normalizeMetadata(metadata);

  try {
    const res = await db.query(
      `
      INSERT INTO sites (
        company_id,
        site_key,
        site_name,
        status,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING site_id, company_id, site_key, site_name, status, metadata, created_at, updated_at
      `,
      [
        companyId,
        normalizedSiteKey,
        normalizedSiteName,
        normalizedStatus,
        JSON.stringify(normalizedMetadata || {})
      ]
    );
    const row = res.rows[0] || null;
    if (!row) {
      return null;
    }
    return {
      ...row,
      active_lease_id: null,
      active_agent_id: null,
      active_leased_at: null,
      active_agent_name: null,
      active_agent_status: null,
      active_agent_last_seen_at: null,
      active_agent_last_heartbeat_at: null
    };
  } catch (err) {
    if (err && err.code === '23505' && err.constraint === 'ux_sites_company_site_key') {
      throw { code: 'conflict', detail: 'site_key already exists for company' };
    }
    throw err;
  }
}

async function ensureDefaultSiteForCompany(db, {
  companyId,
  siteKey = 'default-site',
  siteName = 'Default Site',
  timezone = 'Africa/Tunis',
  metadata
}) {
  const normalizedCompanyId = normalizeText(companyId);
  if (!normalizedCompanyId) {
    throw { code: 'invalid_request', detail: 'company_id is required' };
  }
  const normalizedSiteKey = normalizeSiteKey(siteKey);
  if (!normalizedSiteKey) {
    throw { code: 'invalid_request', detail: 'site_key is required' };
  }
  const normalizedSiteName = normalizeText(siteName);
  if (!normalizedSiteName) {
    throw { code: 'invalid_request', detail: 'site_name is required' };
  }
  const normalizedMetadata = normalizeMetadata(metadata || {});
  const mergedMetadata = {
    ...normalizedMetadata,
    timezone: normalizeText(timezone) || normalizedMetadata.timezone || 'Africa/Tunis',
    product_default_site: true
  };

  const res = await db.query(
    `
    INSERT INTO sites (
      company_id,
      site_key,
      site_name,
      status,
      metadata
    )
    VALUES ($1, $2, $3, 'active', $4::jsonb)
    ON CONFLICT (company_id, site_key)
    DO UPDATE SET
      site_name = EXCLUDED.site_name,
      status = 'active',
      metadata = sites.metadata || EXCLUDED.metadata,
      updated_at = now()
    RETURNING site_id, company_id, site_key, site_name, status, metadata, created_at, updated_at
    `,
    [
      normalizedCompanyId,
      normalizedSiteKey,
      normalizedSiteName,
      JSON.stringify(mergedMetadata)
    ]
  );
  const row = res.rows[0] || null;
  if (!row) {
    return null;
  }
  return getSiteById(db, {
    companyId: normalizedCompanyId,
    siteId: row.site_id
  });
}

async function updateSite(db, { companyId, siteId, siteName, status, metadata }) {
  const normalizedSiteId = normalizeUuidOrNull(siteId);
  if (!normalizedSiteId) {
    throw { code: 'invalid_request', detail: 'site_id is required' };
  }

  const updates = [];
  const params = [companyId, normalizedSiteId];

  if (siteName !== undefined) {
    const normalizedSiteName = normalizeText(siteName);
    if (!normalizedSiteName) {
      throw { code: 'invalid_request', detail: 'site_name cannot be empty when provided' };
    }
    if (normalizedSiteName.length > 255) {
      throw { code: 'invalid_request', detail: 'site_name max length is 255' };
    }
    params.push(normalizedSiteName);
    updates.push(`site_name = $${params.length}`);
  }

  if (status !== undefined) {
    const normalizedStatus = normalizeSiteStatus(status, 'active');
    params.push(normalizedStatus);
    updates.push(`status = $${params.length}`);
  }

  if (metadata !== undefined) {
    params.push(JSON.stringify(normalizeMetadata(metadata) || {}));
    updates.push(`metadata = $${params.length}::jsonb`);
  }

  if (updates.length === 0) {
    throw {
      code: 'invalid_request',
      detail: 'at least one of site_name, status, metadata is required'
    };
  }

  const res = await db.query(
    `
    UPDATE sites
    SET ${updates.join(', ')},
        updated_at = now()
    WHERE company_id = $1
      AND site_id = $2
    RETURNING site_id, company_id, site_key, site_name, status, metadata, created_at, updated_at
    `,
    params
  );
  const row = res.rows[0] || null;
  if (!row) {
    return null;
  }
  const withLease = await getSiteById(db, { companyId, siteId: row.site_id });
  return withLease || row;
}

async function setAgentSiteAssignment(db, { companyId, agentId, siteId }) {
  const normalizedAgentId = normalizeText(agentId);
  if (!normalizedAgentId) {
    throw { code: 'invalid_request', detail: 'agent_id is required' };
  }
  const normalizedSiteId = normalizeUuidOrNull(siteId);
  if (siteId !== undefined && siteId !== null && normalizeText(siteId) && !normalizedSiteId) {
    throw { code: 'invalid_request', detail: 'site_id must be a valid UUID' };
  }

  const res = await db.query(
    `
    WITH updated AS (
      UPDATE agent_nodes
      SET site_id = $3,
          updated_at = now()
      WHERE company_id = $1
        AND id = $2
      RETURNING id, company_id, agent_name, status, last_seen_at, last_heartbeat_at, created_at, site_id
    )
    SELECT
      u.id,
      u.company_id,
      u.agent_name,
      u.status,
      u.last_seen_at,
      u.last_heartbeat_at,
      u.created_at,
      u.site_id,
      s.site_key,
      s.site_name,
      s.status AS site_status
    FROM updated u
    LEFT JOIN sites s
      ON s.company_id = u.company_id
     AND s.site_id = u.site_id
    `,
    [companyId, normalizedAgentId, normalizedSiteId]
  );
  return res.rows[0] || null;
}

async function setDeviceSiteAssignment(db, { companyId, deviceUid, siteId }) {
  const normalizedDeviceUid = normalizeText(deviceUid);
  if (!normalizedDeviceUid) {
    throw { code: 'invalid_request', detail: 'device_uid is required' };
  }
  const normalizedSiteId = normalizeUuidOrNull(siteId);
  if (siteId !== undefined && siteId !== null && normalizeText(siteId) && !normalizedSiteId) {
    throw { code: 'invalid_request', detail: 'site_id must be a valid UUID' };
  }

  const res = await db.query(
    `
    WITH updated AS (
      UPDATE devices
      SET site_id = $3,
          updated_at = now()
      WHERE company_id = $1
        AND device_uid = $2
      RETURNING company_id, device_uid, provider, device_name, managed_status, lifecycle_scope, site_id, updated_at
    )
    SELECT
      u.company_id,
      u.device_uid,
      u.provider,
      u.device_name,
      u.managed_status,
      u.lifecycle_scope,
      u.site_id,
      u.updated_at,
      s.site_key,
      s.site_name,
      s.status AS site_status
    FROM updated u
    LEFT JOIN sites s
      ON s.company_id = u.company_id
     AND s.site_id = u.site_id
    `,
    [companyId, normalizedDeviceUid, normalizedSiteId]
  );
  return res.rows[0] || null;
}

async function getSiteActiveAgentLease(db, { companyId, siteId }) {
  const normalizedSiteId = normalizeUuidOrNull(siteId);
  if (!normalizedSiteId) {
    return null;
  }
  const res = await db.query(
    `
    SELECT
      l.lease_id,
      l.company_id,
      l.site_id,
      l.agent_id,
      l.status,
      l.leased_at,
      l.released_at,
      l.leased_by_key_id,
      l.released_by_key_id,
      l.superseded_by_lease_id,
      l.metadata,
      l.created_at,
      l.updated_at,
      a.agent_name,
      a.status AS agent_status,
      a.last_seen_at AS agent_last_seen_at,
      a.last_heartbeat_at AS agent_last_heartbeat_at,
      a.site_id AS agent_site_id
    FROM site_agent_leases l
    LEFT JOIN agent_nodes a
      ON a.company_id = l.company_id
     AND a.id = l.agent_id
    WHERE l.company_id = $1
      AND l.site_id = $2
      AND l.status = 'active'
    LIMIT 1
    `,
    [companyId, normalizedSiteId]
  );
  return res.rows[0] || null;
}

async function listSiteAgentLeaseHistory(db, { companyId, siteId, limit, offset }) {
  const normalizedSiteId = normalizeUuidOrNull(siteId);
  if (!normalizedSiteId) {
    throw { code: 'invalid_request', detail: 'site_id is required' };
  }
  const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
  const safeOffset = Number.isInteger(offset) ? Math.max(offset, 0) : 0;
  const res = await db.query(
    `
    SELECT
      l.lease_id,
      l.company_id,
      l.site_id,
      l.agent_id,
      l.status,
      l.leased_at,
      l.released_at,
      l.leased_by_key_id,
      l.released_by_key_id,
      l.superseded_by_lease_id,
      l.metadata,
      l.created_at,
      l.updated_at,
      a.agent_name,
      a.status AS agent_status,
      a.last_seen_at AS agent_last_seen_at,
      a.last_heartbeat_at AS agent_last_heartbeat_at,
      a.site_id AS agent_site_id
    FROM site_agent_leases l
    LEFT JOIN agent_nodes a
      ON a.company_id = l.company_id
     AND a.id = l.agent_id
    WHERE l.company_id = $1
      AND l.site_id = $2
    ORDER BY l.leased_at DESC, l.created_at DESC
    LIMIT $3
    OFFSET $4
    `,
    [companyId, normalizedSiteId, safeLimit, safeOffset]
  );
  return res.rows;
}

async function setSiteActiveAgentLease(db, {
  companyId,
  siteId,
  agentId,
  leasedByKeyId,
  metadata
}) {
  const normalizedSiteId = normalizeUuidOrNull(siteId);
  if (!normalizedSiteId) {
    throw { code: 'invalid_request', detail: 'site_id is required' };
  }
  const normalizedAgentId = agentId === null || agentId === undefined
    ? null
    : normalizeUuidOrNull(agentId);
  if (agentId !== null && agentId !== undefined && !normalizedAgentId) {
    throw { code: 'invalid_request', detail: 'agent_id must be a valid UUID or null' };
  }
  const normalizedMetadata = normalizeMetadata(metadata);
  const metadataJson = JSON.stringify(normalizedMetadata || {});

  await db.query('BEGIN');
  try {
    const siteRes = await db.query(
      `
      SELECT site_id, company_id, site_key, site_name, status
      FROM sites
      WHERE company_id = $1
        AND site_id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [companyId, normalizedSiteId]
    );
    const siteRow = siteRes.rows[0] || null;
    if (!siteRow) {
      await db.query('ROLLBACK');
      return { error: 'site_not_found' };
    }

    const activeRes = await db.query(
      `
      SELECT lease_id, agent_id
      FROM site_agent_leases
      WHERE company_id = $1
        AND site_id = $2
        AND status = 'active'
      LIMIT 1
      FOR UPDATE
      `,
      [companyId, normalizedSiteId]
    );
    const currentActive = activeRes.rows[0] || null;

    if (!normalizedAgentId) {
      if (!currentActive) {
        await db.query('COMMIT');
        return {
          value: {
            action: 'no_change',
            site: siteRow,
            active_lease: null,
            previous_active_lease: null
          }
        };
      }
      const releaseRes = await db.query(
        `
        UPDATE site_agent_leases
        SET status = 'released',
            released_at = now(),
            released_by_key_id = $3,
            metadata = metadata || $4::jsonb,
            updated_at = now()
        WHERE lease_id = $1
          AND company_id = $2
        RETURNING lease_id
        `,
        [currentActive.lease_id, companyId, leasedByKeyId || null, metadataJson]
      );
      const releasedLease = await getSiteLeaseByIdTx(db, {
        companyId,
        leaseId: releaseRes.rows[0] ? releaseRes.rows[0].lease_id : null
      });
      await db.query('COMMIT');
      return {
        value: {
          action: 'released',
          site: siteRow,
          active_lease: null,
          previous_active_lease: releasedLease
        }
      };
    }

    const agentRes = await db.query(
      `
      SELECT id, company_id, site_id
      FROM agent_nodes
      WHERE company_id = $1
        AND id = $2
      LIMIT 1
      FOR UPDATE
      `,
      [companyId, normalizedAgentId]
    );
    const agentRow = agentRes.rows[0] || null;
    if (!agentRow) {
      await db.query('ROLLBACK');
      return { error: 'agent_not_found' };
    }

    if (currentActive && currentActive.agent_id === normalizedAgentId) {
      if (!agentRow.site_id || String(agentRow.site_id) !== normalizedSiteId) {
        await db.query(
          `
          UPDATE agent_nodes
          SET site_id = $3,
              updated_at = now()
          WHERE company_id = $1
            AND id = $2
          `,
          [companyId, normalizedAgentId, normalizedSiteId]
        );
      }
      const noChangeLease = await getSiteActiveAgentLease(db, {
        companyId,
        siteId: normalizedSiteId
      });
      await db.query('COMMIT');
      return {
        value: {
          action: 'no_change',
          site: siteRow,
          active_lease: noChangeLease,
          previous_active_lease: noChangeLease
        }
      };
    }

    let previousActiveLease = null;
    if (currentActive) {
      const supersededRes = await db.query(
        `
        UPDATE site_agent_leases
        SET status = 'superseded',
            released_at = now(),
            released_by_key_id = $3,
            metadata = metadata || $4::jsonb,
            updated_at = now()
        WHERE lease_id = $1
          AND company_id = $2
        RETURNING lease_id
        `,
        [currentActive.lease_id, companyId, leasedByKeyId || null, metadataJson]
      );
      previousActiveLease = await getSiteLeaseByIdTx(db, {
        companyId,
        leaseId: supersededRes.rows[0] ? supersededRes.rows[0].lease_id : null
      });
    }

    const insertRes = await db.query(
      `
      INSERT INTO site_agent_leases (
        company_id,
        site_id,
        agent_id,
        status,
        leased_at,
        leased_by_key_id,
        metadata
      )
      VALUES ($1, $2, $3, 'active', now(), $4, $5::jsonb)
      RETURNING lease_id
      `,
      [companyId, normalizedSiteId, normalizedAgentId, leasedByKeyId || null, metadataJson]
    );
    const insertedLeaseId = insertRes.rows[0] ? insertRes.rows[0].lease_id : null;

    if (previousActiveLease && insertedLeaseId) {
      await db.query(
        `
        UPDATE site_agent_leases
        SET superseded_by_lease_id = $2,
            updated_at = now()
        WHERE lease_id = $1
          AND company_id = $3
        `,
        [previousActiveLease.lease_id, insertedLeaseId, companyId]
      );
      previousActiveLease = await getSiteLeaseByIdTx(db, {
        companyId,
        leaseId: previousActiveLease.lease_id
      });
    }

    if (!agentRow.site_id || String(agentRow.site_id) !== normalizedSiteId) {
      await db.query(
        `
        UPDATE agent_nodes
        SET site_id = $3,
            updated_at = now()
        WHERE company_id = $1
          AND id = $2
        `,
        [companyId, normalizedAgentId, normalizedSiteId]
      );
    }

    const activeLease = await getSiteLeaseByIdTx(db, {
      companyId,
      leaseId: insertedLeaseId
    });

    await db.query('COMMIT');
    return {
      value: {
        action: previousActiveLease ? 'reassigned' : 'assigned',
        site: siteRow,
        active_lease: activeLease,
        previous_active_lease: previousActiveLease
      }
    };
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

module.exports = {
  normalizeUuidOrNull,
  getSiteById,
  listSites,
  createSite,
  ensureDefaultSiteForCompany,
  updateSite,
  setAgentSiteAssignment,
  setDeviceSiteAssignment,
  getSiteActiveAgentLease,
  listSiteAgentLeaseHistory,
  setSiteActiveAgentLease
};
