const { sendError } = require('./errorEnvelope');
const { toBool } = require('../../services/envBool');
const { resolveApiKeyRecord } = require('../../services/auth/apiKeyProvider');
const { resolveSessionFromRequest } = require('../../services/auth/sessionAuth');
const db = require('../../db');

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

function getRequestOrigin(req) {
  const value = req.get('origin') || req.get('referer') || '';
  if (!value) {
    return '';
  }
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return '';
  }
}

function getExpectedOrigin(req) {
  const host = req.get('host');
  if (!host) {
    return '';
  }
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${host}`;
}

function isUnsafeMethod(req) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method || '').toUpperCase());
}

function enforceSessionOrigin(req, res) {
  if (!isUnsafeMethod(req)) {
    return true;
  }
  const origin = getRequestOrigin(req);
  if (!origin) {
    return true;
  }
  if (origin !== getExpectedOrigin(req)) {
    buildAuthError(res, 403, 'csrf_origin_mismatch');
    return false;
  }
  return true;
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
    resolveSessionFromRequest(db, req)
      .then(session => {
        if (!session) {
          return buildAuthError(res, 401, 'missing_credentials');
        }
        if (!enforceSessionOrigin(req, res)) {
          return null;
        }
        req.ctx = {
          company_id: session.company_id,
          role: session.role,
          user_id: session.user_id,
          session_id: session.session_id,
          auth_kind: 'session'
        };
        req.auth = req.ctx;
        return next();
      })
      .catch(err => {
        console.error('Session auth failed:', err);
        return buildAuthError(res, 401, 'invalid_session');
      });
    return;
  }

  resolveApiKeyRecord(apiKey)
    .then(record => {
      if (!record || record.active === false || !record.company_id || !record.role) {
        return buildAuthError(res, 401, 'invalid_api_key');
      }
      req.ctx = {
        company_id: record.company_id,
        role: record.role,
        key_id_or_prefix: record.key_id_or_prefix || null,
        auth_kind: 'api_key'
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

function requireHumanSession(req, res, next) {
  resolveSessionFromRequest(db, req)
    .then(session => {
      if (!session) {
        return res.redirect('/login/');
      }
      if (!enforceSessionOrigin(req, res)) {
        return null;
      }
      req.ctx = {
        company_id: session.company_id,
        role: session.role,
        user_id: session.user_id,
        session_id: session.session_id,
        auth_kind: 'session'
      };
      req.auth = req.ctx;
      return next();
    })
    .catch(err => {
      console.error('Product session auth failed:', err);
      return res.redirect('/login/');
    });
}

module.exports = {
  buildAuthError,
  requireApiKey,
  requireHumanSession,
  requireRole,
  enforceCompanyScope,
  isAuthRequired
};
