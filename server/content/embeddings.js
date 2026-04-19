/**
 * Voyage AI Embedding Client
 *
 * Thin wrapper around the Voyage AI embeddings REST API.
 * Uses node-fetch v2 (already in deps) for HTTP calls.
 * Integrates with the existing CircuitBreaker pattern.
 */

const fetch = require('node-fetch');
const { voyageBreaker } = require('../utils/api-breakers');

const EMBEDDING_MODEL = 'voyage-3-lite';
const EMBEDDING_DIMENSIONS = 512;
const API_URL = 'https://api.voyageai.com/v1/embeddings';
const MAX_BATCH_SIZE = 64;

/**
 * Embed an array of text strings using Voyage AI.
 * @param {string[]} texts - Array of text strings to embed.
 * @param {object} opts - Options: { inputType: 'document' | 'query' }
 * @returns {Promise<(number[]|null)[]>} Array of embedding vectors (or nulls on failure).
 */
async function embedBatch(texts, opts = {}) {
  if (!texts || texts.length === 0) return [];

  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY environment variable is not set');
  }

  const allEmbeddings = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    const batch = texts.slice(i, i + MAX_BATCH_SIZE);
    const batchEmbeddings = await voyageBreaker.execute(
      () => embedBatchInternal(batch, apiKey, opts.inputType),
      () => {
        console.warn('[Embeddings] Voyage API unavailable, returning null embeddings');
        return batch.map(() => null);
      }
    );
    allEmbeddings.push(...batchEmbeddings);
  }

  return allEmbeddings;
}

async function embedBatchInternal(texts, apiKey, inputType = 'document') {
  const body = {
    input: texts,
    model: EMBEDDING_MODEL,
    truncation: true,
  };
  if (inputType) {
    body.input_type = inputType;
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    timeout: 30000,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Voyage API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  // Voyage returns data sorted by index; re-sort to match input order
  const sorted = data.data.sort((a, b) => a.index - b.index);
  return sorted.map(item => item.embedding);
}

/**
 * Embed a single text string.
 * @param {string} text - Text to embed.
 * @param {string} inputType - 'document' or 'query'.
 * @returns {Promise<number[]|null>} Embedding vector, or null if unavailable.
 */
async function embedSingle(text, inputType = 'document') {
  const results = await embedBatch([text], { inputType });
  return results[0] || null;
}

/**
 * Compute cosine similarity between two vectors.
 * @param {number[]} a - First vector.
 * @param {number[]} b - Second vector.
 * @returns {number} Cosine similarity in [-1, 1].
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

module.exports = {
  embedBatch,
  embedSingle,
  cosineSimilarity,
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
};
