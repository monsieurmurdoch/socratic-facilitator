const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const usersRepo = require('./db/repositories/users');
const authSessionsRepo = require('./db/repositories/authSessions');

const scryptAsync = promisify(crypto.scrypt);

const JWT_SECRET = process.env.JWT_SECRET || 'dev-socratic-secret-change-me';
const AUTH_TOKEN_TTL = process.env.AUTH_TOKEN_TTL || '30d';
const HASH_KEYLEN = 64;
const USER_ROLES = ['Admin', 'SuperAdmin', 'Teacher', 'Student', 'Parent'];
const SELF_SERVICE_ROLES = ['Teacher', 'Student', 'Parent'];

if (process.env.NODE_ENV === 'production' && JWT_SECRET === 'dev-socratic-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}

function normalizeEmail(email = '') {
  return String(email || '').trim().toLowerCase();
}

function normalizeRole(role, fallback = 'Teacher') {
  const match = USER_ROLES.find(r => r.toLowerCase() === String(role || '').trim().toLowerCase());
  return match || fallback;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = await scryptAsync(password, salt, HASH_KEYLEN);
  return `${salt}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [salt, key] = String(storedHash || '').split(':');
  if (!salt || !key) return false;

  const derivedKey = await scryptAsync(password, salt, HASH_KEYLEN);
  const expected = Buffer.from(key, 'hex');
  if (expected.length !== derivedKey.length) return false;
  return crypto.timingSafeEqual(expected, derivedKey);
}

function parseTtlMs(ttl = AUTH_TOKEN_TTL) {
  if (typeof ttl === 'number') return ttl;
  const value = String(ttl || '').trim().toLowerCase();
  const match = value.match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2] || 'ms';
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };
  return amount * (multipliers[unit] || multipliers.ms);
}

async function issueAuthToken(user, {
  sessionLabel = null,
  userAgent = null,
  ipAddress = null,
  expiresIn = AUTH_TOKEN_TTL
} = {}) {
  const tokenJti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + parseTtlMs(expiresIn));
  const session = await authSessionsRepo.create({
    userId: user.id,
    tokenJti,
    sessionLabel,
    userAgent,
    ipAddress,
    expiresAt
  });

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      sessionId: session.id,
      jti: tokenJti
    },
    JWT_SECRET,
    { expiresIn }
  );

  return { token, session };
}

async function authenticateToken(token, { touch = true } = {}) {
  const payload = jwt.verify(token, JWT_SECRET);
  const sessionId = payload.sessionId || null;
  if (!sessionId) {
    return null;
  }

  const session = await authSessionsRepo.findActiveById(sessionId);
  if (!session || session.token_jti !== payload.jti) {
    return null;
  }

  if (touch) {
    await authSessionsRepo.touch(session.id);
  }

  const user = await usersRepo.findById(payload.userId);
  if (!user) return null;

  return { payload, user, session };
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

async function attachUser(req, _res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    req.user = null;
    req.authSession = null;
    return next();
  }

  try {
    const token = authHeader.slice(7);
    const auth = await authenticateToken(token);
    req.user = auth?.user || null;
    req.authSession = auth?.session || null;
  } catch (_error) {
    req.user = null;
    req.authSession = null;
  }

  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireAnyRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

async function generateToken(user, opts = {}) {
  const { token } = await issueAuthToken(user, opts);
  return token;
}

module.exports = {
  USER_ROLES,
  SELF_SERVICE_ROLES,
  normalizeEmail,
  normalizeRole,
  hashPassword,
  verifyPassword,
  issueAuthToken,
  authenticateToken,
  generateToken,
  verifyToken,
  attachUser,
  requireAuth,
  requireAnyRole
};
