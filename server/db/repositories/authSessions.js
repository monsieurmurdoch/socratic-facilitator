const db = require('../index');

async function create({
  userId,
  tokenJti,
  sessionLabel = null,
  userAgent = null,
  ipAddress = null,
  expiresAt
}) {
  const result = await db.query(
    `INSERT INTO auth_sessions (user_id, token_jti, session_label, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, tokenJti, sessionLabel, userAgent, ipAddress, expiresAt]
  );
  return result.rows[0];
}

async function findActiveById(id) {
  const result = await db.query(
    `SELECT *
     FROM auth_sessions
     WHERE id = $1
       AND revoked_at IS NULL
       AND expires_at > NOW()`,
    [id]
  );
  return result.rows[0] || null;
}

async function touch(id) {
  await db.query(
    `UPDATE auth_sessions
     SET last_seen_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

async function listByUser(userId) {
  const result = await db.query(
    `SELECT *
     FROM auth_sessions
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function revoke(id, reason = 'manual') {
  const result = await db.query(
    `UPDATE auth_sessions
     SET revoked_at = NOW(), revoke_reason = $2
     WHERE id = $1
       AND revoked_at IS NULL
     RETURNING *`,
    [id, reason]
  );
  return result.rows[0] || null;
}

async function revokeAllForUser(userId, reason = 'manual_all') {
  const result = await db.query(
    `UPDATE auth_sessions
     SET revoked_at = NOW(), revoke_reason = $2
     WHERE user_id = $1
       AND revoked_at IS NULL
     RETURNING *`,
    [userId, reason]
  );
  return result.rows;
}

module.exports = {
  create,
  findActiveById,
  touch,
  listByUser,
  revoke,
  revokeAllForUser
};
