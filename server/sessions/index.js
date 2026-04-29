/**
 * Session Manager Module
 * Manages active session state and session-related operations
 */

const { DISCUSSION_TOPICS, FACILITATION_PARAMS, getAgeCalibration, getFacilitationParams } = require("../config");
const { createStore } = require("./store-factory");
const profileBuilder = require("../analysis/profileBuilder");
const messageAnalyticsRepo = require("../db/repositories/messageAnalytics");
const sessionMembershipsRepo = require("../db/repositories/sessionMemberships");
const { computeMessageMetrics } = require("../analysis/scoring");
const { getSpeechPatiencePreset, normalizeSpeechPatienceMode } = require("../speech-patience");
const WARMUP_REPLY_BASE_DELAY_MS = Number(process.env.WARMUP_REPLY_BASE_DELAY_MS || 250);
const WARMUP_REPLY_JITTER_MS = Number(process.env.WARMUP_REPLY_JITTER_MS || 450);

class SessionManager {
  constructor(deps) {
    this.activeSessions = new Map();
    this.silenceCheckers = new Map();
    this.deps = deps;
    this.store = createStore();
  }

  /**
   * Initialize the session store (connect to Redis if configured).
   */
  async init() {
    if (this.store.connect) {
      await this.store.connect();
    }
  }

  /**
   * Get session by short code
   */
  get(shortCode) {
    return this.activeSessions.get(shortCode);
  }

  /**
   * Set session by short code
   */
  set(shortCode, session) {
    this.activeSessions.set(shortCode, session);
  }

  /**
   * Delete session by short code
   */
  delete(shortCode) {
    this.activeSessions.delete(shortCode);
  }

  /**
   * Broadcast message to all clients in a session
   */
  broadcast(shortCode, message) {
    const session = this.activeSessions.get(shortCode);
    if (!session) return;

    const data = JSON.stringify(message);

    for (const client of session.clients) {
      if (client.ws.readyState === 1) {
        client.ws.send(data);
      }
    }
  }

  /**
   * Find participant ID by name (case-insensitive)
   */
  findParticipantIdByName(stateTracker, name) {
    for (const [id, p] of stateTracker.participants) {
      if (p.name.toLowerCase() === name.toLowerCase()) return id;
    }
    return null;
  }

  /**
   * Ensure warmup state structures exist
   */
  ensureWarmupState(session) {
    if (!session.pendingWarmupTurns) {
      session.pendingWarmupTurns = new Map();
    }
    if (!session.pendingWarmupReplies) {
      session.pendingWarmupReplies = new Map();
    }
    if (!session.warmupSpeechActivity) {
      session.warmupSpeechActivity = new Map();
    }
    if (!session.warmupSpeechVersions) {
      session.warmupSpeechVersions = new Map();
    }
  }

  /**
   * Clear pending warmup reply
   */
  clearPendingWarmupReply(session, clientId) {
    this.ensureWarmupState(session);
    const pendingReply = session.pendingWarmupReplies.get(clientId);
    if (pendingReply?.timer) {
      clearTimeout(pendingReply.timer);
    }
    session.pendingWarmupReplies.delete(clientId);
  }

  getEffectiveParams(session) {
    const participantCount = session?.stateTracker?.participants?.size || 0;
    const base = { ...getFacilitationParams(participantCount || 0) };
    if (!session?.paramOverrides) return base;
    return {
      ...base,
      ...session.paramOverrides
    };
  }

  getSpeechPatience(session) {
    const mode = normalizeSpeechPatienceMode(session?.paramOverrides?.speechPatienceMode);
    return getSpeechPatiencePreset(mode);
  }

  countWords(text) {
    return String(text || "").trim().split(/\s+/).filter(Boolean).length;
  }

  estimateSpeakingSeconds(text) {
    const words = this.countWords(text);
    if (!words) return 0;
    return Math.max(1, Math.round((words / 150) * 60));
  }

  async assessParticipantText(sessionShortCode, session, participant, text, previousMessage, options = {}) {
    if (!this.deps.messageAssessor?.assess) return null;
    return this.deps.messageAssessor.assess({
      text,
      participantName: participant.name,
      previousText: previousMessage?.text,
      topicTitle: session.topic?.title,
      openingQuestion: session.topic?.openingQuestion,
      recentAnchors: this.deps.enhancedEngine?.getOrchestrator?.(sessionShortCode)?.anchorTracker?.getTopAnchors(3) || []
    }, options);
  }

  async persistParticipantAnalytics(session, participant, recordedMessage, assessment = null) {
    if (!recordedMessage) return;

    const dbParticipantId = recordedMessage.dbParticipantId || participant.dbId || participant.id;
    const metrics = computeMessageMetrics(assessment || {});

    try {
      await sessionMembershipsRepo.recordMessage(dbParticipantId, {
        wordCount: this.countWords(recordedMessage.text),
        estimatedSpeakingSeconds: this.estimateSpeakingSeconds(recordedMessage.text),
        contributionScore: metrics.contributionWeight,
        engagementScore: metrics.engagementEstimate
      });
    } catch (error) {
      console.error("[analytics] Failed to update session membership metrics:", error.message);
    }

    if (!recordedMessage.dbId) return;

    try {
      await messageAnalyticsRepo.save({
        sessionId: session.stateTracker.sessionId,
        messageId: recordedMessage.dbId,
        participantId: dbParticipantId,
        specificity: metrics.specificity,
        profoundness: metrics.profoundness,
        coherence: metrics.coherence,
        discussionValue: metrics.discussionValue,
        contributionWeight: metrics.contributionWeight,
        engagementEstimate: metrics.engagementEstimate,
        respondedToPeer: metrics.respondedToPeer,
        referencedAnchor: metrics.referencedAnchor,
        isAnchor: !!assessment?.anchor?.isAnchor,
        reasoning: assessment?.briefReasoning || null,
        rawPayload: assessment || {}
      });
    } catch (error) {
      console.error("[analytics] Failed to save message analytics:", error.message);
    }
  }

  /**
   * Mark speech activity for warmup
   */
  markWarmupSpeechActivity(sessionShortCode, clientId) {
    const session = this.activeSessions.get(sessionShortCode);
    if (!session || session.active) return;
    this.ensureWarmupState(session);
    session.warmupSpeechActivity.set(clientId, Date.now());
    session.warmupSpeechVersions.set(clientId, (session.warmupSpeechVersions.get(clientId) || 0) + 1);
    this.clearPendingWarmupReply(session, clientId);
  }

  /**
   * Finalize warmup turn and generate AI response
   */
  async finalizeWarmupTurn(sessionShortCode, clientId, options = {}) {
    const session = this.activeSessions.get(sessionShortCode);
    if (!session || session.active) return;

    this.ensureWarmupState(session);
    const pendingTurn = session.pendingWarmupTurns.get(clientId);
    if (!pendingTurn) return;
    if (pendingTurn.timer) {
      clearTimeout(pendingTurn.timer);
    }

    session.pendingWarmupTurns.delete(clientId);
    const participant = session.stateTracker.participants.get(clientId);
    if (!participant) return;

    const text = pendingTurn.text
      .replace(/\s+/g, " ")
      .trim();
    if (!text) return;
    const expectedSpeechVersion = session.warmupSpeechVersions.get(clientId) || 0;
    const previousMessage = session.stateTracker.messages?.at(-1) || null;
    const assessment = await this.assessParticipantText(sessionShortCode, session, participant, text, previousMessage, {
      strategy: 'heuristic_only'
    });
    const recordedMessage = await session.stateTracker.recordMessage(clientId, text);
    await this.persistParticipantAnalytics(session, participant, recordedMessage, assessment);

    this.broadcast(sessionShortCode, {
      type: "participant_message",
      name: participant.name,
      senderId: clientId,
      text,
      timestamp: Date.now()
    });

    if (options.respond === false) {
      return;
    }

    const names = Array.from(session.stateTracker.participants.values()).map(p => p.name);
    const ages = Array.from(session.stateTracker.participants.values()).map(p => p.age);
    const ageCalibration = getAgeCalibration(ages);

    const generateReply = async () => {
      const latestSpeechAt = session.warmupSpeechActivity.get(clientId) || 0;
      const latestSpeechVersion = session.warmupSpeechVersions.get(clientId) || 0;
      if (latestSpeechVersion !== expectedSpeechVersion) {
        this.clearPendingWarmupReply(session, clientId);
        return;
      }
      const speechPatience = this.getSpeechPatience(session);
      if (pendingTurn.source === "stt" && Date.now() - latestSpeechAt < speechPatience.warmupSettleMs) {
        const retryDelay = Math.max(150, speechPatience.warmupSettleMs - (Date.now() - latestSpeechAt));
        const timer = setTimeout(generateReply, retryDelay);
        session.pendingWarmupReplies.set(clientId, { timer });
        return;
      }

      this.clearPendingWarmupReply(session, clientId);

      const reply = await this.deps.enhancedEngine.warmupChat(
        sessionShortCode, participant.name, text, names, ageCalibration, session.topic
      );
      const currentSpeechVersion = session.warmupSpeechVersions.get(clientId) || 0;
      if (currentSpeechVersion !== expectedSpeechVersion) {
        return;
      }

      if (reply) {
        // No artificial delay — the LLM call already provides natural latency.
        // Just verify the user hasn't started speaking again.
        const stillActiveSession = this.activeSessions.get(sessionShortCode);
        if (!stillActiveSession || stillActiveSession.active) return;
        const newestSpeechVersion = stillActiveSession.warmupSpeechVersions?.get(clientId) || 0;
        if (newestSpeechVersion !== expectedSpeechVersion) return;
        await session.stateTracker.recordAIMessage?.(reply, "warmup");
        this.broadcast(sessionShortCode, {
          type: "facilitator_message",
          text: reply,
          move: "warmup",
          timestamp: Date.now()
        });
      }

      console.log(`[${sessionShortCode}] ☀ WARMUP | ${participant.name}: "${text}"`);
      console.log(`  → Plato: "${reply?.substring(0, 80)}${reply?.length > 80 ? '...' : ''}"`);
    };

    if (pendingTurn.source === "stt") {
      const speechPatience = this.getSpeechPatience(session);
      const timer = setTimeout(generateReply, speechPatience.warmupSettleMs);
      session.pendingWarmupReplies.set(clientId, { timer });
      return;
    }

    await generateReply();
  }

  async flushPendingWarmupTurns(sessionShortCode, options = {}) {
    const session = this.activeSessions.get(sessionShortCode);
    if (!session || session.active) return;
    this.ensureWarmupState(session);

    const pendingClientIds = Array.from(session.pendingWarmupTurns.keys());
    for (const clientId of pendingClientIds) {
      await this.finalizeWarmupTurn(sessionShortCode, clientId, options);
    }
  }

  /**
   * Queue warmup turn for processing
   */
  queueWarmupTurn(sessionShortCode, clientId, text, source = "text") {
    const session = this.activeSessions.get(sessionShortCode);
    if (!session || session.active) return;

    this.ensureWarmupState(session);

    const normalizedText = String(text || "").trim();
    if (!normalizedText) return;

    if (source === "stt") {
      this.markWarmupSpeechActivity(sessionShortCode, clientId);
    } else {
      session.warmupSpeechActivity.set(clientId, Date.now());
      session.warmupSpeechVersions.set(clientId, (session.warmupSpeechVersions.get(clientId) || 0) + 1);
      this.clearPendingWarmupReply(session, clientId);
    }

    const existing = session.pendingWarmupTurns.get(clientId);
    const pendingTurn = existing || { text: "", source };
    pendingTurn.text = pendingTurn.text
      ? `${pendingTurn.text} ${normalizedText}`
      : normalizedText;
    pendingTurn.source = source;

    if (pendingTurn.timer) {
      clearTimeout(pendingTurn.timer);
    }

    const speechPatience = this.getSpeechPatience(session);
    const delay = source === "stt" ? speechPatience.warmupMergeMs : 0;
    pendingTurn.timer = setTimeout(() => {
      this.finalizeWarmupTurn(sessionShortCode, clientId).catch((error) => {
        console.error("[warmup] finalize turn error:", error.message);
      });
    }, delay);

    session.pendingWarmupTurns.set(clientId, pendingTurn);
  }

  /**
   * Start silence checker for a session
   */
  startSilenceChecker(sessionShortCode) {
    const interval = setInterval(async () => {
      const session = this.activeSessions.get(sessionShortCode);
      if (!session || !session.active) {
        clearInterval(interval);
        this.silenceCheckers.delete(sessionShortCode);
        return;
      }

      const snapshot = await session.stateTracker.getStateSnapshot();
      // Use age-calibrated silence tolerance instead of flat timeout
      const ages = Array.from(session.stateTracker.participants.values()).map(p => p.age);
      const ageCalibration = getAgeCalibration(ages);
      const effectiveParams = this.getEffectiveParams(session);
      const silenceThreshold = effectiveParams.silenceTimeoutSec || ageCalibration.silenceToleranceSec || FACILITATION_PARAMS.silenceTimeoutSec;

      if (snapshot.silenceSinceLastActivitySec >= silenceThreshold) {
        const decision = await this.deps.enhancedEngine.decide(session.stateTracker);
        if (decision.shouldSpeak && decision.message) {
          await this.handleFacilitatorMessage(sessionShortCode, decision);
        }
      }
    }, 10000);

    this.silenceCheckers.set(sessionShortCode, interval);
  }

  /**
   * Handle facilitator message (AI speaking)
   */
  async handleFacilitatorMessage(sessionShortCode, decision) {
    const session = this.activeSessions.get(sessionShortCode);
    if (!session) return;

    const targetId = decision.targetParticipantName
      ? this.findParticipantIdByName(session.stateTracker, decision.targetParticipantName)
      : null;

    await session.stateTracker.recordAIMessage(decision.message, decision.move, targetId);

    this.broadcast(sessionShortCode, {
      type: "facilitator_message",
      text: decision.message,
      move: decision.move,
      timestamp: Date.now()
    });

    // If this is a synthesis move, the discussion is ending - trigger cleanup
    if (decision.move === "synthesize") {
      console.log(`[${sessionShortCode}] AI triggered discussion conclusion - ending session`);

      // Mark session as inactive and update database
      session.active = false;
      await this.deps.sessionsRepo.updateStatus(session.dbSession.id, 'ended');

      // Update learner profiles for all participants with user IDs
      const participants = Array.from(session.stateTracker.participants.values());
      for (const participant of participants) {
        if (participant.userId) {
          try {
            await profileBuilder.addSessionToProfile(participant.userId, session.dbSession.id);
            console.log(`[${sessionShortCode}] Updated learner profile for user ${participant.userId}`);
          } catch (error) {
            console.error(`[${sessionShortCode}] Error updating learner profile for user ${participant.userId}:`, error.message);
          }
        }
      }

      // Stop silence checker
      const checker = this.silenceCheckers.get(sessionShortCode);
      if (checker) {
        clearInterval(checker);
        this.silenceCheckers.delete(sessionShortCode);
      }

      // Stop Jitsi bot if running
      if (session.jitsiBot && this.deps.jitsiLauncher) {
        console.log(`[${sessionShortCode}] Stopping Jitsi bot...`);
        this.deps.jitsiLauncher.stopJitsiBot(session.jitsiBot);
        session.jitsiBot = null;
      }

      // Clean up facilitation engine session state
      this.deps.enhancedEngine.cleanupSession(session.stateTracker?.sessionId);

      // Send discussion_ended to all clients
      this.broadcast(sessionShortCode, {
        type: "discussion_ended"
      });

      console.log(`[${sessionShortCode}] Discussion ended by AI facilitator.`);
    }

    // TTS disabled for beta — text-only Plato
    // try {
    //   const wavBuffer = await this.deps.generateTTS(decision.message);
    //   for (const client of session.clients) {
    //     if (client.ws.readyState === 1) client.ws.send(wavBuffer);
    //   }
    // } catch (e) {
    //   console.error("TTS Error:", e);
    // }
  }

  /**
   * Handle participant message
   */
  async handleParticipantMessage(sessionShortCode, clientId, text, meta = {}) {
    const session = this.activeSessions.get(sessionShortCode);
    if (!session) return;

    const participant = session.stateTracker.participants.get(clientId);
    if (!participant) return;

    // ── Pre-discussion: warmup chat mode ──
    if (!session.active) {
      this.queueWarmupTurn(sessionShortCode, clientId, text, meta.source || "text");
      return;
    }

    // ── Active discussion: full pedagogical pipeline ──
    const previousMessage = session.stateTracker.messages?.at(-1) || null;
    let llmAssessment = null;
    if (this.deps.useEnhancedSystem) {
      // Run assessment with heuristic fallback on timeout for speed.
      // The fast LLM gets 1500ms; if it misses, heuristics are instant.
      llmAssessment = await this.assessParticipantText(sessionShortCode, session, participant, text, previousMessage, {
        strategy: 'fast_only'  // Use fastLLM only, no Claude fallback for speed
      });
    }

    const recordedMessage = await session.stateTracker.recordMessage(clientId, text);
    await this.persistParticipantAnalytics(session, participant, recordedMessage, llmAssessment);

    this.broadcast(sessionShortCode, {
      type: "participant_message",
      name: participant.name,
      senderId: clientId,
      text: text,
      timestamp: Date.now()
    });

    // If teacher paused Plato, skip facilitation pipeline
    if (session.paused) {
      console.log(`[${sessionShortCode}] ${participant.name}: "${text}" [PAUSED — skipping pipeline]`);
      return;
    }

    const effectiveParams = this.getEffectiveParams(session);
    const hardConstraints = await session.stateTracker.getHardConstraints(effectiveParams);

    // Use enhanced engine with orchestrator if enabled
    let decision;
    const pipelineStart = Date.now();

    if (this.deps.useEnhancedSystem) {
      // Process through enhanced engine (neuron decision + message generation if needed)
      decision = await this.deps.enhancedEngine.processMessage(session.stateTracker, {
        participantName: participant.name,
        text,
        timestamp: Date.now(),
        llmAssessment
      });
    } else {
      // Fallback to legacy decide() path (still uses enhanced engine)
      decision = await this.deps.enhancedEngine.decide(session.stateTracker);
    }

    const pipelineLatencyMs = Date.now() - pipelineStart;

    if (decision.shouldSpeak && !hardConstraints.canSpeak && !decision.forced) {
      decision = {
        ...decision,
        shouldSpeak: false,
        reasoning: `${decision.reasoning || decision.reason || 'suppressed'} | constrained: ${hardConstraints.reasons.join('; ')}`
      };
    }

    if (decision.shouldSpeak && decision.message) {
      if (pipelineLatencyMs > 8000) {
        console.warn(`[${sessionShortCode}] ⚠ Pipeline latency: ${pipelineLatencyMs}ms — consider tuning timeouts`);
      }

      // Pipeline already takes 1-3s — no artificial delay needed.
      // Deliver immediately for responsiveness.
      await this.handleFacilitatorMessage(sessionShortCode, decision);
    }

    // Log with neuron info when available
    const analysis = decision.analysis || decision._analysis;
    const activation = analysis?.decision?.activation ?? analysis?.activation ?? decision.activation;
    const neuronInfo = activation != null ? ` [neuron=${typeof activation === 'number' ? activation.toFixed(3) : activation}]` : '';
    const iType = analysis?.decision?.interventionType || analysis?.interventionType || '';
    const move = decision.move || 'unknown';
    console.log(`[${sessionShortCode}] ${participant.name}: "${text}"`);
    console.log(`  → Decision: ${decision.shouldSpeak ? move : "SILENT"}${neuronInfo}${iType ? ` type=${iType}` : ''} | ${decision.reasoning || decision.reason || ''}`);
  }
}

module.exports = SessionManager;
