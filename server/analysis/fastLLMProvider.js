/**
 * Fast LLM Provider (cj2api / ChatJimmy)
 *
 * Routes lightweight analysis calls (message assessment, signal computation)
 * to a fast, free LLM (Llama 3.1-8B via ChatJimmy/cj2api) for low-latency
 * responses, while keeping high-quality generation on Claude.
 *
 * Architecture:
 *   - cj2api is a Cloudflare Worker that wraps chatjimmy.ai into an
 *     OpenAI-compatible API (/v1/chat/completions)
 *   - Supports streaming and non-streaming
 *   - ~17,000 tokens/sec throughput
 *   - Model: Llama 3.1-8B (quantized)
 *
 * Staleness Guard:
 *   If the fast LLM response takes longer than FAST_LLM_TIMEOUT_MS,
 *   we abort and fall back to heuristic-only assessment. This prevents
 *   ChatJimmy downtime from blocking the facilitation pipeline.
 *
 * Designed to be a drop-in replacement for Anthropic API calls in
 * assessment-only code paths (NOT for message generation).
 */

class FastLLMProvider {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint     cj2api Cloudflare Worker URL (e.g. https://your-worker.workers.dev/v1)
   * @param {number} opts.timeoutMs    Max wait time before falling back (default: 3000ms)
   * @param {boolean} opts.enabled     Kill switch (default: true)
   * @param {string} opts.model        Model name to send (default: "jimmy")
   */
  constructor(opts = {}) {
    this.endpoint = opts.endpoint || process.env.FAST_LLM_ENDPOINT || null;
    this.timeoutMs = opts.timeoutMs || parseInt(process.env.FAST_LLM_TIMEOUT_MS) || 3000;
    this.enabled = opts.enabled ?? (process.env.FAST_LLM_ENABLED !== 'false');
    this.model = opts.model || process.env.FAST_LLM_MODEL || 'jimmy';

    // Telemetry
    this.stats = {
      totalCalls: 0,
      successes: 0,
      timeouts: 0,
      errors: 0,
      fallbacks: 0,
      avgLatencyMs: 0,
      latencies: [],     // last 50 latencies for rolling average
    };

    // Circuit breaker: if too many failures, temporarily disable
    this.consecutiveFailures = 0;
    this.circuitBreakerThreshold = 5;
    this.circuitOpenUntil = null;
  }

  /**
   * Check if the fast LLM is available and should be used.
   */
  isAvailable() {
    if (!this.enabled || !this.endpoint) return false;

    // Circuit breaker check
    if (this.circuitOpenUntil) {
      if (Date.now() < this.circuitOpenUntil) return false;
      // Reset circuit breaker — allow one attempt
      this.circuitOpenUntil = null;
      this.consecutiveFailures = 0;
    }

    return true;
  }

  /**
   * Send a chat completion request to the fast LLM.
   *
   * @param {object} opts
   * @param {string} opts.prompt         The user prompt
   * @param {string} opts.systemPrompt   Optional system prompt
   * @param {number} opts.maxTokens      Max tokens (default: 800)
   * @param {number} opts.temperature    Temperature (default: 0.3 — low for analysis)
   * @returns {Promise<{text: string, latencyMs: number} | null>}
   *          Returns null if unavailable, timed out, or errored.
   */
  async complete(opts) {
    if (!this.isAvailable()) {
      this.stats.fallbacks++;
      return null;
    }

    const { prompt, systemPrompt, maxTokens = 800, temperature = 0.3 } = opts;

    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const startTime = Date.now();
    this.stats.totalCalls++;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer dummy'  // cj2api doesn't check keys
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: false
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Fast LLM returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content?.trim();

      if (!text) {
        throw new Error('Empty response from fast LLM');
      }

      const latencyMs = Date.now() - startTime;
      this._recordSuccess(latencyMs);

      return { text, latencyMs };

    } catch (error) {
      clearTimeout(timeout);
      const latencyMs = Date.now() - startTime;

      if (error.name === 'AbortError') {
        this.stats.timeouts++;
        this._recordFailure();
        console.warn(`[FastLLM] Timeout after ${this.timeoutMs}ms — falling back to heuristics`);
      } else {
        this.stats.errors++;
        this._recordFailure();
        console.warn(`[FastLLM] Error (${latencyMs}ms): ${error.message} — falling back`);
      }

      return null;
    }
  }

  /**
   * Convenience: Parse a JSON response from the fast LLM.
   * Returns null if parsing fails.
   */
  async completeJSON(opts) {
    const result = await this.complete(opts);
    if (!result) return null;

    try {
      const jsonStr = result.text
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      const parsed = JSON.parse(jsonStr);
      return { data: parsed, latencyMs: result.latencyMs };
    } catch (error) {
      console.warn(`[FastLLM] JSON parse error: ${error.message}`);
      this.stats.errors++;
      return null;
    }
  }

  /**
   * Get telemetry stats.
   */
  getStats() {
    return {
      ...this.stats,
      avgLatencyMs: Math.round(this.stats.avgLatencyMs),
      circuitOpen: this.circuitOpenUntil ? Date.now() < this.circuitOpenUntil : false,
      consecutiveFailures: this.consecutiveFailures,
      available: this.isAvailable()
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INTERNAL
  // ─────────────────────────────────────────────────────────────────────────────

  _recordSuccess(latencyMs) {
    this.stats.successes++;
    this.consecutiveFailures = 0;

    this.stats.latencies.push(latencyMs);
    if (this.stats.latencies.length > 50) {
      this.stats.latencies.shift();
    }
    this.stats.avgLatencyMs = this.stats.latencies.reduce((a, b) => a + b, 0) / this.stats.latencies.length;
  }

  _recordFailure() {
    this.consecutiveFailures++;
    this.stats.fallbacks++;

    if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
      // Open circuit for 30 seconds
      this.circuitOpenUntil = Date.now() + 30000;
      console.warn(`[FastLLM] Circuit breaker OPEN — ${this.consecutiveFailures} consecutive failures. Retrying in 30s.`);
    }
  }
}

// Singleton instance
const fastLLM = new FastLLMProvider();

module.exports = { FastLLMProvider, fastLLM };
