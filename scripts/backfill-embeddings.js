#!/usr/bin/env node
/**
 * One-time script to backfill embeddings for all existing chunks.
 *
 * Run with: node scripts/backfill-embeddings.js
 * Requires VOYAGE_API_KEY environment variable.
 */

require('dotenv').config();
const db = require('../server/db');
const { embedBatch } = require('../server/content/embeddings');

const BATCH_SIZE = 64;

async function main() {
  if (!process.env.VOYAGE_API_KEY) {
    console.error('VOYAGE_API_KEY is required. Set it in .env or environment.');
    process.exit(1);
  }

  await db.initializeSchema();

  const { rows } = await db.query(
    `SELECT id, content FROM material_chunks
     WHERE embedding IS NULL AND embedding_json IS NULL
     ORDER BY created_at ASC`
  );

  console.log(`Found ${rows.length} chunks without embeddings.`);

  if (rows.length === 0) {
    console.log('Nothing to do.');
    await db.end();
    return;
  }

  let processed = 0;
  const usePgvector = db.pgvectorAvailable;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const texts = batch.map(r => r.content);

    const embeddings = await embedBatch(texts, { inputType: 'document' });

    for (let j = 0; j < batch.length; j++) {
      const emb = embeddings[j];
      if (!emb) continue;

      if (usePgvector) {
        await db.query(
          'UPDATE material_chunks SET embedding = $1::vector WHERE id = $2',
          [`[${emb.join(',')}]`, batch[j].id]
        );
      } else {
        await db.query(
          'UPDATE material_chunks SET embedding_json = $1 WHERE id = $2',
          [JSON.stringify(emb), batch[j].id]
        );
      }
    }

    processed += batch.length;
    console.log(`  Embedded ${processed}/${rows.length} chunks...`);
  }

  console.log('Done.');
  await db.end();
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
