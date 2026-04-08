/**
 * WebSocket rate limiter.
 * Tracks message counts per connection and drops excess messages.
 */

const DEFAULT_WINDOW_MS = 1000;    // 1 second
const DEFAULT_MAX_MSGS = 30;       // 30 messages per second per connection

class WsRateLimiter {
  constructor(options = {}) {
    this.windowMs = options.windowMs || DEFAULT_WINDOW_MS;
    this.maxMsgs = options.maxMsgs || DEFAULT_MAX_MSGS;
    this._enabled = process.env.NODE_ENV !== 'test';
  }

  /**
   * Check a WebSocket connection. Returns true if the message is allowed.
   * Call once per incoming text message.
   */
  check(ws) {
    if (!this._enabled) return true;

    const now = Date.now();
    if (!ws._rateLimit) {
      ws._rateLimit = { count: 1, windowStart: now };
      return true;
    }

    const rl = ws._rateLimit;
    if (now - rl.windowStart >= this.windowMs) {
      rl.count = 1;
      rl.windowStart = now;
      return true;
    }

    rl.count++;
    if (rl.count > this.maxMsgs) {
      return false;
    }
    return true;
  }
}

module.exports = { WsRateLimiter };
