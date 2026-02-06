const { sendError } = require('./errorEnvelope');
const { toBool } = require('../../services/envBool');
const { resolveApiKeyRecord } = require('../../services/auth/apiKeyProvider');

const ROLE_RANK = {
  viewer: 1,
  operator: 2,
  admin: 3
};

function isAuthRequired() {
  return toBool(process.env.REQUIRE_AUTH);
}

function buildAuthError(res, status, error) {
  const isUnauthorized = status === 401;
  return sendError(res, {
    status,
    code: isUnauthorized ? 'UNAUTHORIZED' : 'FORBIDDEN',
    message: isUnauthorized ? 'Unauthorized' : 'Forbidden',
    details: {
      kind: isUnauthorized ? 'auth' : 'authz',
      error
    },
    error: isUnauthorized ? 'unauthorized' : 'forbidden'
  });
}

function getProvidedCompanyId(req) {
  const queryId = req.query && typeof req.query.company_id === 'string'
    ? req.query.company_id
    : null;
  const headerId = typeof req.get('x-company-id') === 'string'
    ? req.get('x-company-id')
    : null;
  return {
    queryId,
    headerId
  };
}

function getBodyCompanyId(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }
  return typeof body.company_id === 'string' ? body.company_id : null;
}

function enforceCompanyScope(req, res, next) {
  if (!req.ctx || !req.ctx.company_id) {
    return next();
  }
  const authCompanyId = req.ctx.company_id;
  const { queryId, headerId } = getProvidedCompanyId(req);
  const bodyId = getBodyCompanyId(req.body);
  const provided = [bodyId, queryId, headerId].filter(value => typeof value === 'string' && value.trim());

  if (provided.length === 0) {
    return next();
  }

  const mismatch = provided.some(value => value !== authCompanyId);
  if (mismatch) {
    return buildAuthError(res, 403, 'company_mismatch');
  }

  return next();
}

function requireApiKey(req, res, next) {
  if (!isAuthRequired()) {
    return next();
  }

  const apiKey = req.get('x-api-key');
  if (!apiKey) {
    return buildAuthError(res, 401, 'missing_api_key');
  }

  resolveApiKeyRecord(apiKey)
    .then(record => {
      if (!record || record.active === false || !record.company_id || !record.role) {
        return buildAuthError(res, 401, 'invalid_api_key');
      }
      req.ctx = {
        company_id: record.company_id,
        role: record.role,
        key_id_or_prefix: record.key_id_or_prefix || null
      };
      req.auth = req.ctx;
      return next();
    })
    .catch(err => {
      console.error('API key auth failed:', err);
      return buildAuthError(res, 401, 'invalid_api_key');
    });
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!isAuthRequired()) {
      return next();
    }
    const authRole = req.ctx && req.ctx.role ? req.ctx.role : null;
    if (!authRole) {
      return buildAuthError(res, 401, 'missing_api_key');
    }
    const authRank = ROLE_RANK[authRole] || 0;
    const requiredRank = ROLE_RANK[minRole] || 0;
    if (authRank < requiredRank) {
      return buildAuthError(res, 403, 'insufficient_role');
    }
    return next();
  };
}

module.exports = {
  requireApiKey,
  requireRole,
  enforceCompanyScope,
  isAuthRequired
};
