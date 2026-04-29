jest.mock("../server/db/repositories/sessionMemberships", () => ({
  recordMessage: jest.fn()
}));

jest.mock("../server/db/repositories/messageAnalytics", () => ({
  save: jest.fn()
}));

const { EnhancedFacilitationEngine } = require("../server/enhancedFacilitator");
const SessionManager = require("../server/sessions");
const { MockWebSocket } = require("./helpers/mock-ws");

describe("active solo discussion response cadence", () => {
  test("solo facilitator decisions are marked forced so the opening does not suppress the first reply", async () => {
    const engine = new EnhancedFacilitationEngine("test-key");
    engine._generateMessage = jest.fn(async () => ({
      text: "What makes that feel more cyclical than depressing?",
      move: "deepen",
      targetParticipantName: null
    }));

    const result = await engine.processMessage({
      sessionId: "session-1",
      participants: new Map([
        ["teacher-1", { id: "teacher-1", name: "Demo Teacher", age: 25 }]
      ]),
      topic: { title: "Ozymandias", openingQuestion: "What strikes you?" },
      getTurnsIncludingCurrent: () => [
        {
          participantId: "teacher-1",
          participantName: "Demo Teacher",
          text: "It does not seem depressing to me. It feels cyclical."
        }
      ]
    }, {
      participantName: "Demo Teacher",
      text: "It does not seem depressing to me. It feels cyclical.",
      timestamp: Date.now()
    });

    expect(result.shouldSpeak).toBe(true);
    expect(result.forced).toBe(true);
    expect(result.forcedBySoloCadence).toBe(true);
  });

  test("active solo forced replies bypass group hard constraints", async () => {
    const ws = new MockWebSocket();
    const stateTracker = {
      participants: new Map([
        ["teacher-1", { id: "teacher-1", name: "Demo Teacher", age: 25, dbId: "participant-db-1" }]
      ]),
      messages: [],
      recordMessage: jest.fn(async (_clientId, text) => ({
        dbId: "message-db-1",
        dbParticipantId: "participant-db-1",
        text
      })),
      recordAIMessage: jest.fn(async () => {}),
      getHardConstraints: jest.fn(async () => ({
        canSpeak: false,
        reasons: ["Too soon since last intervention", "AI talk ratio exceeded maximum"]
      }))
    };

    const manager = new SessionManager({
      useEnhancedSystem: true,
      messageAssessor: { assess: jest.fn(async () => null) },
      enhancedEngine: {
        processMessage: jest.fn(async () => ({
          shouldSpeak: true,
          message: "What makes it feel cyclical rather than sad?",
          move: "deepen",
          forced: true,
          forcedBySoloCadence: true
        }))
      },
      sessionsRepo: {}
    });

    manager.set("room1", {
      active: true,
      stateTracker,
      clients: [{ ws, clientId: "teacher-1", sessionRole: "teacher", clientKind: "session" }],
      dbSession: { id: "session-db-1" },
      topic: { title: "Ozymandias", openingQuestion: "What strikes you?" }
    });

    await manager.handleParticipantMessage(
      "room1",
      "teacher-1",
      "It does not seem depressing to me. It feels cyclical.",
      { source: "text" }
    );

    expect(stateTracker.getHardConstraints).toHaveBeenCalled();
    expect(stateTracker.recordAIMessage).toHaveBeenCalledWith(
      "What makes it feel cyclical rather than sad?",
      "deepen",
      null
    );
    expect(ws.findSent("facilitator_message")).toEqual(expect.objectContaining({
      text: "What makes it feel cyclical rather than sad?",
      move: "deepen"
    }));
  });
});
