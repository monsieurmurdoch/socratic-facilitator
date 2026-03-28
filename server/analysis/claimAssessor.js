/**
 * Claim Assessor
 *
 * Classifies claims from participant messages as:
 * - Factual: verifiably true or false
 * - Normative: opinion/value judgment (no correction needed)
 * - Mixed: factual claim embedded in normative argument
 *
 * Falsehoods are flagged for correction even if the statement is
 * an anchor / load-bearing. Normative claims are never judged.
 *
 * Designed to be used standalone — no dependency on the main app.
 */

class ClaimAssessor {
  constructor() {
    /** @type {Claim[]} */
    this.claims = [];

    /** @type {Claim[]} - subset of claims where isAccurate === false */
    this.uncorrectedErrors = [];
  }

  /**
   * Record claims extracted from a message by the LLM.
   *
   * @param {number} messageIndex
   * @param {string} participantName
   * @param {object[]} extractedClaims  Array from LLM analysis
   * @param {string}   extractedClaims[].text           The claim text
   * @param {string}   extractedClaims[].classification  "factual" | "normative" | "mixed"
   * @param {boolean|null} extractedClaims[].isAccurate  true/false/null (null = can't determine)
   * @param {string|null}  extractedClaims[].correction  If false, suggested correction
   * @param {number}   extractedClaims[].confidence      AI's confidence in its accuracy assessment (0-1)
   */
  recordClaims(messageIndex, participantName, extractedClaims) {
    return this._recordClaimsInternal(messageIndex, participantName, extractedClaims);
  }

  /**
   * Alias for backward compatibility.
   */
  recordClaim(messageIndex, participantName, extractedClaims) {
    return this.recordClaims(messageIndex, participantName, extractedClaims);
  }

  /**
   * Internal implementation.
   */
  _recordClaimsInternal(messageIndex, participantName, extractedClaims) {
    if (!extractedClaims || extractedClaims.length === 0) return [];

    const recorded = [];

    for (const claim of extractedClaims) {
      const entry = {
        id: `claim_${this.claims.length + 1}`,
        messageIndex,
        participantName,
        text: claim.text,
        classification: claim.classification || 'normative',
        isAccurate: claim.isAccurate ?? null,
        correction: claim.correction || null,
        confidence: claim.confidence ?? 0.5,
        correctedByAI: false,
        timestamp: Date.now()
      };

      this.claims.push(entry);
      recorded.push(entry);

      // Track uncorrected factual errors
      if (entry.isAccurate === false && entry.confidence >= 0.7) {
        this.uncorrectedErrors.push(entry);
      }
    }

    return recorded;
  }

  /**
   * Mark a factual error as having been corrected by the facilitator.
   * @param {string} claimId
   */
  markCorrected(claimId) {
    const claim = this.claims.find(c => c.id === claimId);
    if (claim) {
      claim.correctedByAI = true;
      this.uncorrectedErrors = this.uncorrectedErrors.filter(c => c.id !== claimId);
    }
  }

  /**
   * Check if there are uncorrected factual errors.
   * @returns {boolean}
   */
  hasUncorrectedErrors() {
    return this.uncorrectedErrors.length > 0;
  }

  /**
   * Get the most urgent uncorrected error (highest confidence first).
   * @returns {Claim|null}
   */
  getMostUrgentError() {
    if (this.uncorrectedErrors.length === 0) return null;
    return this.uncorrectedErrors
      .sort((a, b) => b.confidence - a.confidence)[0];
  }

  /**
   * Compute factual error signal for the intervention neuron.
   * @returns {number} 0-1 (0 = no errors, 1 = high-confidence uncorrected error)
   */
  getFactualErrorSignal() {
    if (this.uncorrectedErrors.length === 0) return 0;

    // Highest confidence error drives the signal
    const maxConfidence = Math.max(...this.uncorrectedErrors.map(c => c.confidence));
    // Scale by number of errors (multiple errors = even more urgent)
    const countFactor = Math.min(this.uncorrectedErrors.length / 3, 1);

    return Math.min(1, maxConfidence * 0.7 + countFactor * 0.3);
  }

  /**
   * Format uncorrected errors for the LLM prompt.
   */
  formatErrorsForPrompt() {
    if (this.uncorrectedErrors.length === 0) return "No uncorrected factual errors.";

    return this.uncorrectedErrors.map(c =>
      `⚠ [${c.participantName}, msg#${c.messageIndex}] claimed: "${c.text}" — this is inaccurate. Suggested correction: "${c.correction}" (confidence: ${(c.confidence * 100).toFixed(0)}%)`
    ).join('\n');
  }

  /**
   * Get counts by classification type.
   */
  getStats() {
    const factual = this.claims.filter(c => c.classification === 'factual');
    const normative = this.claims.filter(c => c.classification === 'normative');
    const mixed = this.claims.filter(c => c.classification === 'mixed');

    return {
      total: this.claims.length,
      factual: factual.length,
      normative: normative.length,
      mixed: mixed.length,
      errors: this.uncorrectedErrors.length,
      factualErrorSignal: Math.round(this.getFactualErrorSignal() * 1000) / 1000
    };
  }

  /**
   * Full state for debugging / dashboard.
   */
  getState() {
    return {
      stats: this.getStats(),
      uncorrectedErrors: this.uncorrectedErrors.map(c => ({
        id: c.id,
        participantName: c.participantName,
        text: c.text,
        correction: c.correction,
        confidence: c.confidence
      })),
      recentClaims: this.claims.slice(-10).map(c => ({
        id: c.id,
        participantName: c.participantName,
        text: c.text.substring(0, 80),
        classification: c.classification,
        isAccurate: c.isAccurate
      }))
    };
  }
}

module.exports = { ClaimAssessor };
