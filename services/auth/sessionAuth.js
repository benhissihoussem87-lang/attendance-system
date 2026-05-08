const crypto = require('crypto');

const SESSION_COOKIE_NAME = process.env.AUTH_SESSION_COOKIE_NAME || 'attendance_session';
const PASSWORD_ALGO = 'scrypt_v1';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 12;

const ROLE_RANK = {
  viewer: 1,
  operator: 2,
  admin: 3
};

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function normalizeRole(role) {
  const value = typeof role === 'string' ? role.trim().toLowerCase() : '';
  return ROLE_RANK[value] ? value : null;
}

function randomToken(byteLength = 32) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function scryptAsync(password, salt, options = {}) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password || ''),
      salt,
      KEY_LENGTH,
      {
        N: options.n || SCRYPT_N,
        r: options.r || SCRYPT_R,
        p: options.p || SCRYPT_P,
        maxmem: 64 * 1024 * 1024
      },
      (err, derivedKey) => err ? reject(err) : resolve(derivedKey)
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const derived = await scryptAsync(password, salt);
  return [PASSWORD_ALGO, SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, derived.toString('base64url')].join('$');
}

function parsePasswordHash(encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== PASSWORD_ALGO) {
    return null;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null;
  }
  return {
    algo: parts[0],
    n,
    r,
    p,
    salt: parts[4],
    hash: parts[5]
  };
}

async function verifyPassword(password, encoded) {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) {
    return false;
  }
  const derived = await scryptAsync(password, parsed.salt, parsed);
  const expected = Buffer.from(parsed.hash, 'base64url');
  if (expected.length !== derived.length) {
    return false;
  }
  return crypto.timingSafeEqual(expected, derived);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return;
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req && req.headers ? req.headers.cookie : '');
  return cookies[SESSION_COOKIE_NAME] || '';
}

function sessionCookieOptions() {
  const secure = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: process.env.AUTH_COOKIE_SAMESITE || 'Lax',
    secure,
    path: '/',
    maxAge: Number(process.env.AUTH_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS) * 1000
  };
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: process.env.AUTH_COOKIE_SAMESITE || 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_id: row.company_id,
    email: row.email,
    role: row.role,
    active: row.active !== false,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  };
}

async function findUserByEmail(db, email) {
  const emailNormalized = normalizeEmail(email);
  if (!emailNormalized) return null;
  const res = await db.query(
    `SELECT id, company_id, email, email_normalized, password_hash, password_algo, role, active, last_login_at, created_at, updated_at
     FROM public.users
     WHERE email_normalized = $1
     LIMIT 1`,
    [emailNormalized]
  );
  return res.rows[0] || null;
}

async function createUser(db, input) {
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const emailNormalized = normalizeEmail(email);
  const role = normalizeRole(input.role) || 'admin';
  const companyId = typeof input.company_id === 'string' && input.company_id.trim() ? input.company_id.trim() : 'DEFAULT';
  if (!email || !emailNormalized) {
    return { error: 'email_required' };
  }
  if (!input.password || String(input.password).length < 8) {
    return { error: 'password_min_length' };
  }
  const passwordHash = await hashPassword(input.password);
  const res = await db.query(
    `INSERT INTO public.users (company_id, email, email_normalized, password_hash, password_algo, role, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, company_id, email, role, active, last_login_at, created_at, updated_at`,
    [companyId, email, emailNormalized, passwordHash, PASSWORD_ALGO, role, input.active === false ? false : true]
  );
  return { value: publicUser(res.rows[0]) };
}

async function createSession(db, user, metadata = {}) {
  const token = randomToken(32);
  const tokenHash = hashToken(token);
  const ttlSeconds = Number(process.env.AUTH_SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
  const res = await db.query(
    `INSERT INTO public.user_sessions (user_id, company_id, session_token_hash, expires_at, metadata)
     VALUES ($1, $2, $3, NOW() + ($4::text || ' seconds')::interval, $5::jsonb)
     RETURNING id, user_id, company_id, created_at, last_seen_at, expires_at, revoked_at, metadata`,
    [user.id, user.company_id, tokenHash, ttlSeconds, JSON.stringify(metadata || {})]
  );
  return { token, session: res.rows[0] };
}

async function loginWithPassword(db, { email, password, metadata }) {
  const user = await findUserByEmail(db, email);
  if (!user || user.active === false) {
    return { error: 'invalid_credentials' };
  }
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    return { error: 'invalid_credentials' };
  }
  const session = await createSession(db, user, metadata || {});
  await db.query('UPDATE public.users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1', [user.id]);
  return { value: { user: publicUser({ ...user, last_login_at: new Date().toISOString() }), token: session.token, session: session.session } };
}

async function resolveSessionToken(db, token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const res = await db.query(
    `SELECT s.id AS session_id, s.user_id, s.company_id, s.created_at AS session_created_at,
            s.last_seen_at, s.expires_at, s.revoked_at, s.metadata AS session_metadata,
            u.email, u.role, u.active, u.last_login_at, u.created_at AS user_created_at, u.updated_at AS user_updated_at
     FROM public.user_sessions s
     JOIN public.users u ON u.id = s.user_id
     WHERE s.session_token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND u.active = true
     LIMIT 1`,
    [tokenHash]
  );
  const row = res.rows[0];
  if (!row) return null;
  await db.query('UPDATE public.user_sessions SET last_seen_at = NOW() WHERE id = $1', [row.session_id]);
  return {
    session_id: row.session_id,
    user_id: row.user_id,
    company_id: row.company_id,
    email: row.email,
    role: row.role,
    active: row.active !== false,
    expires_at: row.expires_at,
    source: 'session'
  };
}

async function resolveSessionFromRequest(db, req) {
  return resolveSessionToken(db, getSessionTokenFromRequest(req));
}

async function revokeSessionToken(db, token) {
  if (!token) return false;
  const tokenHash = hashToken(token);
  const res = await db.query(
    `UPDATE public.user_sessions
     SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE session_token_hash = $1 AND revoked_at IS NULL
     RETURNING id`,
    [tokenHash]
  );
  return res.rows.length > 0;
}

module.exports = {
  SESSION_COOKIE_NAME,
  PASSWORD_ALGO,
  ROLE_RANK,
  clearSessionCookie,
  createUser,
  getSessionTokenFromRequest,
  hashPassword,
  hashToken,
  loginWithPassword,
  normalizeEmail,
  normalizeRole,
  publicUser,
  resolveSessionFromRequest,
  resolveSessionToken,
  revokeSessionToken,
  setSessionCookie,
  verifyPassword
};
