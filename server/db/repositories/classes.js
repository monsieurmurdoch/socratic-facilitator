const db = require('../index');

async function create({ ownerUserId, name, description = null, ageRange = null }) {
  const result = await db.query(
    `INSERT INTO classes (owner_user_id, name, description, age_range)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [ownerUserId, name, description, ageRange]
  );
  return result.rows[0];
}

async function listByOwner(ownerUserId) {
  const result = await db.query(
    `SELECT
      c.*,
      COUNT(s.id) AS session_count
     FROM classes c
     LEFT JOIN sessions s ON s.class_id = c.id
     WHERE c.owner_user_id = $1
     GROUP BY c.id
     ORDER BY c.created_at DESC`,
    [ownerUserId]
  );
  return result.rows;
}

async function listByUser(userId) {
  const result = await db.query(
    `SELECT
      c.*,
      COALESCE(cm.role, 'Teacher') AS membership_role,
      COUNT(DISTINCT s.id) AS session_count
     FROM classes c
     JOIN class_memberships cm ON cm.class_id = c.id
     LEFT JOIN sessions s ON s.class_id = c.id
     WHERE cm.user_id = $1
     GROUP BY c.id, cm.role
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function findOwnedByUser(classId, ownerUserId) {
  const result = await db.query(
    `SELECT *
     FROM classes
     WHERE id = $1 AND owner_user_id = $2`,
    [classId, ownerUserId]
  );
  return result.rows[0] || null;
}

async function findById(classId) {
  const result = await db.query(
    `SELECT *
     FROM classes
     WHERE id = $1`,
    [classId]
  );
  return result.rows[0] || null;
}

module.exports = {
  create,
  listByOwner,
  listByUser,
  findOwnedByUser,
  findById
};
