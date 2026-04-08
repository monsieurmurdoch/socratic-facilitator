/**
 * Pre-configured circuit breakers for each external API.
 * Import and use with CircuitBreaker.execute(fn, fallback).
 */
const { CircuitBreaker } = require('./circuit-breaker');

const claudeBreaker = new CircuitBreaker('anthropic-claude', {
  failureThreshold: parseInt(process.env.CLAUDE_CB_FAILURES) || 3,
  resetTimeoutMs: parseInt(process.env.CLAUDE_CB_RESET_MS) || 30000,
});

const elevenLabsBreaker = new CircuitBreaker('elevenlabs-tts', {
  failureThreshold: parseInt(process.env.ELEVENLABS_CB_FAILURES) || 5,
  resetTimeoutMs: parseInt(process.env.ELEVENLABS_CB_RESET_MS) || 60000,
});

const deepgramBreaker = new CircuitBreaker('deepgram-stt', {
  failureThreshold: parseInt(process.env.DEEPGRAM_CB_FAILURES) || 5,
  resetTimeoutMs: parseInt(process.env.DEEPGRAM_CB_RESET_MS) || 30000,
});

const fastLlmBreaker = new CircuitBreaker('fast-llm', {
  failureThreshold: parseInt(process.env.FAST_LLM_CB_FAILURES) || 5,
  resetTimeoutMs: parseInt(process.env.FAST_LLM_CB_RESET_MS) || 60000,
});

module.exports = { claudeBreaker, elevenLabsBreaker, deepgramBreaker, fastLlmBreaker };
