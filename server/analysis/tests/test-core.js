/**
 * Core unit tests for analysis subsystems.
 *
 * Run:  node server/analysis/tests/test-core.js
 */

const assert = require('assert');
const path = require('path');

// ── Imports ──────────────────────────────────────────────────────────────────
const { InterventionNeuron, WEIGHT_PROFILES } = require(path.resolve(__dirname, '../interventionNeuron.js'));
const { FastLLMProvider } = require(path.resolve(__dirname, '../fastLLMProvider.js'));
const { StalenessGuard } = require(path.resolve(__dirname, '../stalenessGuard.js'));
const { getFacilitationParams, FACILITATION_PARAMS, SOLO_FACILITATION_PARAMS } = require(path.resolve(__dirname, '../../config.js'));

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  InterventionNeuron
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── InterventionNeuron ──');

test('all weight profiles load', () => {
  const expected = ['young', 'middle', 'older', 'solo_young', 'solo_middle', 'solo_older'];
  for (const name of expected) {
    assert.ok(WEIGHT_PROFILES[name], `Missing profile: ${name}`);
    assert.ok(WEIGHT_PROFILES[name].weights, `Profile ${name} missing weights`);
    assert.ok(typeof WEIGHT_PROFILES[name].bias === 'number', `Profile ${name} missing bias`);
    assert.ok(typeof WEIGHT_PROFILES[name].threshold === 'number', `Profile ${name} missing threshold`);
  }
});

test('sigmoid(0) = 0.5', () => {
  const neuron = new InterventionNeuron('middle');
  const val = neuron.sigmoid(0);
  assert.strictEqual(val, 0.5);
});

test('sigmoid(large positive) approaches 1', () => {
  const neuron = new InterventionNeuron('middle');
  assert.ok(neuron.sigmoid(10) > 0.999, `Expected > 0.999, got ${neuron.sigmoid(10)}`);
});

test('sigmoid(large negative) approaches 0', () => {
  const neuron = new InterventionNeuron('middle');
  assert.ok(neuron.sigmoid(-10) < 0.001, `Expected < 0.001, got ${neuron.sigmoid(-10)}`);
});

test('sigmoid clamps extreme inputs', () => {
  const neuron = new InterventionNeuron('middle');
  // Values beyond +/-10 are clamped, so sigmoid(100) === sigmoid(10)
  assert.strictEqual(neuron.sigmoid(100), neuron.sigmoid(10));
  assert.strictEqual(neuron.sigmoid(-100), neuron.sigmoid(-10));
});

test('high engagement suppresses intervention (shouldSpeak=false)', () => {
  const neuron = new InterventionNeuron('middle');
  const decision = neuron.decide({
    engagementScore: 1.0,
    coherenceScore: 1.0,
    topicRelevance: 1.0,
    anchorDrift: 0.0,
    factualError: 0.0,
    silenceDepth: 0.0,
    dominanceImbalance: 0.0,
  });
  assert.strictEqual(decision.shouldSpeak, false,
    `Expected shouldSpeak=false for high engagement, got activation=${decision.activation}`);
});

test('factual error triggers intervention (shouldSpeak=true)', () => {
  const neuron = new InterventionNeuron('middle');
  const decision = neuron.decide({
    engagementScore: 0.3,
    coherenceScore: 0.3,
    topicRelevance: 0.3,
    anchorDrift: 0.3,
    factualError: 1.0,
    silenceDepth: 0.3,
    dominanceImbalance: 0.3,
  });
  assert.strictEqual(decision.shouldSpeak, true,
    `Expected shouldSpeak=true for factual error, got activation=${decision.activation}`);
});

test('solo profiles have higher speak bias than group profiles', () => {
  assert.ok(WEIGHT_PROFILES.solo_young.bias > WEIGHT_PROFILES.young.bias,
    `solo_young bias (${WEIGHT_PROFILES.solo_young.bias}) should exceed young bias (${WEIGHT_PROFILES.young.bias})`);
  assert.ok(WEIGHT_PROFILES.solo_middle.bias > WEIGHT_PROFILES.middle.bias,
    `solo_middle bias (${WEIGHT_PROFILES.solo_middle.bias}) should exceed middle bias (${WEIGHT_PROFILES.middle.bias})`);
  assert.ok(WEIGHT_PROFILES.solo_older.bias > WEIGHT_PROFILES.older.bias,
    `solo_older bias (${WEIGHT_PROFILES.solo_older.bias}) should exceed older bias (${WEIGHT_PROFILES.older.bias})`);
});

test('dominance weight is 0 in solo profiles', () => {
  assert.strictEqual(WEIGHT_PROFILES.solo_young.weights.dominanceImbalance, 0);
  assert.strictEqual(WEIGHT_PROFILES.solo_middle.weights.dominanceImbalance, 0);
  assert.strictEqual(WEIGHT_PROFILES.solo_older.weights.dominanceImbalance, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FastLLMProvider
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── FastLLMProvider ──');

test('isAvailable() returns false when no endpoint configured', () => {
  const provider = new FastLLMProvider({ endpoint: null, enabled: true });
  assert.strictEqual(provider.isAvailable(), false);
});

test('isAvailable() returns false when circuit breaker is open', () => {
  const provider = new FastLLMProvider({ endpoint: 'http://localhost:9999', enabled: true });
  // Force circuit breaker open
  provider.circuitOpenUntil = Date.now() + 60000;
  assert.strictEqual(provider.isAvailable(), false);
});

test('stats tracking works', () => {
  const provider = new FastLLMProvider({ endpoint: 'http://localhost:9999', enabled: true });
  // Simulate some successes
  provider._recordSuccess(100);
  provider._recordSuccess(200);
  assert.strictEqual(provider.stats.successes, 2);
  assert.strictEqual(provider.stats.latencies.length, 2);
  assert.strictEqual(provider.stats.avgLatencyMs, 150);
  assert.strictEqual(provider.consecutiveFailures, 0);

  // Simulate a failure
  provider._recordFailure();
  assert.strictEqual(provider.consecutiveFailures, 1);
  assert.strictEqual(provider.stats.fallbacks, 1);
});

test('circuit breaker opens after threshold failures', () => {
  const provider = new FastLLMProvider({ endpoint: 'http://localhost:9999', enabled: true });
  assert.strictEqual(provider.circuitOpenUntil, null);

  // Record failures up to (but not reaching) the threshold
  for (let i = 0; i < provider.circuitBreakerThreshold - 1; i++) {
    provider._recordFailure();
  }
  assert.strictEqual(provider.circuitOpenUntil, null, 'Circuit should still be closed');

  // One more failure should trip it
  provider._recordFailure();
  assert.ok(provider.circuitOpenUntil !== null, 'Circuit should be open after threshold failures');
  assert.ok(provider.circuitOpenUntil > Date.now(), 'circuitOpenUntil should be in the future');
  assert.strictEqual(provider.isAvailable(), false);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  StalenessGuard
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── StalenessGuard ──');

async function runStalenessTests() {
  const guard = new StalenessGuard({ defaultTimeoutMs: 200 });

  await testAsync('fast function returns immediately (not stale)', async () => {
    const { result, stale } = await guard.guard(
      async () => 42,
      { fallback: -1, label: 'fast' }
    );
    assert.strictEqual(result, 42);
    assert.strictEqual(stale, false);
  });

  await testAsync('slow function gets timed out (stale=true, fallback returned)', async () => {
    const { result, stale } = await guard.guard(
      () => new Promise(resolve => setTimeout(() => resolve('late'), 500)),
      { timeoutMs: 50, fallback: 'fallback_value', label: 'slow' }
    );
    assert.strictEqual(result, 'fallback_value');
    assert.strictEqual(stale, true);
  });

  await testAsync('errors return fallback', async () => {
    const { result, stale } = await guard.guard(
      async () => { throw new Error('boom'); },
      { fallback: 'safe_default', label: 'error' }
    );
    assert.strictEqual(result, 'safe_default');
    assert.strictEqual(stale, true);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Solo config (server/config.js)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n── Solo config ──');

test('getFacilitationParams(1) returns solo params', () => {
  const params = getFacilitationParams(1);
  assert.strictEqual(params, SOLO_FACILITATION_PARAMS);
  assert.strictEqual(params.minInterventionGapSec, 5);
  assert.strictEqual(params.maxAITalkRatio, 0.45);
});

test('getFacilitationParams(3) returns group params', () => {
  const params = getFacilitationParams(3);
  assert.strictEqual(params, FACILITATION_PARAMS);
  assert.strictEqual(params.minInterventionGapSec, 15);
  assert.strictEqual(params.maxAITalkRatio, 0.15);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Run async tests then print summary
// ═══════════════════════════════════════════════════════════════════════════════

runStalenessTests().then(() => {
  console.log(`\n── Summary: ${passed} passed, ${failed} failed ──\n`);
  process.exit(failed > 0 ? 1 : 0);
});
