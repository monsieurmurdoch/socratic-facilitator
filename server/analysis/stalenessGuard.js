/**
 * Staleness Guard
 *
 * Wraps any async LLM call with a timeout. If the call takes longer than
 * the configured threshold, returns a fallback value instead.
 *
 * Used to prevent slow LLM responses from blocking the facilitation pipeline.
 * Works with both the fast LLM (ChatJimmy) and Claude fallback paths.
 *
 * Usage:
 *   const result = await stalenessGuard(
 *     () => fastLLM.completeJSON({ prompt: '...' }),
 *     { timeoutMs: 3000, fallback: defaultAnalysis }
 *   );
 */

class StalenessGuard {
  constructor(opts = {}) {
    this.defaultTimeoutMs = opts.defaultTimeoutMs || parseInt(process.env.STALENESS_GUARD_TIMEOUT_MS) || 3000;
    this.stats = {
      totalCalls: 0,
      onTime: 0,
      stale: 0,
      errors: 0
    };
  }

  /**
   * Execute an async function with a staleness timeout.
   *
   * @param {Function} asyncFn              The async function to execute
   * @param {object}   opts
   * @param {number}   opts.timeoutMs       Override default timeout
   * @param {*}        opts.fallback        Value to return on timeout/error
   * @param {string}   opts.label           Label for logging (e.g. "messageAssessment")
   * @returns {Promise<{result: *, stale: boolean, latencyMs: number}>}
   */
  async guard(asyncFn, opts = {}) {
    const timeoutMs = opts.timeoutMs || this.defaultTimeoutMs;
    const fallback = opts.fallback ?? null;
    const label = opts.label || 'unknown';

    this.stats.totalCalls++;
    const startTime = Date.now();

    try {
      const result = await Promise.race([
        asyncFn(),
        this._timeout(timeoutMs)
      ]);

      const latencyMs = Date.now() - startTime;

      if (result === '__STALENESS_GUARD_TIMEOUT__') {
        this.stats.stale++;
        console.warn(`[StalenessGuard] ${label}: timed out after ${timeoutMs}ms — using fallback`);
        return { result: fallback, stale: true, latencyMs };
      }

      this.stats.onTime++;
      return { result, stale: false, latencyMs };

    } catch (error) {
      const latencyMs = Date.now() - startTime;
      this.stats.errors++;
      console.warn(`[StalenessGuard] ${label}: error after ${latencyMs}ms — ${error.message}`);
      return { result: fallback, stale: true, latencyMs };
    }
  }

  /**
   * Get telemetry stats.
   */
  getStats() {
    const total = this.stats.totalCalls || 1;
    return {
      ...this.stats,
      onTimeRate: Math.round((this.stats.onTime / total) * 100) / 100,
      staleRate: Math.round((this.stats.stale / total) * 100) / 100
    };
  }

  _timeout(ms) {
    return new Promise(resolve => {
      setTimeout(() => resolve('__STALENESS_GUARD_TIMEOUT__'), ms);
    });
  }
}

// Singleton instance
const stalenessGuard = new StalenessGuard();

module.exports = { StalenessGuard, stalenessGuard };
