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

/**
 * List distinct students linked to a parent, with user info.
 */
async function listLinkedStudents(parentUserId) {
  const result = await db.query(
    `SELECT DISTINCT ON (u.id)
      u.id,
      u.name,
      u.email,
      u.role
     FROM parent_student_links psl
     JOIN users u ON u.id = psl.student_user_id
     WHERE psl.parent_user_id = $1
     ORDER BY u.id, psl.created_at DESC`,
    [parentUserId]
  );
  return result.rows;
}

/**
 * Link a parent to a student by their emails.
 * Called by teachers/admins — looks up both users by email.
 * Creates links for each class the student has participated in.
 */
async function linkByEmails(parentEmail, studentEmail) {
  // Find parent user
  const parentResult = await db.query(
    `SELECT id, name, email, role FROM users WHERE email = $1`,
    [parentEmail.toLowerCase().trim()]
  );
  const parent = parentResult.rows[0];
  if (!parent) return { linked: false, error: 'Parent not found' };
  if (parent.role !== 'Parent') return { linked: false, error: 'Target user is not a Parent account' };

  // Find student user
  const studentResult = await db.query(
    `SELECT id, name, email, role FROM users WHERE email = $1`,
    [studentEmail.toLowerCase().trim()]
  );
  const student = studentResult.rows[0];
  if (!student) return { linked: false, error: 'Student not found' };
  if (student.id === parent.id) return { linked: false, error: 'Cannot link parent to themselves' };

  // Find classes the student has participated in via sessions
  const classResult = await db.query(
    `SELECT DISTINCT c.id
     FROM classes c
     JOIN sessions s ON s.class_id = c.id
     JOIN session_memberships sm ON sm.session_id = s.id
     WHERE sm.user_id = $1`,
    [student.id]
  );

  if (classResult.rows.length === 0) {
    return { linked: false, error: 'Student has not joined any classes yet. Linking will happen automatically when they join.' };
  }

  let linksCreated = 0;
  for (const cls of classResult.rows) {
    const result = await db.query(
      `INSERT INTO parent_student_links (class_id, parent_user_id, student_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (class_id, parent_user_id, student_user_id) DO NOTHING
       RETURNING *`,
      [cls.id, parent.id, student.id]
    );
    if (result.rows[0]) linksCreated++;
  }

  return {
    linked: true,
    parent: { id: parent.id, name: parent.name, email: parent.email },
    student: { id: student.id, name: student.name, email: student.email },
    linksCreated
  };
}

/**
 * Get session history for a specific linked student (visible to parent).
 */
async function getStudentSessionsForParent(parentUserId, studentUserId) {
  // Verify the parent is linked to this student
  const linkCheck = await db.query(
    `SELECT 1 FROM parent_student_links
     WHERE parent_user_id = $1 AND student_user_id = $2
     LIMIT 1`,
    [parentUserId, studentUserId]
  );
  if (linkCheck.rows.length === 0) return [];

  const result = await db.query(
    `SELECT
      s.id,
      s.short_code,
      s.title,
      s.status,
      s.created_at,
      sm.message_count,
      sm.estimated_speaking_seconds,
      sm.contribution_score
     FROM session_memberships sm
     JOIN sessions s ON s.id = sm.session_id
     WHERE sm.user_id = $1
     ORDER BY s.created_at DESC`,
    [studentUserId]
  );
  return result.rows;
}

module.exports = {
  add,
  listByClass,
  listStudentsForParent,
  listLinkedStudents,
  linkByEmails,
  getStudentSessionsForParent
};
