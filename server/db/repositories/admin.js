const db = require('../index');

function getCostConfig() {
  return {
    fastAssessmentUsd: Number(process.env.FAST_LLM_ESTIMATED_COST_PER_ASSESSMENT_USD || 0),
    referenceAssessmentUsd: Number(process.env.REFERENCE_LLM_ESTIMATED_COST_PER_ASSESSMENT_USD || 0)
  };
}

async function getOverview() {
  const [summaryResult, rolesResult, topTeachersResult, topClassesResult, recentSessionsResult, usersResult] = await Promise.all([
    db.query(
      `SELECT
        (SELECT COUNT(*) FROM users) AS user_count,
        (SELECT COUNT(*) FROM classes) AS class_count,
        (SELECT COUNT(*) FROM sessions) AS session_count,
        (SELECT COUNT(*) FROM sessions WHERE status = 'active') AS active_session_count,
        (SELECT COUNT(*) FROM messages) AS message_count,
        (SELECT COUNT(*) FROM message_analytics) AS assessment_count`
    ),
    db.query(
      `SELECT role, COUNT(*) AS count
       FROM users
       GROUP BY role
       ORDER BY count DESC`
    ),
    db.query(
      `SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        COUNT(DISTINCT c.id) AS class_count,
        COUNT(DISTINCT s.id) AS session_count,
        COALESCE(SUM(sem.message_count), 0) AS total_messages
       FROM users u
       LEFT JOIN classes c ON c.owner_user_id = u.id
       LEFT JOIN sessions s ON s.owner_user_id = u.id
       LEFT JOIN session_memberships sem ON sem.user_id = u.id
       WHERE u.role IN ('Teacher', 'Admin', 'SuperAdmin')
       GROUP BY u.id
       ORDER BY session_count DESC, class_count DESC, total_messages DESC
       LIMIT 8`
    ),
    db.query(
      `SELECT
        c.id,
        c.name,
        c.age_range,
        owner.name AS owner_name,
        COUNT(DISTINCT s.id) AS session_count,
        COUNT(DISTINCT cm.user_id) AS member_count,
        COALESCE(SUM(sem.message_count), 0) AS total_messages
       FROM classes c
       LEFT JOIN users owner ON owner.id = c.owner_user_id
       LEFT JOIN class_memberships cm ON cm.class_id = c.id
       LEFT JOIN sessions s ON s.class_id = c.id
       LEFT JOIN session_memberships sem ON sem.session_id = s.id
       GROUP BY c.id, owner.name
       ORDER BY session_count DESC, total_messages DESC
       LIMIT 8`
    ),
    db.query(
      `SELECT
        s.id,
        s.short_code,
        s.title,
        s.status,
        s.created_at,
        c.name AS class_name,
        owner.name AS owner_name,
        COUNT(DISTINCT sem.id) AS participant_count,
        COALESCE(SUM(sem.message_count), 0) AS total_messages
       FROM sessions s
       LEFT JOIN classes c ON c.id = s.class_id
       LEFT JOIN users owner ON owner.id = s.owner_user_id
       LEFT JOIN session_memberships sem ON sem.session_id = s.id
       GROUP BY s.id, c.name, owner.name
       ORDER BY s.created_at DESC
       LIMIT 10`
    ),
    db.query(
      `SELECT id, name, email, role, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT 20`
    )
  ]);

  const summary = summaryResult.rows[0] || {};
  const costs = getCostConfig();
  const assessmentCount = Number(summary.assessment_count || 0);

  return {
    summary: {
      userCount: Number(summary.user_count || 0),
      classCount: Number(summary.class_count || 0),
      sessionCount: Number(summary.session_count || 0),
      activeSessionCount: Number(summary.active_session_count || 0),
      messageCount: Number(summary.message_count || 0),
      assessmentCount
    },
    roles: rolesResult.rows.map(row => ({
      role: row.role,
      count: Number(row.count || 0)
    })),
    topTeachers: topTeachersResult.rows.map(row => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      classCount: Number(row.class_count || 0),
      sessionCount: Number(row.session_count || 0),
      totalMessages: Number(row.total_messages || 0)
    })),
    topClasses: topClassesResult.rows.map(row => ({
      id: row.id,
      name: row.name,
      ageRange: row.age_range,
      ownerName: row.owner_name,
      sessionCount: Number(row.session_count || 0),
      memberCount: Number(row.member_count || 0),
      totalMessages: Number(row.total_messages || 0)
    })),
    recentSessions: recentSessionsResult.rows.map(row => ({
      id: row.id,
      shortCode: row.short_code,
      title: row.title,
      status: row.status,
      createdAt: row.created_at,
      className: row.class_name,
      ownerName: row.owner_name,
      participantCount: Number(row.participant_count || 0),
      totalMessages: Number(row.total_messages || 0)
    })),
    recentUsers: usersResult.rows.map(row => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      createdAt: row.created_at
    })),
    estimatedCosts: {
      pricingConfigured: Boolean(costs.fastAssessmentUsd || costs.referenceAssessmentUsd),
      fastAssessmentUsd: costs.fastAssessmentUsd,
      referenceAssessmentUsd: costs.referenceAssessmentUsd,
      projectedFastAssessmentSpendUsd: Math.round(assessmentCount * costs.fastAssessmentUsd * 100) / 100,
      projectedReferenceAssessmentSpendUsd: Math.round(assessmentCount * costs.referenceAssessmentUsd * 100) / 100
    }
  };
}

async function listUsers(limit = 40) {
  const result = await db.query(
    `SELECT id, name, email, role, created_at
     FROM users
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function updateUserRole(userId, role) {
  const result = await db.query(
    `UPDATE users
     SET role = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, email, role, created_at`,
    [userId, role]
  );
  return result.rows[0] || null;
}

module.exports = {
  getOverview,
  listUsers,
  updateUserRole
};
