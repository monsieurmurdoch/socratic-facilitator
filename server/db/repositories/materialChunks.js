const db = require('../index');
const {
  buildChunksFromText,
  buildChunksFromTextSemantic,
  tokenizeForSearch,
  scoreChunk,
  shouldPreferLineChunks,
  extractLineReference,
  extractQuotedPhrases
} = require('../../content/textGrounding');
const {
  embedBatch,
  embedSingle,
  cosineSimilarity,
} = require('../../content/embeddings');

async function clearByMaterial(materialId) {
  await db.query('DELETE FROM material_chunks WHERE material_id = $1', [materialId]);
}

async function replaceForMaterial(materialId, sessionId, text, opts = {}) {
  await clearByMaterial(materialId);

  // Preserve explicit line-based structure for numbered text, poetry,
  // or other short-line passages; otherwise use semantic chunking.
  const preferLineChunks = opts.useSemanticChunking === false || shouldPreferLineChunks(text);
  const chunks = preferLineChunks
    ? buildChunksFromText(text, opts)
    : buildChunksFromTextSemantic(text, opts);

  if (chunks.length === 0) return chunks;

  // Embed all chunk contents in batch
  let embeddings = [];
  const apiKey = process.env.VOYAGE_API_KEY;
  if (apiKey) {
    try {
      embeddings = await embedBatch(
        chunks.map(c => c.content),
        { inputType: 'document' }
      );
    } catch (err) {
      console.warn('[materialChunks] Embedding failed, storing without embeddings:', err.message);
      embeddings = chunks.map(() => null);
    }
  }

  const usePgvector = db.pgvectorAvailable;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];
    const lineStart = chunk.lineStart || chunk.charStart || 0;
    const lineEnd = chunk.lineEnd || chunk.charEnd || 0;

    if (usePgvector && embedding) {
      const vectorStr = `[${embedding.join(',')}]`;
      await db.query(
        `INSERT INTO material_chunks (
           material_id, session_id, chunk_index,
           line_start, line_end, source_kind, content, embedding
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [
          materialId, sessionId, chunk.chunkIndex,
          lineStart, lineEnd,
          opts.sourceKind || 'material',
          chunk.content,
          vectorStr,
        ]
      );
    } else if (embedding) {
      const embeddingJson = JSON.stringify(embedding);
      await db.query(
        `INSERT INTO material_chunks (
           material_id, session_id, chunk_index,
           line_start, line_end, source_kind, content, embedding_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          materialId, sessionId, chunk.chunkIndex,
          lineStart, lineEnd,
          opts.sourceKind || 'material',
          chunk.content,
          embeddingJson,
        ]
      );
    } else {
      // No embedding available — insert without it
      await db.query(
        `INSERT INTO material_chunks (
           material_id, session_id, chunk_index,
           line_start, line_end, source_kind, content
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          materialId, sessionId, chunk.chunkIndex,
          lineStart, lineEnd,
          opts.sourceKind || 'material',
          chunk.content,
        ]
      );
    }
  }

  return chunks;
}

async function getBySession(sessionId) {
  const result = await db.query(
    `SELECT id, material_id, session_id, chunk_index,
            line_start, line_end, source_kind, content, created_at,
            embedding, embedding_json
     FROM material_chunks
     WHERE session_id = $1
     ORDER BY chunk_index ASC`,
    [sessionId]
  );
  return result.rows;
}

async function getViewerBySession(sessionId) {
  const result = await db.query(
    `SELECT
       mc.id,
       mc.material_id,
       mc.session_id,
       mc.chunk_index,
       mc.line_start,
       mc.line_end,
       mc.source_kind,
       mc.content,
       mc.created_at,
       sm.filename,
       sm.original_type,
       sm.uploaded_at
     FROM material_chunks mc
     LEFT JOIN source_materials sm ON sm.id = mc.material_id
     WHERE mc.session_id = $1
     ORDER BY sm.uploaded_at ASC NULLS LAST, mc.chunk_index ASC`,
    [sessionId]
  );

  const byMaterial = new Map();

  for (const row of result.rows) {
    const key = row.material_id || `session-${sessionId}`;
    if (!byMaterial.has(key)) {
      byMaterial.set(key, {
        materialId: row.material_id || null,
        title: row.filename || "Shared Source Text",
        originalType: row.original_type || row.source_kind || "text",
        sourceKind: row.source_kind || "material",
        chunks: []
      });
    }

    byMaterial.get(key).chunks.push({
      id: row.id,
      chunkIndex: Number(row.chunk_index || 0),
      lineStart: Number(row.line_start || 0),
      lineEnd: Number(row.line_end || 0),
      content: row.content || ""
    });
  }

  return Array.from(byMaterial.values()).map((material) => ({
    ...material,
    lineCount: material.chunks.reduce((max, chunk) => Math.max(max, chunk.lineEnd), 0)
  }));
}

// ---------------------------------------------------------------------------
// Hybrid search: semantic + keyword
// ---------------------------------------------------------------------------

/** Extract embedding vector from a chunk row (handles both storage formats). */
function getEmbedding(chunk) {
  if (chunk.embedding) {
    if (Array.isArray(chunk.embedding)) return chunk.embedding;
    if (typeof chunk.embedding === 'string') {
      try { return JSON.parse(chunk.embedding); } catch (e) { return null; }
    }
  }
  if (chunk.embedding_json) {
    try { return JSON.parse(chunk.embedding_json); } catch (e) { return null; }
  }
  return null;
}

/** Min-max normalize a value against all scores to [0, 1]. */
function normalizeScore(value, allScores) {
  const min = Math.min(...allScores);
  const max = Math.max(...allScores);
  if (max === min) return max > 0 ? 1 : 0;
  return (value - min) / (max - min);
}

function lineReferenceBoost(chunk, lineReference) {
  if (!lineReference) return 0;
  const start = Number(chunk.line_start ?? chunk.lineStart ?? 0);
  const end = Number(chunk.line_end ?? chunk.lineEnd ?? 0);
  if (!start || !end) return 0;
  const overlaps = start <= lineReference.end && end >= lineReference.start;
  if (!overlaps) return 0;
  const exact = start === lineReference.start && end === lineReference.end;
  return exact ? 8 : 5;
}

function buildRetrievalQuery(query) {
  const phrases = extractQuotedPhrases(query);
  return [query, ...phrases].filter(Boolean).join(' ');
}

/** Lazily embed chunks that are missing embeddings and write them back. */
async function backfillEmbeddings(chunks) {
  const texts = chunks.map(c => c.content);
  const embeddings = await embedBatch(texts, { inputType: 'document' });

  const usePgvector = db.pgvectorAvailable;

  for (let i = 0; i < chunks.length; i++) {
    const embedding = embeddings[i];
    if (!embedding) continue;

    if (usePgvector) {
      const vectorStr = `[${embedding.join(',')}]`;
      await db.query(
        'UPDATE material_chunks SET embedding = $1::vector WHERE id = $2',
        [vectorStr, chunks[i].id]
      );
    } else {
      await db.query(
        'UPDATE material_chunks SET embedding_json = $1 WHERE id = $2',
        [JSON.stringify(embedding), chunks[i].id]
      );
    }
  }
}

/**
 * Semantic + keyword hybrid retrieval.
 *
 * 1. Fetch all chunks for session.
 * 2. Compute keyword scores (always available).
 * 3. If VOYAGE_API_KEY is set, embed query and compute semantic scores.
 * 4. Blend with hybrid formula (0.7 semantic + 0.3 keyword).
 * 5. Return top-K results sorted by score.
 */
async function searchRelevantBySession(sessionId, query, limit = 5) {
  const chunks = await getBySession(sessionId);
  if (chunks.length === 0) return [];

  const searchQuery = buildRetrievalQuery(query);
  const tokens = tokenizeForSearch(searchQuery);
  const lineReference = extractLineReference(query);

  // --- Keyword scoring (always available) ---
  const keywordScores = chunks.map(chunk => scoreChunk(chunk, tokens) + lineReferenceBoost(chunk, lineReference));

  // --- Semantic scoring ---
  let semanticScores = null;
  const apiKey = process.env.VOYAGE_API_KEY;

  if (apiKey) {
    try {
      const queryEmbedding = await embedSingle(query, 'query');

      if (queryEmbedding) {
        // Lazy-backfill chunks missing embeddings
        const needsBackfill = chunks.filter(c => !getEmbedding(c));
        if (needsBackfill.length > 0) {
          await backfillEmbeddings(needsBackfill);
          // Re-fetch so backfilled embeddings are available
          const freshChunks = await getBySession(sessionId);
          return computeHybridResults(freshChunks, tokens, queryEmbedding, limit, lineReference);
        }

        semanticScores = chunks.map(chunk => {
          const emb = getEmbedding(chunk);
          if (!emb) return 0;
          return cosineSimilarity(queryEmbedding, emb);
        });
      }
    } catch (err) {
      console.warn('[searchRelevant] Semantic scoring failed, using keyword only:', err.message);
    }
  }

  // --- Hybrid scoring ---
  const HYBRID_ALPHA = 0.7; // weight for semantic

  const finalScores = chunks.map((chunk, i) => {
    const kw = keywordScores[i];

    if (semanticScores) {
      const sem = semanticScores[i];
      const normSem = normalizeScore(sem, semanticScores);
      const normKw = normalizeScore(kw, keywordScores);

      // If keyword has no matches at all, rely purely on semantic
      const alpha = (kw === 0 && !lineReference) ? 1.0 : HYBRID_ALPHA;
      return {
        ...chunk,
        _score: alpha * normSem + (1 - alpha) * normKw,
        _semanticScore: sem,
        _keywordScore: kw,
      };
    }

    // Keyword-only fallback (current behavior)
    return {
      ...chunk,
      _score: kw,
      _keywordScore: kw,
    };
  });

  return finalScores
    .filter(chunk => chunk._score > 0)
    .sort((a, b) => b._score - a._score || a.chunk_index - b.chunk_index)
    .slice(0, limit);
}

/**
 * Compute hybrid results from freshly-fetched chunks (after backfill).
 * Extracted to avoid duplicating the scoring logic.
 */
function computeHybridResults(chunks, tokens, queryEmbedding, limit, lineReference = null) {
  const keywordScores = chunks.map(chunk => scoreChunk(chunk, tokens) + lineReferenceBoost(chunk, lineReference));
  const semanticScores = chunks.map(chunk => {
    const emb = getEmbedding(chunk);
    if (!emb) return 0;
    return cosineSimilarity(queryEmbedding, emb);
  });

  const HYBRID_ALPHA = 0.7;

  const finalScores = chunks.map((chunk, i) => {
    const kw = keywordScores[i];
    const sem = semanticScores[i];
    const normSem = normalizeScore(sem, semanticScores);
    const normKw = normalizeScore(kw, keywordScores);
    const alpha = (kw === 0 && !lineReference) ? 1.0 : HYBRID_ALPHA;

    return {
      ...chunk,
      _score: alpha * normSem + (1 - alpha) * normKw,
      _semanticScore: sem,
      _keywordScore: kw,
    };
  });

  return finalScores
    .filter(chunk => chunk._score > 0)
    .sort((a, b) => b._score - a._score || a.chunk_index - b.chunk_index)
    .slice(0, limit);
}

module.exports = {
  clearByMaterial,
  replaceForMaterial,
  getBySession,
  getViewerBySession,
  searchRelevantBySession,
  // Exposed for testing
  getEmbedding,
  normalizeScore,
  lineReferenceBoost,
  buildRetrievalQuery,
};
