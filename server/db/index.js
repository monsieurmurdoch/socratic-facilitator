/**
 * Database Connection
 *
 * PostgreSQL connection pool using pg library.
 * Works with Railway's managed PostgreSQL.
 */

const { Pool } = require('pg');

let pool = null;
let pgvectorAvailable = false;

function getPool() {
  if (!pool) {
    // Railway internal Postgres doesn't need SSL; external does
    const isInternal = (process.env.DATABASE_URL || '').includes('.railway.internal');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: (!isInternal && process.env.NODE_ENV === 'production')
        ? { rejectUnauthorized: false }
        : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }
  return pool;
}

async function query(text, params) {
  const start = Date.now();
  const result = await getPool().query(text, params);
  if (process.env.DEBUG_DB === 'true') {
    const duration = Date.now() - start;
    console.log('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
  }
  return result;
}

async function transaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function end() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Initialize database schema
 * Run this on first startup or when schema changes
 */
async function initializeSchema() {
  const fs = require('fs');
  const path = require('path');
  const schemaPath = path.join(__dirname, 'schema.sql');

  console.log('[DB] Connecting to database...');
  console.log('[DB] URL host:', (process.env.DATABASE_URL || '').replace(/\/\/.*@/, '//***@'));

  try {
    // Test connection first
    await query('SELECT NOW()');
    console.log('[DB] Connection successful');

    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Split schema into individual statements and execute each.
    // pg.query() can only execute one statement at a time.
    // Must respect PostgreSQL dollar-quoting ($$ ... $$) and string literals
    // so that semicolons inside DO $$ ... END $$ blocks aren't treated as delimiters.
    const statements = [];
    let current = '';
    let inDollarQuote = false;

    for (let i = 0; i < schema.length; i++) {
      if (schema[i] === '$' && schema[i + 1] === '$') {
        inDollarQuote = !inDollarQuote;
        current += '$$';
        i++; // skip second $
        continue;
      }

      if (!inDollarQuote && schema[i] === ';') {
        const trimmed = current.trim();
        if (trimmed) statements.push(trimmed);
        current = '';
        continue;
      }

      current += schema[i];
    }

    // Catch any trailing statement without a semicolon
    const lastTrimmed = current.trim();
    if (lastTrimmed) statements.push(lastTrimmed);

    let successCount = 0;
    let skipCount = 0;

    for (const stmt of statements) {
      try {
        await query(stmt);
        successCount++;
      } catch (err) {
        // Ignore "already exists" and related errors for idempotent schema runs
        const msg = err.message || '';
        if (msg.includes('already exists') ||
            msg.includes('duplicate') ||
            msg.includes('relation') && msg.includes('not exist')) {
          skipCount++;
        } else {
          console.warn('[DB] Statement warning:', msg.substring(0, 100));
        }
      }
    }

    console.log(`[DB] Schema initialized: ${successCount} statements executed, ${skipCount} skipped (already exist)`);

    // Detect pgvector availability for semantic search
    try {
      const extResult = await query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
      pgvectorAvailable = extResult.rows.length > 0;
    } catch (e) {
      pgvectorAvailable = false;
    }
    console.log(`[DB] pgvector available: ${pgvectorAvailable}`);
  } catch (error) {
    console.error('[DB] Schema initialization error:', error.message);
    throw error;
  }
}

module.exports = {
  query,
  transaction,
  end,
  initializeSchema,
  getPool,
  get pgvectorAvailable() { return pgvectorAvailable; },
};
