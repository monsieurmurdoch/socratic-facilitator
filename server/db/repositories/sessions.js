/**
 * Sessions Repository
 *
 * Handles all database operations for sessions
 */

const db = require('../index');

/**
 * Generate a short, human-readable session code
 */
function generateShortCode() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // Removed confusing chars: 0, o, 1, l
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

/**
 * Create a new session
 */
async function create({
  title,
  openingQuestion,
  conversationGoal,
  creatorId = null,
  ownerUserId = null,
  classId = null,
  previousSessionShortCode = null
}) {
  let shortCode;
  let attempts = 0;

  // Ensure unique short code
  do {
    shortCode = generateShortCode();
    const existing = await db.query(
      'SELECT id FROM sessions WHERE short_code = $1',
      [shortCode]
    );
    if (existing.rowCount === 0) break;
    attempts++;
  } while (attempts < 10);

  if (attempts >= 10) {
    throw new Error('Failed to generate unique short code');
  }

  let result;
  try {
    result = await db.query(
      `INSERT INTO sessions (short_code, title, opening_question, conversation_goal, created_by, owner_user_id, class_id, previous_session_short_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [shortCode, title, openingQuestion || null, conversationGoal || null, creatorId, ownerUserId, classId, previousSessionShortCode]
    );
  } catch (error) {
    const isMissingOwnershipColumns = error?.code === '42703' && (
      String(error.message || '').includes('owner_user_id') ||
      String(error.message || '').includes('class_id')
    );

    if (!isMissingOwnershipColumns) {
      throw error;
    }

    result = await db.query(
      `INSERT INTO sessions (short_code, title, opening_question, conversation_goal, created_by, previous_session_short_code)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [shortCode, title, openingQuestion || null, conversationGoal || null, creatorId, previousSessionShortCode]
    );
  }

  return result.rows[0];
}

/**
 * Find session by ID
 */
async function findById(id) {
  const result = await db.query('SELECT * FROM sessions WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/**
 * Find session by short code
 */
async function findByShortCode(shortCode) {
  const result = await db.query('SELECT * FROM sessions WHERE short_code = $1', [shortCode]);
  return result.rows[0] || null;
}

/**
 * Update session status
 */
async function updateStatus(id, status) {
  const now = new Date();
  let query_text = 'UPDATE sessions SET status = $2';
  const params = [id, status];

  if (status === 'active') {
    query_text += ', started_at = $3 WHERE id = $1 RETURNING *';
    params.push(now);
  } else if (status === 'ended') {
    query_text += ', ended_at = $3 WHERE id = $1 RETURNING *';
    params.push(now);
  } else {
    query_text += ' WHERE id = $1 RETURNING *';
  }

  const result = await db.query(query_text, params);
  return result.rows[0];
}

/**
 * Get active sessions (for cleanup/monitoring)
 */
async function getActiveSessions() {
  const result = await db.query(
    "SELECT * FROM sessions WHERE status = 'active' ORDER BY created_at DESC"
  );
  return result.rows;
}

/**
 * Delete session and all related data
 */
async function deleteSession(id) {
  await db.query('DELETE FROM sessions WHERE id = $1', [id]);
}

async function listHistoryByUser(userId, limit = 20, { classId = null, q = '' } = {}) {
  const search = String(q || '').trim();
  const searchPattern = search ? `%${search}%` : null;
  const result = await db.query(
    `SELECT
      s.id,
      s.short_code,
      s.class_id,
      s.title,
      s.status,
      s.created_at,
      c.name AS class_name,
      COALESCE(sm.role_snapshot, cm.role, owner.role) AS viewer_role,
      COALESCE(sm.message_count, 0) AS viewer_message_count,
      COALESCE(sm.estimated_speaking_seconds, 0) AS viewer_speaking_seconds,
      COALESCE(sm.contribution_score, 0) AS viewer_contribution_score,
      (
        SELECT p2.name
        FROM participants p2
        WHERE p2.session_id = s.id
          AND ($4::text IS NOT NULL AND p2.name ILIKE $4)
        ORDER BY p2.joined_at ASC
        LIMIT 1
      ) AS matched_participant,
      (
        SELECT LEFT(m2.content, 220)
        FROM messages m2
        WHERE m2.session_id = s.id
          AND ($4::text IS NOT NULL AND m2.content ILIKE $4)
        ORDER BY m2.created_at DESC
        LIMIT 1
      ) AS search_excerpt,
      COUNT(DISTINCT p.id) AS participant_count,
      COUNT(DISTINCT m.id) AS message_count
     FROM sessions s
     LEFT JOIN classes c ON c.id = s.class_id
     LEFT JOIN users owner ON owner.id = s.owner_user_id
     LEFT JOIN class_memberships cm ON cm.class_id = s.class_id AND cm.user_id = $1
     LEFT JOIN session_memberships sm ON sm.session_id = s.id AND sm.user_id = $1
     LEFT JOIN participants p ON p.session_id = s.id
     LEFT JOIN messages m ON m.session_id = s.id
     WHERE (s.owner_user_id = $1
        OR cm.user_id = $1
        OR sm.user_id = $1)
       AND ($3::uuid IS NULL OR s.class_id = $3)
       AND (
         $4::text IS NULL
         OR s.title ILIKE $4
         OR EXISTS (
           SELECT 1 FROM participants p3
           WHERE p3.session_id = s.id
             AND p3.name ILIKE $4
         )
         OR EXISTS (
           SELECT 1 FROM messages m3
           WHERE m3.session_id = s.id
             AND m3.content ILIKE $4
         )
       )
     GROUP BY s.id, c.name, sm.role_snapshot, cm.role, owner.role, sm.message_count, sm.estimated_speaking_seconds, sm.contribution_score
     ORDER BY s.created_at DESC
     LIMIT $2`,
    [userId, limit, classId, searchPattern]
  );
  return result.rows;
}

async function findLatestLiveByClassId(classId) {
  try {
    const result = await db.query(
      `SELECT *
       FROM sessions
       WHERE class_id = $1
         AND status IN ('waiting', 'active')
       ORDER BY created_at DESC
       LIMIT 1`,
      [classId]
    );
    return result.rows[0] || null;
  } catch (error) {
    if (error?.code === '42703') {
      return null;
    }
    throw error;
  }
}

/**
 * Get detailed analytics for a session
 */
async function getDetailedAnalytics(sessionId, userId) {
  // Get session participants with their analytics
  const participantsResult = await db.query(`
    SELECT
      p.id,
      p.name,
      p.age,
      p.role,
      COALESCE(sm.message_count, 0) as message_count,
      COALESCE(sm.total_word_count, 0) as total_words,
      COALESCE(sm.estimated_speaking_seconds, 0) as speaking_seconds,
      ROUND(COALESCE(sm.contribution_score, 0)::numeric, 3) as contribution_score,
      ROUND(COALESCE(sm.engagement_score, 0)::numeric, 3) as engagement_score,
      sm.joined_at,
      sm.left_at
    FROM participants p
    LEFT JOIN session_memberships sm ON sm.participant_id = p.id
    WHERE p.session_id = $1
    ORDER BY sm.estimated_speaking_seconds DESC
  `, [sessionId]);

  // Get message analytics summary (robust against missing data/columns)
  const messagesResult = await db.query(`
    SELECT
      COUNT(*) as total_messages,
      ROUND(COALESCE(AVG(specificity), 0)::numeric, 3) as avg_specificity,
      ROUND(COALESCE(AVG(profoundness), 0)::numeric, 3) as avg_profoundness,
      ROUND(COALESCE(AVG(coherence), 0)::numeric, 3) as avg_coherence,
      ROUND(COALESCE(AVG(discussion_value), 0)::numeric, 3) as avg_discussion_value,
      COUNT(CASE WHEN referenced_anchor IS TRUE THEN 1 END) as anchor_references,
      COUNT(CASE WHEN responded_to_peer IS TRUE THEN 1 END) as peer_responses,
      COUNT(CASE WHEN is_anchor IS TRUE THEN 1 END) as anchors_created
    FROM message_analytics ma
    JOIN messages m ON m.id = ma.message_id
    WHERE m.session_id = $1
  `, [sessionId]);

  // Get session duration and basic stats
  const sessionStats = await db.query(`
    SELECT
      COUNT(DISTINCT p.id) as participant_count,
      COUNT(DISTINCT m.id) as message_count,
      EXTRACT(EPOCH FROM (s.ended_at - s.created_at)) as duration_seconds,
      s.created_at,
      s.ended_at
    FROM sessions s
    LEFT JOIN participants p ON p.session_id = s.id
    LEFT JOIN messages m ON m.session_id = s.id
    WHERE s.id = $1
    GROUP BY s.id, s.created_at, s.ended_at
  `, [sessionId]);

  const participants = participantsResult.rows;
  const messageStats = messagesResult.rows[0] || {};
  const stats = sessionStats.rows[0] || {};

  // Calculate additional metrics
  const totalSpeakingTime = participants.reduce((sum, p) => sum + Number(p.speaking_seconds), 0);
  const avgMessagesPerParticipant = stats.participant_count > 0 ?
    Math.round((stats.message_count / stats.participant_count) * 10) / 10 : 0;

  return {
    overview: {
      durationSeconds: Math.round(stats.duration_seconds || 0),
      participantCount: stats.participant_count || 0,
      messageCount: stats.message_count || 0,
      avgMessagesPerParticipant,
      totalSpeakingTimeSeconds: Math.round(totalSpeakingTime),
      avgSpeakingTimePerParticipant: stats.participant_count > 0 ?
        Math.round((totalSpeakingTime / stats.participant_count) * 10) / 10 : 0
    },
    participants: participants.map(p => ({
      id: p.id,
      name: p.name,
      age: p.age,
      role: p.role,
      messageCount: Number(p.message_count),
      totalWords: Number(p.total_words),
      speakingSeconds: Math.round(Number(p.speaking_seconds)),
      contributionScore: Number(p.contribution_score),
      engagementScore: Number(p.engagement_score),
      speakingPercentage: totalSpeakingTime > 0 ?
        Math.round((Number(p.speaking_seconds) / totalSpeakingTime) * 100) : 0,
      joinedAt: p.joined_at,
      leftAt: p.left_at
    })),
    quality: {
      avgSpecificity: Number(messageStats.avg_specificity || 0),
      avgProfoundness: Number(messageStats.avg_profoundness || 0),
      avgCoherence: Number(messageStats.avg_coherence || 0),
      avgDiscussionValue: Number(messageStats.avg_discussion_value || 0),
      anchorReferences: Number(messageStats.anchor_references || 0),
      peerResponses: Number(messageStats.peer_responses || 0),
      anchorsCreated: Number(messageStats.anchors_created || 0)
    }
  };
}

/**
 * Check if user is in a class
 */
async function userInClass(classId, userId) {
  const result = await db.query(
    'SELECT id FROM class_memberships WHERE class_id = $1 AND user_id = $2',
    [classId, userId]
  );
  return result.rowCount > 0;
}

/**
 * Check if user was a participant in a session
 */
async function userWasParticipant(sessionId, userId) {
  const result = await db.query(`
    SELECT sm.id FROM session_memberships sm
    JOIN participants p ON p.id = sm.participant_id
    WHERE p.session_id = $1 AND sm.user_id = $2
  `, [sessionId, userId]);
  return result.rowCount > 0;
}

module.exports = {
  create,
  findById,
  findByShortCode,
  updateStatus,
  getActiveSessions,
  deleteSession,
  listHistoryByUser,
  findLatestLiveByClassId,
  getDetailedAnalytics,
  userInClass,
  userWasParticipant,
  generateShortCode,
  findLatestWithMaterials
};

/**
 * Find the most recent session for a class that has uploaded materials.
 * Used to pre-populate materials when creating a new session under the same class.
 */
async function findLatestWithMaterials(classId) {
  const result = await db.query(`
    SELECT s.* FROM sessions s
    JOIN source_materials sm ON sm.session_id = s.id
    WHERE s.class_id = $1
    GROUP BY s.id
    ORDER BY s.created_at DESC
    LIMIT 1
  `, [classId]);
  return result.rows[0] || null;
}
