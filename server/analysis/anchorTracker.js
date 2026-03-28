/**
 * Anchor Tracker
 *
 * Tracks "load-bearing" statements — moments in the conversation that
 * people keep returning to. An anchor's importance is measured by:
 *   weight = referenceCount × aiProfoundnessEstimate
 *
 * Key property: anchors do NOT have recency bias. A statement from turn 3
 * that's still being referenced at turn 30 is extremely important.
 *
 * Designed to be used standalone — no dependency on the main app.
 */

class AnchorTracker {
  constructor() {
    /** @type {Anchor[]} */
    this.anchors = [];
    this._nextId = 1;
  }

  /**
   * Register a new anchor (a statement the AI identifies as potentially load-bearing).
   *
   * @param {object} anchor
   * @param {number} anchor.messageIndex       Which message this is
   * @param {string} anchor.participantName     Who said it
   * @param {string} anchor.text               The statement
   * @param {number} anchor.profoundness       AI's initial estimate (0-1)
   * @param {string} anchor.summary            Short summary for reference matching
   * @returns {Anchor}
   */
  addAnchor({ messageIndex, participantName, text, profoundness, summary }) {
    const anchor = {
      id: `anchor_${this._nextId++}`,
      messageIndex,
      participantName,
      text,
      summary: summary || text.substring(0, 100),
      profoundness: profoundness ?? 0.5,
      referenceCount: 0,
      referencedBy: [],
      weight: 0, // computed
      isActive: true,
      createdAt: Date.now(),
      lastReferencedAt: null
    };
    anchor.weight = this._computeWeight(anchor);
    this.anchors.push(anchor);
    return anchor;
  }

  /**
   * Record that a message referenced an existing anchor.
   *
   * @param {string} anchorId
   * @param {number} messageIndex   The message that made the reference
   * @param {string} participantName Who referenced it
   */
  recordReference(anchorId, messageIndex, participantName) {
    const anchor = this.anchors.find(a => a.id === anchorId);
    if (!anchor) return null;

    anchor.referenceCount++;
    anchor.referencedBy.push({ messageIndex, participantName, timestamp: Date.now() });
    anchor.lastReferencedAt = Date.now();
    anchor.weight = this._computeWeight(anchor);

    // Auto-upgrade profoundness if something keeps getting referenced
    // If people keep coming back to it, the AI's initial estimate was too low
    if (anchor.referenceCount >= 3 && anchor.profoundness < 0.7) {
      anchor.profoundness = Math.min(1, anchor.profoundness + 0.15);
      anchor.weight = this._computeWeight(anchor);
    }

    return anchor;
  }

  /**
   * Update the AI's profoundness estimate for an anchor.
   * Called when the AI re-evaluates an anchor in light of new conversation.
   *
   * @param {string} anchorId
   * @param {number} newProfoundness 0-1
   */
  updateProfoundness(anchorId, newProfoundness) {
    const anchor = this.anchors.find(a => a.id === anchorId);
    if (!anchor) return null;

    anchor.profoundness = Math.max(0, Math.min(1, newProfoundness));
    anchor.weight = this._computeWeight(anchor);
    return anchor;
  }

  /**
   * Compute anchor weight.
   * weight = (1 + referenceCount) × profoundness
   * The +1 ensures a new anchor with 0 references still has weight from profoundness alone.
   */
  _computeWeight(anchor) {
    return Math.round((1 + anchor.referenceCount) * anchor.profoundness * 100) / 100;
  }

  /**
   * Get active anchors sorted by weight (most important first).
   */
  getActiveAnchors() {
    return this.anchors
      .filter(a => a.isActive)
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * Get the top N anchors for inclusion in LLM context.
   */
  getTopAnchors(n = 5) {
    return this.getActiveAnchors().slice(0, n);
  }

  /**
   * Compute "anchor drift" — how much the recent conversation has drifted
   * away from the top load-bearing anchors.
   *
   * This is measured by how many recent messages (last N) reference ANY active anchor.
   * If no recent messages reference anchors, drift is high.
   *
   * @param {number} recentMessageCount  Total messages in conversation so far
   * @param {number} lookback            How many recent messages to check (default 8)
   * @returns {number} 0-1 where 1 = fully drifted, 0 = strongly anchored
   */
  computeAnchorDrift(recentMessageCount, lookback = 8) {
    if (this.anchors.length === 0) return 0; // no anchors = no drift

    const windowStart = Math.max(0, recentMessageCount - lookback);

    // Count how many references happened in the recent window
    let recentReferenceCount = 0;
    for (const anchor of this.anchors) {
      for (const ref of anchor.referencedBy) {
        if (ref.messageIndex >= windowStart) {
          recentReferenceCount++;
        }
      }
    }

    // Normalize: if at least 2 references in the window, drift is low
    // 0 references = full drift, 1 = moderate, 2+ = low drift
    if (recentReferenceCount >= 3) return 0.1;
    if (recentReferenceCount >= 2) return 0.25;
    if (recentReferenceCount >= 1) return 0.5;
    return 0.85; // no references to any anchor in recent messages
  }

  /**
   * Format anchors as a string for LLM prompts.
   */
  formatForPrompt() {
    const top = this.getTopAnchors(5);
    if (top.length === 0) return "No anchors identified yet.";

    return top.map((a, i) => {
      const refs = a.referenceCount > 0
        ? ` (referenced ${a.referenceCount}x by ${[...new Set(a.referencedBy.map(r => r.participantName))].join(', ')})`
        : ' (not yet referenced)';
      return `${i + 1}. [${a.participantName}, msg#${a.messageIndex}] "${a.summary}" — weight=${a.weight}${refs}`;
    }).join('\n');
  }

  /**
   * Full state for debugging / dashboard.
   */
  getState() {
    return {
      totalAnchors: this.anchors.length,
      activeAnchors: this.getActiveAnchors().length,
      topAnchors: this.getTopAnchors(5).map(a => ({
        id: a.id,
        summary: a.summary,
        participantName: a.participantName,
        weight: a.weight,
        referenceCount: a.referenceCount,
        profoundness: a.profoundness
      }))
    };
  }
}

module.exports = { AnchorTracker };
