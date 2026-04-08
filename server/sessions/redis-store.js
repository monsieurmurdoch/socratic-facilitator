const { SessionStore } = require('./store');

/**
 * Redis-backed session store for multi-instance deployments.
 * Stores serializable session state in Redis with JSON serialization.
 * Requires a running Redis instance and REDIS_URL environment variable.
 */
class RedisSessionStore extends SessionStore {
  constructor(redisUrl) {
    super();
    this.redisUrl = redisUrl;
    this.client = null;
    this.connected = false;
  }

  async connect() {
    const { createClient } = require('redis');
    this.client = createClient({ url: this.redisUrl });
    this.client.on('error', (err) => {
      console.error('[Redis] Error:', err.message);
    });
    await this.client.connect();
    this.connected = true;
    console.log('[Redis] Connected to', this.redisUrl.replace(/\/\/.*@/, '//***@'));
  }

  _prefix(key) {
    return `session:${key}`;
  }

  async get(key) {
    const data = await this.client.get(this._prefix(key));
    return data ? JSON.parse(data) : null;
  }

  async set(key, value) {
    await this.client.set(this._prefix(key), JSON.stringify(value));
  }

  async delete(key) {
    await this.client.del(this._prefix(key));
  }

  async has(key) {
    return (await this.client.exists(this._prefix(key))) === 1;
  }

  async keys() {
    const keys = await this.client.keys('session:*');
    return keys.map(k => k.replace('session:', ''));
  }
}

module.exports = { RedisSessionStore };
