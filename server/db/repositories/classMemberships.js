const db = require('../index');

async function add({ classId, userId, role }) {
  const result = await db.query(
    `INSERT INTO class_memberships (class_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (class_id, user_id)
     DO UPDATE SET role = EXCLUDED.role
     RETURNING *`,
    [classId, userId, role]
  );
  return result.rows[0];
}

async function listByClass(classId) {
  const result = await db.query(
    `SELECT cm.*, u.name, u.email
     FROM class_memberships cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.class_id = $1
     ORDER BY cm.created_at ASC`,
    [classId]
  );
  return result.rows;
}

module.exports = {
  add,
  listByClass
};
