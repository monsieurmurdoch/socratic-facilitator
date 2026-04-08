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
const { WebSocketServer } = require("ws");
const path = require("path");

// Database
const db = require("./db");

// Services
const { EnhancedFacilitationEngine } = require("./enhancedFacilitator");
const { MessageAssessor } = require("./analysis/messageAssessor");
const { fastLLM } = require("./analysis/fastLLMProvider");
const { stalenessGuard } = require("./analysis/stalenessGuard");
const { FACILITATION_PARAMS } = require("./config");

// Auth middleware
const { attachUser } = require("./auth");

// Routes
const sessionsRouter = require("./routes/sessions");
const authRouter = require("./routes/auth");
const classesRouter = require("./routes/classes");
const adminRouter = require("./routes/admin");
const integrationsRouter = require("./routes/integrations");
const parentsRouter = require("./routes/parents");
const miscRouter = require("./routes/misc");

// WebSocket & Session Management
const { setupWebSocket } = require("./websocket");
const SessionManager = require("./sessions");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend
app.use(express.static(path.join(__dirname, "../client/public")));
app.use("/src", express.static(path.join(__dirname, "../client/src")));

// Auth middleware — attaches req.user from JWT if present
app.use(attachUser);

// Make dependencies available to routes
app.locals.deps = {};

// API routes
app.use("/api/auth", authRouter);
app.use("/api/classes", classesRouter);
app.use("/api/sessions", sessionsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/parents", parentsRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/", miscRouter);

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

// Initialize database and services
async function initialize() {
  try {
    await db.initializeSchema();
    console.log('Database initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
    throw error; // Re-throw to prevent server from starting
  }

  // Initialize engine and services
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

  // Create service instances
  const enhancedEngine = new EnhancedFacilitationEngine(ANTHROPIC_KEY);
  const messageAssessor = new MessageAssessor(ANTHROPIC_KEY);

  // Feature flag for using enhanced system
  const USE_ENHANCED_SYSTEM = process.env.USE_ENHANCED_SYSTEM !== 'false';  // Default to true

  // Create dependencies object
  const deps = {
    enhancedEngine,
    messageAssessor,
    fastLLM,
    stalenessGuard,
    USE_ENHANCED_SYSTEM,
    FACILITATION_PARAMS,
    sessionsRepo: require("./db/repositories/sessions"),
    jitsiLauncher,
    // TTS (if needed in future)
    generateTTS: require("./voice/tts").generateTTS
  };

  // Store deps for routes access
  app.locals.deps = deps;

  // Create session manager
  const sessionManager = new SessionManager(deps);
  await sessionManager.init();
  deps.sessionManager = sessionManager;

  // Setup WebSocket server
  setupWebSocket(wss, deps);

  return { deps, sessionManager };
}

async function main() {
  try {
    await initialize();

    server.listen(PORT, () => {
      console.log(`\n  Socratic Facilitator running at http://localhost:${PORT}`);
      console.log(`  WebSocket server attached to HTTP server`);
      console.log(`  Ready.\n`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
