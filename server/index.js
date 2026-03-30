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

// JaaS JWT token generation
const jwt = require("jsonwebtoken");
const JAAS_APP_ID = process.env.JAAS_APP_ID || "vpaas-magic-cookie-44bf27b66fab458bae6a8c271ea52a82";
const JAAS_API_KEY = process.env.JAAS_API_KEY || null;
const JAAS_KEY_ID = process.env.JAAS_KEY_ID || null;

app.get("/api/jitsi-token", (req, res) => {
  if (!JAAS_API_KEY) {
    return res.status(501).json({ error: "JaaS API key not configured" });
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

  const token = jwt.sign(payload, JAAS_API_KEY, {
    algorithm: "RS256",
    header: {
      kid: JAAS_KEY_ID,
      typ: "JWT",
      alg: "RS256"
    }
  });

  res.json({ token });
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

// Jitsi bot launcher (for video mode)
let jitsiLauncher = null;
try {
  jitsiLauncher = require("./jitsi-bot/start-session");
} catch (e) {
  console.log("Jitsi bot module not available:", e.message);
}

// Initialize enhanced engine
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
console.log(`[INIT] ANTHROPIC_API_KEY: ${ANTHROPIC_KEY ? ANTHROPIC_KEY.substring(0, 10) + '...' : 'NOT SET'}`);
console.log(`[INIT] ELEVENLABS_API_KEY: ${process.env.ELEVENLABS_API_KEY ? 'SET' : 'NOT SET'}`);
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
      console.warn(`[TTS:ElevenLabs] API returned ${response.status}, falling back to Piper`);
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
      setTimeout(async () => {
        broadcastToSession(sessionShortCode, {
          type: "facilitator_message",
          text: reply,
          move: "warmup",
          timestamp: Date.now()
        });

        // TTS for warmup replies
        try {
          const wavBuffer = await generateTTS(reply);
          for (const client of session.clients) {
            if (client.ws.readyState === 1) client.ws.send(wavBuffer);
          }
        } catch (e) {
          console.error("[TTS] Warmup TTS error:", e.message);
        }
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

wss.on("connection", (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] New connection from ${ip} (total: ${wss.clients.size})`);
  let clientId = uuidv4();
  let currentSessionShortCode = null;

  // Send a welcome message so client knows the WS is truly connected end-to-end
  ws.send(JSON.stringify({ type: "connected", clientId }));

  ws.on("message", async (raw, isBinary) => {
    // Skip binary data (no longer using local STT process)
    if (isBinary) return;

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
        console.log(`[join_session] Looking up session: ${sessionId}`);
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

        console.log(`[join_session] Adding participant: ${name}`);
        currentSessionShortCode = sessionId;
        await session.stateTracker.addParticipant(clientId, name, age || 12);
        session.clients.push({ ws, clientId, name });
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
    } catch (err) {
      console.error(`[WS] Error handling ${msg.type}:`, err);
      try {
        ws.send(JSON.stringify({ type: "error", text: "Server error: " + err.message }));
      } catch (e) { /* ws may be closed */ }
    }
  });

  ws.on("close", () => {
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
  console.log(`\n  Socratic Facilitator running at http://localhost:${PORT}`);
  console.log(`  WebSocket server attached to HTTP server`);
  console.log(`  Ready.\n`);
});
