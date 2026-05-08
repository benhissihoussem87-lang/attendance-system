const crypto = require('crypto');
const db = require('../db');
const { sendError } = require('../api/lib/errorEnvelope');

function normalizeText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function hashSecret(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function randomToken(prefix, bytes = 24) {
  const entropy = crypto.randomBytes(bytes).toString('hex');
  return `${prefix}_${entropy}`;
}

function extractBearerToken(req) {
  const authHeader = normalizeText(req.get('authorization'));
  if (!authHeader) {
    return '';
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? normalizeText(match[1]) : '';
}

async function findAgentBySecret(rawSecret) {
  const secretHash = hashSecret(rawSecret);
  const runtimeRes = await db.query(
    `
    SELECT
      a.id,
      a.company_id,
      a.agent_name,
      a.status,
      a.credential_version,
      a.identity_status,
      a.active_runtime_identity_id,
      ari.identity_id AS runtime_identity_id,
      ari.status AS runtime_identity_status,
      ari.issued_at AS runtime_identity_issued_at,
      ari.revoked_at AS runtime_identity_revoked_at
    FROM agent_runtime_identities ari
    JOIN agent_nodes a
      ON a.company_id = ari.company_id
     AND a.id = ari.agent_id
    WHERE ari.credential_hash = $1
      AND ari.status = 'active'
    LIMIT 1
    `,
    [secretHash]
  );
  if (runtimeRes.rows[0]) {
    return runtimeRes.rows[0];
  }

  // Compatibility fallback: allow legacy bootstrap-only rows that predate runtime identity issuance.
  const legacyRes = await db.query(
    `
    SELECT
      id,
      company_id,
      agent_name,
      status,
      credential_version,
      identity_status,
      active_runtime_identity_id,
      NULL::uuid AS runtime_identity_id,
      'legacy_bootstrap'::text AS runtime_identity_status,
      NULL::timestamptz AS runtime_identity_issued_at,
      NULL::timestamptz AS runtime_identity_revoked_at
    FROM agent_nodes
    WHERE auth_secret_hash = $1
      AND COALESCE(identity_status, 'bootstrap_only') = 'bootstrap_only'
      AND active_runtime_identity_id IS NULL
    LIMIT 1
    `,
    [secretHash]
  );
  return legacyRes.rows[0] || null;
}

function requireAgentAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    return sendError(res, {
      status: 401,
      code: 'UNAUTHORIZED',
      message: 'Unauthorized',
      details: {
        kind: 'auth',
        error: 'missing_bearer_token'
      },
      error: 'unauthorized'
    });
  }

  findAgentBySecret(token)
    .then(agent => {
      if (!agent || agent.status !== 'active') {
        return sendError(res, {
          status: 401,
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
          details: {
            kind: 'auth',
            error: 'invalid_agent_token'
          },
          error: 'unauthorized'
        });
      }

      req.agent = {
        id: agent.id,
        company_id: agent.company_id,
        agent_name: agent.agent_name,
        credential_version: agent.credential_version,
        identity_status: agent.identity_status,
        runtime_identity_id: agent.runtime_identity_id || null,
        runtime_identity_status: agent.runtime_identity_status || null
      };
      return next();
    })
    .catch(err => {
      console.error('Agent auth failed:', err);
      return sendError(res, {
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
        details: {
          kind: 'auth',
          error: 'invalid_agent_token'
        },
        error: 'unauthorized'
      });
    });
}

module.exports = {
  normalizeText,
  hashSecret,
  randomToken,
  extractBearerToken,
  requireAgentAuth
};
