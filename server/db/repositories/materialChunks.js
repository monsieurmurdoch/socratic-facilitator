const db = require('../index');
const {
  buildChunksFromText,
  tokenizeForSearch,
  scoreChunk
} = require('../../content/textGrounding');

async function clearByMaterial(materialId) {
  await db.query('DELETE FROM material_chunks WHERE material_id = $1', [materialId]);
}

async function replaceForMaterial(materialId, sessionId, text, opts = {}) {
  await clearByMaterial(materialId);
  const chunks = buildChunksFromText(text, opts);
  for (const chunk of chunks) {
    await db.query(
      `INSERT INTO material_chunks (
         material_id,
         session_id,
         chunk_index,
         line_start,
         line_end,
         source_kind,
         content
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        materialId,
        sessionId,
        chunk.chunkIndex,
        chunk.lineStart,
        chunk.lineEnd,
        opts.sourceKind || 'material',
        chunk.content
      ]
    );
  }
  return chunks;
}

async function getBySession(sessionId) {
  const result = await db.query(
    `SELECT *
     FROM material_chunks
     WHERE session_id = $1
     ORDER BY chunk_index ASC`,
    [sessionId]
  );
  return result.rows;
}

async function searchRelevantBySession(sessionId, query, limit = 5) {
  const chunks = await getBySession(sessionId);
  if (chunks.length === 0) return [];

  const tokens = tokenizeForSearch(query);
  if (tokens.length === 0) {
    return chunks.slice(0, limit);
  }

  return chunks
    .map(chunk => ({
      ...chunk,
      _score: scoreChunk(chunk, tokens)
    }))
    .filter(chunk => chunk._score > 0)
    .sort((a, b) => b._score - a._score || a.chunk_index - b.chunk_index)
    .slice(0, limit);
}

module.exports = {
  clearByMaterial,
  replaceForMaterial,
  getBySession,
  searchRelevantBySession
};
