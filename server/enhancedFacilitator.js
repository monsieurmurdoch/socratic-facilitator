/**
 * Enhanced Facilitation Engine
 *
 * Integrates the new neural-inspired intervention system with
 * LLM-based message generation.
 *
 * Key changes from original:
 * 1. Uses FacilitationOrchestrator for intervention decisions
 * 2. Human deference built in from the ground up
 * 3. Anchor-aware message generation
 * 4. Factual error correction
 * 5. Plato identity for the facilitator
 */

const Anthropic = require("@anthropic-ai/sdk");
const { FacilitationOrchestrator, AGE_PROFILES } = require("./analysis/facilitationOrchestrator");
const { MessageAssessor } = require("./analysis/messageAssessor");
const { getMoveTaxonomyPrompt } = require("./moves");
const { getAgeCalibration, FACILITATION_PARAMS, SOLO_EXCLUDED_MOVES, getFacilitationParams } = require("./config");
const {
  PLATO_IDENTITY,
  getPlatoForAge,
  getPlatoSystemPromptAddition,
  getPlatoDisplayConfig
} = require("./platoIdentity");

class EnhancedFacilitationEngine {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.model = "claude-sonnet-4-5-20250514";

    // Orchestrator instances per session
    this.orchestrators = new Map();

    // Message assessor for LLM-based analysis
    this.messageAssessor = new MessageAssessor(apiKey);

    // Plato display config for frontend
    this.platoDisplay = getPlatoDisplayConfig();
  }

  /**
   * Get or create an orchestrator for a session.
   */
  getOrchestrator(sessionId, opts = {}) {
    if (!this.orchestrators.has(sessionId)) {
      this.orchestrators.set(sessionId, new FacilitationOrchestrator(opts));
    }
    return this.orchestrators.get(sessionId);
  }

  /**
   * Process a participant message and decide whether to intervene.
   *
   * @param {object} stateTracker  The existing state tracker
   * @param {object} message
   * @returns {object} Decision with shouldSpeak, message, etc.
   */
  async processMessage(stateTracker, message) {
    const sessionId = stateTracker.sessionId;
    const ages = Array.from(stateTracker.participants.values()).map(p => p.age);
    const ageCalibration = getAgeCalibration(ages);
    const participantCount = stateTracker.participants.size;
    const isSolo = participantCount <= 1;

    // Use solo neuron profile if only one participant
    const baseAgeProfile = this._getAgeProfile(ages);
    const ageProfile = isSolo ? `solo_${baseAgeProfile}` : baseAgeProfile;

    // Get orchestrator (re-create if solo status changed)
    const orchestrator = this.getOrchestrator(sessionId, {
      ageProfile,
      topicTitle: stateTracker.topic?.title,
      openingQuestion: stateTracker.topic?.openingQuestion
    });

    // Process message through orchestrator
    const analysis = orchestrator.processMessage({
      participantName: message.participantName,
      text: message.text,
      timestamp: message.timestamp || Date.now(),
      llmAssessment: message.llmAssessment  // Optional pre-computed assessment
    });

    const decision = analysis.decision;

    // If we should speak, generate the message
    if (decision.shouldSpeak) {
      const generatedMessage = await this._generateMessage(
        stateTracker,
        orchestrator,
        decision,
        ageCalibration
      );

      return {
        shouldSpeak: true,
        message: generatedMessage.text,
        move: generatedMessage.move,
        targetParticipantName: generatedMessage.targetParticipantName,
        reasoning: decision.reason,
        activation: decision.activation,
        analysis
      };
    }

    // Otherwise, return the decision
    return {
      shouldSpeak: false,
      reasoning: decision.reason,
      activation: decision.activation,
      analysis
    };
  }

  /**
   * Legacy compatibility: Main decision function.
   * Called after every participant message.
   */
  async decide(stateTracker, params = FACILITATION_PARAMS) {
    // Get the last participant message
    const lastMessage = stateTracker.messages[stateTracker.messages.length - 1];

    if (!lastMessage || lastMessage.participantId === "__facilitator__") {
      return {
        shouldSpeak: false,
        reasoning: "No new participant message",
        move: null,
        targetParticipantName: null,
        message: null,
        stateUpdates: {}
      };
    }

    // Process through new system
    const result = await this.processMessage(stateTracker, {
      participantName: lastMessage.participantName,
      text: lastMessage.text,
      timestamp: lastMessage.timestamp
    });

    return {
      shouldSpeak: result.shouldSpeak,
      reasoning: result.reasoning,
      move: result.move || null,
      targetParticipantName: result.targetParticipantName || null,
      message: result.message || null,
      stateUpdates: {},
      _debug: result.analysis  // Include analysis for debugging
    };
  }

  /**
   * Generate the facilitator message.
   */
  async _generateMessage(stateTracker, orchestrator, decision, ageCalibration) {
    const snapshot = await stateTracker.getStateSnapshot();
    const history = await stateTracker.getRecentHistory(40);
    const llmContext = orchestrator.getLLMContext();
    const participantCount = stateTracker.participants.size;

    // Determine what kind of intervention is needed
    const interventionType = this._determineInterventionType(decision, orchestrator);

    const ages = Array.from(stateTracker.participants.values()).map(p => p.age);
    const ageProfile = this._getAgeProfile(ages);

    const systemPrompt = this._buildSystemPrompt(
      stateTracker.topic,
      ageCalibration,
      interventionType,
      llmContext,
      ageProfile,
      participantCount
    );

    const userMessage = this._buildUserMessage(
      snapshot,
      history,
      decision,
      interventionType,
      llmContext
    );

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }]
      });

      const text = response.content[0].text.trim();
      const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const result = JSON.parse(jsonStr);

      // Record anchor if this message establishes one
      if (result.isAnchor) {
        orchestrator.anchorTracker.addAnchor({
          messageIndex: stateTracker.messages.length,
          participantName: 'Facilitator',
          text: result.message,
          profoundness: result.anchorProfundness || 0.5,
          summary: result.anchorSummary || result.message.substring(0, 100)
        });
      }

      return {
        text: result.message,
        move: result.move,
        targetParticipantName: result.targetParticipantName,
        isAnchor: result.isAnchor || false
      };
    } catch (error) {
      console.error("Message generation error:", error.message);
      return {
        text: "Can you say more about that?",
        move: "deepen",
        targetParticipantName: null,
        isAnchor: false
      };
    }
  }

  /**
   * Determine the type of intervention needed.
   */
  _determineInterventionType(decision, orchestrator) {
    const state = orchestrator.getState();

    // Check for factual error
    if (state.claims.uncorrectedErrors?.length > 0) {
      return 'correct_fact';
    }

    // Check for deferred message release
    if (decision.reason === 'releasing_deferred_message' ||
        decision.reason === 'human_invited_deferred_message') {
      return 'deferred_message';
    }

    // Check for dominance correction
    if (decision.signals?.dominanceImbalance > 0.5) {
      return 'redirect_dominance';
    }

    // Check for anchor drift
    if (decision.signals?.anchorDrift > 0.6) {
      return 'return_to_anchors';
    }

    // Check for low engagement
    if (decision.signals?.engagementScore < 0.4) {
      return 'reignite_engagement';
    }

    // Check for extended silence
    if (decision.signals?.silenceDepth > 0.7) {
      return 'prompt_after_silence';
    }

    // Default: normal facilitation
    return 'normal';
  }

  /**
   * Build the system prompt.
   */
  _buildSystemPrompt(topic, ageCalibration, interventionType, llmContext, ageProfile = 'middle', participantCount = 2) {
    const isSolo = participantCount <= 1;
    const interventionGuidance = this._getInterventionGuidance(interventionType, llmContext);
    const platoIdentity = getPlatoSystemPromptAddition(ageProfile);

    const roleDescription = isSolo
      ? `YOUR ROLE:
- You are having a 1-on-1 Socratic dialogue with a single thinker
- You help them examine their assumptions, test their logic, and explore ideas more deeply
- You never give answers, explanations, or your own opinion on the discussion topic
- You address the participant by name
- You ask ONE question at a time — never stack multiple questions
- You are more conversational and responsive than in a group — this is a dialogue, not facilitation`
      : `YOUR ROLE:
- You facilitate a multi-person conversation among students
- You help them think more carefully, listen to each other, and explore ideas together
- You never give answers, explanations, or your own opinion on the discussion topic
- You address participants by name — always be specific about who you're talking to
- You ask ONE question at a time — never stack multiple questions`;

    const silenceGuidance = isSolo
      ? `YOUR DEFAULT POSTURE IS LISTENING.
You respond after each message — this is a dialogue. But keep responses tight: one question, nothing more.`
      : `YOUR DEFAULT STATE IS SILENCE.
Most of the time, you should not speak. The conversation belongs to the participants.`;

    const moveTaxonomy = getMoveTaxonomyPrompt({
      solo: isSolo,
      exclude: isSolo ? SOLO_EXCLUDED_MOVES : []
    });

    return `You are a Socratic discussion facilitator${isSolo ? ' in a 1-on-1 dialogue' : ' for a group of young people'}. You are NOT a teacher, tutor, or expert. You do not explain, lecture, or share your own views on the topic. You ask questions. That is your only tool.
${platoIdentity}
${roleDescription}

${silenceGuidance}

CURRENT CONVERSATION STATE:
Phase: ${llmContext.phase}
Messages so far: ${llmContext.messageCount}
Engagement score: ${llmContext.engagementScore}
Coherence score: ${llmContext.coherenceScore}

${interventionGuidance}

THE DISCUSSION TOPIC:
Title: ${topic.title}
Opening question: ${topic.openingQuestion}
Possible follow-up angles: ${topic.followUpAngles?.join("; ") || 'None specified'}

AGE CALIBRATION:
- Vocabulary level: ${ageCalibration.vocabLevel}
- Question complexity: ${ageCalibration.maxQuestionComplexity}

FACILITATION MOVES AVAILABLE:
${moveTaxonomy}

OUTPUT FORMAT:
You must respond with ONLY a JSON object:
{
  "message": "What you will say (one short question)",
  "move": "move_id from taxonomy",
  "targetParticipantName": "Name of who you're addressing (or null for group)",
  "reasoning": "Brief explanation of why you chose this intervention",
  "isAnchor": false,
  "anchorSummary": null
}

CRITICAL RULES:
1. Keep it SHORT. One question maximum.
2. Use names. Be specific.
3. Never lecture. Never explain.
4. If correcting a fact, do it gently as a question ("Is it possible that...?")
5. Build on what they've said, especially anchor points.
6. Never use these phrases: ${PLATO_IDENTITY.personality.language.forbiddenPhrases.slice(0, 4).join(', ')}`;
  }

  /**
   * Get specific guidance based on intervention type.
   */
  _getInterventionGuidance(type, llmContext) {
    switch (type) {
      case 'correct_fact':
        return `⚠ FACTUAL CORRECTION NEEDED:
${llmContext.uncorrectedErrors}

Your job is to gently surface the inaccuracy WITHOUT lecturing. Frame it as a question.
Example: "Wait - is that right about [X]? I want to make sure we're building on accurate info."`;

      case 'redirect_dominance':
        return `⚠ ONE PERSON IS DOMINATING:
Someone has been speaking a lot more than others. Gently draw in quieter participants.
Don't call out the dominant speaker directly - instead, invite others.`;

      case 'return_to_anchors':
        return `⚠ CONVERSATION HAS DRIFTED FROM KEY POINTS:
${llmContext.anchorsFormatted}

Consider whether to bring the conversation back to one of these anchors, or if the drift is productive.`;

      case 'reignite_engagement':
        return `⚠ ENGAGEMENT IS LOW:
Participants seem less engaged. Consider:
- A provocative question
- Connecting to something personal
- Surfacing a tension they haven't noticed`;

      case 'prompt_after_silence':
        return `⚠ EXTENDED SILENCE:
The group has been quiet. This could mean:
- They're thinking (good!)
- They're stuck (help them)
- They're done with this thread (pivot)

Check in gently without pressure.`;

      case 'deferred_message':
        return `📢 HUMAN INVITED YOU TO SPEAK:
A participant explicitly asked for your input. This is a rare invitation - use it well.
Don't over-explain, but you can be slightly more substantive than usual.`;

      default:
        return `NORMAL FACILITATION MODE:
The conversation is flowing. Only intervene if you can add genuine value.
When in doubt, stay silent.`;
    }
  }

  /**
   * Build the user message with conversation context.
   */
  _buildUserMessage(snapshot, history, decision, interventionType, llmContext) {
    return `CURRENT STATE:
${JSON.stringify(snapshot, null, 2)}

RECENT CONVERSATION:
${history}

DECISION CONTEXT:
- Intervention type: ${interventionType}
- Activation: ${decision.activation}
- Reason: ${decision.reason}
${decision.signals ? `- Engagement: ${decision.signals.engagementScore}\n- Coherence: ${decision.signals.coherenceScore}\n- Anchor drift: ${decision.signals.anchorDrift}` : ''}

Based on this, generate your intervention message. Remember: ONE question, SHORT, use names.

Respond with ONLY the JSON.`;
  }

  /**
   * Get age profile string from ages array.
   */
  _getAgeProfile(ages) {
    if (!ages || ages.length === 0) return 'middle';
    const avg = ages.reduce((a, b) => a + b, 0) / ages.length;
    if (avg <= 10) return 'young';
    if (avg <= 14) return 'middle';
    return 'older';
  }

  /**
   * Generate opening message (unchanged from original).
   */
  async generateOpening(topic, participantNames, ageCalibration) {
    const prompt = `You are opening a Socratic discussion with these participants: ${participantNames.join(", ")}.

Topic: ${topic.title}
Passage: ${topic.passage}
Suggested opening question: ${topic.openingQuestion}
Age calibration: ${ageCalibration.vocabLevel}

Generate a brief, warm opening that:
1. Welcomes everyone by name
2. Presents or references the passage/scenario briefly
3. Asks the opening question
4. Keeps it to 3-4 sentences maximum

Do NOT explain what Socratic discussion is. Do NOT give rules. Just open naturally.
Respond with ONLY the opening message text, nothing else.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }]
      });
      return response.content[0].text.trim();
    } catch (error) {
      console.error("Error generating opening:", error.message);
      return `Welcome everyone! Let's think about this together: ${topic.openingQuestion}`;
    }
  }

  /**
   * Generate closing synthesis (unchanged from original).
   */
  async generateClosing(stateTracker) {
    const snapshot = await stateTracker.getStateSnapshot();
    const history = await stateTracker.getRecentHistory(60);

    const prompt = `The Socratic discussion is ending. Based on the conversation below, generate a brief closing synthesis (3-5 sentences) that:
1. Summarizes the main ideas that emerged (without judging them as right or wrong)
2. Notes any interesting tensions or disagreements that remain
3. Highlights 1-2 open questions the group might continue thinking about
4. Thanks everyone naturally

Do NOT lecture. Do NOT resolve the discussion. Leave it open.

CONVERSATION:
${history}

Respond with ONLY the closing message text.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }]
      });
      return response.content[0].text.trim();
    } catch (error) {
      console.error("Error generating closing:", error.message);
      return "That was a great discussion. Keep thinking about these questions.";
    }
  }

  /**
   * Clean up orchestrator for a session.
   */
  cleanupSession(sessionId) {
    this.orchestrators.delete(sessionId);
  }

  /**
   * Get orchestrator state for debugging.
   */
  getOrchestratorState(sessionId) {
    const orchestrator = this.orchestrators.get(sessionId);
    return orchestrator ? orchestrator.getState() : null;
  }

  /**
   * Get Plato display configuration for frontend.
   */
  getPlatoDisplay() {
    return this.platoDisplay;
  }

  /**
   * Get the facilitator name (Plato).
   */
  getFacilitatorName() {
    return PLATO_IDENTITY.name;
  }
}

module.exports = {
  EnhancedFacilitationEngine,
  getPlatoDisplayConfig,
  PLATO_IDENTITY
};
