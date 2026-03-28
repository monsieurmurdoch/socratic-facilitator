/**
 * Primed Context Repository
 *
 * Handles AI comprehension of source materials
 */

const db = require('../index');

/**
 * Create primed context for a session
 */
async function create(sessionId) {
  const result = await db.query(
    `INSERT INTO primed_context (session_id, comprehension_status)
     VALUES ($1, 'pending')
     RETURNING *`,
    [sessionId]
  );
  return result.rows[0];
}

/**
 * Get primed context for a session
 */
async function getBySession(sessionId) {
  const result = await db.query(
    'SELECT * FROM primed_context WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] || null;
}

/**
 * Update status to processing
 */
async function markProcessing(id) {
  await db.query(
    "UPDATE primed_context SET comprehension_status = 'processing', updated_at = NOW() WHERE id = $1",
    [id]
  );
}

/**
 * Complete priming with results
 */
async function complete(id, { summary, keyThemes, potentialTensions, suggestedAngles }) {
  const result = await db.query(
    `UPDATE primed_context
     SET summary = $2,
         key_themes = $3,
         potential_tensions = $4,
         suggested_angles = $5,
         comprehension_status = 'complete',
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, summary, JSON.stringify(keyThemes), JSON.stringify(potentialTensions), JSON.stringify(suggestedAngles)]
  );
  return result.rows[0];
}

/**
 * Mark priming as failed
 */
async function markFailed(id, errorMessage) {
  await db.query(
    "UPDATE primed_context SET comprehension_status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1",
    [id, errorMessage]
  );
}

/**
 * Check if session is primed and ready
 */
async function isReady(sessionId) {
  const result = await db.query(
    "SELECT comprehension_status FROM primed_context WHERE session_id = $1",
    [sessionId]
  );
  return result.rows[0]?.comprehension_status === 'complete';
}

module.exports = {
  create,
  getBySession,
  markProcessing,
  complete,
  markFailed,
  isReady
};
