const SessionManager = require("../server/sessions");
const { getSpeechPatiencePreset, normalizeSpeechPatienceMode } = require("../server/speech-patience");
const { MockWebSocket } = require("./helpers/mock-ws");

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
});
