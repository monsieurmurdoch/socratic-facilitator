const {
  issueSessionAccessToken,
  verifySessionAccessToken,
  getSessionAccessFromRequest
} = require("../server/sessionAccess");

const session = {
  id: "session-db-1",
  short_code: "abc123"
};

describe("signed session access tokens", () => {
  test("issues view tokens for joined participants", () => {
    const token = issueSessionAccessToken(session, {
      participantId: "client-1",
      sessionRole: "participant"
    });

    const payload = verifySessionAccessToken(token, session);
    expect(payload.sessionId).toBe(session.id);
    expect(payload.shortCode).toBe(session.short_code);
    expect(payload.participantId).toBe("client-1");
    expect(payload.scope).toBe("view");
  });

  test("issues manage tokens for teachers", () => {
    const token = issueSessionAccessToken(session, {
      participantId: "teacher-1",
      sessionRole: "teacher"
    });

    const access = getSessionAccessFromRequest({
      headers: { "x-session-access": token },
      query: {}
    }, session);

    expect(access.canView).toBe(true);
    expect(access.canManage).toBe(true);
  });

  test("rejects tokens for another session", () => {
    const token = issueSessionAccessToken(session, {
      participantId: "client-1",
      sessionRole: "participant"
    });

    expect(verifySessionAccessToken(token, { id: "other", short_code: "other" })).toBeNull();
  });
});
