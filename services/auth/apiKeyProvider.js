const ROLE_RANK = {
  viewer: 1,
  operator: 2,
  admin: 3
};

function normalizeRole(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return ROLE_RANK[trimmed] ? trimmed : null;
}

function getKeyPrefix(rawKey) {
  if (!rawKey) {
    return null;
  }
  const key = String(rawKey);
  if (!key) {
    return null;
  }
  return key.slice(0, Math.min(8, key.length));
}

function buildFallbackRecord(rawKey, role) {
  return {
    key_id_or_prefix: getKeyPrefix(rawKey),
    company_id: 'DEFAULT',
    role,
    active: true,
    source: 'fallback'
  };
}

async function lookupApiKeyInDb(rawKey) {
  let db;
  try {
    db = require('../../db');
  } catch (err) {
    return { dbAvailable: false };
  }

  try {
    const res = await db.query(
      `
      SELECT id, company_id, role, active
      FROM api_keys
      WHERE api_key = $1
      LIMIT 1
      `,
      [rawKey]
    );
    if (res.rows.length === 0) {
      return { dbAvailable: true, record: null };
    }
    const row = res.rows[0];
    const role = normalizeRole(row.role);
    if (!role) {
      return { dbAvailable: true, record: null };
    }
    const record = {
      key_id_or_prefix: String(row.id),
      company_id: row.company_id,
      role,
      active: row.active !== false,
      source: 'db'
    };

    if (record.active) {
      try {
        await db.query(
          `
          UPDATE api_keys
          SET last_used_at = NOW()
          WHERE id = $1
          `,
          [row.id]
        );
      } catch (err) {
        console.error('API key last_used_at update failed:', err);
      }
    }

    return { dbAvailable: true, record };
  } catch (err) {
    if (err && err.code === '42P01') {
      return { dbAvailable: false };
    }
    console.error('API key lookup failed:', err);
    return { dbAvailable: true, record: null };
  }
}

function lookupFallbackKey(rawKey) {
  if (!rawKey) {
    return null;
  }
  const adminKey = process.env.DEFAULT_API_KEY;
  if (adminKey && rawKey === adminKey) {
    return buildFallbackRecord(rawKey, 'admin');
  }
  const operatorKey = process.env.DEFAULT_API_KEY_OPERATOR;
  if (operatorKey && rawKey === operatorKey) {
    return buildFallbackRecord(rawKey, 'operator');
  }
  const viewerKey = process.env.DEFAULT_API_KEY_VIEWER;
  if (viewerKey && rawKey === viewerKey) {
    return buildFallbackRecord(rawKey, 'viewer');
  }
  return null;
}

async function resolveApiKeyRecord(rawKey) {
  if (!rawKey) {
    return null;
  }
  const dbResult = await lookupApiKeyInDb(rawKey);
  if (dbResult.dbAvailable) {
    return dbResult.record;
  }
  return lookupFallbackKey(rawKey);
}

module.exports = {
  resolveApiKeyRecord
};
