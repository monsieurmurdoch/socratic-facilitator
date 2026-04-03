const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const usersRepo = require('./db/repositories/users');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-socratic-secret-change-me';
const HASH_KEYLEN = 64;
const USER_ROLES = ['Admin', 'SuperAdmin', 'Teacher', 'Student', 'Parent'];
const SELF_SERVICE_ROLES = ['Teacher', 'Student', 'Parent'];

function normalizeEmail(email = '') {
  return email.trim().toLowerCase();
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, HASH_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve, reject) => {
    const [salt, key] = String(storedHash || '').split(':');
    if (!salt || !key) return resolve(false);

    crypto.scrypt(password, salt, HASH_KEYLEN, (err, derivedKey) => {
      if (err) return reject(err);
      const expected = Buffer.from(key, 'hex');
      if (expected.length !== derivedKey.length) return resolve(false);
      resolve(crypto.timingSafeEqual(expected, derivedKey));
    });
  });
}

function generateToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function normalizeRole(role, fallback = 'Teacher') {
  const match = USER_ROLES.find(r => r.toLowerCase() === String(role || '').trim().toLowerCase());
  return match || fallback;
}

async function attachUser(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await usersRepo.findById(payload.userId);
    req.user = user || null;
  } catch (error) {
    req.user = null;
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

module.exports = {
  USER_ROLES,
  SELF_SERVICE_ROLES,
  normalizeEmail,
  normalizeRole,
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  attachUser,
  requireAuth,
  requireAnyRole
};
