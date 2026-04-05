const db = require('../index');

async function create({
  actorUserId = null,
  targetUserId = null,
  action,
  entityType = null,
  entityId = null,
  ipAddress = null,
  userAgent = null,
  metadata = {}
}) {
  const result = await db.query(
    `INSERT INTO audit_logs (
      actor_user_id, target_user_id, action, entity_type, entity_id, ip_address, user_agent, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      actorUserId,
      targetUserId,
      action,
      entityType,
      entityId,
      ipAddress,
      userAgent,
      JSON.stringify(metadata || {})
    ]
  );
  return result.rows[0];
}

async function listRecent(limit = 50) {
  const result = await db.query(
    `SELECT
      al.*,
      actor.name AS actor_name,
      actor.email AS actor_email,
      target.name AS target_name,
      target.email AS target_email
     FROM audit_logs al
     LEFT JOIN users actor ON actor.id = al.actor_user_id
     LEFT JOIN users target ON target.id = al.target_user_id
     ORDER BY al.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

module.exports = {
  create,
  listRecent
};
