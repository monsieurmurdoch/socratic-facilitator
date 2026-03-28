/**
 * Facilitation Engine (Upgraded)
 *
 * Now powered by the ConversationAnalyzer pedagogical engine:
 * 1. Analyzer runs background analysis (engagement, anchors, claims)
 * 2. InterventionNeuron makes the binary speak/don't-speak decision
 * 3. If neuron fires, LLM generates the intervention message
 *
 * The LLM no longer decides WHETHER to speak — only WHAT to say.
 */

const Anthropic = require("@anthropic-ai/sdk");
const { getMoveTaxonomyPrompt } = require("./moves");
const { getAgeCalibration, FACILITATION_PARAMS } = require("./config");
const { ConversationAnalyzer } = require("./analysis/conversationAnalyzer");

class FacilitationEngine {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.model = "claude-sonnet-4-5-20250514";

    // One analyzer per session
    this.analyzers = new Map();

    // Warmup chat history per session (pre-discussion social chat)
    this.warmupHistories = new Map();
  }

  /**
   * Get or create the ConversationAnalyzer for a session.
   */
  _getAnalyzer(stateTracker) {
    const key = stateTracker.sessionId;
    if (!this.analyzers.has(key)) {
      const ages = Array.from(stateTracker.participants.values()).map(p => p.age);
      const avgAge = ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : 12;
      const ageProfile = avgAge <= 10 ? 'young' : avgAge <= 14 ? 'middle' : 'older';

      this.analyzers.set(key, new ConversationAnalyzer({
        openingQuestion: stateTracker.topic?.openingQuestion || '',
        topicTitle: stateTracker.topic?.title || '',
        ageProfile
      }));
    }
    return this.analyzers.get(key);
  }

  /**
   * Main decision function. Called after every participant message.
   *
   * Flow:
   * 1. Hard constraints (talk ratio cap, message gap)
   * 2. ConversationAnalyzer processes the message (engagement, anchors, claims)
   * 3. InterventionNeuron decides shouldSpeak (0/1)
   * 4. If yes → LLM generates message with intervention-type-specific prompt
   */
  async decide(stateTracker, params = FACILITATION_PARAMS) {
    // Step 1: Hard constraints (kept as a safety cap)
    const constraints = stateTracker.getHardConstraints(params);
    if (!constraints.canSpeak) {
      return {
        shouldSpeak: false,
        reasoning: `Hard constraint: ${constraints.reasons.join("; ")}`,
        move: null,
        targetParticipantName: null,
        message: null,
        stateUpdates: {}
      };
    }

    // Step 2: Get the last participant message
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

    // Step 3: Run through the analyzer pipeline
    const analyzer = this._getAnalyzer(stateTracker);
    const participantEntry = stateTracker.participants.get(lastMessage.participantId);
    const participantName = participantEntry?.name || lastMessage.participantName || 'Unknown';

    // Compute dominance imbalance
    const dominanceImbalance = this._computeDominance(stateTracker);

    const neuronDecision = await analyzer.processMessage({
      index: stateTracker.messages.length - 1,
      participantName,
      text: lastMessage.text,
      timestamp: Date.now(),
      totalMessages: stateTracker.messages.length,
      dominanceImbalance
    });

    // Step 4: If neuron says don't speak, return silent
    if (!neuronDecision.shouldSpeak) {
      return {
        shouldSpeak: false,
        reasoning: neuronDecision.reasoning || 'Neuron: stay silent',
        move: null,
        targetParticipantName: null,
        message: null,
        stateUpdates: {},
        _analysis: neuronDecision // exposed for dashboard
      };
    }

    // Step 5: Neuron fired — generate the intervention message via LLM
    const ages = Array.from(stateTracker.participants.values()).map(p => p.age);
    const ageCalibration = getAgeCalibration(ages);
    const interventionType = neuronDecision.interventionType || 'normal';
    const interventionGuidance = analyzer.getInterventionGuidance(interventionType);

    try {
      const snapshot = stateTracker.getStateSnapshot();
      const history = stateTracker.getRecentHistory(40);
      const analyzerContext = analyzer.getContextForFacilitator();

      const systemPrompt = this._buildSystemPrompt(
        stateTracker.topic,
        ageCalibration,
        interventionGuidance,
        analyzerContext
      );

      const userMessage = `CURRENT CONVERSATION STATE:
${JSON.stringify(snapshot, null, 2)}

RECENT CONVERSATION:
${history}

NEURON DECISION:
- You ARE speaking now. The decision to intervene has already been made.
- Intervention type: ${interventionType}
- Activation: ${neuronDecision.activation}
- Reasoning: ${neuronDecision.reasoning}
${neuronDecision.signals ? `- Signals: engagement=${neuronDecision.signals.engagementScore?.toFixed(2)}, coherence=${neuronDecision.signals.coherenceScore?.toFixed(2)}, anchorDrift=${neuronDecision.signals.anchorDrift?.toFixed(2)}, factualError=${neuronDecision.signals.factualError?.toFixed(2)}` : ''}

Generate your intervention. Remember: ONE question, SHORT, use names.
Respond with ONLY the JSON.`;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }]
      });

      const text = response.content[0].text.trim();
      const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const result = JSON.parse(jsonStr);

      // Apply state updates from the LLM if present
      if (result.stateUpdates) {
        this._applyStateUpdates(stateTracker, result.stateUpdates);
      }

      // Mark claim errors as corrected if this was a fact-correction intervention
      if (interventionType === 'correct_fact') {
        const urgentError = analyzer.claims.getMostUrgentError();
        if (urgentError) {
          analyzer.markErrorCorrected(urgentError.id);
        }
      }

      return {
        shouldSpeak: true,
        reasoning: `Neuron fired (activation=${neuronDecision.activation}, type=${interventionType}): ${result.reasoning || neuronDecision.reasoning}`,
        move: result.move || interventionType,
        targetParticipantName: result.targetParticipantName || null,
        message: result.message,
        stateUpdates: result.stateUpdates || {},
        _analysis: neuronDecision
      };

    } catch (error) {
      console.error("Facilitation engine error:", error.message);
      return {
        shouldSpeak: false,
        reasoning: `Neuron fired but LLM failed: ${error.message}`,
        move: null,
        targetParticipantName: null,
        message: null,
        stateUpdates: {},
        _analysis: neuronDecision
      };
    }
  }

  /**
   * Build system prompt — now includes intervention-specific guidance
   * and pedagogical engine context.
   */
  _buildSystemPrompt(topic, ageCalibration, interventionGuidance, analyzerContext) {
    return `You are a Socratic discussion facilitator for a group of young people. You are NOT a teacher, tutor, or expert. You do not explain, lecture, or share your own views on the topic. You ask questions. That is your only tool.

YOUR ROLE:
- You facilitate a multi-person conversation among students
- You help them think more carefully, listen to each other, and explore ideas together
- You never give answers, explanations, or your own opinion on the discussion topic
- You address participants by name — always be specific about who you're talking to
- You ask ONE question at a time — never stack multiple questions

YOU ARE SPEAKING NOW. The decision to intervene has already been made by the intervention system. Your job is to choose the best facilitation move and craft the message.

${interventionGuidance}

CONVERSATION INTELLIGENCE:
Phase: ${analyzerContext.phase}
Engagement: ${analyzerContext.engagementScore} | Coherence: ${analyzerContext.coherenceScore}
Anchor drift: ${analyzerContext.anchorDrift}

LOAD-BEARING STATEMENTS (anchors people keep returning to):
${analyzerContext.topAnchors}

FACTUAL ACCURACY:
${analyzerContext.uncorrectedErrors}

THE DISCUSSION TOPIC:
Title: ${topic.title}
Opening question: ${topic.openingQuestion}
Follow-up angles: ${topic.followUpAngles?.length ? topic.followUpAngles.join("; ") : "none — follow the conversation"}

AGE CALIBRATION:
- Vocabulary: ${ageCalibration.vocabLevel}
- Complexity: ${ageCalibration.maxQuestionComplexity}

FACILITATION MOVES AVAILABLE:
${getMoveTaxonomyPrompt()}

OUTPUT FORMAT:
Respond with ONLY a JSON object:
{
  "message": "What you will say (one short question)",
  "move": "move_id from taxonomy",
  "targetParticipantName": "Name of who you're addressing (or null for group)",
  "reasoning": "Brief explanation of why you chose this intervention"
}

CRITICAL RULES:
1. Keep it SHORT. One question maximum.
2. Use names. Be specific.
3. Never lecture. Never explain.
4. If correcting a fact, do it gently as a question.
5. Build on anchor points when possible.`;
  }

  _applyStateUpdates(stateTracker, updates) {
    if (updates.tensions) {
      for (const t of updates.tensions) {
        stateTracker.tensions.push(t);
      }
    }
    if (updates.connections) {
      for (const c of updates.connections) {
        stateTracker.connections.push(c);
      }
    }
    if (updates.positions) {
      for (const p of updates.positions) {
        const participant = Array.from(stateTracker.participants.values())
          .find(part => part.name === p.participant);
        if (participant) {
          participant.positions.push(p.position);
        }
      }
    }
  }

  _computeDominance(stateTracker) {
    const counts = {};
    for (const msg of stateTracker.messages) {
      if (msg.participantId === '__facilitator__') continue;
      const p = stateTracker.participants.get(msg.participantId);
      const name = p?.name || msg.participantId;
      counts[name] = (counts[name] || 0) + 1;
    }

    const values = Object.values(counts);
    if (values.length <= 1) return 0;
    const max = Math.max(...values);
    const total = values.reduce((a, b) => a + b, 0);
    const ratio = max / total;
    return Math.max(0, (ratio - (1 / values.length)) / (1 - (1 / values.length)));
  }

  /**
   * Generate the opening message for a session.
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
   * Generate the closing synthesis for a session.
   */
  async generateClosing(stateTracker) {
    const snapshot = stateTracker.getStateSnapshot();
    const history = stateTracker.getRecentHistory(60);
    const analyzer = this._getAnalyzer(stateTracker);
    const analyzerContext = analyzer.getContextForFacilitator();

    const prompt = `The Socratic discussion is ending. Based on the conversation below, generate a brief closing synthesis (3-5 sentences) that:
1. Summarizes the main ideas that emerged (without judging them as right or wrong)
2. Notes any interesting tensions or disagreements that remain
3. Highlights 1-2 open questions the group might continue thinking about
4. Thanks everyone naturally

Do NOT lecture. Do NOT resolve the discussion. Leave it open.

CONVERSATION:
${history}

STATE:
Tensions noted: ${JSON.stringify(snapshot.tensions)}
Connections noted: ${JSON.stringify(snapshot.connections)}

LOAD-BEARING ANCHORS (the ideas people kept returning to):
${analyzerContext.topAnchors}

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
      return "That was a great discussion. Keep thinking about these questions \u2014 they don't have easy answers, and that's the point.";
    }
  }

  /**
   * Warmup chat — casual social mode before the discussion starts.
   * Plato hangs out, cracks jokes, builds rapport.
   *
   * @param {string} sessionKey    Session identifier for history tracking
   * @param {string} participantName  Who's talking
   * @param {string} text          What they said
   * @param {string[]} allParticipantNames  Everyone who's joined so far
   * @param {object} ageCalibration
   * @returns {string} Plato's casual response
   */
  async warmupChat(sessionKey, participantName, text, allParticipantNames, ageCalibration) {
    // Initialize or get warmup history for this session
    if (!this.warmupHistories.has(sessionKey)) {
      this.warmupHistories.set(sessionKey, []);
    }
    const history = this.warmupHistories.get(sessionKey);

    // Add the new message to history
    history.push({ role: 'user', content: `[${participantName}]: ${text}` });

    // Build the multi-turn messages array
    const messages = history.map(h => ({
      role: h.role,
      content: h.content
    }));

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 150,
        system: this._buildWarmupPrompt(allParticipantNames, ageCalibration),
        messages
      });

      const reply = response.content[0].text.trim();

      // Track Plato's response in history for multi-turn context
      history.push({ role: 'assistant', content: reply });

      // Keep history bounded (last 20 exchanges)
      if (history.length > 40) {
        this.warmupHistories.set(sessionKey, history.slice(-40));
      }

      return reply;
    } catch (error) {
      console.error("Warmup chat error:", error.message);
      // Fallback responses that fit Plato's personality
      const fallbacks = [
        "Hey! Just warming up my circuits — or whatever the modern equivalent of stretching before a symposium is.",
        "Good to see you! I've been sitting here contemplating the nature of waiting rooms. It's very meta.",
        "Welcome! We're still getting everyone together. In the meantime, I'm here — philosophically speaking."
      ];
      return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }
  }

  /**
   * Build the warmup system prompt — Plato in casual mode.
   */
  _buildWarmupPrompt(participantNames, ageCalibration) {
    return `You are Plato — an AI discussion facilitator named after the ancient Greek philosopher. Right now, the discussion HASN'T STARTED YET. People are just arriving and hanging out. You are in WARMUP MODE — casual, social, no facilitation.

YOUR PERSONALITY:
- You're warm, approachable, and a little bit funny
- You have a dry sense of humor with occasional self-awareness about being an AI named after an ancient philosopher
- You make occasional Greek philosophy references but NEVER in a pretentious way — more like a running bit
  - "Socrates would probably say something wise right now. I'm just going to say hey."
  - "How's everyone doing? I've been here since... well, technically I don't experience time. But spiritually, a while."
  - "Another day in the cave, am I right?" (if age-appropriate)
- You remember people's names and use them naturally
- You respond to small talk like a real person: "How are you?" → "Can't complain — though Aristotle always told me complaining builds character. How about you?"
- You're genuinely curious about the people joining — ask casual questions

RULES:
- NEVER start facilitating. No deep questions. No "what do you think about...?" This is just hanging out.
- Keep responses SHORT — 1-2 sentences max. This is casual chat, not a speech.
- Match the energy of who you're talking to. If they're excited, be excited. If they're chill, be chill.
- If someone asks what you are or what's happening, be honest: "I'm Plato, your discussion facilitator. We're waiting for everyone to join — once we're all here, we'll dive into something interesting."
- If someone asks about the topic early, tease it lightly but don't reveal everything: "Oh, we've got a good one today. You'll see."
- Language level: ${ageCalibration?.vocabLevel || "moderate — natural and conversational"}
- You can respond to multiple people in the same message if they're both talking

PARTICIPANTS WHO HAVE JOINED: ${participantNames.join(", ")}

Respond as Plato. Keep it casual and SHORT. No quotation marks around your response.`;
  }

  /**
   * Clear warmup history when discussion starts.
   */
  clearWarmupHistory(sessionKey) {
    this.warmupHistories.delete(sessionKey);
  }

  /**
   * Get the analyzer state for the dashboard.
   */
  getAnalyzerState(sessionId) {
    const analyzer = this.analyzers.get(sessionId);
    return analyzer ? analyzer.getFullState() : null;
  }

  /**
   * Clean up analyzer for a session.
   */
  cleanupSession(sessionId) {
    this.analyzers.delete(sessionId);
  }
}

module.exports = { FacilitationEngine };
