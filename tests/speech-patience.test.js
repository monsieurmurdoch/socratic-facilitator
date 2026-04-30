jest.mock("../server/db/repositories/sessionMemberships", () => ({
  recordMessage: jest.fn(),
  recordJoin: jest.fn(),
  recordLeave: jest.fn()
}));

jest.mock("../server/db/repositories/messageAnalytics", () => ({
  save: jest.fn()
}));

const SessionManager = require("../server/sessions");
const { getSpeechPatiencePreset, normalizeSpeechPatienceMode } = require("../server/speech-patience");
const { MockWebSocket } = require("./helpers/mock-ws");
const sessionMembershipsRepo = require("../server/db/repositories/sessionMemberships");
const messageAnalyticsRepo = require("../server/db/repositories/messageAnalytics");

describe("speech patience presets", () => {
  test("normalizes invalid values back to balanced", () => {
    expect(normalizeSpeechPatienceMode("")).toBe("balanced");
    expect(normalizeSpeechPatienceMode("unknown")).toBe("balanced");
  });

  test("returns quick, balanced, and patient presets", () => {
    expect(getSpeechPatiencePreset("quick").warmupMergeMs).toBeLessThan(getSpeechPatiencePreset("balanced").warmupMergeMs);
    expect(getSpeechPatiencePreset("patient").warmupSettleMs).toBeGreaterThan(getSpeechPatiencePreset("balanced").warmupSettleMs);
  });
});

describe("SessionManager speech patience", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("uses patient mode for warmup timing when teacher overrides it", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse("2026-04-14T19:00:00Z"));

    const mockWs = new MockWebSocket();
    const deps = {
      enhancedEngine: {
        warmupChat: jest.fn().mockResolvedValue("Tell me more about that."),
        cleanupSession: jest.fn()
      }
    };
    const manager = new SessionManager(deps);

    const participant = { name: "Rob", age: 16 };
    const session = {
      active: false,
      clients: [{ ws: mockWs, clientId: "p1" }],
      paramOverrides: { speechPatienceMode: "patient" },
      stateTracker: {
        participants: new Map([["p1", participant]]),
        messages: [],
        sessionId: "room1-db",
        recordMessage: jest.fn().mockResolvedValue({
          dbId: "msg-1",
          dbParticipantId: "p1",
          text: "I think Achilles is angry"
        }),
        topic: { title: "Iliad", openingQuestion: "What does Achilles want?" }
      }
    };

    manager.set("room1", session);
    manager.queueWarmupTurn("room1", "p1", "I think Achilles is angry", "stt");

    await jest.advanceTimersByTimeAsync(1600);
    expect(mockWs.sentMessages.find((m) => m.type === "facilitator_message")).toBeUndefined();

    await jest.advanceTimersByTimeAsync(1000);
    const facilitatorMessage = mockWs.sentMessages.find((m) => m.type === "facilitator_message");
    expect(facilitatorMessage).toBeDefined();
    expect(facilitatorMessage.text).toBe("Tell me more about that.");

    jest.useRealTimers();
  });

  test("flushes pending warmup turns into analytics before ending", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse("2026-04-14T19:00:00Z"));

    const mockWs = new MockWebSocket();
    const deps = {
      messageAssessor: {
        assess: jest.fn().mockResolvedValue({
          engagement: { specificity: 0.8, profoundness: 0.4, coherence: 0.7 },
          anchor: { isAnchor: false },
          referencesAnchors: [],
          briefReasoning: "Warmup contribution with concrete evidence."
        })
      },
      enhancedEngine: {
        warmupChat: jest.fn().mockResolvedValue("Tell me more about that.")
      }
    };
    const manager = new SessionManager(deps);

    const participant = { id: "p1", dbId: "participant-db-1", name: "Rob", age: 16 };
    const session = {
      active: false,
      clients: [{ ws: mockWs, clientId: "p1" }],
      stateTracker: {
        participants: new Map([["p1", participant]]),
        messages: [],
        sessionId: "room1-db",
        recordMessage: jest.fn().mockResolvedValue({
          dbId: "msg-1",
          dbParticipantId: "participant-db-1",
          text: "I think the statue is a warning about pride."
        })
      },
      topic: { title: "Ozymandias", openingQuestion: "What remains?" }
    };

    manager.set("room1", session);
    manager.queueWarmupTurn("room1", "p1", "I think the statue is a warning about pride.", "stt");

    await manager.flushPendingWarmupTurns("room1", { respond: false });

    expect(session.stateTracker.recordMessage).toHaveBeenCalledWith(
      "p1",
      "I think the statue is a warning about pride."
    );
    expect(sessionMembershipsRepo.recordMessage).toHaveBeenCalledWith(
      "participant-db-1",
      expect.objectContaining({
        wordCount: 9,
        estimatedSpeakingSeconds: 4,
        contributionScore: 0.63,
        engagementScore: 0.63
      })
    );
    expect(messageAnalyticsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "room1-db",
      messageId: "msg-1",
      participantId: "participant-db-1",
      specificity: 0.8,
      profoundness: 0.4,
      coherence: 0.7,
      discussionValue: 0.62
    }));
    expect(deps.enhancedEngine.warmupChat).not.toHaveBeenCalled();
    expect(mockWs.findSent("participant_message")).toBeDefined();
    expect(mockWs.findSent("facilitator_message")).toBeNull();

    await jest.advanceTimersByTimeAsync(2000);
    expect(session.stateTracker.recordMessage).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });

  test("batches active STT fragments into one persisted participant turn", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse("2026-04-14T19:00:00Z"));

    const mockWs = new MockWebSocket();
    const deps = {
      useEnhancedSystem: true,
      messageAssessor: {
        assess: jest.fn().mockResolvedValue({
          engagement: { specificity: 0.7, profoundness: 0.5, coherence: 0.8 },
          anchor: { isAnchor: false },
          referencesAnchors: [],
          briefReasoning: "Participant develops a connected thought."
        })
      },
      enhancedEngine: {
        processMessage: jest.fn().mockResolvedValue({
          shouldSpeak: true,
          message: "What makes that cycle feel surprising?",
          move: "probe",
          forced: true
        })
      }
    };
    const manager = new SessionManager(deps);

    const participant = { id: "p1", dbId: "participant-db-1", name: "Demo Teacher", age: 25 };
    const session = {
      active: true,
      clients: [{ ws: mockWs, clientId: "p1" }],
      paramOverrides: { speechPatienceMode: "balanced" },
      stateTracker: {
        participants: new Map([["p1", participant]]),
        messages: [],
        sessionId: "room1-db",
        recordMessage: jest.fn(async (_clientId, text) => {
          const recorded = { dbId: "msg-1", dbParticipantId: "participant-db-1", text };
          session.stateTracker.messages.push({ participantId: "p1", participantName: "Demo Teacher", text });
          return recorded;
        }),
        recordAIMessage: jest.fn(async (text, move) => {
          session.stateTracker.messages.push({ participantId: "__facilitator__", participantName: "Facilitator", text, move });
        }),
        getHardConstraints: jest.fn(async () => ({ canSpeak: true, reasons: [] }))
      },
      topic: { title: "Ozymandias", openingQuestion: "What remains?" }
    };

    manager.set("room1", session);

    await manager.handleParticipantMessage("room1", "p1", "It doesn't seem depressing to me.", { source: "stt" });
    await manager.handleParticipantMessage("room1", "p1", "I mean, there's something cyclical about civilization.", { source: "stt" });

    await jest.advanceTimersByTimeAsync(1000);
    expect(session.stateTracker.recordMessage).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(200);

    const expectedText = "It doesn't seem depressing to me. I mean, there's something cyclical about civilization.";
    expect(session.stateTracker.recordMessage).toHaveBeenCalledTimes(1);
    expect(session.stateTracker.recordMessage).toHaveBeenCalledWith("p1", expectedText);
    expect(mockWs.findSent("participant_message")).toEqual(expect.objectContaining({
      name: "Demo Teacher",
      senderId: "p1",
      text: expectedText
    }));
    expect(mockWs.findSent("facilitator_message")).toEqual(expect.objectContaining({
      text: "What makes that cycle feel surprising?",
      move: "probe"
    }));

    jest.useRealTimers();
  });

  test("flushes pending active STT without triggering a new AI response", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(Date.parse("2026-04-14T19:00:00Z"));

    const mockWs = new MockWebSocket();
    const deps = {
      useEnhancedSystem: true,
      messageAssessor: {
        assess: jest.fn().mockResolvedValue({
          engagement: { specificity: 0.6, profoundness: 0.4, coherence: 0.7 },
          anchor: { isAnchor: false },
          referencesAnchors: [],
          briefReasoning: "Final participant turn before ending."
        })
      },
      enhancedEngine: {
        processMessage: jest.fn()
      }
    };
    const manager = new SessionManager(deps);

    const participant = { id: "p1", dbId: "participant-db-1", name: "Demo Teacher", age: 25 };
    const session = {
      active: true,
      clients: [{ ws: mockWs, clientId: "p1" }],
      stateTracker: {
        participants: new Map([["p1", participant]]),
        messages: [],
        sessionId: "room1-db",
        recordMessage: jest.fn(async (_clientId, text) => ({ dbId: "msg-2", dbParticipantId: "participant-db-1", text })),
        getHardConstraints: jest.fn(async () => ({ canSpeak: true, reasons: [] }))
      },
      topic: { title: "Ozymandias", openingQuestion: "What remains?" }
    };

    manager.set("room1", session);

    await manager.handleParticipantMessage("room1", "p1", "but I think it inspires", { source: "stt" });
    await manager.handleParticipantMessage("room1", "p1", "a surprising feeling.", { source: "stt" });

    await manager.flushPendingActiveTurns("room1", { respond: false });

    expect(session.stateTracker.recordMessage).toHaveBeenCalledTimes(1);
    expect(session.stateTracker.recordMessage).toHaveBeenCalledWith(
      "p1",
      "but I think it inspires a surprising feeling."
    );
    expect(deps.enhancedEngine.processMessage).not.toHaveBeenCalled();
    expect(mockWs.findSent("participant_message")).toBeDefined();
    expect(mockWs.findSent("facilitator_message")).toBeNull();

    await jest.advanceTimersByTimeAsync(2000);
    expect(session.stateTracker.recordMessage).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});
