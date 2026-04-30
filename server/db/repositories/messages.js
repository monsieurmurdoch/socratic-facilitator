/**
 * Messages Repository
 *
 * Handles all database operations for messages
 */

const db = require('../index');

/**
 * Add a participant message
 */
async function addParticipantMessage(sessionId, participantId, content) {
  const result = await db.query(
    `INSERT INTO messages (session_id, participant_id, sender_type, sender_name, content)
     VALUES ($1, $2, 'participant', (SELECT name FROM participants WHERE id = $2), $3)
     RETURNING *`,
    [sessionId, participantId, content]
  );
  return result.rows[0];
}

/**
 * Add a facilitator message
 */
async function addFacilitatorMessage(sessionId, content, moveType = null, targetParticipantId = null) {
  const result = await db.query(
    `INSERT INTO messages (session_id, sender_type, sender_name, content, move_type, target_participant_id)
     VALUES ($1, 'facilitator', 'Facilitator', $2, $3, $4)
     RETURNING *`,
    [sessionId, content, moveType, targetParticipantId]
  );
  return result.rows[0];
}

/**
 * Add a system message
 */
async function addSystemMessage(sessionId, content) {
  const result = await db.query(
    `INSERT INTO messages (session_id, sender_type, sender_name, content)
     VALUES ($1, 'system', 'System', $2)
     RETURNING *`,
    [sessionId, content]
  );
  return result.rows[0];
}

/**
 * Get messages for a session
 */
async function getBySession(sessionId, options = {}) {
  const { limit = 100, offset = 0, order = 'ASC' } = options;

  const result = await db.query(
    `SELECT
      m.*,
      p.name as participant_name,
      p.user_id as participant_user_id,
      tp.name as target_participant_name
     FROM messages m
     LEFT JOIN participants p ON m.participant_id = p.id
     LEFT JOIN participants tp ON m.target_participant_id = tp.id
     WHERE m.session_id = $1
     ORDER BY m.created_at ${order}
     LIMIT $2 OFFSET $3`,
    [sessionId, limit, offset]
  );
  return result.rows;
}

/**
 * Get recent messages (for LLM context)
 */
async function getRecent(sessionId, count = 40) {
  const result = await db.query(
    `SELECT
      m.*,
      p.name as participant_name
     FROM messages m
     LEFT JOIN participants p ON m.participant_id = p.id
     WHERE m.session_id = $1
     ORDER BY m.created_at DESC
     LIMIT $2`,
    [sessionId, count]
  );
  return result.rows.reverse();
}

/**
 * Get message count for a session
 */
async function getCount(sessionId) {
  const result = await db.query(
    'SELECT COUNT(*) as count FROM messages WHERE session_id = $1',
    [sessionId]
  );
  return parseInt(result.rows[0].count);
}

/**
 * Get facilitator stats for a session
 */
async function getFacilitatorStats(sessionId) {
  const result = await db.query(
    `SELECT
      COUNT(*) FILTER (WHERE sender_type = 'facilitator') as facilitator_count,
      COUNT(*) FILTER (WHERE sender_type = 'participant') as participant_count,
      COUNT(*) as total,
      MAX(CASE WHEN sender_type = 'facilitator' THEN created_at END) as last_facilitator_at
     FROM messages WHERE session_id = $1`,
    [sessionId]
  );
  return result.rows[0];
}

/**
 * Format messages for LLM context
 */
function formatForLLM(messages) {
  return messages.map(m => {
    const role = m.sender_type === 'facilitator' ? 'Facilitator' : (m.participant_name || 'Unknown');
    return `[${role}]: ${m.content}`;
  }).join('\n');
}

module.exports = {
  addParticipantMessage,
  addFacilitatorMessage,
  addSystemMessage,
  getBySession,
  getRecent,
  getCount,
  getFacilitatorStats,
  formatForLLM
};
