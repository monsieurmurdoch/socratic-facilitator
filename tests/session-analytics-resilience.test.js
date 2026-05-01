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

  test("transcript loading falls back when legacy message columns are missing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const query = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('column p.user_id does not exist'), { code: '42703' }))
      .mockResolvedValueOnce({
        rows: [{
          id: "message-1",
          session_id: "session-1",
          participant_id: "participant-1",
          sender_type: "participant",
          content: "A legacy transcript turn.",
          created_at: "2026-05-01T12:00:00.000Z",
          participant_name: "Demo Teacher",
          participant_user_id: null,
          target_participant_name: null
        }]
      });

    jest.doMock("../server/db", () => ({ query }));
    const messagesRepo = require("../server/db/repositories/messages");

    const messages = await messagesRepo.getBySession("session-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      id: "message-1",
      participant_name: "Demo Teacher",
      participant_user_id: null,
      target_participant_name: null
    }));
    expect(query).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "[messages] Falling back to legacy transcript query:",
      "column p.user_id does not exist"
    );

    warn.mockRestore();
  });
});
