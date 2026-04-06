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

async function listHistoryByUser(userId, limit = 20) {
  const result = await db.query(
    `SELECT
      s.id,
      s.short_code,
      s.title,
      s.status,
      s.created_at,
      c.name AS class_name,
      COALESCE(sm.role_snapshot, cm.role, owner.role) AS viewer_role,
      COALESCE(sm.message_count, 0) AS viewer_message_count,
      COALESCE(sm.estimated_speaking_seconds, 0) AS viewer_speaking_seconds,
      COALESCE(sm.contribution_score, 0) AS viewer_contribution_score,
      COUNT(DISTINCT p.id) AS participant_count,
      COUNT(DISTINCT m.id) AS message_count
     FROM sessions s
     LEFT JOIN classes c ON c.id = s.class_id
     LEFT JOIN users owner ON owner.id = s.owner_user_id
     LEFT JOIN class_memberships cm ON cm.class_id = s.class_id AND cm.user_id = $1
     LEFT JOIN session_memberships sm ON sm.session_id = s.id AND sm.user_id = $1
     LEFT JOIN participants p ON p.session_id = s.id
     LEFT JOIN messages m ON m.session_id = s.id
     WHERE s.owner_user_id = $1
        OR cm.user_id = $1
        OR sm.user_id = $1
     GROUP BY s.id, c.name, sm.role_snapshot, cm.role, owner.role, sm.message_count, sm.estimated_speaking_seconds, sm.contribution_score
     ORDER BY s.created_at DESC
     LIMIT $2`,
    [userId, limit]
  );
  return result.rows;
}

module.exports = {
  create,
  findById,
  findByShortCode,
  updateStatus,
  getActiveSessions,
  deleteSession,
  listHistoryByUser,
  generateShortCode
};
