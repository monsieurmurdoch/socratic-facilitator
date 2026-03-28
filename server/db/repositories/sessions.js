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
async function create({ title, openingQuestion, conversationGoal, creatorId = null }) {
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

  const result = await db.query(
    `INSERT INTO sessions (short_code, title, opening_question, conversation_goal, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [shortCode, title, openingQuestion || null, conversationGoal || null, creatorId]
  );

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

module.exports = {
  create,
  findById,
  findByShortCode,
  updateStatus,
  getActiveSessions,
  deleteSession,
  generateShortCode
};
