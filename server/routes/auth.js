const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const usersRepo = require('../db/repositories/users');
const authSessionsRepo = require('../db/repositories/authSessions');
const passwordResetTokensRepo = require('../db/repositories/passwordResetTokens');
const {
  normalizeEmail,
  normalizeRole,
  SELF_SERVICE_ROLES,
  hashPassword,
  verifyPassword,
  issueAuthToken,
  requireAuth
} = require('../auth');
const { logAudit, getRequestIp } = require('../audit');

router.use(express.json({ limit: '1mb' }));

const loginAttempts = new Map();
const DEFAULT_DEMO_TEACHER = {
  name: process.env.DEMO_TEACHER_NAME || 'Demo Teacher',
  email: normalizeEmail(process.env.DEMO_TEACHER_EMAIL || 'teacher@socratic.local'),
  password: process.env.DEMO_TEACHER_PASSWORD || 'plato-demo'
};

function isDemoTeacherEnabled() {
  return process.env.DEMO_TEACHER_LOGIN_ENABLED === 'true' || process.env.NODE_ENV !== 'production';
}

function getDemoTeacherConfig() {
  return {
    enabled: isDemoTeacherEnabled(),
    name: DEFAULT_DEMO_TEACHER.name,
    email: DEFAULT_DEMO_TEACHER.email
  };
}

function getClientKey(req, email = '') {
  return `${getRequestIp(req) || 'unknown'}:${normalizeEmail(email) || 'unknown'}`;
}

function registerFailedLogin(req, email = '') {
  const key = getClientKey(req, email);
  const current = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  const count = current.count + 1;
  const lockedUntil = count >= 8 ? Date.now() + (15 * 60 * 1000) : 0;
  loginAttempts.set(key, { count, lockedUntil });
}

function clearFailedLogin(req, email = '') {
  loginAttempts.delete(getClientKey(req, email));
}

function ensureLoginAllowed(req, email = '') {
  const entry = loginAttempts.get(getClientKey(req, email));
  if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
    const remaining = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return `Too many login attempts. Try again in ${remaining} seconds.`;
  }
  return null;
}

function formatUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.created_at
  };
}

function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

router.get('/demo-teacher', (_req, res) => {
  res.json(getDemoTeacherConfig());
});

router.post('/demo-teacher/login', async (req, res) => {
  try {
    if (!isDemoTeacherEnabled()) {
      return res.status(403).json({ error: 'Demo teacher login is not enabled' });
    }

    const passwordHash = await hashPassword(DEFAULT_DEMO_TEACHER.password);
    const user = await usersRepo.upsertDemoTeacher({
      name: DEFAULT_DEMO_TEACHER.name,
      email: DEFAULT_DEMO_TEACHER.email,
      passwordHash
    });

    const { token, session } = await issueAuthToken(user, {
      sessionLabel: 'Demo Teacher',
      userAgent: req.headers['user-agent'] || null,
      ipAddress: getRequestIp(req)
    });

    await logAudit({
      req,
      actorUserId: user.id,
      action: 'auth.demo_teacher_logged_in',
      entityType: 'auth_session',
      entityId: session.id,
      metadata: { sessionId: session.id }
    });

    res.json({
      user: formatUser(user),
      token,
      demoTeacher: {
        name: DEFAULT_DEMO_TEACHER.name,
        email: DEFAULT_DEMO_TEACHER.email
      }
    });
  } catch (error) {
    console.error('Demo teacher login error:', error);
    res.status(500).json({ error: 'Failed to sign in as demo teacher' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = normalizeEmail(req.body.email || '');
    const password = String(req.body.password || '');
    const role = normalizeRole(req.body.role || 'Teacher');

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (!SELF_SERVICE_ROLES.includes(role)) {
      return res.status(403).json({ error: 'That role must be assigned by an administrator' });
    }

    const existing = await usersRepo.findWithPasswordByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists' });
    }

    const passwordHash = await hashPassword(password);
    const user = await usersRepo.create({ name, email, role, passwordHash });
    const { token, session } = await issueAuthToken(user, {
      sessionLabel: 'Web',
      userAgent: req.headers['user-agent'] || null,
      ipAddress: getRequestIp(req)
    });

    await logAudit({
      req,
      actorUserId: user.id,
      action: 'auth.registered',
      entityType: 'user',
      entityId: user.id,
      metadata: { role, sessionId: session.id }
    });

    res.status(201).json({ user: formatUser(user), token });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email || '');
    const password = String(req.body.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const blockReason = ensureLoginAllowed(req, email);
    if (blockReason) {
      return res.status(429).json({ error: blockReason });
    }

    const user = await usersRepo.findWithPasswordByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      registerFailedLogin(req, email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    clearFailedLogin(req, email);

    const { token, session } = await issueAuthToken(user, {
      sessionLabel: 'Web',
      userAgent: req.headers['user-agent'] || null,
      ipAddress: getRequestIp(req)
    });

    await logAudit({
      req,
      actorUserId: user.id,
      action: 'auth.logged_in',
      entityType: 'auth_session',
      entityId: session.id,
      metadata: { sessionId: session.id }
    });

    res.json({ user: formatUser(user), token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Failed to sign in' });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  res.json({ user: formatUser(req.user) });
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const user = await usersRepo.findWithPasswordByEmail(req.user.email);
    if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const passwordHash = await hashPassword(newPassword);
    await usersRepo.updatePassword(user.id, passwordHash);
    await passwordResetTokensRepo.revokeAllForUser(user.id);
    await authSessionsRepo.revokeAllForUser(user.id, 'password_changed');

    await logAudit({
      req,
      actorUserId: user.id,
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

router.post('/password-reset/request', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email || '');
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await usersRepo.findWithPasswordByEmail(email);
    const response = { ok: true };

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(rawToken);
      const expiresAt = new Date(Date.now() + (60 * 60 * 1000));
      await passwordResetTokensRepo.create({
        userId: user.id,
        tokenHash,
        expiresAt,
        requestedIp: getRequestIp(req),
        requestedUserAgent: req.headers['user-agent'] || null
      });

      await logAudit({
        req,
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
        entityType: 'user',
        entityId: user.id
      });

      if (process.env.NODE_ENV !== 'production' || process.env.PASSWORD_RESET_DEBUG_TOKENS === 'true') {
        response.debugResetToken = rawToken;
      }
    }

    res.json(response);
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ error: 'Failed to request password reset' });
  }
});

router.post('/password-reset/confirm', async (req, res) => {
  try {
    const token = String(req.body.token || '');
    const newPassword = String(req.body.newPassword || '');
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Reset token and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const passwordReset = await passwordResetTokensRepo.findActiveByHash(hashResetToken(token));
    if (!passwordReset) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await hashPassword(newPassword);
    await usersRepo.updatePassword(passwordReset.user_id, passwordHash);
    await passwordResetTokensRepo.markUsed(passwordReset.id);
    await passwordResetTokensRepo.revokeAllForUser(passwordReset.user_id);
    await authSessionsRepo.revokeAllForUser(passwordReset.user_id, 'password_reset');

    await logAudit({
      req,
      actorUserId: passwordReset.user_id,
      action: 'auth.password_reset_confirmed',
      entityType: 'password_reset_token',
      entityId: passwordReset.id
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Password reset confirm error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const sessions = await authSessionsRepo.listByUser(req.user.id);
    res.json(sessions.map(session => ({
      id: session.id,
      sessionLabel: session.session_label,
      userAgent: session.user_agent,
      ipAddress: session.ip_address,
      createdAt: session.created_at,
      lastSeenAt: session.last_seen_at,
      expiresAt: session.expires_at,
      revokedAt: session.revoked_at,
      revokeReason: session.revoke_reason
    })));
  } catch (error) {
    console.error('List auth sessions error:', error);
    res.status(500).json({ error: 'Failed to load sessions' });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  try {
    if (req.authSession?.id) {
      await authSessionsRepo.revoke(req.authSession.id, 'logout');
      await logAudit({
        req,
        actorUserId: req.user.id,
        action: 'auth.logged_out',
        entityType: 'auth_session',
        entityId: req.authSession.id
      });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Failed to log out' });
  }
});

router.post('/sessions/:id/revoke', requireAuth, async (req, res) => {
  try {
    const session = await authSessionsRepo.findById(req.params.id);
    if (!session || session.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const revoked = await authSessionsRepo.revoke(session.id, 'manual_revoke');

    await logAudit({
      req,
      actorUserId: req.user.id,
      action: 'auth.session_revoked',
      entityType: 'auth_session',
      entityId: revoked.id
    });

    res.json({ ok: true });
  } catch (error) {
    console.error('Revoke auth session error:', error);
    res.status(500).json({ error: 'Failed to revoke session' });
  }
});

router.post('/sessions/revoke-all', requireAuth, async (req, res) => {
  try {
    const revoked = await authSessionsRepo.revokeAllForUser(req.user.id, 'manual_revoke_all');
    await logAudit({
      req,
      actorUserId: req.user.id,
      action: 'auth.sessions_revoked_all',
      entityType: 'user',
      entityId: req.user.id,
      metadata: { revokedCount: revoked.length }
    });
    res.json({ ok: true, revokedCount: revoked.length });
  } catch (error) {
    console.error('Revoke all auth sessions error:', error);
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
});

module.exports = router;
