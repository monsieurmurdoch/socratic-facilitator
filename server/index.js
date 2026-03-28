/**
 * Socratic Facilitator Server
 *
 * Express server serves the frontend.
 * WebSocket handles real-time multi-party chat.
 * PostgreSQL provides persistence.
 *
 * The AI facilitator is named "Plato" after the Greek philosopher
 * who pioneered the Socratic method through his dialogues.
 */

require("dotenv").config();
const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { spawn } = require("child_process");

// Database
const db = require("./db");
const sessionsRepo = require("./db/repositories/sessions");
const participantsRepo = require("./db/repositories/participants");
const messagesRepo = require("./db/repositories/messages");
const materialsRepo = require("./db/repositories/materials");
const primedContextRepo = require("./db/repositories/primedContext");

// Services
const { EnhancedFacilitationEngine, getPlatoDisplayConfig } = require("./enhancedFacilitator");
const { FacilitationOrchestrator } = require("./analysis/facilitationOrchestrator");
const { MessageAssessor } = require("./analysis/messageAssessor");
const { fastLLM } = require("./analysis/fastLLMProvider");
const { stalenessGuard } = require("./analysis/stalenessGuard");
const { DISCUSSION_TOPICS, FACILITATION_PARAMS, getAgeCalibration } = require("./config");

// Routes
const sessionsRouter = require("./routes/sessions");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend
app.use(express.static(path.join(__dirname, "../client/public")));
app.use("/src", express.static(path.join(__dirname, "../client/src")));

// API routes
app.use("/api/sessions", sessionsRouter);

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Legacy topics endpoint
app.get("/api/topics", (req, res) => {
  res.json(DISCUSSION_TOPICS.map(t => ({
    id: t.id,
    title: t.title,
    passage: t.passage,
    ageRange: t.ageRange
  })));
});

// Plato display configuration for frontend
app.get("/api/plato", (req, res) => {
  res.json(getPlatoDisplayConfig());
});

// Orchestrator state for debugging/dashboard
app.get("/api/session/:sessionId/orchestrator", (req, res) => {
  const { sessionId } = req.params;
  const state = enhancedEngine.getOrchestratorState(sessionId);
  if (!state) {
    return res.status(404).json({ error: "Session orchestrator not found" });
  }
  res.json(state);
});

// Latency telemetry endpoint — shows fast LLM and staleness guard stats
app.get("/api/telemetry", (req, res) => {
  res.json({
    fastLLM: fastLLM.getStats(),
    stalenessGuard: stalenessGuard.getStats(),
    enhancedSystem: USE_ENHANCED_SYSTEM
  });
});

// ---- In-Memory Session State (for active WebSocket connections) ----
// This maps short codes to active session state
const activeSessions = new Map();

// Jitsi bot launcher (for video mode)
let jitsiLauncher = null;
try {
  jitsiLauncher = require("./jitsi-bot/start-session");
} catch (e) {
  console.log("Jitsi bot module not available:", e.message);
}

// Initialize enhanced engine
const enhancedEngine = new EnhancedFacilitationEngine(process.env.ANTHROPIC_API_KEY);
const messageAssessor = new MessageAssessor(process.env.ANTHROPIC_API_KEY);

// Feature flag for using enhanced system
const USE_ENHANCED_SYSTEM = process.env.USE_ENHANCED_SYSTEM !== 'false';  // Default to true

// ---- Voice Integration: TTS Helper ----
const PIPER_PATH = process.env.PIPER_PATH || 'server/models/tts/piper/piper';
const PIPER_MODEL_PATH = process.env.PIPER_MODEL_PATH || 'server/models/tts/en_US-lessac-medium.onnx';

function generateTTS(text) {
  return new Promise((resolve, reject) => {
    const piper = spawn(PIPER_PATH, [
      '--model', PIPER_MODEL_PATH,
      '--output_file', '-'
    ]);

    let audioData = [];
    piper.stdout.on('data', chunk => audioData.push(chunk));

    piper.on('error', (err) => {
      reject(new Error('Piper TTS not available: ' + err.message));
    });

    piper.stdin.write(text);
    piper.stdin.end();

    piper.on('close', code => {
      if (code === 0) resolve(Buffer.concat(audioData));
      else reject(new Error('Piper TTS failed with code ' + code));
    });
  });
}

// Silence checker
const silenceCheckers = new Map();

function startSilenceChecker(sessionShortCode) {
  const interval = setInterval(async () => {
    const session = activeSessions.get(sessionShortCode);
    if (!session || !session.active) {
      clearInterval(interval);
      silenceCheckers.delete(sessionShortCode);
      return;
    }

    const snapshot = await session.stateTracker.getStateSnapshot();
    // Use age-calibrated silence tolerance instead of flat timeout
    const ages = Array.from(session.stateTracker.participants.values()).map(p => p.age);
    const ageCalibration = getAgeCalibration(ages);
    const silenceThreshold = ageCalibration.silenceToleranceSec || FACILITATION_PARAMS.silenceTimeoutSec;

    if (snapshot.silenceSinceLastActivitySec >= silenceThreshold) {
      const decision = await enhancedEngine.decide(session.stateTracker);
      if (decision.shouldSpeak && decision.message) {
        await handleFacilitatorMessage(sessionShortCode, decision);
      }
    }
  }, 10000);

  silenceCheckers.set(sessionShortCode, interval);
}

async function handleFacilitatorMessage(sessionShortCode, decision) {
  const session = activeSessions.get(sessionShortCode);
  if (!session) return;

  const targetId = decision.targetParticipantName
    ? findParticipantIdByName(session.stateTracker, decision.targetParticipantName)
    : null;

  await session.stateTracker.recordAIMessage(decision.message, decision.move, targetId);

  broadcastToSession(sessionShortCode, {
    type: "facilitator_message",
    text: decision.message,
    move: decision.move,
    timestamp: Date.now()
  });

  try {
    const wavBuffer = await generateTTS(decision.message);
    for (const client of session.clients) {
      if (client.ws.readyState === 1) client.ws.send(wavBuffer);
    }
  } catch (e) {
    console.error("TTS Error:", e);
  }
}

function findParticipantIdByName(stateTracker, name) {
  for (const [id, p] of stateTracker.participants) {
    if (p.name.toLowerCase() === name.toLowerCase()) return id;
  }
  return null;
}

function broadcastToSession(sessionShortCode, message) {
  const session = activeSessions.get(sessionShortCode);
  if (!session) return;

  const data = JSON.stringify(message);

  for (const client of session.clients) {
    if (client.ws.readyState === 1) {
      client.ws.send(data);
    }
  }
}

// ---- WebSocket Handling ----

async function handleParticipantMessage(sessionShortCode, clientId, text) {
  const session = activeSessions.get(sessionShortCode);
  if (!session) return;

  const participant = session.stateTracker.participants.get(clientId);
  if (!participant) return;

  // ── Pre-discussion: warmup chat mode ──
  if (!session.active) {
    broadcastToSession(sessionShortCode, {
      type: "participant_message",
      name: participant.name,
      text: text,
      timestamp: Date.now()
    });

    const names = Array.from(session.stateTracker.participants.values()).map(p => p.name);
    const ages = Array.from(session.stateTracker.participants.values()).map(p => p.age);
    const ageCalibration = getAgeCalibration(ages);

    const reply = await enhancedEngine.warmupChat(
      sessionShortCode, participant.name, text, names, ageCalibration
    );

    if (reply) {
      // Small delay to feel natural
      setTimeout(() => {
        broadcastToSession(sessionShortCode, {
          type: "facilitator_message",
          text: reply,
          move: "warmup",
          timestamp: Date.now()
        });
      }, 800 + Math.random() * 1200);
    }

    console.log(`[${sessionShortCode}] ☀ WARMUP | ${participant.name}: "${text}"`);
    console.log(`  → Plato: "${reply?.substring(0, 80)}${reply?.length > 80 ? '...' : ''}"`);
    return;
  }

  // ── Active discussion: full pedagogical pipeline ──
  await session.stateTracker.recordMessage(clientId, text);

  broadcastToSession(sessionShortCode, {
    type: "participant_message",
    name: participant.name,
    text: text,
    timestamp: Date.now()
  });

  // Use enhanced engine with orchestrator if enabled
  let decision;
  const pipelineStart = Date.now();

  if (USE_ENHANCED_SYSTEM) {
    // Assess the message through LLM for engagement, anchors, claims
    // (FastLLMProvider + StalenessGuard are wired inside messageAssessor)
    const previousMessage = session.stateTracker.messages.length > 1
      ? session.stateTracker.messages[session.stateTracker.messages.length - 2]
      : null;

    const llmAssessment = await messageAssessor.assess({
      text,
      participantName: participant.name,
      previousText: previousMessage?.text,
      topicTitle: session.topic?.title,
      openingQuestion: session.topic?.openingQuestion,
      recentAnchors: enhancedEngine.getOrchestrator(sessionShortCode)?.anchorTracker?.getTopAnchors(3) || []
    });

    // Process through enhanced engine
    decision = await enhancedEngine.processMessage(session.stateTracker, {
      participantName: participant.name,
      text,
      timestamp: Date.now(),
      llmAssessment
    });
  } else {
    // Fallback to legacy decide() path (still uses enhanced engine)
    decision = await enhancedEngine.decide(session.stateTracker);
  }

  const pipelineLatencyMs = Date.now() - pipelineStart;

  if (decision.shouldSpeak && decision.message) {
    // Staleness guard on message delivery: if the entire pipeline took too long,
    // log it but still deliver (the message is already generated)
    if (pipelineLatencyMs > 10000) {
      console.warn(`[${sessionShortCode}] ⚠ Pipeline latency: ${pipelineLatencyMs}ms — consider tuning timeouts`);
    }

    const delay = 1500 + Math.random() * 2000;
    setTimeout(async () => {
      await handleFacilitatorMessage(sessionShortCode, decision);
    }, delay);
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

// Initialize database on startup
async function initialize() {
  try {
    await db.initializeSchema();
    console.log('Database initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

initialize();

wss.on("connection", (ws) => {
  let clientId = uuidv4();
  let currentSessionShortCode = null;

  ws.on("message", async (raw, isBinary) => {
    if (isBinary || Buffer.isBuffer(raw)) {
      if (ws.stt && !ws.stt.killed) {
        ws.stt.stdin.write(raw);
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {

      case "create_session": {
        const topicId = msg.topicId || DISCUSSION_TOPICS[0].id;
        const topic = DISCUSSION_TOPICS.find(t => t.id === topicId);
        if (!topic) {
          ws.send(JSON.stringify({ type: "error", text: "Unknown topic" }));
          return;
        }

        // Create session in database
        const session = await sessionsRepo.create({
          title: topic.title,
          openingQuestion: topic.openingQuestion
        });

        const shortCode = session.short_code;

        // Create in-memory state tracker
        const SessionStateTracker = require("./stateTracker").SessionStateTracker;
        const stateTracker = new SessionStateTracker(session.id, session);
        await stateTracker.loadFromDatabase();

        activeSessions.set(shortCode, {
          dbSession: session,
          stateTracker,
          clients: [],
          active: false,
          topic,
          mode: msg.mode || "text"  // Track session mode (text/video)
        });

        ws.send(JSON.stringify({
          type: "session_created",
          sessionId: shortCode,
          topicId: topic.id,
          topicTitle: topic.title,
          passage: topic.passage,
          mode: msg.mode || "text"
        }));
        break;
      }

      case "join_dashboard": {
        const { sessionId } = msg;
        const session = activeSessions.get(sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", text: "Session not found" }));
          return;
        }

        currentSessionShortCode = sessionId;
        session.clients.push({ ws, clientId, role: "teacher" });

        const snapshot = await session.stateTracker.getStateSnapshot();

        // Include analyzer state if available
        const analyzerState = enhancedEngine.getAnalyzerState?.(sessionId) || null;

        ws.send(JSON.stringify({
          type: "dashboard_joined",
          sessionId,
          snapshot,
          analyzerState
        }));
        break;
      }

      case "join_session": {
        const { sessionId, name, age } = msg;
        let session = activeSessions.get(sessionId);

        // If not in memory, try loading from DB (supports REST-created sessions)
        if (!session) {
          try {
            const dbSession = await sessionsRepo.findByShortCode(sessionId);
            if (dbSession) {
              const SessionStateTracker = require("./stateTracker").SessionStateTracker;
              const stateTracker = new SessionStateTracker(dbSession.id, dbSession);
              await stateTracker.loadFromDatabase();

              // Try to find a matching topic for context
              const topic = DISCUSSION_TOPICS.find(t => t.title === dbSession.title) || {
                id: "custom",
                title: dbSession.title,
                passage: dbSession.opening_question || "",
                openingQuestion: dbSession.opening_question || "",
                followUpAngles: []
              };

              session = {
                dbSession,
                stateTracker,
                clients: [],
                active: dbSession.status === 'active',
                topic
              };
              activeSessions.set(sessionId, session);
            }
          } catch (err) {
            console.error("Error loading session from DB:", err);
          }
        }

        if (!session) {
          ws.send(JSON.stringify({ type: "error", text: "Session not found" }));
          return;
        }

        currentSessionShortCode = sessionId;
        await session.stateTracker.addParticipant(clientId, name, age || 12);
        session.clients.push({ ws, clientId, name });

        broadcastToSession(sessionId, {
          type: "participant_joined",
          name,
          participantCount: session.stateTracker.participants.size
        });

        // Initialize STT Process for Voice
        const STT_PYTHON = process.env.STT_PYTHON || 'server/venv/bin/python';
        const STT_SCRIPT = process.env.STT_SCRIPT || 'server/stt.py';
        const stt = spawn(STT_PYTHON, [STT_SCRIPT]);
        stt.on('error', (err) => {
          console.warn(`[STT] Failed to start for ${name}:`, err.message);
        });
        stt.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(l => l.trim().length > 0);
          for (const line of lines) {
            try {
              const res = JSON.parse(line);
              if (res.text && res.text.trim()) {
                handleParticipantMessage(currentSessionShortCode, clientId, res.text);
              } else if (res.partial && res.partial.trim()) {
                broadcastToSession(currentSessionShortCode, {
                  type: "participant_partial",
                  name: name,
                  text: res.partial
                });
              }
            } catch (e) { }
          }
        });
        ws.stt = stt;

        const participants = Array.from(session.stateTracker.participants.values())
          .map(p => ({ name: p.name, id: p.id }));

        ws.send(JSON.stringify({
          type: "session_joined",
          sessionId,
          topicTitle: session.topic.title,
          passage: session.topic.passage,
          participants,
          yourId: clientId
        }));
        break;
      }

      case "rejoin_session": {
        const { sessionId, oldClientId } = msg;
        const session = activeSessions.get(sessionId);
        if (!session) {
          ws.send(JSON.stringify({ type: "error", text: "Session not found or expired" }));
          return;
        }

        const participant = session.stateTracker.participants.get(oldClientId);
        if (!participant) {
          ws.send(JSON.stringify({ type: "error", text: "Participant not found in session" }));
          return;
        }

        clientId = oldClientId;
        currentSessionShortCode = sessionId;

        session.clients = session.clients.filter(c => c.clientId !== clientId);
        session.clients.push({ ws, clientId, name: participant.name });

        // Kill any existing STT process before spawning a new one
        if (ws.stt && !ws.stt.killed) {
          ws.stt.kill();
        }

        const sttRejoin = spawn(process.env.STT_PYTHON || 'server/venv/bin/python', [process.env.STT_SCRIPT || 'server/stt.py']);
        sttRejoin.on('error', (err) => {
          console.warn(`[STT] Failed to start for rejoin:`, err.message);
        });
        sttRejoin.stdout.on('data', (data) => {
          const lines = data.toString().split('\n').filter(l => l.trim().length > 0);
          for (const line of lines) {
            try {
              const res = JSON.parse(line);
              if (res.text && res.text.trim()) {
                handleParticipantMessage(currentSessionShortCode, clientId, res.text);
              }
            } catch (e) { }
          }
        });
        ws.stt = sttRejoin;

        const participants = Array.from(session.stateTracker.participants.values())
          .map(p => ({ name: p.name, id: p.id }));

        ws.send(JSON.stringify({
          type: "session_joined",
          sessionId,
          topicTitle: session.topic.title,
          passage: session.topic.passage,
          participants,
          yourId: clientId
        }));

        if (session.active) {
          ws.send(JSON.stringify({ type: "discussion_started" }));
        }
        break;
      }

      case "start_discussion": {
        const session = activeSessions.get(currentSessionShortCode);
        if (!session) return;

        session.active = true;
        await sessionsRepo.updateStatus(session.dbSession.id, 'active');

        // Clear warmup chat history — Plato is now in facilitator mode
        enhancedEngine.clearWarmupHistory(currentSessionShortCode);

        const names = Array.from(session.stateTracker.participants.values()).map(p => p.name);
        const ages = Array.from(session.stateTracker.participants.values()).map(p => p.age);
        const ageCalibration = getAgeCalibration(ages);

        // Launch Jitsi bot for video mode
        if (session.mode === "video" && jitsiLauncher) {
          console.log(`[${currentSessionShortCode}] Starting video mode with Jitsi bot...`);
          session.jitsiBot = jitsiLauncher.startJitsiBot(currentSessionShortCode, {
            roomName: `socratic-${currentSessionShortCode}`,
            topic: session.topic?.title,
            defaultAge: ages[0] || 12
          });
        }

        const opening = await enhancedEngine.generateOpening(
          session.topic, names, ageCalibration
        );

        await session.stateTracker.recordAIMessage(opening, "opening");

        broadcastToSession(currentSessionShortCode, {
          type: "discussion_started",
          mode: session.mode || "text"
        });

        broadcastToSession(currentSessionShortCode, {
          type: "facilitator_message",
          text: opening,
          move: "opening",
          timestamp: Date.now()
        });

        // Only start silence checker for text mode (Jitsi handles its own)
        if (session.mode !== "video") {
          startSilenceChecker(currentSessionShortCode);
        }
        break;
      }

      case "message": {
        handleParticipantMessage(currentSessionShortCode, clientId, msg.text);
        break;
      }

      case "end_discussion": {
        const session = activeSessions.get(currentSessionShortCode);
        if (!session) return;

        session.active = false;
        await sessionsRepo.updateStatus(session.dbSession.id, 'ended');

        const checker = silenceCheckers.get(currentSessionShortCode);
        if (checker) {
          clearInterval(checker);
          silenceCheckers.delete(currentSessionShortCode);
        }

        // Stop Jitsi bot if running
        if (session.jitsiBot && jitsiLauncher) {
          console.log(`[${currentSessionShortCode}] Stopping Jitsi bot...`);
          jitsiLauncher.stopJitsiBot(session.jitsiBot);
          session.jitsiBot = null;
        }

        // Clean up facilitation engine session state
        enhancedEngine.cleanupSession(session.stateTracker?.sessionId);

        const closing = await enhancedEngine.generateClosing(session.stateTracker);
        await session.stateTracker.recordAIMessage(closing, "synthesize");

        broadcastToSession(currentSessionShortCode, {
          type: "facilitator_message",
          text: closing,
          move: "synthesize",
          timestamp: Date.now()
        });

        broadcastToSession(currentSessionShortCode, {
          type: "discussion_ended"
        });

        console.log(`[${currentSessionShortCode}] Discussion ended.`);
        break;
      }
    }
  });

  ws.on("close", () => {
    if (ws.stt) {
      ws.stt.kill();
    }

    if (currentSessionShortCode) {
      const session = activeSessions.get(currentSessionShortCode);
      if (session) {
        session.clients = session.clients.filter(c => c.clientId !== clientId);

        const participant = session.stateTracker.participants.get(clientId);
        if (participant) {
          broadcastToSession(currentSessionShortCode, {
            type: "participant_left",
            name: participant.name,
            participantCount: session.stateTracker.participants.size
          });
        }

        if (session.clients.length === 0) {
          const checker = silenceCheckers.get(currentSessionShortCode);
          if (checker) clearInterval(checker);
          silenceCheckers.delete(currentSessionShortCode);
          activeSessions.delete(currentSessionShortCode);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  Socratic Facilitator running at http://localhost:${PORT}\n`);
  console.log(`  Available topics:`);
  DISCUSSION_TOPICS.forEach(t => console.log(`    - ${t.title} (${t.id})`));
  console.log();
});
