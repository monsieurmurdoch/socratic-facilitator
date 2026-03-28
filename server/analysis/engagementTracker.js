/**
 * Engagement Tracker
 *
 * Computes a recency-weighted engagement score from per-message dimensions:
 * - Specificity: how concrete/detailed is the statement (vs vague agreement)
 * - Profoundness: does it push thinking forward
 * - Specificity-relative-to-profoundness: the money metric
 * - Response latency: quick responses to hard questions = engagement
 * - Coherence: does this comment build on the previous one
 *
 * Designed to be used standalone — no dependency on the main app.
 */

class EngagementTracker {
  /**
   * @param {object} opts
   * @param {number} opts.decayLambda  Exponential decay rate (default: 0.12 → stmt 10 turns ago has ~30% weight)
   * @param {number} opts.windowSize   Max statements to consider for aggregate score
   */
  constructor(opts = {}) {
    this.decayLambda = opts.decayLambda ?? 0.12;
    this.windowSize = opts.windowSize ?? 30;

    /** @type {MessageAssessment[]} */
    this.assessments = [];
  }

  /**
   * Record a new message assessment from the LLM.
   *
   * @param {object} assessment
   * @param {number} assessment.messageIndex
   * @param {string} assessment.participantName
   * @param {string} assessment.text
   * @param {number} assessment.specificity         0-1
   * @param {number} assessment.profoundness         0-1
   * @param {number} assessment.coherence            0-1 (does this build on previous message)
   * @param {number} assessment.responseLatencyMs    ms since previous message (null if first)
   * @param {number} assessment.timestamp
   */
  recordAssessment(assessment) {
    const a = {
      ...assessment,
      // Derived: the "money metric" — high specificity AND high profoundness is peak engagement
      // Geometric mean rewards both being high; either being low pulls it down
      specificityRelativeToProfoundness: Math.sqrt(
        (assessment.specificity ?? 0.5) * (assessment.profoundness ?? 0.5)
      ),
      // Composite per-message engagement: weighted blend of dimensions
      engagementScore: this._computeMessageEngagement(assessment)
    };
    this.assessments.push(a);
    return a;
  }

  /**
   * Per-message composite engagement score.
   * Blends specificity-relative-to-profoundness, coherence, and latency signal.
   */
  _computeMessageEngagement(a) {
    const srp = Math.sqrt((a.specificity ?? 0.5) * (a.profoundness ?? 0.5));
    const coherence = a.coherence ?? 0.5;

    // Latency signal: quick response (< 5s) after a non-trivial message = engaged
    // Long pause (> 30s) after a simple question = maybe disengaged
    // But: long pause after a profound question = thinking (not disengagement)
    // Normalize to 0-1 where higher = more engaged
    let latencySignal = 0.5; // neutral default
    if (a.responseLatencyMs != null && a.responseLatencyMs > 0) {
      const latencySec = a.responseLatencyMs / 1000;
      if (latencySec < 5) {
        latencySignal = 0.8; // quick response
      } else if (latencySec < 15) {
        latencySignal = 0.6;
      } else if (latencySec < 30) {
        latencySignal = 0.5; // neutral
      } else {
        // Long pause — but if the previous message was profound, this is thinking
        latencySignal = 0.35;
      }
    }

    // Weighted blend
    return (srp * 0.45) + (coherence * 0.35) + (latencySignal * 0.20);
  }

  /**
   * Recency-weighted aggregate engagement score over recent statements.
   * Recent messages weight exponentially more than older ones.
   *
   * @returns {number} 0-1 engagement score
   */
  getEngagementScore() {
    if (this.assessments.length === 0) return 0.5;

    const recent = this.assessments.slice(-this.windowSize);
    let weightedSum = 0;
    let totalWeight = 0;

    for (let i = 0; i < recent.length; i++) {
      const age = recent.length - 1 - i; // 0 for most recent
      const weight = Math.exp(-this.decayLambda * age);
      weightedSum += weight * recent[i].engagementScore;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  }

  /**
   * Recency-weighted coherence score (are comments building on each other?).
   * @returns {number} 0-1
   */
  getCoherenceScore() {
    if (this.assessments.length === 0) return 0.5;

    const recent = this.assessments.slice(-this.windowSize);
    let weightedSum = 0;
    let totalWeight = 0;

    for (let i = 0; i < recent.length; i++) {
      const age = recent.length - 1 - i;
      const weight = Math.exp(-this.decayLambda * age);
      weightedSum += weight * (recent[i].coherence ?? 0.5);
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0.5;
  }

  /**
   * Per-participant engagement breakdown.
   * @returns {Map<string, {score: number, messageCount: number}>}
   */
  getPerParticipantEngagement() {
    const byParticipant = new Map();

    for (const a of this.assessments) {
      if (!byParticipant.has(a.participantName)) {
        byParticipant.set(a.participantName, { scores: [], count: 0 });
      }
      const entry = byParticipant.get(a.participantName);
      entry.scores.push(a.engagementScore);
      entry.count++;
    }

    const result = new Map();
    for (const [name, data] of byParticipant) {
      const avg = data.scores.reduce((a, b) => a + b, 0) / data.scores.length;
      result.set(name, { score: Math.round(avg * 100) / 100, messageCount: data.count });
    }
    return result;
  }

  /**
   * Get the most recent assessment for context.
   */
  getLatestAssessment() {
    return this.assessments.length > 0
      ? this.assessments[this.assessments.length - 1]
      : null;
  }

  /**
   * Full state for debugging / dashboard.
   */
  getState() {
    return {
      engagementScore: Math.round(this.getEngagementScore() * 1000) / 1000,
      coherenceScore: Math.round(this.getCoherenceScore() * 1000) / 1000,
      assessmentCount: this.assessments.length,
      perParticipant: Object.fromEntries(this.getPerParticipantEngagement()),
      latestAssessment: this.getLatestAssessment()
    };
  }
}

module.exports = { EngagementTracker };
