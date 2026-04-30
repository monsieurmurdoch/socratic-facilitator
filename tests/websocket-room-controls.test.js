const { HANDLERS } = require("../server/websocket/handlers");
const { MockWebSocket } = require("./helpers/mock-ws");

function createSession(overrides = {}) {
  const stateTracker = {
    participants: new Map(),
    addParticipant: jest.fn(async (id, name, age, opts = {}) => {
      stateTracker.participants.set(id, { id, name, age, ...opts });
      return stateTracker.participants.get(id);
    }),
    getStateSnapshot: jest.fn(async () => ({})),
    getRecentTurns: jest.fn(() => "")
  };
  return {
    dbSession: { id: "session-db-1", short_code: "room1", owner_user_id: null, class_id: null, status: "waiting" },
    stateTracker,
    clients: [],
    active: false,
    topic: { title: "Test", passage: "", openingQuestion: "Why?" },
    disconnectTimers: new Map(),
    ...overrides
  };
}

function createContext(session, clientId = "client-1") {
  const sessions = new Map([["room1", session]]);
  const sessionManager = {
    get: jest.fn((code) => sessions.get(code)),
    silenceCheckers: new Map(),
    broadcast: jest.fn((code, msg) => {
      const target = sessions.get(code);
      for (const client of target?.clients || []) {
        client.ws.send(JSON.stringify(msg));
      }
    })
  };
  return {
    clientId,
    currentSessionShortCode: "room1",
    deps: { sessionsRepo: {}, enhancedEngine: {} },
    sessionManager
  };
}

describe("WebSocket room controls", () => {
  test("late joiners are sent into an already active discussion", async () => {
    const session = createSession({ active: true });
    const ws = new MockWebSocket();
    const ctx = createContext(session, "late-client");

    await HANDLERS.join_session(ws, {
      type: "join_session",
      sessionId: "room1",
      name: "Chris",
      age: 15
    }, ctx);

    expect(ws.findSent("session_joined")).toBeDefined();
    expect(ws.findSent("discussion_started")).toBeDefined();
    expect(ws.findSent("session_joined").sessionAccessToken).toBeDefined();
  });

  test("duplicate display names create separate participant identities", async () => {
    const session = createSession();
    const firstWs = new MockWebSocket();
    const secondWs = new MockWebSocket();

    await HANDLERS.join_session(firstWs, {
      type: "join_session",
      sessionId: "room1",
      name: "Chris",
      age: 15
    }, createContext(session, "client-a"));

    await HANDLERS.join_session(secondWs, {
      type: "join_session",
      sessionId: "room1",
      name: "Chris",
      age: 15
    }, createContext(session, "client-b"));

    expect(session.stateTracker.participants.size).toBe(2);
    expect(session.stateTracker.participants.get("client-a").name).toBe("Chris");
    expect(session.stateTracker.participants.get("client-b").name).toBe("Chris");
  });

  test("non-teacher clients cannot use teacher-only room controls", async () => {
    const session = createSession({
      hostClientId: "teacher-client",
      clients: [{ ws: new MockWebSocket(), clientId: "student-client", sessionRole: "participant", clientKind: "session" }]
    });
    const ws = new MockWebSocket();
    const ctx = createContext(session, "student-client");

    const teacherOnlyActions = [
      ["teacher_pause", {}],
      ["teacher_resume", {}],
      ["teacher_force_speak", {}],
      ["teacher_set_goal", { goal: "Push for evidence" }],
      ["teacher_adjust_params", { params: { minIntervalMs: 1000 } }],
      ["enter_video", {}],
      ["start_discussion", {}],
      ["end_discussion", {}]
    ];

    for (const [type, payload] of teacherOnlyActions) {
      await HANDLERS[type](ws, { type, ...payload }, ctx);
    }

    expect(ws.sentMessages.filter(msg => msg.type === "error")).toHaveLength(teacherOnlyActions.length);
    expect(session.active).toBe(false);
    expect(session.paused).toBeUndefined();
    expect(session.inVideoRoom).toBeUndefined();
  });

  test("in-memory rejoin restores a disconnected participant during the grace window", async () => {
    const session = createSession({ active: true });
    session.stateTracker.participants.set("client-a", { id: "client-a", name: "Chris", age: 15, sessionRole: "participant" });
    const ws = new MockWebSocket();
    const ctx = createContext(session, "new-ws-client");

    await HANDLERS.rejoin_session(ws, {
      type: "rejoin_session",
      sessionId: "room1",
      oldClientId: "client-a"
    }, ctx);

    expect(ws.findSent("session_joined")).toBeDefined();
    expect(ws.findSent("discussion_started")).toBeDefined();
    expect(session.clients).toHaveLength(1);
    expect(session.clients[0].clientId).toBe("client-a");
  });

  test("ending from warmup flushes pending warmup turns before closing", async () => {
    const teacherWs = new MockWebSocket();
    const session = createSession({
      hostClientId: "teacher-client",
      clients: [{ ws: teacherWs, clientId: "teacher-client", sessionRole: "teacher", clientKind: "session" }]
    });
    session.stateTracker.recordAIMessage = jest.fn();

    const ws = new MockWebSocket();
    const ctx = createContext(session, "teacher-client");
    ctx.sessionManager.flushPendingWarmupTurns = jest.fn(async () => {});
    ctx.sessionManager.flushPendingActiveTurns = jest.fn(async () => {});
    ctx.deps.sessionsRepo.updateStatus = jest.fn(async () => ({ ...session.dbSession, status: "ended" }));
    ctx.deps.enhancedEngine.cleanupSession = jest.fn();
    ctx.deps.enhancedEngine.generateClosing = jest.fn(async () => "Thanks for the discussion.");

    await HANDLERS.end_discussion(ws, { type: "end_discussion" }, ctx);

    expect(ctx.sessionManager.flushPendingWarmupTurns).toHaveBeenCalledWith("room1", { respond: false });
    expect(ctx.sessionManager.flushPendingActiveTurns).toHaveBeenCalledWith("room1", { respond: false });
    expect(ctx.deps.enhancedEngine.generateClosing).toHaveBeenCalledWith(session.stateTracker);
    expect(session.stateTracker.recordAIMessage).toHaveBeenCalledWith("Thanks for the discussion.", "synthesize");
    expect(teacherWs.findSent("discussion_ended")).toBeDefined();
  });
});
