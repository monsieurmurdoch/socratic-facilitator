/**
 * Facilitation Orchestrator
 *
 * Coordinates all the subsystems for intervention decisions:
 * - EngagementTracker: recency-weighted engagement
 * - AnchorTracker: load-bearing statements
 * - ClaimAssessor: factual/normative classification
 * - InterventionNeuron: binary decision (speak/silent)
 * - HumanDeference: human priority
 *
 * This is the main entry point for the intervention system.
 * Designed to be used standalone — no dependency on the main app.
 */

const { EngagementTracker } = require('./engagementTracker');
const { AnchorTracker } = require('./anchorTracker');
const { ClaimAssessor } = require('./claimAssessor');
const { InterventionNeuron, WEIGHT_PROFILES } = require('./interventionNeuron');
const { HumanDeference } = require('./humanDeference');

/**
 * Age profile mapping
 */
const AGE_PROFILES = {
  young: 'young',    // 8-10
  middle: 'middle',  // 11-14
  older: 'older',    // 15-18
  solo_young: 'solo_young',
  solo_middle: 'solo_middle',
  solo_older: 'solo_older'
};

class FacilitationOrchestrator {
  /**
   * @param {object} opts
   * @param {string} opts.ageProfile  "young" | "middle" | "older"
   * @param {string} opts.topicTitle
   * @param {string} opts.openingQuestion
   */
  constructor(opts = {}) {
    const ageProfile = opts.ageProfile || 'middle';

    // Initialize subsystems
    this.engagementTracker = new EngagementTracker({
      decayLambda: 0.12,
      windowSize: 30
    });

    this.anchorTracker = new AnchorTracker();
    this.claimAssessor = new ClaimAssessor();
    this.neuron = new InterventionNeuron(ageProfile);
    this.humanDeference = new HumanDeference();

    // Conversation state
    this.topicTitle = opts.topicTitle || 'Discussion';
    this.openingQuestion = opts.openingQuestion || '';
    this.messageCount = 0;
    this.participants = new Map();  // name -> { messageCount, lastSpokeAt }

    // Phase tracking
    this.phase = 'opening';  // opening | active | highEngagement | struggling | closing
    this.lastPhaseUpdateAt = Date.now();

    // Forced intervention tracking
    this.consecutiveLowEngagementCount = 0;
    this.consecutiveSilentDecisions = 0;
    this.forcedInterventionThreshold = 5;  // Force after N silent decisions with low engagement
    this.lastForcedInterventionAt = null;
    this.minForcedInterventionGapMs = 60000;  // Don't force more than once per minute
  }

  /**
   * Process a new participant message.
   * Returns analysis results including intervention decision.
   *
   * @param {object} message
   * @param {string} message.participantName
   * @param {string} message.text
   * @param {number} message.timestamp
   * @param {object} message.llmAssessment  Optional pre-computed assessment from LLM
   */
  processMessage(message) {
    const { participantName, text, timestamp, llmAssessment } = message;
    const messageIndex = this.messageCount++;

    // Update participant tracking
    this._updateParticipant(participantName);

    // Update solo mode for human deference
    this.humanDeference.isSolo = this.participants.size <= 1;

    // Notify human deference system
    this.humanDeference.humanStartedSpeaking(participantName);

    // ─────────────────────────────────────────────────────────────────────────
    // ENGAGEMENT TRACKING
    // ─────────────────────────────────────────────────────────────────────────

    const engagement = this._assessEngagement(message, messageIndex, llmAssessment);

    this.engagementTracker.recordAssessment({
      messageIndex,
      participantName,
      text,
      specificity: engagement.specificity,
      profoundness: engagement.profoundness,
      coherence: engagement.coherence,
      responseLatencyMs: engagement.responseLatencyMs,
      timestamp: timestamp || Date.now()
    });

    // ─────────────────────────────────────────────────────────────────────────
    // ANCHOR TRACKING
    // ─────────────────────────────────────────────────────────────────────────

    // Check if this message references existing anchors
    this._checkAnchorReferences(text, messageIndex, participantName);

    // If LLM identified this as anchor-worthy, add it
    if (llmAssessment?.isAnchor) {
      this.anchorTracker.addAnchor({
        messageIndex,
        participantName,
        text,
        profoundness: llmAssessment.anchorProfundness || 0.6,
        summary: llmAssessment.anchorSummary || text.substring(0, 100)
      });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CLAIM ASSESSMENT
    // ─────────────────────────────────────────────────────────────────────────

    if (llmAssessment?.claims?.length > 0) {
      this.claimAssessor.recordClaims(messageIndex, participantName, llmAssessment.claims);
    }

    // Notify human deference that speaking is done
    this.humanDeference.humanStoppedSpeaking(text, participantName);

    // ─────────────────────────────────────────────────────────────────────────
    // UPDATE PHASE
    // ─────────────────────────────────────────────────────────────────────────

    this._updatePhase();

    // ─────────────────────────────────────────────────────────────────────────
    // MAKE INTERVENTION DECISION
    // ─────────────────────────────────────────────────────────────────────────

    const decision = this._makeDecision();

    return {
      messageIndex,
      engagement: this.engagementTracker.getState(),
      anchors: this.anchorTracker.getState(),
      claims: this.claimAssessor.getState(),
      neuron: this.neuron.getState(),
      deference: this.humanDeference.getState(),
      decision,
      phase: this.phase
    };
  }

  /**
   * Make the intervention decision using all subsystems.
   */
  _makeDecision() {
    // First: check human deference
    const deferenceCheck = this.humanDeference.shouldDefer();
    if (deferenceCheck.defer) {
      return {
        shouldSpeak: false,
        reason: `deferred: ${deferenceCheck.reason}`,
        deferred: true
      };
    }

    // Check for explicit human invitation
    if (this.humanDeference.hasInvitation()) {
      this.humanDeference.clearInvitation();
      // Check for deferred message first
      if (this.humanDeference.hasDeferredMessage()) {
        const deferred = this.humanDeference.getDeferredMessage();
        return {
          shouldSpeak: true,
          reason: 'human_invited_deferred_message',
          message: deferred.message,
          activation: 1.0
        };
      }
      // Otherwise, proceed to normal decision with high activation
    }

    // Gather signals for the neuron
    const signals = {
      engagementScore: this.engagementTracker.getEngagementScore(),
      coherenceScore: this.engagementTracker.getCoherenceScore(),
      topicRelevance: this._computeTopicRelevance(),
      anchorDrift: this.anchorTracker.computeAnchorDrift(this.messageCount),
      factualError: this.claimAssessor.getFactualErrorSignal(),
      silenceDepth: this._computeSilenceDepth(),
      dominanceImbalance: this._computeDominanceImbalance()
    };

    // Get neuron decision
    const neuronDecision = this.neuron.decide(signals);

    // If neuron says speak, check if we should defer the message
    if (neuronDecision.shouldSpeak) {
      // Check deference again (in case state changed)
      const recheck = this.humanDeference.shouldDefer();
      if (recheck.defer) {
        // Defer this message
        this.humanDeference.deferMessage(
          '(message would be generated here)',
          recheck.reason
        );
        return {
          shouldSpeak: false,
          reason: `deferred: ${recheck.reason}`,
          deferred: true,
          neuronActivation: neuronDecision.activation
        };
      }
    }

    // Check for deferred message that's now releasable
    if (!neuronDecision.shouldSpeak && this.humanDeference.hasDeferredMessage()) {
      // Don't release if conversation has moved on significantly
      const deferred = this.humanDeference.getDeferredMessage();
      if (deferred.ageMs < 15000) {  // Only if < 15 seconds old
        return {
          shouldSpeak: true,
          reason: 'releasing_deferred_message',
          message: deferred.message,
          activation: neuronDecision.activation
        };
      }
    }

    // Check for forced intervention (stuck conversation)
    if (!neuronDecision.shouldSpeak) {
      this.consecutiveSilentDecisions++;

      // Check if we should force intervention
      if (this._shouldForceIntervention(signals)) {
        this.consecutiveSilentDecisions = 0;
        this.lastForcedInterventionAt = Date.now();

        return {
          shouldSpeak: true,
          reason: 'forced_intervention_stuck_conversation',
          activation: neuronDecision.activation,
          forced: true,
          signals
        };
      }
    } else {
      this.consecutiveSilentDecisions = 0;
    }

    // Track low engagement streak
    if (signals.engagementScore < 0.4) {
      this.consecutiveLowEngagementCount++;
    } else {
      this.consecutiveLowEngagementCount = 0;
    }

    return {
      shouldSpeak: neuronDecision.shouldSpeak,
      reason: neuronDecision.reasoning,
      activation: neuronDecision.activation,
      contributions: neuronDecision.contributions,
      signals
    };
  }

  /**
   * Determine if we should force an intervention.
   */
  _shouldForceIntervention(signals) {
    // Don't force if we just forced
    if (this.lastForcedInterventionAt) {
      const timeSinceLastForce = Date.now() - this.lastForcedInterventionAt;
      if (timeSinceLastForce < this.minForcedInterventionGapMs) {
        return false;
      }
    }

    // Force if: many silent decisions + low engagement + low coherence
    if (this.consecutiveSilentDecisions >= this.forcedInterventionThreshold &&
        signals.engagementScore < 0.45 &&
        signals.coherenceScore < 0.45) {
      return true;
    }

    // Force if: extended low engagement streak
    if (this.consecutiveLowEngagementCount >= 6 &&
        signals.engagementScore < 0.35) {
      return true;
    }

    return false;
  }

  /**
   * Assess engagement dimensions for a message.
   * Uses LLM assessment if provided, otherwise heuristics.
   */
  _assessEngagement(message, messageIndex, llmAssessment) {
    if (llmAssessment) {
      return {
        specificity: llmAssessment.specificity ?? 0.5,
        profoundness: llmAssessment.profoundness ?? 0.5,
        coherence: llmAssessment.coherence ?? 0.5,
        responseLatencyMs: llmAssessment.responseLatencyMs ?? null
      };
    }

    // Heuristic assessment
    const text = message.text || '';
    const wordCount = text.split(/\s+/).length;

    // Specificity heuristic
    let specificity = 0.4;
    if (wordCount > 20) specificity += 0.15;
    if (wordCount > 40) specificity += 0.15;
    if (/for example|for instance|specifically|such as/i.test(text)) specificity += 0.2;
    if (/because|since|therefore|the reason/i.test(text)) specificity += 0.1;

    // Profoundness heuristic
    let profoundness = 0.4;
    if (/\b(why|how|what if|what makes|what would happen)\b/i.test(text)) profoundness += 0.2;
    if (/difference between|distinction|on the other hand/i.test(text)) profoundness += 0.15;
    if (/identity|consciousness|truth|meaning|purpose|value|essence/i.test(text)) profoundness += 0.15;

    // Coherence heuristic (builds on previous)
    let coherence = 0.5;
    if (/agree|disagree|yes|no|but|however|building on|like you said/i.test(text)) {
      coherence = 0.7;
    }
    if (messageIndex > 0 && this._referencesPrevious(text)) {
      coherence = 0.8;
    }

    return {
      specificity: Math.min(1, specificity),
      profoundness: Math.min(1, profoundness),
      coherence: Math.min(1, coherence),
      responseLatencyMs: null
    };
  }

  /**
   * Check if message references previous anchors.
   */
  _checkAnchorReferences(text, messageIndex, participantName) {
    const activeAnchors = this.anchorTracker.getActiveAnchors();

    for (const anchor of activeAnchors) {
      // Check for speaker reference
      if (anchor.participantName &&
          text.toLowerCase().includes(anchor.participantName.toLowerCase())) {
        // Check if referencing their anchor content
        if (this._referencesAnchorContent(text, anchor)) {
          this.anchorTracker.recordReference(anchor.id, messageIndex, participantName);
          continue;
        }
      }

      // Check for summary keyword matches
      const summaryWords = anchor.summary.toLowerCase().split(/\s+/)
        .filter(w => w.length > 4);
      for (const word of summaryWords.slice(0, 3)) {
        if (text.toLowerCase().includes(word)) {
          this.anchorTracker.recordReference(anchor.id, messageIndex, participantName);
          break;
        }
      }
    }
  }

  _referencesAnchorContent(text, anchor) {
    const speaker = anchor.participantName?.toLowerCase();
    if (!speaker) return false;

    const patterns = [
      new RegExp(`as ${speaker} (said|mentioned|pointed out)`, 'i'),
      new RegExp(`like ${speaker} (said|mentioned)`, 'i'),
      new RegExp(`building on ${speaker}'s`, 'i'),
      new RegExp(`${speaker}'s (point|idea|question)`, 'i'),
      new RegExp(`what ${speaker} (said|meant|was getting at)`, 'i')
    ];

    return patterns.some(p => p.test(text));
  }

  _referencesPrevious(text) {
    // Simple check for backward references
    return /\b(that|this|it|those|these)\b.*\b(said|mentioned|pointed|asked)\b/i.test(text) ||
           /\b(as|like)\s+\w+\s+(said|mentioned)\b/i.test(text);
  }

  /**
   * Compute topic relevance (how on-topic the conversation is).
   */
  _computeTopicRelevance() {
    // For now, use a simple heuristic based on anchor drift
    // In production, this would use LLM analysis
    const anchorDrift = this.anchorTracker.computeAnchorDrift(this.messageCount);

    // Low drift = high relevance
    return 1 - anchorDrift;
  }

  /**
   * Compute silence depth (how long since last activity).
   * Normalized to 0-1 where 1 = very long silence.
   */
  _computeSilenceDepth() {
    // This would be computed from actual timestamps in production
    // For now, return a placeholder based on recent activity
    const recentAssessments = this.engagementTracker.assessments.slice(-5);

    if (recentAssessments.length < 2) return 0;

    // Check time gaps between recent messages
    let maxGap = 0;
    for (let i = 1; i < recentAssessments.length; i++) {
      const prev = recentAssessments[i - 1].timestamp;
      const curr = recentAssessments[i].timestamp;
      if (prev && curr) {
        const gap = Math.abs(curr - prev);
        maxGap = Math.max(maxGap, gap);
      }
    }

    // Normalize: 30+ seconds = 1.0
    if (maxGap === 0) return 0;
    return Math.min(1, maxGap / 30000);
  }

  /**
   * Compute dominance imbalance (one person speaking too much).
   */
  _computeDominanceImbalance() {
    const participantCounts = Array.from(this.participants.values())
      .map(p => p.messageCount);

    if (participantCounts.length < 2) return 0;

    const total = participantCounts.reduce((a, b) => a + b, 0);
    const maxCount = Math.max(...participantCounts);
    const dominanceRatio = maxCount / total;

    // If one person has > 50% in a multi-person conversation
    if (dominanceRatio > 0.5 && this.participants.size > 2) {
      return dominanceRatio;
    }

    return 0;
  }

  /**
   * Update participant tracking.
   */
  _updateParticipant(name) {
    if (!this.participants.has(name)) {
      this.participants.set(name, { messageCount: 0, lastSpokeAt: null });
    }
    const p = this.participants.get(name);
    p.messageCount++;
    p.lastSpokeAt = Date.now();
  }

  /**
   * Update conversation phase based on state.
   */
  _updatePhase() {
    const engagementScore = this.engagementTracker.getEngagementScore();
    const messageCount = this.messageCount;

    let newPhase = this.phase;

    // Phase transitions
    if (messageCount < 5) {
      newPhase = 'opening';
    } else if (messageCount > 50) {
      newPhase = 'closing';
    } else if (engagementScore > 0.75) {
      newPhase = 'highEngagement';
    } else if (engagementScore < 0.35) {
      newPhase = 'struggling';
    } else {
      newPhase = 'active';
    }

    if (newPhase !== this.phase) {
      this.phase = newPhase;
      this.lastPhaseUpdateAt = Date.now();
    }
  }

  /**
   * Get full state for debugging/dashboard.
   */
  getState() {
    return {
      phase: this.phase,
      messageCount: this.messageCount,
      participantCount: this.participants.size,
      engagement: this.engagementTracker.getState(),
      anchors: this.anchorTracker.getState(),
      claims: this.claimAssessor.getState(),
      neuron: this.neuron.getState(),
      deference: this.humanDeference.getState(),
      forcedIntervention: {
        consecutiveSilentDecisions: this.consecutiveSilentDecisions,
        consecutiveLowEngagementCount: this.consecutiveLowEngagementCount,
        lastForcedInterventionAt: this.lastForcedInterventionAt
      }
    };
  }

  /**
   * Get formatted context for LLM prompt.
   */
  getLLMContext() {
    return {
      phase: this.phase,
      messageCount: this.messageCount,
      anchorsFormatted: this.anchorTracker.formatForPrompt(),
      uncorrectedErrors: this.claimAssessor.formatErrorsForPrompt(),
      topAnchors: this.anchorTracker.getTopAnchors(5).map(a => ({
        speaker: a.participantName,
        summary: a.summary,
        weight: a.weight,
        referenceCount: a.referenceCount
      })),
      engagementScore: Math.round(this.engagementTracker.getEngagementScore() * 100) / 100,
      coherenceScore: Math.round(this.engagementTracker.getCoherenceScore() * 100) / 100
    };
  }
}

module.exports = {
  FacilitationOrchestrator,
  AGE_PROFILES
};
