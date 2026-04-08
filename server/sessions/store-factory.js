/**
 * Session store factory.
 * Picks Redis if REDIS_URL is set, otherwise falls back to in-memory.
 * Warns in production if no Redis URL is configured.
 */
const { MemorySessionStore } = require('./memory-store');
const { RedisSessionStore } = require('./redis-store');

function createStore() {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    console.log('[Sessions] Using Redis session store');
    return new RedisSessionStore(redisUrl);
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      '[Sessions] WARNING: No REDIS_URL in production. Using in-memory store.',
      'Sessions will be lost on server restart. Set REDIS_URL for production deployments.'
    );
  }
  console.log('[Sessions] Using in-memory session store');
  return new MemorySessionStore();
}

module.exports = { createStore };
