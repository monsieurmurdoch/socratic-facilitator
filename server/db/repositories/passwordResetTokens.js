const db = require('../index');

async function create({
  userId,
  tokenHash,
  expiresAt,
  requestedIp = null,
  requestedUserAgent = null
}) {
  const result = await db.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip, requested_user_agent)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, tokenHash, expiresAt, requestedIp, requestedUserAgent]
  );
  return result.rows[0];
}

async function findActiveByHash(tokenHash) {
  const result = await db.query(
    `SELECT *
     FROM password_reset_tokens
     WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

async function markUsed(id) {
  const result = await db.query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE id = $1
       AND used_at IS NULL
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function revokeAllForUser(userId) {
  await db.query(
    `UPDATE password_reset_tokens
     SET used_at = NOW()
     WHERE user_id = $1
       AND used_at IS NULL`,
    [userId]
  );
}

module.exports = {
  create,
  findActiveByHash,
  markUsed,
  revokeAllForUser
};
