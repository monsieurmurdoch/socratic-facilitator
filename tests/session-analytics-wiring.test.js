jest.mock("../server/db/repositories/messages", () => ({
  addParticipantMessage: jest.fn().mockResolvedValue({ id: "msg-db-1" }),
  addFacilitatorMessage: jest.fn(),
  getFacilitatorStats: jest.fn().mockResolvedValue({ total: 0, facilitator_count: 0 })
}));

jest.mock("../server/db/repositories/participants", () => ({
  add: jest.fn().mockResolvedValue({ id: "participant-db-1" }),
  getBySession: jest.fn().mockResolvedValue([]),
  getStats: jest.fn().mockResolvedValue([]),
  markLeft: jest.fn()
}));

jest.mock("../server/db/repositories/conversationState", () => ({
  save: jest.fn()
}));

jest.mock("../server/db/repositories/sessionMemberships", () => ({
  recordJoin: jest.fn().mockResolvedValue({ id: "membership-1" }),
  recordLeave: jest.fn(),
  recordMessage: jest.fn()
}));

jest.mock("../server/db/repositories/messageAnalytics", () => ({
  save: jest.fn()
}));

const { SessionStateTracker } = require("../server/stateTracker");
const SessionManager = require("../server/sessions");
const messagesRepo = require("../server/db/repositories/messages");
const sessionMembershipsRepo = require("../server/db/repositories/sessionMemberships");
const messageAnalyticsRepo = require("../server/db/repositories/messageAnalytics");

describe("session analytics wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    messagesRepo.addParticipantMessage.mockResolvedValue({ id: "msg-db-1" });
    sessionMembershipsRepo.recordJoin.mockResolvedValue({ id: "membership-1" });
  });

  test("participant joins create membership rows used by analytics", async () => {
    const tracker = new SessionStateTracker("session-db-1", { title: "Test" });

    const participant = await tracker.addParticipant("client-1", "Chris", 15, {
      userId: "user-1",
      accountRole: "Student",
      sessionRole: "participant"
    });

    expect(participant.dbId).toBe("participant-db-1");
    expect(sessionMembershipsRepo.recordJoin).toHaveBeenCalledWith({
      sessionId: "session-db-1",
      participantId: "participant-db-1",
      userId: "user-1",
      name: "Chris",
      roleSnapshot: "participant"
    });
  });

  test("recorded participant messages expose DB ids for analytics rows", async () => {
    const tracker = new SessionStateTracker("session-db-1", { title: "Test" });
    await tracker.addParticipant("client-1", "Chris", 15);

    const message = await tracker.recordMessage("client-1", "I think Achilles wants honor because he feels insulted.");

    expect(messagesRepo.addParticipantMessage).toHaveBeenCalledWith(
      "session-db-1",
      "participant-db-1",
      "I think Achilles wants honor because he feels insulted."
    );
    expect(message.dbId).toBe("msg-db-1");
    expect(message.dbParticipantId).toBe("participant-db-1");
  });

  test("session manager persists membership metrics and message analytics", async () => {
    const manager = new SessionManager({ enhancedEngine: {} });
    const session = {
      stateTracker: { sessionId: "session-db-1" }
    };
    const participant = { id: "client-1", dbId: "participant-db-1" };
    const recordedMessage = {
      dbId: "msg-db-1",
      dbParticipantId: "participant-db-1",
      text: "I disagree because the example points to a different kind of courage."
    };
    const assessment = {
      engagement: { specificity: 0.7, profoundness: 0.6, coherence: 0.8 },
      anchor: { isAnchor: true },
      referencesAnchors: [1],
      briefReasoning: "Builds on a prior anchor with a concrete disagreement."
    };

    await manager.persistParticipantAnalytics(session, participant, recordedMessage, assessment);

    expect(sessionMembershipsRepo.recordMessage).toHaveBeenCalledWith(
      "participant-db-1",
      expect.objectContaining({
        wordCount: 12,
        estimatedSpeakingSeconds: 5,
        contributionScore: 0.7,
        engagementScore: 0.72
      })
    );
    expect(messageAnalyticsRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-db-1",
      messageId: "msg-db-1",
      participantId: "participant-db-1",
      specificity: 0.7,
      profoundness: 0.6,
      coherence: 0.8,
      discussionValue: 0.69,
      referencedAnchor: true,
      isAnchor: true
    }));
  });
});
