/**
 * Abstract session store interface.
 * Subclass this for different storage backends.
 */
class SessionStore {
  async get(key) {
    throw new Error('Not implemented');
  }

  async set(key, value) {
    throw new Error('Not implemented');
  }

  async delete(key) {
    throw new Error('Not implemented');
  }

  async has(key) {
    throw new Error('Not implemented');
  }

  async keys() {
    throw new Error('Not implemented');
  }

  async connect() {
    // Override if the store needs async initialization
  }
}

module.exports = { SessionStore };
