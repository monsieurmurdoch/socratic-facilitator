/**
 * Jitsi Bot Service
 *
 * Joins a Jitsi meeting as a bot participant
 * - Handles real-time audio processing via STT
 * - Routes messages through Socratic facilitation engine
 * - Speaks via TTS
 *
 * Usage:
 *   const bot = new JitsiBot(config);
 *   await bot.start();
 */

const Anthropic = require("@anthropic-ai/sdk");
const { EventEmitter } = require("events");
const { JitsiAdapter } = require("./jitsi-adapter");
const { STTService } = require("./stt-service");
const { TTSService } = require("./tts-service");

class JitsiBot extends EventEmitter {
  constructor(config) {
    super();

    this.config = {
      // Jitsi config
      jitsiDomain: config.jitsiDomain || "meet.jit.si",
      roomName: config.roomName,
      botName: config.botName || "Facilitator",

      // API keys
      anthropicKey: config.anthropicKey,
      deepgramKey: config.deepgramKey,
      elevenLabsKey: config.elevenLabsKey,

      // Service preferences
      sttProvider: config.sttProvider || "deepgram",
      ttsProvider: config.ttsProvider || "piper",

      // Facilitation config
      maxTalkRatio: config.maxTalkRatio || 0.15,
      minMessagesBetween: config.minMessagesBetween || 3,
      silenceTimeoutMs: config.silenceTimeoutMs || 15000,

      ...config
    };

    // Initialize Anthropic client
    this.client = new Anthropic({ apiKey: this.config.anthropicKey });

    // Session state
    this.sessionState = {
      participants: new Map(),
      messages: [],
      facilitatorMessages: [],
      lastActivity: Date.now(),
      lastFacilitatorMessage: 0,
      isSpeaking: false
    };

    // Initialize services
    this.jitsi = new JitsiAdapter({
      domain: this.config.jitsiDomain,
      roomName: this.config.roomName,
      botName: this.config.botName
    });

    this.stt = new STTService({
      provider: this.config.sttProvider,
      deepgramKey: this.config.deepgramKey,
      assemblyKey: this.config.assemblyKey
    });

    this.tts = new TTSService({
      provider: this.config.ttsProvider,
      elevenLabsKey: this.config.elevenLabsKey,
      piperModel: this.config.piperModel
    });

    // Wire up event handlers
    this.setupEventHandlers();
  }

  /**
   * Set up event handlers for services
   */
  setupEventHandlers() {
    // Handle audio from Jitsi
    this.jitsi.onAudioData = (participantId, audioData) => {
      this.stt.processAudio(participantId, audioData);
    };

    // Handle transcripts from STT
    this.stt.onTranscript = async (data) => {
      if (data.isFinal) {
        await this.handleTranscript(data.participantId, data.participantName, data.transcript);
      }
    };

    // Handle audio ready from TTS
    this.tts.onAudioReady = (audioBuffer) => {
      this.emit("audio", audioBuffer);
      // Would send to Jitsi audio stream here
    };
  }

  /**
   * Start the bot - connect to Jitsi and initialize
   */
  async start() {
    console.log(`[JitsiBot] Starting for room: ${this.config.roomName}`);

    try {
      // Connect to Jitsi
      await this.jitsi.connect();
      console.log("[JitsiBot] Connected to Jitsi");

      // Join the room
      await this.jitsi.joinRoom();
      console.log("[JitsiBot] Joined room");

      // Get existing participants
      const participants = this.jitsi.getParticipants();
      for (const p of participants) {
        this.registerParticipant(p.id, p.name);
      }

      // Start STT streams for each participant
      for (const [id, participant] of this.sessionState.participants) {
        await this.stt.startStreaming(id, participant.name);
      }

      this.emit("started");
      console.log("[JitsiBot] Bot started successfully");

    } catch (error) {
      console.error("[JitsiBot] Failed to start:", error);
      this.emit("error", error);
      throw error;
    }
  }

  /**
   * Register a new participant
   */
  registerParticipant(participantId, name) {
    this.sessionState.participants.set(participantId, {
      id: participantId,
      name: name || `Participant ${participantId.slice(0, 4)}`,
      joinTime: Date.now(),
      lastActivity: null,
      messageCount: 0
    });

    console.log(`[JitsiBot] Participant registered: ${name}`);
    this.emit("participant_joined", { id: participantId, name });
  }

  /**
   * Remove a participant
   */
  removeParticipant(participantId) {
    const participant = this.sessionState.participants.get(participantId);
    if (participant) {
      console.log(`[JitsiBot] Participant left: ${participant.name}`);
      this.stt.stopStreaming(participantId);
      this.sessionState.participants.delete(participantId);
      this.emit("participant_left", { id: participantId, name: participant.name });
    }
  }

  /**
   * Handle a final transcript from a participant
   */
  async handleTranscript(participantId, participantName, transcript) {
    const participant = this.sessionState.participants.get(participantId);
    if (!participant) {
      this.registerParticipant(participantId, participantName);
    }

    // Update activity
    if (participant) {
      participant.lastActivity = Date.now();
      participant.messageCount++;
    }
    this.sessionState.lastActivity = Date.now();

    // Store message
    const message = {
      participantId,
      participantName: participant?.name || participantName,
      text: transcript,
      timestamp: Date.now()
    };
    this.sessionState.messages.push(message);

    console.log(`[${participant?.name || participantName}]: ${transcript}`);
    this.emit("transcript", message);

    // Evaluate facilitation
    await this.evaluateFacilitation();
  }

  /**
   * Evaluate whether to intervene
   */
  async evaluateFacilitation() {
    // Check hard constraints first
    if (!this.shouldConsiderIntervention()) {
      return;
    }

    // Build context for LLM
    const recentMessages = this.sessionState.messages.slice(-20);
    const participantNames = Array.from(this.sessionState.participants.values())
      .map(p => p.name)
      .join(", ");

    const prompt = `You are a Socratic discussion facilitator in a voice call. Listen and only speak when truly helpful.

RECENT EXCHANGES:
${recentMessages.map(m => `[${m.participantName}]: ${m.text}`).join("\n")}

PARTICIPANTS: ${participantNames}

Should you speak? If so, with what facilitation move? Respond with JSON:
{
  "shouldSpeak": true/false,
  "reasoning": "Brief reason for decision",
  "move": "redirect" | "deepen" | "surface_tension" | "connect" | "clarify" | "reframe" | "affirm_process" | "prompt_after_silence" | null,
  "targetParticipant": "Name to address, or null",
  "message": "What to say if speaking"
}

Remember: You are a facilitator, not a teacher. Ask questions, never lecture. Be specific and brief.`;

    try {
      const response = await this.client.messages.create({
        model: "claude-sonnet-4-5-20250514",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }]
      });

      const decision = JSON.parse(response.content[0].text);

      if (decision.shouldSpeak && decision.message) {
        await this.speak(decision.message, decision.move);
      }

    } catch (error) {
      console.error("[JitsiBot] Facilitation error:", error);
    }
  }

  /**
   * Check hard constraints before considering intervention
   */
  shouldConsiderIntervention() {
    const state = this.sessionState;
    const now = Date.now();

    // Don't interrupt if already speaking
    if (state.isSpeaking) return false;

    // Count messages since last facilitator message
    const recentMessages = state.messages.filter(
      m => m.timestamp > state.lastFacilitatorMessage
    );

    // Must have minimum messages between interventions
    if (recentMessages.length < this.config.minMessagesBetween) return false;

    // Check talk ratio
    const facilitatorCount = state.facilitatorMessages.length;
    const totalCount = state.messages.length + facilitatorCount;
    const talkRatio = totalCount > 0 ? facilitatorCount / totalCount : 0;

    if (talkRatio > this.config.maxTalkRatio) return false;

    return true;
  }

  /**
   * Speak via TTS
   */
  async speak(text, move = null) {
    if (this.sessionState.isSpeaking) {
      console.log("[JitsiBot] Already speaking, skipping");
      return;
    }

    this.sessionState.isSpeaking = true;

    console.log(`[Facilitator]: ${text}`);
    this.emit("speaking", { text, move });

    try {
      // Generate TTS audio
      const audioBuffer = await this.tts.speak(text);

      if (audioBuffer) {
        // Would send to Jitsi here
        // await this.jitsi.playAudio(audioBuffer);
      }

      // Store facilitator message
      this.sessionState.facilitatorMessages.push({
        text,
        move,
        timestamp: Date.now()
      });
      this.sessionState.lastFacilitatorMessage = Date.now();

    } catch (error) {
      console.error("[JitsiBot] TTS error:", error);
    } finally {
      this.sessionState.isSpeaking = false;
    }
  }

  /**
   * Deliver opening question
   */
  async deliverOpening(topic, openingQuestion) {
    const message = openingQuestion || `Welcome everyone. Let's begin our discussion on ${topic}. What interests you most about this topic?`;
    await this.speak(message, "prompt_after_silence");
  }

  /**
   * Stop the bot and cleanup
   */
  async stop() {
    console.log("[JitsiBot] Stopping...");

    // Stop all STT streams
    this.stt.stopAll();

    // Clear TTS queue
    this.tts.clearQueue();

    // Disconnect from Jitsi
    await this.jitsi.disconnect();

    this.emit("stopped");
    console.log("[JitsiBot] Stopped");
  }

  /**
   * Get session state for analysis
   */
  getState() {
    return {
      participants: Array.from(this.sessionState.participants.values()),
      messageCount: this.sessionState.messages.length,
      facilitatorMessageCount: this.sessionState.facilitatorMessages.length,
      lastActivity: this.sessionState.lastActivity
    };
  }
}

module.exports = { JitsiBot };
