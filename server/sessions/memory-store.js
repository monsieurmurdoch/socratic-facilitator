const { SessionStore } = require('./store');

/**
 * In-memory session store using a Map.
 * Suitable for development and single-instance deployments.
 * Sessions are lost on server restart.
 */
class MemorySessionStore extends SessionStore {
  constructor() {
    super();
    this._map = new Map();
  }

  async get(key) {
    return this._map.get(key) || null;
  }

  async set(key, value) {
    this._map.set(key, value);
  }

  async delete(key) {
    this._map.delete(key);
  }

  async has(key) {
    return this._map.has(key);
  }

  async keys() {
    return Array.from(this._map.keys());
  }
}

module.exports = { MemorySessionStore };
