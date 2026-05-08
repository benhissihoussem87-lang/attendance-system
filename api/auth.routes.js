const express = require('express');
const router = express.Router();

const db = require('../db');
const { sendError } = require('./lib/errorEnvelope');
const { toBool } = require('../services/envBool');
const {
  clearSessionCookie,
  createUser,
  getSessionTokenFromRequest,
  loginWithPassword,
  resolveSessionFromRequest,
  revokeSessionToken,
  setSessionCookie
} = require('../services/auth/sessionAuth');

function getExpectedOrigin(req) {
  const host = req.get('host');
  if (!host) return '';
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${host}`;
}

function originAllowed(req) {
  const originHeader = req.get('origin') || req.get('referer') || '';
  if (!originHeader) return true;
  try {
    const parsed = new URL(originHeader);
    return `${parsed.protocol}//${parsed.host}` === getExpectedOrigin(req);
  } catch (_) {
    return false;
  }
}

function authError(res, status, error) {
  return sendError(res, {
    status,
    code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
    message: status === 401 ? 'Unauthorized' : 'Forbidden',
    details: { kind: status === 401 ? 'auth' : 'authz', error },
    error: status === 401 ? 'unauthorized' : 'forbidden'
  });
}

router.post('/login', async (req, res) => {
  try {
    if (!originAllowed(req)) {
      return authError(res, 403, 'csrf_origin_mismatch');
    }
    const result = await loginWithPassword(db, {
      email: req.body && req.body.email,
      password: req.body && req.body.password,
      metadata: {
        user_agent: req.get('user-agent') || null,
        ip: req.ip || null
      }
    });
    if (result.error) {
      return authError(res, 401, result.error);
    }
    setSessionCookie(res, result.value.token);
    return res.json({ user: result.value.user, session_expires_at: result.value.session.expires_at });
  } catch (err) {
    console.error('login failed:', err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.post('/logout', async (req, res) => {
  try {
    if (!originAllowed(req)) {
      return authError(res, 403, 'csrf_origin_mismatch');
    }
    await revokeSessionToken(db, getSessionTokenFromRequest(req));
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (err) {
    console.error('logout failed:', err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const session = await resolveSessionFromRequest(db, req);
    if (!session) {
      return authError(res, 401, 'missing_or_invalid_session');
    }
    return res.json({ user: {
      id: session.user_id,
      company_id: session.company_id,
      email: session.email,
      role: session.role,
      active: session.active
    }, session: {
      id: session.session_id,
      expires_at: session.expires_at
    } });
  } catch (err) {
    console.error('me failed:', err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

router.post('/bootstrap-admin', async (req, res) => {
  try {
    if (!originAllowed(req)) {
      return authError(res, 403, 'csrf_origin_mismatch');
    }
    if (!toBool(process.env.AUTH_BOOTSTRAP_ADMIN_ENABLED)) {
      return authError(res, 403, 'bootstrap_disabled');
    }
    const expected = process.env.AUTH_BOOTSTRAP_SECRET;
    if (!expected || req.get('x-bootstrap-secret') !== expected) {
      return authError(res, 403, 'invalid_bootstrap_secret');
    }
    const result = await createUser(db, {
      company_id: req.body && req.body.company_id,
      email: req.body && req.body.email,
      password: req.body && req.body.password,
      role: 'admin',
      active: true
    });
    if (result.error) {
      return sendError(res, {
        status: result.error === 'password_min_length' ? 400 : 409,
        code: result.error === 'password_min_length' ? 'VALIDATION_ERROR' : 'CONFLICT',
        message: result.error === 'password_min_length' ? 'Validation failed' : 'Conflict',
        details: { kind: result.error === 'password_min_length' ? 'validation' : 'conflict', error: result.error }
      });
    }
    return res.status(201).json({ user: result.value });
  } catch (err) {
    if (err && err.code === '23505') {
      return sendError(res, { status: 409, code: 'CONFLICT', message: 'Conflict', details: { kind: 'conflict', error: 'user_already_exists' } });
    }
    console.error('bootstrap admin failed:', err);
    return sendError(res, { status: 500, code: 'INTERNAL_ERROR', message: 'Server error' });
  }
});

module.exports = router;
