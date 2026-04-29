/**
 * Participants Repository
 *
 * Handles all database operations for participants
 */

const db = require('../index');

/**
 * Add a participant to a session
 */
async function add(sessionId, { name, age, role = 'participant', userId = null }) {
  try {
    const result = await db.query(
      `INSERT INTO participants (session_id, name, age, role, user_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [sessionId, name, age || null, role, userId]
    );
    return result.rows[0];
  } catch (error) {
    if (error?.code !== '42703') throw error;

    const legacyResult = await db.query(
      `INSERT INTO participants (session_id, name, age, role)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [sessionId, name, age || null, role]
    );
    return legacyResult.rows[0];
  }
}

/**
 * Find participant by ID
 */
async function findById(id) {
  const result = await db.query('SELECT * FROM participants WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/**
 * Find participant by name in session
 */
async function findByName(sessionId, name) {
  const result = await db.query(
    'SELECT * FROM participants WHERE session_id = $1 AND name = $2',
    [sessionId, name]
  );
  return result.rows[0] || null;
}

/**
 * Get all participants in a session
 */
async function getBySession(sessionId) {
  const result = await db.query(
    `SELECT * FROM participants
     WHERE session_id = $1 AND left_at IS NULL
     ORDER BY joined_at`,
    [sessionId]
  );
  return result.rows;
}

/**
 * Get participant count for a session
 */
async function getCount(sessionId) {
  const result = await db.query(
    "SELECT COUNT(*) as count FROM participants WHERE session_id = $1 AND left_at IS NULL",
    [sessionId]
  );
  return parseInt(result.rows[0].count);
}

/**
 * Mark participant as left
 */
async function markLeft(id) {
  await db.query(
    'UPDATE participants SET left_at = NOW() WHERE id = $1',
    [id]
  );
}

/**
 * Get participant stats (message count, etc.)
 */
async function getStats(sessionId) {
  const result = await db.query(
    `SELECT
      p.id,
      p.name,
      p.age,
      p.role,
      COUNT(m.id) as message_count,
      MAX(m.created_at) as last_message_at
     FROM participants p
     LEFT JOIN messages m ON m.participant_id = p.id
     WHERE p.session_id = $1
     GROUP BY p.id
     ORDER BY message_count DESC`,
    [sessionId]
  );
  return result.rows;
}

module.exports = {
  add,
  findById,
  findByName,
  getBySession,
  getCount,
  markLeft,
  getStats
};
