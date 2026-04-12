/**
 * WebSocket Setup and Routing
 * Handles WebSocket connections and routes messages to handlers
 */

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const { ConfidenceChecker } = require("../confidence-checker");
const { HANDLERS } = require("./handlers");
const { WsRateLimiter } = require("./rate-limit");

const wsRateLimiter = new WsRateLimiter();

/**
 * Setup WebSocket server
 * @param {WebSocketServer} wss - WebSocket server instance
 * @param {Object} deps - Dependencies object
 */
function setupWebSocket(wss, deps) {
  wss.on("connection", (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[WS] New connection from ${ip} (total: ${wss.clients.size})`);

    // Per-client state
    let clientId = uuidv4();
    let currentSessionShortCode = null;
    let deepgramWs = null;
    let confidenceChecker = new ConfidenceChecker();

    // Context object passed to handlers
    const ctx = {
      clientId,
      currentSessionShortCode,
      deepgramWs,
      confidenceChecker,
      deps,
      sessionManager: deps.sessionManager
    };

    // Send a welcome message so client knows the WS is truly connected end-to-end
    ws.send(JSON.stringify({ type: "connected", clientId }));

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

      // Rate limit check
      if (!wsRateLimiter.check(ws)) {
        console.warn(`[WS] Rate limit exceeded for client ${clientId}`);
        return;
      }

      // Update context with current values
      ctx.clientId = clientId;
      ctx.currentSessionShortCode = currentSessionShortCode;
      ctx.deepgramWs = deepgramWs;
      ctx.confidenceChecker = confidenceChecker;

      try {
        const handler = HANDLERS[msg.type];
        if (handler) {
          await handler(ws, msg, ctx);
          // Sync mutations back to closure variables so next message sees them
          clientId = ctx.clientId;
          currentSessionShortCode = ctx.currentSessionShortCode;
          deepgramWs = ctx.deepgramWs;
        } else {
          console.warn(`[WS] Unknown message type: ${msg.type}`);
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
        const session = deps.sessionManager.get(currentSessionShortCode);
        if (session) {
          session.clients = session.clients.filter(c => c.ws !== ws);

          const participant = session.stateTracker.participants.get(clientId);
          const hasRemainingConnection = session.clients.some(c => c.clientId === clientId);
          if (participant && !hasRemainingConnection) {
            session.stateTracker.removeParticipant(clientId).catch((error) => {
              console.error('[session] Failed to remove participant on disconnect:', error.message);
            });
            deps.sessionManager.broadcast(currentSessionShortCode, {
              type: "participant_left",
              name: participant.name,
              participantCount: session.stateTracker.participants.size
            });
          }

          if (session.clients.length === 0) {
            // Grace period: keep session alive for 30s so reconnects don't lose state
            const shortCode = currentSessionShortCode;
            const dbSessionId = session.dbSession?.id;
            console.log(`[${shortCode}] All clients disconnected — 30s grace period before cleanup`);
            if (session._cleanupTimer) clearTimeout(session._cleanupTimer);
            session._cleanupTimer = setTimeout(async () => {
              const s = deps.sessionManager.get(shortCode);
              if (s && s.clients.length === 0) {
                console.log(`[${shortCode}] Grace period expired — cleaning up session`);

                // Mark session as ended in database
                if (dbSessionId) {
                  try {
                    await deps.sessionsRepo.updateStatus(dbSessionId, 'ended');
                    console.log(`[${shortCode}] Session marked as ended in database`);
                  } catch (err) {
                    console.warn(`[${shortCode}] Failed to mark session ended:`, err.message);
                  }
                }

                // Clean up silence checker
                const checker = deps.sessionManager.silenceCheckers.get(shortCode);
                if (checker) clearInterval(checker);
                deps.sessionManager.silenceCheckers.delete(shortCode);

                // Clean up facilitation engine state
                if (s.stateTracker?.sessionId) {
                  try { deps.enhancedEngine.cleanupSession(s.stateTracker.sessionId); } catch (e) {}
                }

                // Stop Jitsi bot if running
                if (s.jitsiBot && deps.jitsiLauncher) {
                  try { deps.jitsiLauncher.stopJitsiBot(s.jitsiBot); } catch (e) {}
                  s.jitsiBot = null;
                }

                deps.sessionManager.delete(shortCode);
              }
            }, 30000);
          }
        }
      }
    });
  });
}

module.exports = { setupWebSocket };
