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
const { DEFAULT_ANTHROPIC_MODEL } = require("./models");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
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
const usersRepo = require("./db/repositories/users");
const messageAnalyticsRepo = require("./db/repositories/messageAnalytics");
const sessionMembershipsRepo = require("./db/repositories/sessionMemberships");

// Services
const { EnhancedFacilitationEngine, getPlatoDisplayConfig } = require("./enhancedFacilitator");
const { FacilitationOrchestrator } = require("./analysis/facilitationOrchestrator");
const { MessageAssessor } = require("./analysis/messageAssessor");
const { fastLLM } = require("./analysis/fastLLMProvider");
const { stalenessGuard } = require("./analysis/stalenessGuard");
const { DISCUSSION_TOPICS, FACILITATION_PARAMS, getAgeCalibration } = require("./config");

// Auth
const { attachUser, authenticateToken } = require("./auth");

// Routes
const sessionsRouter = require("./routes/sessions");
const authRouter = require("./routes/auth");
const classesRouter = require("./routes/classes");
const adminRouter = require("./routes/admin");
const integrationsRouter = require("./routes/integrations");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend
app.use(express.static(path.join(__dirname, "../client/public")));
app.use("/src", express.static(path.join(__dirname, "../client/src")));

// Auth middleware — attaches req.user from JWT if present
app.use(attachUser);

// API routes
app.use("/api/auth", authRouter);
app.use("/api/classes", classesRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/integrations", integrationsRouter);

// Teacher dashboard — served at /dashboard?session=CODE
app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/public/dashboard.html"));
});

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// JaaS JWT token generation
const jwt = require("jsonwebtoken");
const JAAS_APP_ID = process.env.JAAS_APP_ID || "vpaas-magic-cookie-44bf27b66fab458bae6a8c271ea52a82";
// JaaS private key may have literal \n in env var — convert to real newlines
const JAAS_API_KEY = process.env.JAAS_API_KEY
  ? process.env.JAAS_API_KEY.replace(/\\n/g, '\n')
  : null;
const JAAS_KEY_ID = process.env.JAAS_KEY_ID || null;

app.get("/api/jitsi-token", (req, res) => {
  // Check if we have the required JaaS credentials
  if (!JAAS_API_KEY || !JAAS_KEY_ID) {
    console.warn("[Jitsi] JAAS_API_KEY or JAAS_KEY_ID not configured - returning empty token");
    // Return empty token - Jitsi will join without auth (public rooms work fine)
    return res.json({ token: null, reason: "JaaS not configured" });
  }

  // Validate that API key looks like an RSA private key (starts with -----BEGIN)
  if (!JAAS_API_KEY.includes('-----BEGIN')) {
    console.error("[Jitsi] JAAS_API_KEY is not a valid RSA private key (missing PEM header)");
    return res.status(500).json({ error: "Invalid JAAS_API_KEY format - must be RSA private key in PEM format" });
  }

  const { room, name, moderator } = req.query;
  const userId = uuidv4();
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    aud: "jitsi",
    iss: "chat",
    iat: now,
    exp: now + 7200, // 2 hours
    nbf: now - 5,
    sub: JAAS_APP_ID,
    context: {
      features: {
        livestreaming: false,
        "file-upload": false,
        "outbound-call": false,
        "sip-outbound-call": false,
        transcription: false,
        recording: false
      },
      user: {
        "hidden-from-recorder": false,
        moderator: moderator === "true",
        name: name || "Participant",
        id: userId,
        avatar: "",
        email: ""
      }
    },
    room: room || "*"
  };

  try {
    const token = jwt.sign(payload, JAAS_API_KEY, {
      algorithm: "RS256",
      header: {
        kid: JAAS_KEY_ID,
        typ: "JWT",
        alg: "RS256"
      }
    });
    res.json({ token });
  } catch (err) {
    console.error("[Jitsi] JWT signing failed:", err.message);
    res.status(500).json({ error: "Failed to generate JWT token: " + err.message });
  }
});

// Legacy topics endpoint (kept for backward compatibility)
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
const WARMUP_STT_MERGE_MS = Number(process.env.WARMUP_STT_MERGE_MS || 2500);
const WARMUP_STT_SETTLE_MS = Number(process.env.WARMUP_STT_SETTLE_MS || 900);
const WARMUP_REPLY_BASE_DELAY_MS = Number(process.env.WARMUP_REPLY_BASE_DELAY_MS || 250);
const WARMUP_REPLY_JITTER_MS = Number(process.env.WARMUP_REPLY_JITTER_MS || 450);

// Jitsi bot launcher (for video mode)
// Disabled on Railway — Puppeteer/Chrome can't run in Alpine containers.
// STT is handled client-side via Web Speech API instead.
let jitsiLauncher = null;
if (process.env.ENABLE_JITSI_BOT === 'true') {
  try {
    jitsiLauncher = require("./jitsi-bot/start-session");
  } catch (e) {
    console.log("Jitsi bot module not available:", e.message);
  }
}

// Initialize enhanced engine
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
console.log(`[INIT] ANTHROPIC_API_KEY: ${ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0, 10) + '...' : 'NOT SET'}`);
console.log(`[INIT] ANTHROPIC_MODEL: ${process.env.ANTHROPIC_MODEL || `${DEFAULT_ANTHROPIC_MODEL} (default)`}`);
console.log(`[INIT] ELEVENLABS_API_KEY: ${process.env.ELEVENLABS_API_KEY ? 'SET' : 'NOT SET'}`);
console.log(`[INIT] DEEPGRAM_API_KEY: ${process.env.DEEPGRAM_API_KEY ? 'SET' : 'NOT SET'}`);
const fastLLMEndpoint = process.env.FAST_LLM_ENDPOINT || process.env.FAST_LLM_BASE_URL || null;
let fastLLMHost = 'NOT SET';
if (fastLLMEndpoint) {
  try {
    fastLLMHost = new URL(fastLLMEndpoint).host;
  } catch (_error) {
    fastLLMHost = 'INVALID URL';
  }
}
console.log(`[INIT] FAST_LLM: ${fastLLM.isAvailable() ? 'ENABLED' : 'DISABLED'} (${fastLLMHost})`);
const enhancedEngine = new EnhancedFacilitationEngine(ANTHROPIC_KEY);
const messageAssessor = new MessageAssessor(ANTHROPIC_KEY);

// Feature flag for using enhanced system
const USE_ENHANCED_SYSTEM = process.env.USE_ENHANCED_SYSTEM !== 'false';  // Default to true

// ---- Voice Integration: TTS Helper ----
// Priority: ElevenLabs (cloud, high quality) → Piper (local, free) → silent
const PIPER_PATH = process.env.PIPER_PATH || 'server/models/tts/piper/piper';
const PIPER_MODEL_PATH = process.env.PIPER_MODEL_PATH || 'server/models/tts/en_US-lessac-medium.onnx';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel

async function generateTTS(text) {
  // Try ElevenLabs first (cloud, high quality)
  if (ELEVENLABS_API_KEY) {
    try {
      const nodeFetch = require('node-fetch');
      const response = await nodeFetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'xi-api-key': ELEVENLABS_API_KEY
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_monolingual_v1',
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.75
            }
          })
        }
      );

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = Buffer.from(arrayBuffer);
        console.log(`[TTS:ElevenLabs] Generated ${audioBuffer.length} bytes`);
        return audioBuffer;
      }
      const errBody = await response.text();
      console.warn(`[TTS:ElevenLabs] API returned ${response.status}: ${errBody}, key starts with: ${ELEVENLABS_API_KEY.substring(0, 6)}...`);
    } catch (err) {
      console.warn('[TTS:ElevenLabs] Error:', err.message, '— falling back to Piper');
    }
  }

  // Fall back to Piper (local)
  return new Promise((resolve, reject) => {
    const piper = spawn(PIPER_PATH, [
      '--model', PIPER_MODEL_PATH,
      '--output_file', '-'
    ]);

    let audioData = [];
    piper.stdout.on('data', chunk => audioData.push(chunk));

    piper.on('error', (err) => {
      reject(new Error('TTS not available (no ElevenLabs key, Piper not installed): ' + err.message));
    });

    piper.stdin.write(text);
    piper.stdin.end();

    piper.on('close', code => {
      if (code === 0) {
        console.log(`[TTS:Piper] Generated ${Buffer.concat(audioData).length} bytes`);
        resolve(Buffer.concat(audioData));
      }
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

  // TTS disabled for beta — text-only Plato
  // try {
  //   const wavBuffer = await generateTTS(decision.message);
  //   for (const client of session.clients) {
  //     if (client.ws.readyState === 1) client.ws.send(wavBuffer);
  //   }
  // } catch (e) {
  //   console.error("TTS Error:", e);
  // }
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

function ensureWarmupState(session) {
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

function clearPendingWarmupReply(session, clientId) {
  ensureWarmupState(session);
  const pendingReply = session.pendingWarmupReplies.get(clientId);
  if (pendingReply?.timer) {
    clearTimeout(pendingReply.timer);
  }
  session.pendingWarmupReplies.delete(clientId);
}

function markWarmupSpeechActivity(sessionShortCode, clientId) {
  const session = activeSessions.get(sessionShortCode);
  if (!session || session.active) return;
  ensureWarmupState(session);
  session.warmupSpeechActivity.set(clientId, Date.now());
  session.warmupSpeechVersions.set(clientId, (session.warmupSpeechVersions.get(clientId) || 0) + 1);
  clearPendingWarmupReply(session, clientId);
}

async function finalizeWarmupTurn(sessionShortCode, clientId) {
  const session = activeSessions.get(sessionShortCode);
  if (!session || session.active) return;

  ensureWarmupState(session);
  const pendingTurn = session.pendingWarmupTurns.get(clientId);
  if (!pendingTurn) return;

  session.pendingWarmupTurns.delete(clientId);
  const participant = session.stateTracker.participants.get(clientId);
  if (!participant) return;

  const text = pendingTurn.text
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return;
  const expectedSpeechVersion = session.warmupSpeechVersions.get(clientId) || 0;

  broadcastToSession(sessionShortCode, {
    type: "participant_message",
    name: participant.name,
    senderId: clientId,
    text,
    timestamp: Date.now()
  });

  const names = Array.from(session.stateTracker.participants.values()).map(p => p.name);
  const ages = Array.from(session.stateTracker.participants.values()).map(p => p.age);
  const ageCalibration = getAgeCalibration(ages);

  const generateReply = async () => {
    const latestSpeechAt = session.warmupSpeechActivity.get(clientId) || 0;
    const latestSpeechVersion = session.warmupSpeechVersions.get(clientId) || 0;
    if (latestSpeechVersion !== expectedSpeechVersion) {
      clearPendingWarmupReply(session, clientId);
      return;
    }
    if (pendingTurn.source === "stt" && Date.now() - latestSpeechAt < WARMUP_STT_SETTLE_MS) {
      const retryDelay = Math.max(150, WARMUP_STT_SETTLE_MS - (Date.now() - latestSpeechAt));
      const timer = setTimeout(generateReply, retryDelay);
      session.pendingWarmupReplies.set(clientId, { timer });
      return;
    }

    clearPendingWarmupReply(session, clientId);

    const reply = await enhancedEngine.warmupChat(
      sessionShortCode, participant.name, text, names, ageCalibration, session.topic
    );
    const currentSpeechVersion = session.warmupSpeechVersions.get(clientId) || 0;
    if (currentSpeechVersion !== expectedSpeechVersion) {
      return;
    }

    if (reply) {
      const replyDelay = WARMUP_REPLY_BASE_DELAY_MS + Math.random() * WARMUP_REPLY_JITTER_MS;
      setTimeout(() => {
        const stillActiveSession = activeSessions.get(sessionShortCode);
        if (!stillActiveSession || stillActiveSession.active) return;
        const newestSpeechVersion = stillActiveSession.warmupSpeechVersions?.get(clientId) || 0;
        if (newestSpeechVersion !== expectedSpeechVersion) return;
        broadcastToSession(sessionShortCode, {
          type: "facilitator_message",
          text: reply,
          move: "warmup",
          timestamp: Date.now()
        });
      }, replyDelay);
    }

    console.log(`[${sessionShortCode}] ☀ WARMUP | ${participant.name}: "${text}"`);
    console.log(`  → Plato: "${reply?.substring(0, 80)}${reply?.length > 80 ? '...' : ''}"`);
  };

  if (pendingTurn.source === "stt") {
    const timer = setTimeout(generateReply, WARMUP_STT_SETTLE_MS);
    session.pendingWarmupReplies.set(clientId, { timer });
    return;
  }

  await generateReply();
}

function queueWarmupTurn(sessionShortCode, clientId, text, source = "text") {
  const session = activeSessions.get(sessionShortCode);
  if (!session || session.active) return;

  ensureWarmupState(session);

  const normalizedText = String(text || "").trim();
  if (!normalizedText) return;

  if (source === "stt") {
    markWarmupSpeechActivity(sessionShortCode, clientId);
  } else {
    session.warmupSpeechActivity.set(clientId, Date.now());
    session.warmupSpeechVersions.set(clientId, (session.warmupSpeechVersions.get(clientId) || 0) + 1);
    clearPendingWarmupReply(session, clientId);
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

  const delay = source === "stt" ? WARMUP_STT_MERGE_MS : 0;
  pendingTurn.timer = setTimeout(() => {
    finalizeWarmupTurn(sessionShortCode, clientId).catch((error) => {
      console.error("[warmup] finalize turn error:", error.message);
    });
  }, delay);

  session.pendingWarmupTurns.set(clientId, pendingTurn);
}

// ---- WebSocket Handling ----

async function handleParticipantMessage(sessionShortCode, clientId, text, meta = {}) {
  const session = activeSessions.get(sessionShortCode);
  if (!session) return;

  const participant = session.stateTracker.participants.get(clientId);
  if (!participant) return;

  // ── Pre-discussion: warmup chat mode ──
  if (!session.active) {
    queueWarmupTurn(sessionShortCode, clientId, text, meta.source || "text");
    return;
  }

  // ── Active discussion: full pedagogical pipeline ──
  await session.stateTracker.recordMessage(clientId, text);

  broadcastToSession(sessionShortCode, {
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

    const delay = 500 + Math.random() * 1000;
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
    throw error; // Re-throw to prevent server from starting
  }
}

async function startServer() {
  await initialize();
}

wss.on("connection", (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] New connection from ${ip} (total: ${wss.clients.size})`);
  let clientId = uuidv4();
  let currentSessionShortCode = null;

  // Send a welcome message so client knows the WS is truly connected end-to-end
  ws.send(JSON.stringify({ type: "connected", clientId }));

  // Per-client Deepgram relay state
  let deepgramWs = null;

  ws.on("message", async (raw, isBinary) => {
    // Binary data = audio frames for Deepgram relay
    if (isBinary) {
      if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(raw);
      }
      return;
    }

    // Convert Buffer to string (ws library sends Buffers for text frames too)
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    console.log(`[WS] Received: ${msg.type}`, msg.type === 'join_session' ? `sessionId=${msg.sessionId} name=${msg.name}` : '');

    try {
    switch (msg.type) {

      case "create_session": {
        // Legacy WS-based session creation (kept for backward compat)
        // The primary flow now uses POST /api/sessions + join_session
        const title = msg.title || "Open Discussion";
        const openingQuestion = msg.openingQuestion || null;

        const session = await sessionsRepo.create({ title, openingQuestion });
        const shortCode = session.short_code;

        const SessionStateTracker = require("./stateTracker").SessionStateTracker;
        const stateTracker = new SessionStateTracker(session.id, session);
        await stateTracker.loadFromDatabase();

        const topic = {
          id: "custom",
          title,
          passage: "",
          openingQuestion: openingQuestion || "",
          followUpAngles: []
        };

        activeSessions.set(shortCode, {
          dbSession: session,
          stateTracker,
          clients: [],
          active: false,
          topic,
          mode: "video"
        });

        ws.send(JSON.stringify({
          type: "session_created",
          sessionId: shortCode,
          topicTitle: title,
          mode: "video"
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
        const analyzerState = enhancedEngine.getAnalyzerState?.(sessionId) || null;
        const recentTurns = session.stateTracker.getRecentTurns(30);

        ws.send(JSON.stringify({
          type: "dashboard_joined",
          sessionId,
          snapshot,
          analyzerState,
          recentTurns,
          paused: !!session.paused,
          active: !!session.active,
          topic: session.topic
        }));

        // Start streaming dashboard updates every 3s
        const dashInterval = setInterval(async () => {
          if (ws.readyState !== 1) { clearInterval(dashInterval); return; }
          const s = activeSessions.get(sessionId);
          if (!s) { clearInterval(dashInterval); return; }
          const snap = await s.stateTracker.getStateSnapshot();
          const aState = enhancedEngine.getAnalyzerState?.(sessionId) || null;
          ws.send(JSON.stringify({
            type: "dashboard_update",
            snapshot: snap,
            analyzerState: aState,
            paused: !!s.paused,
            active: !!s.active
          }));
        }, 3000);
        ws._dashInterval = dashInterval;
        break;
      }

      case "teacher_pause": {
        const session = activeSessions.get(currentSessionShortCode);
        if (!session) return;
        session.paused = true;
        console.log(`[${currentSessionShortCode}] Teacher PAUSED Plato`);
        broadcastToSession(currentSessionShortCode, {
          type: "facilitator_paused"
        });
        break;
      }

      case "teacher_resume": {
        const session = activeSessions.get(currentSessionShortCode);
        if (!session) return;
        session.paused = false;
        console.log(`[${currentSessionShortCode}] Teacher RESUMED Plato`);
        broadcastToSession(currentSessionShortCode, {
          type: "facilitator_resumed"
        });
        break;
      }

      case "teacher_force_speak": {
        const session = activeSessions.get(currentSessionShortCode);
        if (!session || !session.active) return;
        console.log(`[${currentSessionShortCode}] Teacher FORCED Plato to speak`);
        const decision = await enhancedEngine.decide(session.stateTracker);
        if (decision.message) {
          await handleFacilitatorMessage(currentSessionShortCode, decision);
        } else {
          // Force a generic deepen move
          const fallback = await enhancedEngine.decide(session.stateTracker);
          if (fallback.message) {
            await handleFacilitatorMessage(currentSessionShortCode, fallback);
          }
        }
        break;
      }

      case "teacher_set_goal": {
        const session = activeSessions.get(currentSessionShortCode);
        if (!session) return;
        const { goal } = msg;
        if (goal) {
          session.teacherGoal = goal;
          console.log(`[${currentSessionShortCode}] Teacher set goal: "${goal}"`);
        }
        break;
      }

      case "teacher_adjust_params": {
        const session = activeSessions.get(currentSessionShortCode);
        if (!session) return;
        // Apply overrides to the session's stateTracker params
        const overrides = msg.params || {};
        if (!session.paramOverrides) session.paramOverrides = {};
        Object.assign(session.paramOverrides, overrides);
        console.log(`[${currentSessionShortCode}] Teacher adjusted params:`, overrides);
        break;
      }

      case "join_session": {
        const { sessionId, name, age, authToken } = msg;
        console.log(`[join_session] Looking up session: ${sessionId}`);
        let authUser = null;
        if (authToken) {
          try {
            const auth = await authenticateToken(authToken, { touch: false });
            authUser = auth?.user || null;
          } catch (error) {
            console.warn("[join_session] Invalid auth token:", error.message);
          }
        }
        let session = activeSessions.get(sessionId);

        // If not in memory, try loading from DB (supports REST-created sessions)
        if (!session) {
          console.log(`[join_session] Not in memory, loading from DB...`);
          try {
            const dbSession = await sessionsRepo.findByShortCode(sessionId);
            console.log(`[join_session] DB lookup result:`, dbSession ? `found (id=${dbSession.id})` : 'not found');
            if (dbSession) {
              const SessionStateTracker = require("./stateTracker").SessionStateTracker;
              const stateTracker = new SessionStateTracker(dbSession.id, dbSession);
              await stateTracker.loadFromDatabase();
              // Persisted participant rows are historical state; rebuild the live
              // roster from actual websocket joins so warmup/solo mode isn't
              // polluted by stale "present" participants from previous runs.
              stateTracker.participants.clear();
              console.log(`[join_session] State tracker loaded`);

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
            console.error("[join_session] Error loading from DB:", err);
          }
        }

        if (!session) {
          console.log(`[join_session] Session not found, sending error`);
          ws.send(JSON.stringify({ type: "error", text: "Session not found" }));
          return;
        }

        // Check for duplicate name (e.g. same user in two tabs)
        const existingByName = Array.from(session.stateTracker.participants.values())
          .find(p => p.name.toLowerCase() === name.toLowerCase());
        if (existingByName) {
          // Reuse the existing participant identity instead of creating a duplicate
          console.log(`[join_session] Duplicate name "${name}" — reusing existing participant ${existingByName.id}`);
          clientId = existingByName.id;
          // Remove stale client entry if any
          session.clients = session.clients.filter(c => c.clientId !== clientId);
        } else {
          console.log(`[join_session] Adding participant: ${name}`);
          const sessionRole = authUser?.role === 'Teacher' || authUser?.role === 'Admin' || authUser?.role === 'SuperAdmin'
            ? 'teacher'
            : 'participant';
          await session.stateTracker.addParticipant(clientId, name, age || 12, {
            userId: authUser?.id || null,
            accountRole: authUser?.role || null,
            sessionRole
          });
        }

        currentSessionShortCode = sessionId;
        // Cancel cleanup grace period if someone joins
        if (session._cleanupTimer) {
          clearTimeout(session._cleanupTimer);
          session._cleanupTimer = null;
        }
        session.clients.push({ ws, clientId, name, userId: authUser?.id || null, role: authUser?.role || null });
        console.log(`[join_session] Sending session_joined response`);

        broadcastToSession(sessionId, {
          type: "participant_joined",
          name,
          participantCount: session.stateTracker.participants.size
        });

        // Note: STT is handled by the Jitsi bot (Deepgram) in video mode.
        // Text messages from the WebSocket "message" handler still work for
        // any typed chat input if needed.

        const participants = Array.from(session.stateTracker.participants.values())
          .map(p => ({ name: p.name, id: p.id, role: p.accountRole }));

        ws.send(JSON.stringify({
          type: "session_joined",
          sessionId,
          topicTitle: session.topic.title,
          passage: session.topic.passage,
          participants,
          yourId: clientId,
          yourRole: authUser?.role || null
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

        // Cancel cleanup grace period if we're reconnecting
        if (session._cleanupTimer) {
          clearTimeout(session._cleanupTimer);
          session._cleanupTimer = null;
          console.log(`[${sessionId}] Reconnect cancelled cleanup timer`);
        }

        session.clients = session.clients.filter(c => c.clientId !== clientId);
        session.clients.push({ ws, clientId, name: participant.name });

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
        } else if (session.inVideoRoom) {
          ws.send(JSON.stringify({ type: "enter_video" }));
        }
        break;
      }

      case "enter_video": {
        // Move everyone into the video room in warmup mode (session.active stays false)
        const session = activeSessions.get(currentSessionShortCode);
        if (!session) return;

        session.inVideoRoom = true;

        broadcastToSession(currentSessionShortCode, {
          type: "enter_video"
        });
        break;
      }

      case "start_discussion": {
        const session = activeSessions.get(currentSessionShortCode);
        if (!session) return;
        if (session.active) return; // guard against double-click

        session.active = true;
        await sessionsRepo.updateStatus(session.dbSession.id, 'active');

        // Clear warmup chat history — Plato is now in facilitator mode
        enhancedEngine.clearWarmupHistory(currentSessionShortCode);

        const names = Array.from(session.stateTracker.participants.values()).map(p => p.name);
        const ages = Array.from(session.stateTracker.participants.values()).map(p => p.age);
        const ageCalibration = getAgeCalibration(ages);

        // Launch Jitsi bot (handles STT via Deepgram, TTS, and voice facilitation)
        if (jitsiLauncher) {
          console.log(`[${currentSessionShortCode}] Starting Jitsi bot...`);
          session.jitsiBot = jitsiLauncher.startJitsiBot(currentSessionShortCode, {
            roomName: `socratic-${currentSessionShortCode}`,
            topic: session.topic?.title,
            defaultAge: ages[0] || 12
          });
        }

        const opening = await enhancedEngine.generateOpening(
          session.topic, names, ageCalibration, session.dbSession?.id
        );

        await session.stateTracker.recordAIMessage(opening, "opening");

        broadcastToSession(currentSessionShortCode, {
          type: "discussion_started",
          mode: "video"
        });

        broadcastToSession(currentSessionShortCode, {
          type: "facilitator_message",
          text: opening,
          move: "opening",
          timestamp: Date.now()
        });

        // Start silence checker as a safety net
        startSilenceChecker(currentSessionShortCode);
        break;
      }

      case "message": {
        handleParticipantMessage(currentSessionShortCode, clientId, msg.text, {
          source: msg.source || "text"
        });
        break;
      }

      case "stt_start": {
        const dgKey = process.env.DEEPGRAM_API_KEY;
        if (!dgKey) {
          ws.send(JSON.stringify({ type: "stt_error", text: "DEEPGRAM_API_KEY not configured" }));
          break;
        }
        // Close existing connection if any
        if (deepgramWs) {
          try { deepgramWs.close(); } catch (e) {}
        }
        // endpointing: ms of silence before finalizing utterance (lower = faster response)
        // vad_events: enables SpeechStarted/SpeechStopped events for better timing
        const dgUrl = `wss://api.deepgram.com/v1/listen?` +
          `encoding=linear16&sample_rate=16000&channels=1` +
          `&interim_results=true&punctuate=true&language=en-US` +
          `&endpointing=300&vad_events=true`;
        deepgramWs = new WebSocket(dgUrl, {
          headers: { Authorization: `Token ${dgKey}` }
        });
        deepgramWs.on("open", () => {
          console.log(`[STT:Deepgram] Connected for client ${clientId}`);
        });
        deepgramWs.on("message", (data) => {
          try {
            const result = JSON.parse(data.toString());
            if (result.type === "Results" && result.channel) {
              const alt = result.channel.alternatives;
              if (alt && alt.length > 0 && alt[0].transcript) {
                const transcript = alt[0].transcript;
                const isFinal = result.is_final;
                if (transcript.trim()) {
                  markWarmupSpeechActivity(currentSessionShortCode, clientId);
                  ws.send(JSON.stringify({
                    type: "stt_transcript",
                    text: transcript,
                    isFinal
                  }));
                }
              }
            } else if (result.type === "SpeechStarted" || result.type === "SpeechStopped") {
              // Forward VAD events to client for better timing
              const vadType = result.type === "SpeechStarted" ? "speech_started" : "speech_stopped";
              ws.send(JSON.stringify({
                type: "vad_event",
                event: vadType,
                timestamp: result.timestamp || Date.now()
              }));
            }
          } catch (e) {
            console.error("[STT:Deepgram] Parse error:", e.message);
          }
        });
        deepgramWs.on("error", (err) => {
          console.error(`[STT:Deepgram] Error for ${clientId}:`, err.message);
          ws.send(JSON.stringify({ type: "stt_error", text: err.message }));
        });
        deepgramWs.on("close", () => {
          console.log(`[STT:Deepgram] Closed for ${clientId}`);
          deepgramWs = null;
        });
        break;
      }

      case "stt_stop": {
        if (deepgramWs) {
          try {
            deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
            deepgramWs.close();
          } catch (e) {}
          deepgramWs = null;
        }
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
    } catch (err) {
      console.error(`[WS] Error handling ${msg.type}:`, err);
      try {
        ws.send(JSON.stringify({ type: "error", text: "Server error: " + err.message }));
      } catch (e) { /* ws may be closed */ }
    }
  });

  ws.on("close", () => {
    // Clean up dashboard interval
    if (ws._dashInterval) clearInterval(ws._dashInterval);
    // Clean up Deepgram connection
    if (deepgramWs) {
      try { deepgramWs.close(); } catch (e) {}
      deepgramWs = null;
    }
    if (currentSessionShortCode) {
      const session = activeSessions.get(currentSessionShortCode);
      if (session) {
        session.clients = session.clients.filter(c => c.ws !== ws);

        const participant = session.stateTracker.participants.get(clientId);
        const hasRemainingConnection = session.clients.some(c => c.clientId === clientId);
        if (participant && !hasRemainingConnection) {
          session.stateTracker.removeParticipant(clientId).catch((error) => {
            console.error('[session] Failed to remove participant on disconnect:', error.message);
          });
          broadcastToSession(currentSessionShortCode, {
            type: "participant_left",
            name: participant.name,
            participantCount: session.stateTracker.participants.size
          });
        }

        if (session.clients.length === 0) {
          // Grace period: keep session alive for 30s so reconnects don't lose state
          const shortCode = currentSessionShortCode;
          console.log(`[${shortCode}] All clients disconnected — 30s grace period before cleanup`);
          if (session._cleanupTimer) clearTimeout(session._cleanupTimer);
          session._cleanupTimer = setTimeout(() => {
            const s = activeSessions.get(shortCode);
            if (s && s.clients.length === 0) {
              console.log(`[${shortCode}] Grace period expired — cleaning up session`);
              const checker = silenceCheckers.get(shortCode);
              if (checker) clearInterval(checker);
              silenceCheckers.delete(shortCode);
              activeSessions.delete(shortCode);
            }
          }, 30000);
        }
      }
    }
  });
});

startServer().then(() => {
  server.listen(PORT, () => {
    console.log(`\n  Socratic Facilitator running at http://localhost:${PORT}`);
    console.log(`  WebSocket server attached to HTTP server`);
    console.log(`  Ready.\n`);
  });
}).catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
