/**
 * Miscellaneous Routes
 * Inline routes extracted from main server file
 */

const express = require("express");
const jwt = require("jsonwebtoken");
const path = require("path");
const { DISCUSSION_TOPICS } = require("../config");
const { getPlatoDisplayConfig } = require("../enhancedFacilitator");
const { claudeBreaker, elevenLabsBreaker, deepgramBreaker, fastLlmBreaker } = require("../utils/api-breakers");

const router = express.Router();

// JaaS configuration
const JAAS_APP_ID = process.env.JAAS_APP_ID || "vpaas-magic-cookie-44bf27b66fab458bae6a8c271ea52a82";
// JaaS private key may have literal \n in env var — convert to real newlines
const JAAS_API_KEY = process.env.JAAS_API_KEY
  ? process.env.JAAS_API_KEY.replace(/\\n/g, '\n')
  : null;
const JAAS_KEY_ID = process.env.JAAS_KEY_ID || null;

/**
 * GET /dashboard
 * Teacher dashboard page
 */
router.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "../../client/public/dashboard.html"));
});

/**
 * GET /admin
 * Admin portal page
 */
router.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "../../client/public/admin.html"));
});

/**
 * GET /health
 * Health check endpoint
 */
router.get("/health", (req, res) => res.json({ status: "ok" }));

/**
 * GET /api/jitsi-token
 * Generate JaaS JWT token for Jitsi meetings
 */
router.get("/jitsi-token", (req, res) => {
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
  const { v4: uuidv4 } = require("uuid");
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

/**
 * GET /api/topics
 * Legacy topics endpoint (kept for backward compatibility)
 */
router.get("/topics", (req, res) => {
  res.json(DISCUSSION_TOPICS.map(t => ({
    id: t.id,
    title: t.title,
    passage: t.passage,
    ageRange: t.ageRange
  })));
});

/**
 * GET /api/plato
 * Plato display configuration for frontend
 */
router.get("/plato", (req, res) => {
  res.json(getPlatoDisplayConfig());
});

/**
 * GET /api/session/:sessionId/orchestrator
 * Orchestrator state for debugging/dashboard
 */
router.get("/session/:sessionId/orchestrator", (req, res) => {
  const { sessionId } = req.params;
  const { enhancedEngine } = req.app.locals.deps;
  const state = enhancedEngine.getOrchestratorState(sessionId);
  if (!state) {
    return res.status(404).json({ error: "Session orchestrator not found" });
  }
  res.json(state);
});

/**
 * GET /api/telemetry
 * Latency telemetry endpoint — shows fast LLM and staleness guard stats
 */
router.get("/telemetry", (req, res) => {
  const { fastLLM, stalenessGuard, USE_ENHANCED_SYSTEM } = req.app.locals.deps;
  res.json({
    fastLLM: fastLLM.getStats(),
    stalenessGuard: stalenessGuard.getStats(),
    enhancedSystem: USE_ENHANCED_SYSTEM,
    circuitBreakers: {
      claude: claudeBreaker.getState(),
      elevenLabs: elevenLabsBreaker.getState(),
      deepgram: deepgramBreaker.getState(),
      fastLlm: fastLlmBreaker.getState()
    }
  });
});

module.exports = router;
