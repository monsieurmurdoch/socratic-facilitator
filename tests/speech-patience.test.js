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
});
