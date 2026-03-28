/**
 * Conversation Analyzer — Orchestrator (Merged)
 *
 * The brain that ties everything together. After each participant message:
 * 1. Instantly runs heuristic analysis (no LLM wait) for engagement + anchor refs
 * 2. Makes ONE LLM call that assesses the message across all dimensions
 * 3. Feeds the assessment into each tracker (engagement, anchors, claims)
 * 4. Compiles signals for the intervention neuron
 * 5. Checks human deference (turn-taking)
 * 6. Returns the binary should-speak decision + intervention type + enriched context
 *
 * This file is the single integration point. The main app only needs
 * to call `analyzer.processMessage(...)` after each participant message.
 *
 * Merges the best of both implementations:
 * - LLM-per-message analysis (for deep assessment)
 * - Heuristic fallbacks (for graceful degradation + instant anchor detection)
 * - Human deference (turn-taking respect)
 * - Phase tracking (opening → active → highEngagement → struggling → closing)
 * - Intervention type routing (neuron fires → specific strategy → LLM prompt)
 */

const Anthropic = require('@anthropic-ai/sdk');
const { EngagementTracker } = require('./engagementTracker');
const { AnchorTracker } = require('./anchorTracker');
const { ClaimAssessor } = require('./claimAssessor');
const { InterventionNeuron } = require('./interventionNeuron');
const { HumanDeference } = require('./humanDeference');

class ConversationAnalyzer {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey          Anthropic API key
   * @param {string} opts.ageProfile      "young" | "middle" | "older"
   * @param {string} opts.model           LLM model to use for analysis
   * @param {string} opts.openingQuestion The discussion's opening question
   * @param {string} opts.topicTitle      The discussion topic title
   */
  constructor(opts = {}) {
    this.client = new Anthropic({ apiKey: opts.apiKey || process.env.ANTHROPIC_API_KEY });
    this.model = opts.model || 'claude-sonnet-4-5-20250514';
    this.openingQuestion = opts.openingQuestion || '';
    this.topicTitle = opts.topicTitle || '';

    // Initialize all subsystems
    this.engagement = new EngagementTracker();
    this.anchors = new AnchorTracker();
    this.claims = new ClaimAssessor();
    this.neuron = new InterventionNeuron(opts.ageProfile || 'middle');
    this.deference = new HumanDeference();

    // Conversation history for LLM context
    this.messages = [];
    this.lastMessageTimestamp = null;

    // Phase tracking
    this.phase = 'opening'; // opening | active | highEngagement | struggling | closing
    this.lastPhaseChangeAt = Date.now();
  }

  /**
   * Process a new participant message through the full analysis pipeline.
   *
   * @param {object} message
   * @param {number} message.index          Message index in conversation
   * @param {string} message.participantName Who said it
   * @param {string} message.text           What they said
   * @param {number} message.timestamp      When (ms)
   * @param {number} message.totalMessages  Total messages in conversation so far
   * @param {number} message.dominanceImbalance  Talk ratio imbalance (0-1)
   *
   * @returns {NeuronDecision} The intervention decision with full context
   */
  async processMessage(message) {
    const {
      index, participantName, text, timestamp,
      totalMessages, dominanceImbalance = 0
    } = message;

    // Track the message
    this.messages.push({ index, participantName, text, timestamp });

    // Compute response latency
    const responseLatencyMs = this.lastMessageTimestamp
      ? timestamp - this.lastMessageTimestamp
      : null;
    this.lastMessageTimestamp = timestamp;

    // ---- Step 0: Human deference (turn-taking) ----
    this.deference.humanStartedSpeaking(participantName);

    // ---- Step 1: Instant heuristic pass (no API wait) ----
    // Detect anchor references via regex BEFORE the LLM call
    this._detectAnchorReferencesHeuristic(text, index ?? this.messages.length - 1, participantName);

    // Compute heuristic engagement as fallback
    const heuristicAssessment = this._heuristicAssessment(text, index ?? this.messages.length - 1);

    // ---- Step 2: LLM analysis (one call, all dimensions) ----
    const analysis = await this._analyzeMessage(
      index ?? this.messages.length - 1, participantName, text, responseLatencyMs
    );

    // Use LLM results when available, heuristic fallback otherwise
    const isLLMDefault = (
      analysis.specificity === 0.5 &&
      analysis.profoundness === 0.5 &&
      analysis.coherence === 0.5
    );
    const effectiveAnalysis = isLLMDefault
      ? { ...analysis, ...heuristicAssessment }
      : analysis;

    // ---- Step 3: Feed into each tracker ----

    // Engagement
    this.engagement.recordAssessment({
      messageIndex: index ?? this.messages.length - 1,
      participantName,
      text,
      specificity: effectiveAnalysis.specificity,
      profoundness: effectiveAnalysis.profoundness,
      coherence: effectiveAnalysis.coherence,
      responseLatencyMs,
      timestamp
    });

    // Anchors: new anchors nominated by LLM
    if (analysis.newAnchors && analysis.newAnchors.length > 0) {
      for (const anchor of analysis.newAnchors) {
        this.anchors.addAnchor({
          messageIndex: index ?? this.messages.length - 1,
          participantName: anchor.participantName || participantName,
          text: anchor.text,
          profoundness: anchor.profoundness,
          summary: anchor.summary
        });
      }
    }

    // Anchors: LLM-detected references (supplements heuristic refs from Step 1)
    if (analysis.anchorReferences && analysis.anchorReferences.length > 0) {
      for (const ref of analysis.anchorReferences) {
        this.anchors.recordReference(ref.anchorId, index ?? this.messages.length - 1, participantName);
      }
    }

    // Claims
    if (analysis.claims && analysis.claims.length > 0) {
      this.claims.recordClaims(index ?? this.messages.length - 1, participantName, analysis.claims);
    }

    // ---- Step 4: Human deference — mark speech done ----
    this.deference.humanStoppedSpeaking(text, participantName);

    // ---- Step 5: Update conversation phase ----
    this._updatePhase();

    // ---- Step 6: Compute neuron signals ----
    const silenceDepth = this._computeSilenceDepth(responseLatencyMs, effectiveAnalysis.profoundness);
    const msgCount = totalMessages || this.messages.length;

    const signals = {
      engagementScore: this.engagement.getEngagementScore(),
      coherenceScore: this.engagement.getCoherenceScore(),
      topicRelevance: effectiveAnalysis.topicRelevance ?? 0.5,
      anchorDrift: this.anchors.computeAnchorDrift(msgCount),
      factualError: this.claims.getFactualErrorSignal(),
      silenceDepth,
      dominanceImbalance
    };

    // ---- Step 7: Deference check ----
    const deferenceCheck = this.deference.shouldDefer();
    if (deferenceCheck.defer) {
      return {
        shouldSpeak: false,
        activation: 0,
        reasoning: `Deferred: ${deferenceCheck.reason}`,
        deferred: true,
        signals,
        interventionType: null,
        phase: this.phase,
        context: this._buildContext(effectiveAnalysis)
      };
    }

    // Check for explicit human invitation — boosts activation
    const hasInvitation = this.deference.hasInvitation();
    if (hasInvitation) {
      this.deference.clearInvitation();
    }

    // ---- Step 8: Neuron decision ----
    const decision = this.neuron.decide(signals);

    // Human invitation overrides neuron
    if (hasInvitation && !decision.shouldSpeak) {
      decision.shouldSpeak = true;
      decision.reasoning = `Human invited AI to speak (neuron activation=${decision.activation})`;
    }

    // Check deferred message queue
    if (!decision.shouldSpeak && this.deference.hasDeferredMessage()) {
      const deferred = this.deference.getDeferredMessage();
      if (deferred && deferred.ageMs < 15000) {
        decision.shouldSpeak = true;
        decision.reasoning = `Releasing deferred message (age: ${(deferred.ageMs / 1000).toFixed(1)}s)`;
        decision.deferredMessage = deferred.message;
      }
    }

    // If neuron fires but human just stopped speaking, defer
    if (decision.shouldSpeak) {
      const recheck = this.deference.shouldDefer();
      if (recheck.defer) {
        this.deference.deferMessage('(pending)', recheck.reason);
        return {
          shouldSpeak: false,
          activation: decision.activation,
          reasoning: `Deferred: ${recheck.reason} (neuron wanted to speak)`,
          deferred: true,
          signals,
          interventionType: null,
          phase: this.phase,
          context: this._buildContext(effectiveAnalysis)
        };
      }
    }

    // ---- Step 9: Determine intervention type ----
    const interventionType = decision.shouldSpeak
      ? this._determineInterventionType(signals)
      : null;

    // Enrich decision with full context
    decision.interventionType = interventionType;
    decision.phase = this.phase;
    decision.context = this._buildContext(effectiveAnalysis);

    return decision;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Make one LLM call that assesses the message across ALL dimensions.
   */
  async _analyzeMessage(messageIndex, participantName, text, responseLatencyMs) {
    const recentHistory = this._getRecentHistoryForPrompt(15);
    const activeAnchors = this.anchors.formatForPrompt();

    const prompt = `You are a background conversation analyst for a Socratic discussion. Analyze this latest message in context.

OPENING QUESTION: ${this.openingQuestion}

RECENT CONVERSATION:
${recentHistory}

LATEST MESSAGE (analyze this):
[${participantName}]: ${text}

ACTIVE ANCHORS (load-bearing statements the group keeps returning to):
${activeAnchors}

Analyze the latest message and return ONLY a JSON object:

{
  "specificity": <float 0.0-1.0, how concrete/detailed vs vague is this statement>,
  "profoundness": <float 0.0-1.0, does this push thinking forward or deepen the discussion>,
  "coherence": <float 0.0-1.0, does this build on what was just said, or is it disconnected>,
  "topicRelevance": <float 0.0-1.0, how relevant to the opening question / core discussion>,

  "newAnchors": [
    <If this message contains a potentially load-bearing idea worth tracking, include it:>
    {"text": "<the key statement>", "summary": "<10-word summary>", "profoundness": <0.0-1.0>, "participantName": "${participantName}"}
  ],

  "anchorReferences": [
    <If this message refers back to or builds upon a known anchor, list references:>
    {"anchorId": "<id from active anchors>", "nature": "<extends|challenges|restates>"}
  ],

  "claims": [
    <Extract any claims made in this message:>
    {
      "text": "<the specific claim>",
      "classification": "<factual|normative|mixed>",
      "isAccurate": <true|false|null>,
      "correction": "<if false, brief factual correction, else null>",
      "confidence": <0.0-1.0 confidence in your accuracy assessment>
    }
  ]
}

IMPORTANT RULES:
- "specificity": "yeah I agree" = 0.1, "but what about the case where X because Y" = 0.8
- "profoundness": restating what others said = 0.2, introducing a new angle or challenging an assumption = 0.8
- "coherence": random topic change = 0.1, directly building on previous speaker = 0.9
- "topicRelevance": completely off-topic = 0.1, "helpfully off-topic" exploration = 0.6, directly on-topic = 0.9
- For claims: ONLY flag factual claims as isAccurate=false if you are HIGHLY confident. Do NOT fact-check opinions.
- For anchors: only nominate truly significant statements, not every comment. Be selective.
- If there's nothing notable for a field, use empty arrays.

Return ONLY the JSON, no other text.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      });

      const raw = response.content[0].text.trim();
      const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(jsonStr);
    } catch (error) {
      console.error('[ConversationAnalyzer] LLM analysis error:', error.message);
      return this._getDefaultAnalysis();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HEURISTIC FALLBACKS (instant, no LLM)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Regex-based engagement assessment when LLM fails or as instant pre-pass.
   */
  _heuristicAssessment(text, messageIndex) {
    const wordCount = text.split(/\s+/).length;

    // Specificity heuristic
    let specificity = 0.35;
    if (wordCount > 15) specificity += 0.1;
    if (wordCount > 30) specificity += 0.1;
    if (wordCount > 50) specificity += 0.1;
    if (/for example|for instance|specifically|such as/i.test(text)) specificity += 0.15;
    if (/because|since|therefore|the reason/i.test(text)) specificity += 0.1;
    if (/\d/.test(text)) specificity += 0.05; // numbers = concrete

    // Profoundness heuristic
    let profoundness = 0.35;
    if (/\b(why|how|what if|what makes|what would happen|what does it mean)\b/i.test(text)) profoundness += 0.2;
    if (/difference between|distinction|on the other hand|paradox|contradiction/i.test(text)) profoundness += 0.15;
    if (/identity|consciousness|truth|meaning|purpose|value|essence|exist/i.test(text)) profoundness += 0.1;
    if (/\?/.test(text) && wordCount > 8) profoundness += 0.1; // substantive questions

    // Coherence heuristic
    let coherence = 0.4;
    if (/agree|disagree|yes but|no but|however|building on|like you said/i.test(text)) coherence += 0.2;
    if (/going back to|earlier|before|mentioned|point about/i.test(text)) coherence += 0.2;
    if (this._referencesPreviousSpeaker(text)) coherence += 0.15;

    // Topic relevance: hard to do heuristically, use moderate default
    let topicRelevance = 0.5;

    return {
      specificity: Math.min(1, specificity),
      profoundness: Math.min(1, profoundness),
      coherence: Math.min(1, coherence),
      topicRelevance
    };
  }

  /**
   * Check if text references a previous speaker by name.
   */
  _referencesPreviousSpeaker(text) {
    const speakers = [...new Set(this.messages.map(m => m.participantName))];
    const textLower = text.toLowerCase();
    return speakers.some(name =>
      textLower.includes(name.toLowerCase()) &&
      (
        new RegExp(`as ${name} (said|mentioned|pointed out)`, 'i').test(text) ||
        new RegExp(`like ${name} (said|mentioned)`, 'i').test(text) ||
        new RegExp(`building on ${name}'s`, 'i').test(text) ||
        new RegExp(`${name}'s (point|idea|question|argument)`, 'i').test(text) ||
        new RegExp(`what ${name} (said|meant|was getting at)`, 'i').test(text)
      )
    );
  }

  /**
   * Detect anchor references via regex/keyword BEFORE the LLM response arrives.
   * This gives instant anchor tracking without API latency.
   */
  _detectAnchorReferencesHeuristic(text, messageIndex, participantName) {
    const activeAnchors = this.anchors.getActiveAnchors();
    const textLower = text.toLowerCase();

    for (const anchor of activeAnchors) {
      // Check for speaker reference + content reference
      const speaker = anchor.participantName?.toLowerCase();
      if (speaker && textLower.includes(speaker)) {
        const patterns = [
          new RegExp(`as ${speaker} (said|mentioned|pointed out)`, 'i'),
          new RegExp(`like ${speaker} (said|mentioned)`, 'i'),
          new RegExp(`building on ${speaker}'s`, 'i'),
          new RegExp(`${speaker}'s (point|idea|question)`, 'i'),
          new RegExp(`what ${speaker} (said|meant|was getting at)`, 'i')
        ];
        if (patterns.some(p => p.test(text))) {
          this.anchors.recordReference(anchor.id, messageIndex, participantName);
          continue;
        }
      }

      // Check for summary keyword overlap (significant words only)
      const summaryWords = anchor.summary.toLowerCase().split(/\s+/)
        .filter(w => w.length > 4); // skip short/common words
      const matchCount = summaryWords.filter(w => textLower.includes(w)).length;
      if (matchCount >= 2 && summaryWords.length > 0) {
        this.anchors.recordReference(anchor.id, messageIndex, participantName);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE TRACKING
  // ═══════════════════════════════════════════════════════════════════════════

  _updatePhase() {
    const engScore = this.engagement.getEngagementScore();
    const msgCount = this.messages.length;
    let newPhase = this.phase;

    if (msgCount < 5) {
      newPhase = 'opening';
    } else if (msgCount > 50) {
      newPhase = 'closing';
    } else if (engScore > 0.75) {
      newPhase = 'highEngagement';
    } else if (engScore < 0.35) {
      newPhase = 'struggling';
    } else {
      newPhase = 'active';
    }

    if (newPhase !== this.phase) {
      this.phase = newPhase;
      this.lastPhaseChangeAt = Date.now();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERVENTION TYPE ROUTING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Map neuron signals to a specific intervention strategy.
   * The facilitator LLM gets different prompts depending on the type.
   */
  _determineInterventionType(signals) {
    // Priority order: errors > dominance > drift > silence > engagement > normal

    if (signals.factualError > 0.5) return 'correct_fact';
    if (signals.dominanceImbalance > 0.5) return 'redirect_dominance';
    if (signals.anchorDrift > 0.6) return 'return_to_anchors';
    if (signals.silenceDepth > 0.7) return 'prompt_after_silence';
    if (signals.engagementScore < 0.4) return 'reignite_engagement';

    return 'normal';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SILENCE + CONTEXT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Context-aware silence depth.
   * Silence after a profound message = thinking (lower signal).
   */
  _computeSilenceDepth(responseLatencyMs, profoundnessOfPrevMessage) {
    if (responseLatencyMs == null || responseLatencyMs <= 0) return 0;

    const latencySec = responseLatencyMs / 1000;

    let depth;
    if (latencySec < 10) depth = 0;
    else if (latencySec < 20) depth = 0.2;
    else if (latencySec < 30) depth = 0.4;
    else if (latencySec < 45) depth = 0.6;
    else if (latencySec < 60) depth = 0.8;
    else depth = 1.0;

    // Discount silence if the previous message was profound (they're thinking)
    const prevProfoundness = profoundnessOfPrevMessage ?? 0.5;
    if (prevProfoundness > 0.6) {
      depth *= (1 - prevProfoundness * 0.4);
    }

    return Math.max(0, Math.min(1, depth));
  }

  _getRecentHistoryForPrompt(n = 15) {
    const recent = this.messages.slice(-n);
    if (recent.length === 0) return '(no messages yet)';
    return recent.map(m => `[${m.participantName}]: ${m.text}`).join('\n');
  }

  _getDefaultAnalysis() {
    return {
      specificity: 0.5,
      profoundness: 0.5,
      coherence: 0.5,
      topicRelevance: 0.5,
      newAnchors: [],
      anchorReferences: [],
      claims: []
    };
  }

  _buildContext(analysis) {
    return {
      topAnchors: this.anchors.getTopAnchors(3),
      uncorrectedErrors: this.claims.uncorrectedErrors,
      engagementState: this.engagement.getState(),
      deferenceState: this.deference.getState(),
      latestAnalysis: analysis
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — for integration with facilitation engine
  // ═══════════════════════════════════════════════════════════════════════════

  markErrorCorrected(claimId) {
    this.claims.markCorrected(claimId);
  }

  getFullState() {
    return {
      engagement: this.engagement.getState(),
      anchors: this.anchors.getState(),
      claims: this.claims.getState(),
      neuron: this.neuron.getState(),
      deference: this.deference.getState(),
      phase: this.phase,
      messageCount: this.messages.length
    };
  }

  /**
   * Get a summary suitable for the facilitation engine's LLM prompt.
   */
  getContextForFacilitator() {
    return {
      phase: this.phase,
      engagementScore: this.engagement.getEngagementScore(),
      coherenceScore: this.engagement.getCoherenceScore(),
      perParticipantEngagement: Object.fromEntries(this.engagement.getPerParticipantEngagement()),
      topAnchors: this.anchors.formatForPrompt(),
      anchorDrift: this.anchors.computeAnchorDrift(this.messages.length),
      uncorrectedErrors: this.claims.formatErrorsForPrompt(),
      claimStats: this.claims.getStats(),
      neuronStats: this.neuron.getStats()
    };
  }

  /**
   * Get specific intervention guidance text for the facilitation LLM prompt.
   */
  getInterventionGuidance(interventionType) {
    const context = this.getContextForFacilitator();

    switch (interventionType) {
      case 'correct_fact':
        return `⚠ FACTUAL CORRECTION NEEDED:\n${context.uncorrectedErrors}\n\nYour job is to gently surface the inaccuracy WITHOUT lecturing. Frame it as a question.\nExample: "Wait - is that right about [X]? I want to make sure we're building on accurate info."`;

      case 'redirect_dominance':
        return `⚠ ONE PERSON IS DOMINATING:\nSomeone has been speaking much more than others. Gently draw in quieter participants.\nDon't call out the dominant speaker — instead, invite others by name.`;

      case 'return_to_anchors':
        return `⚠ CONVERSATION HAS DRIFTED FROM KEY POINTS:\n${context.topAnchors}\n\nConsider whether to bring the conversation back to one of these anchors, or if the drift is productive.`;

      case 'reignite_engagement':
        return `⚠ ENGAGEMENT IS LOW:\nParticipants seem less engaged. Consider:\n- A provocative question\n- Connecting to something personal\n- Surfacing a tension they haven't noticed`;

      case 'prompt_after_silence':
        return `⚠ EXTENDED SILENCE:\nThe group has been quiet. This could mean:\n- They're thinking (good!)\n- They're stuck (help them)\n- They're done with this thread (pivot)\n\nCheck in gently without pressure.`;

      default:
        return `NORMAL FACILITATION MODE:\nThe conversation is flowing. Only intervene if you can add genuine value.\nWhen in doubt, stay silent.`;
    }
  }
}

module.exports = { ConversationAnalyzer };
