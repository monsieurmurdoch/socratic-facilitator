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
     ORDER BY c.sort_order NULLS LAST, c.created_at DESC`,
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

async function update(classId, fields) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of [['name', 'name'], ['description', 'description'], ['ageRange', 'age_range']]) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = $${i}`);
      values.push(fields[key]);
      i++;
    }
  }
  if (sets.length === 0) return findById(classId);
  values.push(classId);
  const result = await db.query(
    `UPDATE classes SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

async function reorder(ownerUserId, orderedIds) {
  // Only update classes owned by this user
  for (let i = 0; i < orderedIds.length; i++) {
    await db.query(
      `UPDATE classes SET sort_order = $1 WHERE id = $2 AND owner_user_id = $3`,
      [i, orderedIds[i], ownerUserId]
    );
  }
}

module.exports = {
  create,
  listByOwner,
  listByUser,
  findOwnedByUser,
  findById,
  update,
  reorder
};
