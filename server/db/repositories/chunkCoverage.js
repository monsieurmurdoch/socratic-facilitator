/**
 * Chunk Coverage Repository
 *
 * Tracks which source material chunks were referenced during discussion.
 * Piggybacks on the per-turn grounding search — no extra LLM calls.
 */

const db = require('../index');

/**
 * Record that chunks were referenced in a given turn.
 * Uses upsert: first reference sets sample_message_id, subsequent refs increment count.
 *
 * @param {string} sessionId - Session UUID
 * @param {string[]} chunkIds - Array of chunk UUIDs that matched the grounding search
 * @param {string|null} messageId - The message UUID that triggered the reference
 */
async function recordReferences(sessionId, chunkIds, messageId = null) {
  if (!chunkIds || chunkIds.length === 0) return;

  for (const chunkId of chunkIds) {
    await db.query(
      `INSERT INTO chunk_coverage (session_id, chunk_id, reference_count, sample_message_id)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (session_id, chunk_id) DO UPDATE SET
         reference_count = chunk_coverage.reference_count + 1`,
      [sessionId, chunkId, messageId]
    );
  }
}

/**
 * Get all coverage rows for a session, joined with chunk content.
 *
 * @param {string} sessionId
 * @returns {Promise<Array>} Coverage rows with chunk content
 */
async function getBySession(sessionId) {
  const result = await db.query(
    `SELECT
       cc.id,
       cc.session_id,
       cc.chunk_id,
       cc.first_referenced_at,
       cc.reference_count,
       cc.sample_message_id,
       mc.chunk_index,
       mc.content,
       mc.line_start,
       mc.line_end
     FROM chunk_coverage cc
     JOIN material_chunks mc ON mc.id = cc.chunk_id
     WHERE cc.session_id = $1
     ORDER BY mc.chunk_index ASC`,
    [sessionId]
  );
  return result.rows;
}

/**
 * Get a coverage summary for a session.
 *
 * @param {string} sessionId
 * @returns {Promise<{totalChunks: number, coveredChunks: number, coveragePercent: number, uncoveredChunks: Array}>}
 */
async function getCoverageSummary(sessionId) {
  // Total chunks for this session
  const totalResult = await db.query(
    `SELECT COUNT(*) AS total FROM material_chunks WHERE session_id = $1`,
    [sessionId]
  );
  const totalChunks = parseInt(totalResult.rows[0]?.total || 0, 10);

  if (totalChunks === 0) {
    return {
      totalChunks: 0,
      coveredChunks: 0,
      coveragePercent: 0,
      uncoveredChunks: [],
    };
  }

  // Covered chunks
  const coveredResult = await db.query(
    `SELECT COUNT(DISTINCT chunk_id) AS covered FROM chunk_coverage WHERE session_id = $1`,
    [sessionId]
  );
  const coveredChunks = parseInt(coveredResult.rows[0]?.covered || 0, 10);

  // Uncovered chunks: chunks in this session NOT in chunk_coverage
  // Sort by importance DESC so most discussion-worthy passages surface first
  const uncoveredResult = await db.query(
    `SELECT mc.id, mc.chunk_index, mc.content, mc.line_start, mc.line_end,
            mc.importance, mc.role
     FROM material_chunks mc
     WHERE mc.session_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM chunk_coverage cc
         WHERE cc.chunk_id = mc.id AND cc.session_id = $1
       )
     ORDER BY mc.importance DESC NULLS LAST, mc.chunk_index ASC`,
    [sessionId]
  );

  const coveragePercent = totalChunks > 0
    ? Math.round((coveredChunks / totalChunks) * 100)
    : 0;

  return {
    totalChunks,
    coveredChunks,
    coveragePercent,
    uncoveredChunks: uncoveredResult.rows,
  };
}

module.exports = {
  recordReferences,
  getBySession,
  getCoverageSummary,
};
