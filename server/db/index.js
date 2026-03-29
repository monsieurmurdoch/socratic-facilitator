/**
 * Database Connection
 *
 * PostgreSQL connection pool using pg library.
 * Works with Railway's managed PostgreSQL.
 */

const { Pool } = require('pg');

let pool = null;

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
  if (process.env.NODE_ENV !== 'production') {
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
    await query(schema);
    console.log('[DB] Schema initialized successfully');
  } catch (error) {
    // Ignore "already exists" errors
    if (error.message.includes('already exists') || error.message.includes('duplicate key')) {
      console.log('[DB] Schema already exists');
    } else {
      console.error('[DB] Schema initialization error:', error.message);
      throw error;
    }
  }
}

module.exports = {
  query,
  transaction,
  end,
  initializeSchema,
  getPool
};
