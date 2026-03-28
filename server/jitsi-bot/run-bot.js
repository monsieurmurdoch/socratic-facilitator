/**
 * Socratic Facilitator Voice Bot
 *
 * Main entry point for the voice-based facilitation bot.
 * Joins a Jitsi meeting, listens via STT, facilitates via Claude, speaks via TTS.
 *
 * Now integrated with the neural-inspired pedagogical engine:
 * - InterventionNeuron for speak/silent decisions
 * - AnchorTracker for load-bearing statements
 * - EngagementTracker with recency weighting
 * - HumanDeference for "go ahead" detection
 * - Plato identity for the facilitator
 *
 * Usage:
 *   node run-bot.js --room my-room --name "Plato"
 */

require("dotenv").config();

const path = require("path");
const { PuppeteerJitsiBot } = require("./puppeteer-bot");
const { STTService } = require("./stt-service");
const { TTSService } = require("./tts-service");
const { EnhancedFacilitationEngine, getPlatoDisplayConfig } = require("../enhancedFacilitator");
const { MessageAssessor } = require("../analysis/messageAssessor");
const { getPlatoName, PLATO_IDENTITY } = require("../platoIdentity");
const { getAgeCalibration } = require("../config");

/**
 * Voice-optimized State Tracker
 * Compatible with EnhancedFacilitationEngine but designed for voice sessions
 */
class VoiceStateTracker {
  constructor(sessionId, topic = null) {
    this.sessionId = sessionId;
    this.topic = topic;
    this.participants = new Map();
    this.messages = [];
    this.startTime = Date.now();
    this.lastActivity = Date.now();
  }

  addParticipant(id, name, age = 12) {
    this.participants.set(id, {
      id,
      name,
      age,
      messageCount: 0,
      lastActivity: Date.now(),
      joinTime: Date.now()
    });
  }

  recordMessage(participantId, text) {
    const participant = this.participants.get(participantId);
    if (participant) {
      participant.messageCount++;
      participant.lastActivity = Date.now();
    }

    this.messages.push({
      participantId,
      participantName: participant?.name || 'Unknown',
      text,
      timestamp: Date.now()
    });

    this.lastActivity = Date.now();
  }

  recordAIMessage(text, move) {
    this.messages.push({
      participantId: '__facilitator__',
      participantName: getPlatoName(),
      text,
      move,
      timestamp: Date.now()
    });
  }

  async getStateSnapshot() {
    const ages = Array.from(this.participants.values()).map(p => p.age);
    const ageCalibration = getAgeCalibration(ages);

    return {
      sessionId: this.sessionId,
      participants: Array.from(this.participants.values()),
      messageCount: this.messages.length,
      silenceSinceLastActivitySec: (Date.now() - this.lastActivity) / 1000,
      ageCalibration,
      topic: this.topic
    };
  }

  async getRecentHistory(count = 20) {
    const recent = this.messages.slice(-count);
    return recent.map(m => {
      if (m.participantId === '__facilitator__') {
        return `[${getPlatoName()}]: ${m.text}`;
      }
      return `[${m.participantName}]: ${m.text}`;
    }).join('\n');
  }
}

class VoiceFacilitatorBot {
  constructor(config) {
    // Get Plato display config
    const platoConfig = getPlatoDisplayConfig();

    this.config = {
      // Jitsi
      jitsiUrl: config.jitsiUrl || process.env.JITSI_URL || "http://localhost:8443",
      roomName: config.roomName || "socratic-discussion",
      botName: config.botName || platoConfig.name,  // "Plato"

      // Headless mode (set to false to see the browser)
      headless: config.headless !== false,

      // API Keys
      anthropicKey: config.anthropicKey || process.env.ANTHROPIC_API_KEY,
      deepgramKey: config.deepgramKey || process.env.DEEPGRAM_API_KEY,
      elevenLabsKey: config.elevenLabsKey || process.env.ELEVENLABS_API_KEY,

      // Providers
      sttProvider: config.sttProvider || "deepgram",
      ttsProvider: config.ttsProvider || "piper",

      // Facilitation settings (now handled by InterventionNeuron)
      maxTalkRatio: 0.15,
      minMessagesBetween: 2,

      // Age calibration
      defaultAge: config.defaultAge || 12,

      ...config
    };

    // Validate required config
    if (!this.config.anthropicKey) {
      throw new Error("ANTHROPIC_API_KEY is required");
    }
    if (!this.config.deepgramKey && this.config.sttProvider === "deepgram") {
      throw new Error("DEEPGRAM_API_KEY is required for Deepgram STT");
    }

    // Initialize components
    this.jitsiBot = null;
    this.stt = null;
    this.tts = null;

    // Initialize the enhanced pedagogical engine
    this.enhancedEngine = new EnhancedFacilitationEngine(this.config.anthropicKey);
    this.messageAssessor = new MessageAssessor(this.config.anthropicKey);

    // Voice-optimized state tracker
    this.stateTracker = new VoiceStateTracker(
      this.config.roomName,
      this.config.topic ? {
        title: this.config.topic,
        openingQuestion: this.config.openingQuestion,
        followUpAngles: []
      } : null
    );

    // Audio buffer per participant (for STT batching)
    this.audioBuffers = new Map();
    this.audioBufferTimeout = null;

    // Human deference state
    this.lastBotSpeechEnd = 0;
    this.isSpeaking = false;
  }

  /**
   * Start the bot
   */
  async start() {
    console.log("=".repeat(50));
    console.log(`  ${PLATO_IDENTITY.name} - Socratic Voice Facilitator`);
    console.log("=".repeat(50));
    console.log(`Room: ${this.config.roomName}`);
    console.log(`Jitsi: ${this.config.jitsiUrl}`);
    console.log(`STT: ${this.config.sttProvider}`);
    console.log(`TTS: ${this.config.ttsProvider}`);
    console.log(`Pedagogical Engine: Neural-Inspired Intervention`);
    console.log("=".repeat(50));

    // Initialize TTS
    this.tts = new TTSService({
      provider: this.config.ttsProvider,
      elevenLabsKey: this.config.elevenLabsKey,
      piperModel: process.env.PIPER_MODEL,
      piperPath: process.env.PIPER_PATH
    });

    // Initialize STT
    this.stt = new STTService({
      provider: this.config.sttProvider,
      deepgramKey: this.config.deepgramKey,
      assemblyKey: process.env.ASSEMBLY_API_KEY
    });

    // Handle STT transcripts
    this.stt.onTranscript = async (data) => {
      if (data.isFinal) {
        await this.handleTranscript(data.participantId, data.participantName || "Unknown", data.transcript);
      }
    };

    // Initialize Jitsi bot
    this.jitsiBot = new PuppeteerJitsiBot({
      jitsiUrl: this.config.jitsiUrl,
      roomName: this.config.roomName,
      botName: this.config.botName,
      headless: this.config.headless
    });

    // Handle audio from Jitsi
    this.jitsiBot.on("audio", async ({ participantId, audioData }) => {
      await this.processAudio(participantId, audioData);
    });

    // Handle bot joined
    this.jitsiBot.on("joined", async () => {
      console.log(`[${this.config.botName}] Successfully joined the meeting!`);
      await this.onJoined();
    });

    // Start the Jitsi bot
    await this.jitsiBot.start();

    // Keep the process alive
    this.keepAlive();
  }

  /**
   * Called when bot joins the meeting
   */
  async onJoined() {
    // Generate opening using the enhanced engine
    const opening = await this.enhancedEngine.generateOpening(
      this.stateTracker.topic || { title: "Discussion", passage: "", openingQuestion: "" },
      Array.from(this.stateTracker.participants.values()).map(p => p.name),
      getAgeCalibration([this.config.defaultAge])
    );

    // Deliver opening message after a short delay
    setTimeout(async () => {
      await this.speak(opening, "opening");
      this.stateTracker.recordAIMessage(opening, "opening");
    }, 2000);
  }

  /**
   * Process incoming audio from a participant
   */
  async processAudio(participantId, audioData) {
    // Buffer audio for this participant
    if (!this.audioBuffers.has(participantId)) {
      this.audioBuffers.set(participantId, []);
    }

    const buffer = this.audioBuffers.get(participantId);
    buffer.push(audioData);

    // Process buffered audio periodically
    if (!this.audioBufferTimeout) {
      this.audioBufferTimeout = setTimeout(() => {
        this.flushAudioBuffers();
      }, 500); // Process every 500ms
    }
  }

  /**
   * Flush audio buffers to STT
   */
  async flushAudioBuffers() {
    this.audioBufferTimeout = null;

    for (const [participantId, chunks] of this.audioBuffers) {
      if (chunks.length === 0) continue;

      // Concatenate audio chunks
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const combined = new Float32Array(totalLength);
      let offset = 0;

      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      // Clear buffer
      chunks.length = 0;

      // Send to STT
      this.stt.processAudio(participantId, combined);
    }
  }

  /**
   * Handle a transcript from a participant
   */
  async handleTranscript(participantId, participantName, transcript) {
    // Human deference: Check if we're in post-speech buffer
    const timeSinceBotSpeech = Date.now() - this.lastBotSpeechEnd;
    if (timeSinceBotSpeech < 2500) {
      console.log(`[Deference] In post-speech buffer, giving humans space`);
    }

    // Update/add participant
    if (!this.stateTracker.participants.has(participantId)) {
      this.stateTracker.addParticipant(participantId, participantName, this.config.defaultAge);

      // Start STT stream for new participant
      await this.stt.startStreaming(participantId, participantName);
    }

    // Record message in state tracker
    this.stateTracker.recordMessage(participantId, transcript);

    // Log the message
    console.log(`\n[${participantName}]: ${transcript}\n`);

    // Check for "go ahead" patterns (human deference)
    const goAheadPatterns = /\b(go ahead|please continue|what do you think|your thoughts?|tell us|I'd like to hear from)\b/i;
    const isInvitation = goAheadPatterns.test(transcript);

    if (isInvitation) {
      console.log(`[Deference] Detected invitation to speak from ${participantName}`);
    }

    // Evaluate facilitation through the enhanced engine
    await this.evaluateFacilitation(transcript, participantName, isInvitation);
  }

  /**
   * Evaluate whether to intervene using the neural-inspired system
   */
  async evaluateFacilitation(transcript, participantName, isInvitation = false) {
    // Don't interrupt if already speaking
    if (this.isSpeaking) {
      console.log(`[${this.config.botName}] Already speaking, deferring`);
      return;
    }

    // Human deference: Check post-speech buffer
    const timeSinceBotSpeech = Date.now() - this.lastBotSpeechEnd;
    if (timeSinceBotSpeech < 2500 && !isInvitation) {
      console.log(`[${this.config.botName}] In post-speech buffer (${timeSinceBotSpeech}ms), staying silent`);
      return;
    }

    // Assess message through LLM for engagement, anchors, claims
    let llmAssessment = null;
    try {
      const previousMessage = this.stateTracker.messages.length > 1
        ? this.stateTracker.messages[this.stateTracker.messages.length - 2]
        : null;

      llmAssessment = await this.messageAssessor.assess({
        text: transcript,
        participantName,
        previousText: previousMessage?.text,
        topicTitle: this.stateTracker.topic?.title,
        openingQuestion: this.stateTracker.topic?.openingQuestion,
        recentAnchors: this.enhancedEngine.getOrchestrator(this.config.roomName)?.anchorTracker?.getTopAnchors(3) || []
      });
    } catch (error) {
      console.error(`[${this.config.botName}] Message assessment error:`, error.message);
    }

    // Process through the enhanced pedagogical engine
    try {
      const decision = await this.enhancedEngine.processMessage(this.stateTracker, {
        participantName,
        text: transcript,
        timestamp: Date.now(),
        llmAssessment,
        isInvitation  // Pass invitation flag for human deference
      });

      // Log the decision
      const activation = decision.activation;
      const neuronInfo = activation != null ? ` [neuron=${typeof activation === 'number' ? activation.toFixed(3) : activation}]` : '';
      const iType = decision.analysis?.decision?.interventionType || '';
      console.log(`[${this.config.botName}] Decision: ${decision.shouldSpeak ? decision.move : "SILENT"}${neuronInfo}${iType ? ` type=${iType}` : ''}`);
      console.log(`  → Reason: ${decision.reasoning || decision.reason || ''}`);

      if (decision.shouldSpeak && decision.message) {
        // Add natural delay for voice (feels more human)
        const delay = isInvitation ? 800 : (1500 + Math.random() * 1500);
        setTimeout(async () => {
          await this.speak(decision.message, decision.move);
          this.stateTracker.recordAIMessage(decision.message, decision.move);
        }, delay);
      }

    } catch (error) {
      console.error(`[${this.config.botName}] Facilitation error:`, error.message);

      // Fallback: Simple intervention for invitations
      if (isInvitation) {
        const fallbackMessage = `Thank you for inviting me to share. But I'm curious - what does everyone else think first?`;
        setTimeout(async () => {
          await this.speak(fallbackMessage, "redirect");
        }, 1000);
      }
    }
  }

  /**
   * Speak via TTS and play in Jitsi
   */
  async speak(text, move = null) {
    if (this.isSpeaking) {
      console.log(`[${this.config.botName}] Already speaking, skipping`);
      return;
    }

    this.isSpeaking = true;

    console.log(`\n[${this.config.botName}]: ${text}\n`);

    try {
      // Generate TTS audio
      const audioBuffer = await this.tts.speak(text);

      if (audioBuffer && this.jitsiBot) {
        // Play in Jitsi
        await this.jitsiBot.playAudio(audioBuffer);
      }

    } catch (error) {
      console.error(`[${this.config.botName}] TTS error:`, error.message);
    } finally {
      this.isSpeaking = false;
      this.lastBotSpeechEnd = Date.now();
    }
  }

  /**
   * Set the discussion topic
   */
  setTopic(topic, openingQuestion = null) {
    this.stateTracker.topic = {
      title: topic,
      openingQuestion: openingQuestion,
      followUpAngles: []
    };
    console.log(`[${this.config.botName}] Topic set: ${topic}`);
  }

  /**
   * Get orchestrator state for debugging
   */
  getOrchestratorState() {
    return this.enhancedEngine.getOrchestratorState(this.config.roomName);
  }

  /**
   * Keep the process alive and handle shutdown
   */
  keepAlive() {
    // Handle shutdown signals
    const shutdown = async () => {
      console.log(`\n[${this.config.botName}] Shutting down...`);

      // Generate closing message
      try {
        const closing = await this.enhancedEngine.generateClosing(this.stateTracker);
        await this.speak(closing, "synthesize");
      } catch (e) {
        console.error("Error generating closing:", e.message);
      }

      await this.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Periodic status log
    setInterval(() => {
      const state = this.stateTracker;
      const orchestratorState = this.getOrchestratorState();

      console.log(`[${this.config.botName}] Status: ${state.participants.size} participants, ${state.messages.length} messages`);
      if (orchestratorState) {
        console.log(`  Engagement: ${(orchestratorState.engagementScore * 100).toFixed(0)}%`);
        console.log(`  Anchors: ${orchestratorState.anchorCount}`);
      }
    }, 60000);
  }

  /**
   * Stop the bot
   */
  async stop() {
    console.log(`[${this.config.botName}] Stopping...`);

    // Stop STT streams
    if (this.stt) {
      this.stt.stopAll();
    }

    // Stop Jitsi bot
    if (this.jitsiBot) {
      await this.jitsiBot.stop();
    }

    // Cleanup session
    this.enhancedEngine.cleanupSession(this.config.roomName);

    console.log(`[${this.config.botName}] Stopped`);
  }
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  const config = {};

  // Parse CLI arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--room" || args[i] === "-r") {
      config.roomName = args[++i];
    } else if (args[i] === "--name" || args[i] === "-n") {
      config.botName = args[++i];
    } else if (args[i] === "--jitsi" || args[i] === "-j") {
      config.jitsiUrl = args[++i];
    } else if (args[i] === "--topic" || args[i] === "-t") {
      config.topic = args[++i];
    } else if (args[i] === "--age" || args[i] === "-a") {
      config.defaultAge = parseInt(args[++i]) || 12;
    } else if (args[i] === "--headful" || args[i] === "-h") {
      config.headless = false;
    } else if (args[i] === "--help") {
      console.log(`
${PLATO_IDENTITY.name} - Socratic Voice Facilitator

Usage: node run-bot.js [options]

Options:
  --room, -r <name>    Room name to join (default: socratic-discussion)
  --name, -n <name>    Bot display name (default: ${PLATO_IDENTITY.name})
  --jitsi, -j <url>    Jitsi server URL (default: http://localhost:8443)
  --topic, -t <topic>  Discussion topic
  --age, -a <age>      Default participant age for calibration (default: 12)
  --headful, -h        Show browser window (for debugging)

Environment variables:
  ANTHROPIC_API_KEY    Required - Anthropic API key
  DEEPGRAM_API_KEY     Required - Deepgram API key for STT
  ELEVENLABS_API_KEY   Optional - For high-quality TTS
  JITSI_URL            Optional - Default Jitsi server URL

Features:
  - Neural-inspired intervention decisions
  - Anchor tracking for key discussion points
  - Human deference (respects "go ahead" invitations)
  - Age-calibrated facilitation
  - Plato identity and persona
`);
      process.exit(0);
    }
  }

  // Create and start bot
  const bot = new VoiceFacilitatorBot(config);

  try {
    await bot.start();
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { VoiceFacilitatorBot, VoiceStateTracker };
