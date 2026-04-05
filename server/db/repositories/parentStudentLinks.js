const db = require('../index');

async function add({ classId, parentUserId, studentUserId }) {
  const result = await db.query(
    `INSERT INTO parent_student_links (class_id, parent_user_id, student_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (class_id, parent_user_id, student_user_id) DO NOTHING
     RETURNING *`,
    [classId, parentUserId, studentUserId]
  );
  return result.rows[0] || null;
}

async function listByClass(classId) {
  const result = await db.query(
    `SELECT
      psl.*,
      parent.name AS parent_name,
      parent.email AS parent_email,
      student.name AS student_name,
      student.email AS student_email
     FROM parent_student_links psl
     JOIN users parent ON parent.id = psl.parent_user_id
     JOIN users student ON student.id = psl.student_user_id
     WHERE psl.class_id = $1
     ORDER BY psl.created_at ASC`,
    [classId]
  );
  return result.rows;
}

async function listStudentsForParent(parentUserId) {
  const result = await db.query(
    `SELECT *
     FROM parent_student_links
     WHERE parent_user_id = $1`,
    [parentUserId]
  );
  return result.rows;
}

module.exports = {
  add,
  listByClass,
  listStudentsForParent
};
