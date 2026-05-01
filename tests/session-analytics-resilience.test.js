describe("session analytics resilience", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test("session analytics still returns transcript stats when score rows are unavailable", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const query = jest.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "participant-1",
          name: "Demo Teacher",
          age: 25,
          role: "teacher",
          message_count: "2",
          total_words: "18",
          speaking_seconds: "7.2",
          contribution_score: "0",
          engagement_score: "0",
          joined_at: "2026-05-01T12:00:00.000Z",
          left_at: null
        }]
      })
      .mockRejectedValueOnce(new Error('relation "message_analytics" does not exist'))
      .mockResolvedValueOnce({
        rows: [{
          participant_count: "1",
          message_count: "3",
          duration_seconds: "180",
          created_at: "2026-05-01T12:00:00.000Z",
          ended_at: "2026-05-01T12:03:00.000Z"
        }]
      });

    jest.doMock("../server/db", () => ({ query }));
    const sessionsRepo = require("../server/db/repositories/sessions");

    const analytics = await sessionsRepo.getDetailedAnalytics("session-1", "user-1");

    expect(analytics.overview).toEqual(expect.objectContaining({
      participantCount: "1",
      messageCount: "3",
      durationSeconds: 180,
      totalSpeakingTimeSeconds: 7
    }));
    expect(analytics.participants[0]).toEqual(expect.objectContaining({
      id: "participant-1",
      messageCount: 2,
      speakingSeconds: 7
    }));
    expect(analytics.quality).toEqual({
      avgSpecificity: 0,
      avgProfoundness: 0,
      avgCoherence: 0,
      avgDiscussionValue: 0,
      anchorReferences: 0,
      peerResponses: 0,
      anchorsCreated: 0
    });
    expect(warn).toHaveBeenCalledWith(
      "[analytics] Message analytics summary unavailable:",
      'relation "message_analytics" does not exist'
    );

    warn.mockRestore();
  });
});
