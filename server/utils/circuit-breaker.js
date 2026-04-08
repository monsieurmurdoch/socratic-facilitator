/**
 * Reusable circuit breaker for wrapping external API calls.
 *
 * States:
 *   - CLOSED: Normal operation. Calls go through. Failures are counted.
 *   - OPEN: Too many failures. All calls are rejected. Waits for reset timeout.
 *   - HALF-OPEN: Testing recovery. Allows one call. If it succeeds, closes. If it fails, reopens.
 */
class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts || 1;

    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.halfOpenAttempts = 0;
    this.openedAt = null;
    this.lastError = null;
  }

  async execute(fn, fallback = null) {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.resetTimeoutMs) {
        if (fallback) return fallback();
        const err = new Error(`Circuit breaker [${this.name}] is OPEN`);
        err.circuitBreaker = this.name;
        throw err;
      }
      // Transition to half-open
      this.state = 'half-open';
      this.halfOpenAttempts = 0;
    }

    if (this.state === 'half-open') {
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        if (fallback) return fallback();
        const err = new Error(`Circuit breaker [${this.name}] is HALF-OPEN (max attempts reached)`);
        err.circuitBreaker = this.name;
        throw err;
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure(error);
      if (fallback) return fallback();
      throw error;
    }
  }

  _onSuccess() {
    this.failureCount = 0;
    this.state = 'closed';
    this.lastError = null;
    this.successCount++;
  }

  _onFailure(error) {
    this.failureCount++;
    this.lastError = error;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      console.warn(
        `[CircuitBreaker:${this.name}] OPENED after ${this.failureCount} failures: ${error.message}`
      );
    }
  }

  getState() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastError: this.lastError?.message || null,
      openedAt: this.openedAt,
    };
  }
}

module.exports = { CircuitBreaker };
