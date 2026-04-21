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

async function addFamilyLink({ parentUserId, studentUserId }) {
  const result = await db.query(
    `INSERT INTO parent_student_links (class_id, parent_user_id, student_user_id)
     VALUES (NULL, $1, $2)
     ON CONFLICT (parent_user_id, student_user_id) WHERE class_id IS NULL DO NOTHING
     RETURNING *`,
    [parentUserId, studentUserId]
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
    `SELECT
      u.id,
      u.name,
      u.email,
      u.role,
      sp.grade_level,
      sp.age_band,
      sp.reading_level,
      sp.guardian_notes,
      COUNT(DISTINCT psl.class_id) FILTER (WHERE psl.class_id IS NOT NULL) AS linked_class_count
     FROM parent_student_links psl
     JOIN users u ON u.id = psl.student_user_id
     LEFT JOIN student_profiles sp ON sp.user_id = u.id
     WHERE psl.parent_user_id = $1
     GROUP BY u.id, u.name, u.email, u.role, sp.grade_level, sp.age_band, sp.reading_level, sp.guardian_notes
     ORDER BY LOWER(u.name) ASC`,
    [parentUserId]
  );
  return result.rows;
}

async function createManagedStudent({ parentUserId, name, email, passwordHash, gradeLevel = null, ageBand = null, readingLevel = null }) {
  const result = await db.transaction(async (client) => {
    const userResult = await client.query(
      `INSERT INTO users (name, email, role, password_hash)
       VALUES ($1, $2, 'Student', $3)
       RETURNING id, name, email, role, created_at`,
      [name, email, passwordHash]
    );
    const student = userResult.rows[0];

    await client.query(
      `INSERT INTO student_profiles (user_id, grade_level, age_band, reading_level, managed_by_parent_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id)
       DO UPDATE SET
         grade_level = COALESCE(EXCLUDED.grade_level, student_profiles.grade_level),
         age_band = COALESCE(EXCLUDED.age_band, student_profiles.age_band),
         reading_level = COALESCE(EXCLUDED.reading_level, student_profiles.reading_level),
         managed_by_parent_user_id = COALESCE(student_profiles.managed_by_parent_user_id, EXCLUDED.managed_by_parent_user_id),
         updated_at = NOW()`,
      [student.id, gradeLevel, ageBand, readingLevel, parentUserId]
    );

    await client.query(
      `INSERT INTO parent_student_links (class_id, parent_user_id, student_user_id)
       VALUES (NULL, $1, $2)
       ON CONFLICT (parent_user_id, student_user_id) WHERE class_id IS NULL DO NOTHING`,
      [parentUserId, student.id]
    );

    return student;
  });

  return result;
}

async function updateStudentProfile({ parentUserId, studentUserId, gradeLevel = null, ageBand = null, readingLevel = null, guardianNotes = null }) {
  const linkCheck = await db.query(
    `SELECT 1 FROM parent_student_links
     WHERE parent_user_id = $1 AND student_user_id = $2
     LIMIT 1`,
    [parentUserId, studentUserId]
  );
  if (linkCheck.rows.length === 0) return null;

  const result = await db.query(
    `INSERT INTO student_profiles (user_id, grade_level, age_band, reading_level, guardian_notes, managed_by_parent_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id)
     DO UPDATE SET
       grade_level = EXCLUDED.grade_level,
       age_band = EXCLUDED.age_band,
       reading_level = EXCLUDED.reading_level,
       guardian_notes = EXCLUDED.guardian_notes,
       managed_by_parent_user_id = COALESCE(student_profiles.managed_by_parent_user_id, EXCLUDED.managed_by_parent_user_id),
       updated_at = NOW()
     RETURNING *`,
    [studentUserId, gradeLevel, ageBand, readingLevel, guardianNotes, parentUserId]
  );
  return result.rows[0] || null;
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

async function linkExistingStudentToParent({ parentUserId, studentEmail, profile = {} }) {
  const studentResult = await db.query(
    `SELECT id, name, email, role FROM users WHERE email = $1`,
    [studentEmail.toLowerCase().trim()]
  );
  const student = studentResult.rows[0];
  if (!student) return { linked: false, error: 'Student not found' };
  if (student.role !== 'Student') return { linked: false, error: 'Target user is not a Student account' };
  if (student.id === parentUserId) return { linked: false, error: 'Cannot link parent to themselves' };

  await addFamilyLink({ parentUserId, studentUserId: student.id });
  await updateStudentProfile({
    parentUserId,
    studentUserId: student.id,
    gradeLevel: profile.gradeLevel || null,
    ageBand: profile.ageBand || null,
    readingLevel: profile.readingLevel || null,
    guardianNotes: profile.guardianNotes || null
  });

  return {
    linked: true,
    student: { id: student.id, name: student.name, email: student.email }
  };
}

async function getParentDashboard(parentUserId) {
  const students = await listLinkedStudents(parentUserId);
  const studentIds = students.map(s => s.id);
  let statsByStudent = new Map();

  if (studentIds.length > 0) {
    const statsResult = await db.query(
      `SELECT
        sm.user_id,
        COUNT(DISTINCT sm.session_id) AS session_count,
        MAX(s.created_at) AS last_session_at,
        COALESCE(SUM(sm.message_count), 0) AS message_count,
        COALESCE(SUM(sm.estimated_speaking_seconds), 0) AS speaking_seconds,
        COALESCE(AVG(sm.contribution_score), 0) AS avg_contribution
       FROM session_memberships sm
       JOIN sessions s ON s.id = sm.session_id
       WHERE sm.user_id = ANY($1::uuid[])
       GROUP BY sm.user_id`,
      [studentIds]
    );
    statsByStudent = new Map(statsResult.rows.map(row => [row.user_id, row]));
  }

  const billingResult = await db.query(
    `SELECT provider, billing_status, plan_label, external_customer_id IS NOT NULL AS connected
     FROM family_billing_accounts
     WHERE parent_user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [parentUserId]
  );

  const bookingsResult = await db.query(
    `SELECT
       pbr.id,
       pbr.student_user_id,
       u.name AS student_name,
       pbr.class_id,
       c.name AS class_name,
       pbr.requested_window_start,
       pbr.requested_window_end,
       pbr.request_type,
       pbr.status,
       pbr.notes,
       pbr.created_at
     FROM parent_booking_requests pbr
     LEFT JOIN users u ON u.id = pbr.student_user_id
     LEFT JOIN classes c ON c.id = pbr.class_id
     WHERE pbr.parent_user_id = $1
     ORDER BY COALESCE(pbr.requested_window_start, pbr.created_at) ASC
     LIMIT 20`,
    [parentUserId]
  );

  return {
    children: students.map(student => {
      const stats = statsByStudent.get(student.id) || {};
      return {
        ...student,
        linkedClassCount: Number(student.linked_class_count || 0),
        sessionCount: Number(stats.session_count || 0),
        messageCount: Number(stats.message_count || 0),
        speakingSeconds: Number(stats.speaking_seconds || 0),
        avgContribution: Number(stats.avg_contribution || 0),
        lastSessionAt: stats.last_session_at || null
      };
    }),
    billing: billingResult.rows[0] || {
      provider: 'stripe',
      billing_status: 'setup_needed',
      plan_label: null,
      connected: false
    },
    bookings: bookingsResult.rows
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
  addFamilyLink,
  listByClass,
  listStudentsForParent,
  listLinkedStudents,
  createManagedStudent,
  updateStudentProfile,
  linkByEmails,
  linkExistingStudentToParent,
  getParentDashboard,
  getStudentSessionsForParent
};
