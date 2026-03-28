/**
 * Intervention Neuron
 *
 * A single-neuron activation function inspired by neural networks.
 * Takes weighted input signals from the engagement, anchor, and claim
 * subsystems, passes them through a sigmoid, and emits a binary
 * fire/don't-fire decision.
 *
 * The key insight: NEGATIVE weights on healthy conversation signals
 * (engagement, coherence, on-topic) suppress intervention — the conversation
 * is going well, stay out of it. POSITIVE weights on problem signals
 * (drift, errors, dominance, silence) activate intervention.
 *
 * Designed to be used standalone — no dependency on the main app.
 */

/**
 * Default weight profiles for different age ranges.
 * Younger students get lower thresholds (more facilitation).
 */
const WEIGHT_PROFILES = {
  young: {  // ages 8-10
    weights: {
      engagementScore:    -0.6,
      coherenceScore:     -0.5,
      topicRelevance:     -0.4,
      anchorDrift:         0.6,
      factualError:        1.2,
      silenceDepth:        0.7,  // younger kids need more silence prompting
      dominanceImbalance:  0.6,
    },
    bias: 0.2,       // more biased toward speaking
    threshold: 0.45  // lower bar to intervene
  },

  middle: {  // ages 11-14
    weights: {
      engagementScore:    -0.8,
      coherenceScore:     -0.6,
      topicRelevance:     -0.5,
      anchorDrift:         0.7,
      factualError:        1.2,
      silenceDepth:        0.6,
      dominanceImbalance:  0.5,
    },
    bias: 0.1,
    threshold: 0.5
  },

  older: {  // ages 15-18
    weights: {
      engagementScore:    -1.0,
      coherenceScore:     -0.7,
      topicRelevance:     -0.6,
      anchorDrift:         0.7,
      factualError:        1.2,
      silenceDepth:        0.5,  // older kids handle silence better
      dominanceImbalance:  0.4,
    },
    bias: -0.1,      // biased toward silence
    threshold: 0.55  // higher bar to intervene
  }
};

class InterventionNeuron {
  /**
   * @param {string} profile  "young" | "middle" | "older" — or pass custom config
   * @param {object} customConfig  {weights, bias, threshold} to override a profile
   */
  constructor(profile = 'middle', customConfig = null) {
    const base = WEIGHT_PROFILES[profile] || WEIGHT_PROFILES.middle;
    const config = customConfig
      ? { ...base, ...customConfig, weights: { ...base.weights, ...(customConfig.weights || {}) } }
      : base;

    this.weights = { ...config.weights };
    this.bias = config.bias;
    this.threshold = config.threshold;

    /** @type {DecisionRecord[]} - history for analysis */
    this.history = [];
  }

  /**
   * Sigmoid activation: σ(z) = 1 / (1 + e^(-z))
   * Maps any real number to (0, 1).
   */
  sigmoid(z) {
    // Clamp for numerical stability
    const clamped = Math.max(-10, Math.min(10, z));
    return 1 / (1 + Math.exp(-clamped));
  }

  /**
   * Core decision function.
   *
   * @param {object} signals  All normalized to 0-1
   * @param {number} signals.engagementScore     From EngagementTracker
   * @param {number} signals.coherenceScore      From EngagementTracker (do comments build on each other)
   * @param {number} signals.topicRelevance      From LLM analysis (how on/off-topic)
   * @param {number} signals.anchorDrift         From AnchorTracker (drift from load-bearing points)
   * @param {number} signals.factualError        From ClaimAssessor (uncorrected errors)
   * @param {number} signals.silenceDepth        Context-aware silence measure
   * @param {number} signals.dominanceImbalance  From talk ratio computation
   *
   * @returns {NeuronDecision}
   */
  decide(signals) {
    // Compute weighted sum
    let z = this.bias;
    const contributions = {};

    for (const [key, weight] of Object.entries(this.weights)) {
      const value = signals[key] ?? 0;
      const contribution = weight * value;
      z += contribution;
      contributions[key] = {
        value: Math.round(value * 1000) / 1000,
        weight,
        contribution: Math.round(contribution * 1000) / 1000
      };
    }

    // Sigmoid activation
    const activation = this.sigmoid(z);
    const shouldSpeak = activation > this.threshold;

    const decision = {
      shouldSpeak,
      activation: Math.round(activation * 1000) / 1000,
      rawZ: Math.round(z * 1000) / 1000,
      threshold: this.threshold,
      signals,
      contributions,
      reasoning: this._explain(contributions, activation, shouldSpeak),
      timestamp: Date.now()
    };

    this.history.push(decision);
    return decision;
  }

  /**
   * Human-readable explanation of what drove the decision.
   */
  _explain(contributions, activation, shouldSpeak) {
    // Sort by absolute contribution magnitude
    const sorted = Object.entries(contributions)
      .sort((a, b) => Math.abs(b[1].contribution) - Math.abs(a[1].contribution));

    const top3 = sorted.slice(0, 3);
    const parts = top3.map(([key, data]) => {
      if (Math.abs(data.contribution) < 0.01) return null;
      const direction = data.contribution > 0 ? '↑speak' : '↓quiet';
      return `${key}=${data.value.toFixed(2)}(${direction})`;
    }).filter(Boolean);

    const verdict = shouldSpeak ? 'FIRE → speak' : 'QUIET → silent';
    return `${verdict} [activation=${activation.toFixed(3)}]: ${parts.join(', ')}`;
  }

  /**
   * Get recent decision history for dashboard.
   * @param {number} n  Number of recent decisions to return
   */
  getRecentHistory(n = 10) {
    return this.history.slice(-n).map(d => ({
      shouldSpeak: d.shouldSpeak,
      activation: d.activation,
      reasoning: d.reasoning,
      timestamp: d.timestamp
    }));
  }

  /**
   * Get stats about the neuron's behavior over time.
   */
  getStats() {
    if (this.history.length === 0) {
      return { totalDecisions: 0, speakRate: 0, avgActivation: 0.5 };
    }

    const speaks = this.history.filter(d => d.shouldSpeak).length;
    const avgActivation = this.history.reduce((sum, d) => sum + d.activation, 0) / this.history.length;

    return {
      totalDecisions: this.history.length,
      speakCount: speaks,
      silentCount: this.history.length - speaks,
      speakRate: Math.round((speaks / this.history.length) * 100) / 100,
      avgActivation: Math.round(avgActivation * 1000) / 1000,
      currentWeights: { ...this.weights },
      bias: this.bias,
      threshold: this.threshold
    };
  }

  /**
   * Full state for debugging / dashboard.
   */
  getState() {
    const lastDecision = this.history.length > 0
      ? this.history[this.history.length - 1]
      : null;

    return {
      stats: this.getStats(),
      lastDecision: lastDecision ? {
        shouldSpeak: lastDecision.shouldSpeak,
        activation: lastDecision.activation,
        reasoning: lastDecision.reasoning,
        contributions: lastDecision.contributions
      } : null,
      recentHistory: this.getRecentHistory(5)
    };
  }
}

module.exports = { InterventionNeuron, WEIGHT_PROFILES };
