/**
 * WebSocket Message Handlers
 * Individual handler functions for each WebSocket message type
 */

const WebSocket = require("ws");
const { DISCUSSION_TOPICS } = require("../config");
const { authenticateToken, issueParticipantToken } = require("../auth");
const { v4: uuidv4 } = require("uuid");

/**
 * Handler: create_session
 * Legacy WS-based session creation (kept for backward compat)
 */
async function handleCreateSession(ws, msg, ctx) {
  const { sessionsRepo } = ctx.deps;
  const title = msg.title || "Open Discussion";
  const openingQuestion = msg.openingQuestion || null;

  const session = await sessionsRepo.create({ title, openingQuestion });
  const shortCode = session.short_code;

  const SessionStateTracker = require("../stateTracker").SessionStateTracker;
  const stateTracker = new SessionStateTracker(session.id, session);
  await stateTracker.loadFromDatabase();

  const topic = {
    id: "custom",
    title,
    passage: "",
    openingQuestion: openingQuestion || "",
    followUpAngles: []
  };

  ctx.sessionManager.set(shortCode, {
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
}

/**
 * Handler: join_dashboard
 * Teacher dashboard connection
 */
async function handleJoinDashboard(ws, msg, ctx) {
  const { sessionId } = msg;
  const session = ctx.sessionManager.get(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "error", text: "Session not found" }));
    return;
  }

  ctx.currentSessionShortCode = sessionId;
  session.clients.push({ ws, clientId: ctx.clientId, role: "teacher", clientKind: "dashboard" });

  const snapshot = await session.stateTracker.getStateSnapshot();
  const analyzerState = ctx.deps.enhancedEngine.getAnalyzerState?.(sessionId) || null;
  const recentTurns = session.stateTracker.getRecentTurns(30);

  ws.send(JSON.stringify({
    type: "dashboard_joined",
    sessionId,
    snapshot,
    analyzerState,
    recentTurns,
    currentParams: session.paramOverrides || {},
    paused: !!session.paused,
    active: !!session.active,
    topic: session.topic
  }));

  // Start streaming dashboard updates every 3s
  const dashInterval = setInterval(async () => {
    if (ws.readyState !== 1) { clearInterval(dashInterval); return; }
    const s = ctx.sessionManager.get(sessionId);
    if (!s) { clearInterval(dashInterval); return; }
    const snap = await s.stateTracker.getStateSnapshot();
    const aState = ctx.deps.enhancedEngine.getAnalyzerState?.(sessionId) || null;
    ws.send(JSON.stringify({
      type: "dashboard_update",
      snapshot: snap,
      analyzerState: aState,
      currentParams: s.paramOverrides || {},
      paused: !!s.paused,
      active: !!s.active
    }));
  }, 3000);
  ws._dashInterval = dashInterval;
}

/**
 * Handler: teacher_pause
 */
async function handleTeacherPause(ws, msg, ctx) {
  const session = ctx.sessionManager.get(ctx.currentSessionShortCode);
  if (!session) return;
  session.paused = true;
  console.log(`[${ctx.currentSessionShortCode}] Teacher PAUSED Plato`);
  ctx.sessionManager.broadcast(ctx.currentSessionShortCode, {
    type: "facilitator_paused"
  });
}

/**
 * Handler: teacher_resume
 */
async function handleTeacherResume(ws, msg, ctx) {
  const session = ctx.sessionManager.get(ctx.currentSessionShortCode);
  if (!session) return;
  session.paused = false;
  console.log(`[${ctx.currentSessionShortCode}] Teacher RESUMED Plato`);
  ctx.sessionManager.broadcast(ctx.currentSessionShortCode, {
    type: "facilitator_resumed"
  });
}

/**
 * Handler: teacher_force_speak
 */
async function handleTeacherForceSpeak(ws, msg, ctx) {
  const session = ctx.sessionManager.get(ctx.currentSessionShortCode);
  if (!session || !session.active) return;
  console.log(`[${ctx.currentSessionShortCode}] Teacher FORCED Plato to speak`);
  const decision = await ctx.deps.enhancedEngine.decide(session.stateTracker);
  if (decision.message) {
    await ctx.sessionManager.handleFacilitatorMessage(ctx.currentSessionShortCode, decision);
  } else {
    // Force a generic deepen move
    const fallback = await ctx.deps.enhancedEngine.decide(session.stateTracker);
    if (fallback.message) {
      await ctx.sessionManager.handleFacilitatorMessage(ctx.currentSessionShortCode, fallback);
    }
  }
}

/**
 * Handler: teacher_set_goal
 */
async function handleTeacherSetGoal(ws, msg, ctx) {
  const session = ctx.sessionManager.get(ctx.currentSessionShortCode);
  if (!session) return;
  const { goal } = msg;
  if (goal) {
    session.teacherGoal = goal;
    console.log(`[${ctx.currentSessionShortCode}] Teacher set goal: "${goal}"`);
  }
}

/**
 * Handler: teacher_adjust_params
 */
async function handleTeacherAdjustParams(ws, msg, ctx) {
  const session = ctx.sessionManager.get(ctx.currentSessionShortCode);
  if (!session) return;
  // Apply overrides to the session's stateTracker params
  const overrides = msg.params || {};
  if (!session.paramOverrides) session.paramOverrides = {};
  Object.assign(session.paramOverrides, overrides);
  console.log(`[${ctx.currentSessionShortCode}] Teacher adjusted params:`, overrides);
  ctx.sessionManager.broadcast(ctx.currentSessionShortCode, {
    type: "teacher_params_updated",
    params: session.paramOverrides
  });
}

/**
 * Handler: join_session
 */
async function handleJoinSession(ws, msg, ctx) {
  const { sessionId, name, age, authToken } = msg;
  let requestedCode = sessionId;
  console.log(`[join_session] Looking up session: ${requestedCode}`);
  let authUser = null;
  if (authToken) {
    try {
      const auth = await authenticateToken(authToken, { touch: false });
      authUser = auth?.user || null;
    } catch (error) {
      console.warn("[join_session] Invalid auth token:", error.message);
    }
  }
  let session = ctx.sessionManager.get(requestedCode);

  // If not in memory, try loading from DB (supports REST-created sessions)
  if (!session) {
    console.log(`[join_session] Not in memory, loading from DB...`);
    try {
      let dbSession = await ctx.deps.sessionsRepo.findByShortCode(requestedCode);
      if (!dbSession) {
        const classesRepo = require("../db/repositories/classes");
        const cls = await classesRepo.findByRoomCode(requestedCode);
        if (cls) {
          const liveSession = await ctx.deps.sessionsRepo.findLatestLiveByClassId(cls.id);
          if (!liveSession) {
            ws.send(JSON.stringify({
              type: "room_not_live",
              roomCode: cls.room_code,
              classId: cls.id,
              className: cls.name,
              classDescription: cls.description || null
            }));
            return;
          }
          requestedCode = liveSession.short_code;
          dbSession = await ctx.deps.sessionsRepo.findByShortCode(requestedCode);
        }
      }

      console.log(`[join_session] DB lookup result:`, dbSession ? `found (id=${dbSession.id})` : 'not found');
      if (dbSession) {
        // If session has ended, send the transcript as read-only instead of live join
        if (dbSession.status === 'ended') {
          console.log(`[join_session] Session ${requestedCode} has ended — sending read-only transcript`);
          const messagesRepo = require("../db/repositories/messages");
          const msgs = await messagesRepo.getBySession(dbSession.id, { limit: 500 });
          ws.send(JSON.stringify({
            type: "session_ended_readonly",
            sessionId: requestedCode,
            title: dbSession.title,
            messages: msgs.map(m => ({
              senderType: m.sender_type,
              senderName: m.sender_name || m.participant_name,
              content: m.content,
              moveType: m.move_type,
              targetName: m.target_participant_name,
              createdAt: m.created_at
            }))
          }));
          return;
        }

        const SessionStateTracker = require("../stateTracker").SessionStateTracker;
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
        ctx.sessionManager.set(requestedCode, session);
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
  let joinedParticipantId = ctx.clientId;
  let isFreshParticipant = false;
  if (existingByName) {
    // Reuse the existing participant identity instead of creating a duplicate
    console.log(`[join_session] Duplicate name "${name}" — reusing existing participant ${existingByName.id}`);
    ctx.clientId = existingByName.id;
    joinedParticipantId = existingByName.id;
    // Remove stale client entry if any
    session.clients = session.clients.filter(c => c.clientId !== ctx.clientId);
  } else {
    console.log(`[join_session] Adding participant: ${name}`);
    const sessionRole = authUser?.role === 'Teacher' || authUser?.role === 'Admin' || authUser?.role === 'SuperAdmin'
      ? 'teacher'
      : 'participant';
    await session.stateTracker.addParticipant(ctx.clientId, name, age || 12, {
      userId: authUser?.id || null,
      accountRole: authUser?.role || null,
      sessionRole
    });
    joinedParticipantId = ctx.clientId;
    isFreshParticipant = true;
  }

  ctx.currentSessionShortCode = requestedCode;
  // Cancel cleanup grace period if someone joins
  if (session._cleanupTimer) {
    clearTimeout(session._cleanupTimer);
    session._cleanupTimer = null;
  }
  session.clients.push({
    ws,
    clientId: ctx.clientId,
    name,
    userId: authUser?.id || null,
    role: authUser?.role || null,
    clientKind: "session"
  });
  console.log(`[join_session] Sending session_joined response`);

  if (isFreshParticipant) {
    ctx.sessionManager.broadcast(requestedCode, {
      type: "participant_joined",
      name,
      participantId: joinedParticipantId,
      participantCount: session.stateTracker.participants.size
    });
  }

  // Note: STT is handled by the Jitsi bot (Deepgram) in video mode.
  // Text messages from the WebSocket "message" handler still work for
  // any typed chat input if needed.

  const participants = Array.from(session.stateTracker.participants.values())
    .map(p => ({ name: p.name, id: p.id, role: p.accountRole }));

  // Mint a session-scoped participant token so anonymous joiners can hit
  // session-scoped HTTP endpoints (e.g. /source-text) without a user account.
  let participantToken = null;
  try {
    participantToken = issueParticipantToken({
      sessionShortCode: requestedCode,
      sessionId: session.dbSession?.id || null,
      participantId: joinedParticipantId,
      name
    });
  } catch (err) {
    console.warn("[join_session] Failed to mint participant token:", err.message);
  }

  ws.send(JSON.stringify({
    type: "session_joined",
    sessionId: requestedCode,
    topicTitle: session.topic.title,
    passage: session.topic.passage,
    currentParams: session.paramOverrides || {},
    participants,
    yourId: ctx.clientId,
    yourRole: authUser?.role || null,
    participantToken
  }));
}

/**
 * Handler: rejoin_session
 */
async function handleRejoinSession(ws, msg, ctx) {
  const { sessionId, oldClientId } = msg;
  let session = ctx.sessionManager.get(sessionId);

  // If session not in memory, try reconstructing from database
  if (!session) {
    console.log(`[rejoin_session] Session not in memory, attempting to reconstruct from DB...`);
    try {
      const dbSession = await ctx.deps.sessionsRepo.findByShortCode(sessionId);
      if (!dbSession) {
        ws.send(JSON.stringify({ type: "error", text: "Session not found" }));
        return;
      }

      console.log(`[rejoin_session] Found session in DB, reconstructing state...`);

      // Create new state tracker and load full history
      const SessionStateTracker = require("../stateTracker").SessionStateTracker;
      const stateTracker = new SessionStateTracker(dbSession.id, dbSession);
      await stateTracker.loadFullHistory();

      // Check if participant exists in reconstructed session
      const participant = stateTracker.participants.get(oldClientId);
      if (!participant) {
        ws.send(JSON.stringify({ type: "error", text: "Participant not found in session" }));
        return;
      }

      // Build topic object from DB session
      const topic = {
        id: "custom",
        title: dbSession.title,
        passage: "",
        openingQuestion: dbSession.opening_question || "",
        followUpAngles: []
      };

      // Create session object in memory
      const isReadOnly = dbSession.status === 'ended';
      session = {
        dbSession,
        stateTracker,
        clients: [],
        active: dbSession.status === 'active',
        paused: false,
        topic,
        readOnly: isReadOnly
      };
      ctx.sessionManager.set(sessionId, session);

      console.log(`[rejoin_session] Session reconstructed successfully (readOnly=${isReadOnly})`);

      // Send session_restored message with full history
      const messages = stateTracker.messages.map(m => ({
        type: m.participantId === '__facilitator__' ? 'facilitator_message' : 'participant_message',
        text: m.text,
        participantId: m.participantId,
        participantName: m.participantName,
        move: m.move || null,
        targetParticipantId: m.targetParticipantId || null,
        timestamp: m.timestamp
      }));

      let participantToken = null;
      try {
        participantToken = issueParticipantToken({
          sessionShortCode: sessionId,
          sessionId: dbSession.id,
          participantId: oldClientId,
          name: participant?.name || null
        });
      } catch (err) {
        console.warn("[rejoin_session] Failed to mint participant token:", err.message);
      }

      ws.send(JSON.stringify({
        type: "session_restored",
        readOnly: isReadOnly,
        sessionStatus: dbSession.status,
        messages,
        sessionId,
        topicTitle: topic.title,
        passage: topic.passage,
        yourId: oldClientId,
        participantToken
      }));

      // Add client to session
      ctx.clientId = oldClientId;
      ctx.currentSessionShortCode = sessionId;
      session.clients.push({ ws, clientId: ctx.clientId, name: participant.name, clientKind: "session" });

      return;
    } catch (err) {
      console.error(`[rejoin_session] Error reconstructing session:`, err);
      ws.send(JSON.stringify({ type: "error", text: "Failed to restore session" }));
      return;
    }
  }

  // Session is in memory - use existing rejoin logic
  const participant = session.stateTracker.participants.get(oldClientId);
  if (!participant) {
    ws.send(JSON.stringify({ type: "error", text: "Participant not found in session" }));
    return;
  }

  ctx.clientId = oldClientId;
  ctx.currentSessionShortCode = sessionId;

  // Cancel cleanup grace period if we're reconnecting
  if (session._cleanupTimer) {
    clearTimeout(session._cleanupTimer);
    session._cleanupTimer = null;
    console.log(`[${sessionId}] Reconnect cancelled cleanup timer`);
  }

  session.clients = session.clients.filter(c => c.clientId !== ctx.clientId);
  session.clients.push({ ws, clientId: ctx.clientId, name: participant.name, clientKind: "session" });

  const participants = Array.from(session.stateTracker.participants.values())
    .map(p => ({ name: p.name, id: p.id }));

  let participantToken = null;
  try {
    participantToken = issueParticipantToken({
      sessionShortCode: sessionId,
      sessionId: session.dbSession?.id || null,
      participantId: ctx.clientId,
      name: participant?.name || null
    });
  } catch (err) {
    console.warn("[rejoin_session] Failed to mint participant token:", err.message);
  }

  ws.send(JSON.stringify({
    type: "session_joined",
    sessionId,
    topicTitle: session.topic.title,
    passage: session.topic.passage,
    participants,
    yourId: ctx.clientId,
    participantToken
  }));

  if (session.active) {
    ws.send(JSON.stringify({ type: "discussion_started" }));
  } else if (session.inVideoRoom) {
    ws.send(JSON.stringify({ type: "enter_video" }));
  }
}

/**
 * Handler: enter_video
 */
async function handleEnterVideo(ws, msg, ctx) {
  // Move everyone into the video room in warmup mode (session.active stays false)
  const session = ctx.sessionManager.get(ctx.currentSessionShortCode);
  if (!session) return;

  session.inVideoRoom = true;

  ctx.sessionManager.broadcast(ctx.currentSessionShortCode, {
    type: "enter_video"
  });
}

/**
 * Handler: start_discussion
 */
async function handleStartDiscussion(ws, msg, ctx) {
  const session = ctx.sessionManager.get(ctx.currentSessionShortCode);
  if (!session) return;
  if (session.active) return; // guard against double-click

  const { getAgeCalibration } = require("../config");

  session.active = true;
  await ctx.deps.sessionsRepo.updateStatus(session.dbSession.id, 'active');

  // Clear warmup chat history — Plato is now in facilitator mode
  ctx.deps.enhancedEngine.clearWarmupHistory(ctx.currentSessionShortCode);

  const names = Array.from(session.stateTracker.participants.values()).map(p => p.name);
  const ages = Array.from(session.stateTracker.participants.values()).map(p => p.age);
  const ageCalibration = getAgeCalibration(ages);

  // Launch Jitsi bot (handles STT via Deepgram, TTS, and voice facilitation)
  if (ctx.deps.jitsiLauncher) {
    console.log(`[${ctx.currentSessionShortCode}] Starting Jitsi bot...`);
    session.jitsiBot = ctx.deps.jitsiLauncher.startJitsiBot(ctx.currentSessionShortCode, {
      roomName: `socratic-${ctx.currentSessionShortCode}`,
      topic: session.topic?.title,
      defaultAge: ages[0] || 12
    });
  }

  const opening = await ctx.deps.enhancedEngine.generateOpening(
    session.topic, names, ageCalibration, session.dbSession?.id
  );

  await session.stateTracker.recordAIMessage(opening, "opening");

  ctx.sessionManager.broadcast(ctx.currentSessionShortCode, {
    type: "discussion_started",
    mode: "video"
  });

  ctx.sessionManager.broadcast(ctx.currentSessionShortCode, {
    type: "facilitator_message",
    text: opening,
    move: "opening",
    timestamp: Date.now()
  });

  // Start silence checker as a safety net
  ctx.sessionManager.startSilenceChecker(ctx.currentSessionShortCode);
}

/**
 * Handler: message
 */
async function handleMessage(ws, msg, ctx) {
  await ctx.sessionManager.handleParticipantMessage(
    ctx.currentSessionShortCode,
    ctx.clientId,
    msg.text,
    { source: msg.source || "text" }
  );
}

/**
 * Handler: stt_start
 */
async function handleSttStart(ws, msg, ctx) {
  const dgKey = process.env.DEEPGRAM_API_KEY;
  if (!dgKey) {
    ws.send(JSON.stringify({ type: "stt_error", text: "DEEPGRAM_API_KEY not configured" }));
    return;
  }
  // Close existing connection if any
  if (ctx.deepgramWs) {
    try { ctx.deepgramWs.close(); } catch (e) {}
  }
  // endpointing: ms of silence before finalizing utterance (lower = faster response)
  // vad_events: enables SpeechStarted/SpeechStopped events for better timing
  const dgUrl = `wss://api.deepgram.com/v1/listen?` +
    `encoding=linear16&sample_rate=16000&channels=1` +
    `&interim_results=true&punctuate=true&language=en-US` +
    `&endpointing=300&vad_events=true`;
  ctx.deepgramWs = new WebSocket(dgUrl, {
    headers: { Authorization: `Token ${dgKey}` }
  });
  ctx.deepgramWs.on("open", () => {
    console.log(`[STT:Deepgram] Connected for client ${ctx.clientId}`);
  });
  ctx.deepgramWs.on("message", (data) => {
    try {
      const result = JSON.parse(data.toString());
      if (result.type === "Results" && result.channel) {
        const alt = result.channel.alternatives;
        if (alt && alt.length > 0 && alt[0].transcript) {
          const transcript = alt[0].transcript;
          const isFinal = result.is_final;
          if (transcript.trim()) {
            ctx.sessionManager.markWarmupSpeechActivity(ctx.currentSessionShortCode, ctx.clientId);
            ws.send(JSON.stringify({
              type: "stt_transcript",
              text: transcript,
              isFinal
            }));

            // Check confidence for interim transcripts
            if (!isFinal && ctx.confidenceChecker) {
              ctx.confidenceChecker.assessConfidence(transcript).then(result => {
                if (result.isReady) {
                  console.log(`[STT] Predictive flush: "${transcript}" (${result.confidence.toFixed(2)})`);
                  // Send flush signal to client
                  ws.send(JSON.stringify({
                    type: "stt_flush_now",
                    confidence: result.confidence,
                    reasoning: result.reasoning
                  }));
                }
              }).catch(err => {
                console.warn('[STT] Confidence check failed:', err.message);
              });
            }
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
  ctx.deepgramWs.on("error", (err) => {
    console.error(`[STT:Deepgram] Error for ${ctx.clientId}:`, err.message);
    ws.send(JSON.stringify({ type: "stt_error", text: err.message }));
  });
  ctx.deepgramWs.on("close", () => {
    console.log(`[STT:Deepgram] Closed for ${ctx.clientId}`);
    ctx.deepgramWs = null;
  });
}

/**
 * Handler: stt_stop
 */
async function handleSttStop(ws, msg, ctx) {
  if (ctx.deepgramWs) {
    try {
      ctx.deepgramWs.send(JSON.stringify({ type: "CloseStream" }));
      ctx.deepgramWs.close();
    } catch (e) {}
    ctx.deepgramWs = null;
  }
}

/**
 * Handler: end_discussion
 */
async function handleEndDiscussion(ws, msg, ctx) {
  const session = ctx.sessionManager.get(ctx.currentSessionShortCode);
  if (!session) return;

  session.active = false;
  await ctx.deps.sessionsRepo.updateStatus(session.dbSession.id, 'ended');

  const checker = ctx.sessionManager.silenceCheckers.get(ctx.currentSessionShortCode);
  if (checker) {
    clearInterval(checker);
    ctx.sessionManager.silenceCheckers.delete(ctx.currentSessionShortCode);
  }

  // Stop Jitsi bot if running
  if (session.jitsiBot && ctx.deps.jitsiLauncher) {
    console.log(`[${ctx.currentSessionShortCode}] Stopping Jitsi bot...`);
    ctx.deps.jitsiLauncher.stopJitsiBot(session.jitsiBot);
    session.jitsiBot = null;
  }

  // Clean up facilitation engine session state
  ctx.deps.enhancedEngine.cleanupSession(session.stateTracker?.sessionId);

  const closing = await ctx.deps.enhancedEngine.generateClosing(session.stateTracker);
  await session.stateTracker.recordAIMessage(closing, "synthesize");

  ctx.sessionManager.broadcast(ctx.currentSessionShortCode, {
    type: "facilitator_message",
    text: closing,
    move: "synthesize",
    timestamp: Date.now()
  });

  ctx.sessionManager.broadcast(ctx.currentSessionShortCode, {
    type: "discussion_ended"
  });

  console.log(`[${ctx.currentSessionShortCode}] Discussion ended.`);

  const sessionDbId = session.dbSession.id;
  const shortCode = ctx.currentSessionShortCode;
  const reportBuilder = ctx.deps.reportBuilder;
  if (reportBuilder?.assembleAndPersistReport) {
    setImmediate(() => {
      reportBuilder
        .assembleAndPersistReport({ sessionId: sessionDbId, apiKey: process.env.ANTHROPIC_API_KEY })
        .then(() => {
          ctx.sessionManager.broadcast(shortCode, { type: 'report_ready', shortCode });
          console.log(`[${shortCode}] Post-session report generated.`);
        })
        .catch((err) => {
          console.error(`[${shortCode}] Report generation failed:`, err.message);
        });
    });
  }
}

// Export handlers map
const HANDLERS = {
  create_session: handleCreateSession,
  join_dashboard: handleJoinDashboard,
  teacher_pause: handleTeacherPause,
  teacher_resume: handleTeacherResume,
  teacher_force_speak: handleTeacherForceSpeak,
  teacher_set_goal: handleTeacherSetGoal,
  teacher_adjust_params: handleTeacherAdjustParams,
  join_session: handleJoinSession,
  rejoin_session: handleRejoinSession,
  enter_video: handleEnterVideo,
  start_discussion: handleStartDiscussion,
  message: handleMessage,
  stt_start: handleSttStart,
  stt_stop: handleSttStop,
  end_discussion: handleEndDiscussion,
};

module.exports = { HANDLERS };
