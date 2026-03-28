/**
 * Source Materials Repository
 *
 * Handles all database operations for source materials
 */

const db = require('../index');

/**
 * Add a source material to a session
 */
async function add(sessionId, { filename, originalType, storagePath, url, extractedText }) {
  const result = await db.query(
    `INSERT INTO source_materials (session_id, filename, original_type, storage_path, url, extracted_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [sessionId, filename, originalType, storagePath, url, extractedText]
  );
  return result.rows[0];
}

/**
 * Get all materials for a session
 */
async function getBySession(sessionId) {
  const result = await db.query(
    'SELECT * FROM source_materials WHERE session_id = $1 ORDER BY uploaded_at',
    [sessionId]
  );
  return result.rows;
}

/**
 * Get material by ID
 */
async function findById(id) {
  const result = await db.query('SELECT * FROM source_materials WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/**
 * Delete a material
 */
async function remove(id) {
  await db.query('DELETE FROM source_materials WHERE id = $1', [id]);
}

/**
 * Get combined extracted text for a session
 */
async function getCombinedText(sessionId) {
  const result = await db.query(
    `SELECT string_agg(extracted_text, E'\n\n---\n\n' ORDER BY uploaded_at) as combined_text
     FROM source_materials WHERE session_id = $1`,
    [sessionId]
  );
  return result.rows[0].combined_text || '';
}

/**
 * Check if session has materials
 */
async function hasMaterials(sessionId) {
  const result = await db.query(
    'SELECT COUNT(*) as count FROM source_materials WHERE session_id = $1',
    [sessionId]
  );
  return parseInt(result.rows[0].count) > 0;
}

module.exports = {
  add,
  getBySession,
  findById,
  remove,
  getCombinedText,
  hasMaterials
};
