const jwt = require("jsonwebtoken");

const SESSION_ACCESS_SECRET =
  process.env.SESSION_ACCESS_SECRET ||
  process.env.JWT_SECRET ||
  "dev-session-access-secret-change-me";
const SESSION_ACCESS_TTL = process.env.SESSION_ACCESS_TTL || "12h";

function issueSessionAccessToken(session, {
  participantId = null,
  sessionRole = "participant",
  scope = null
} = {}) {
  if (!session?.id || !session?.short_code) return null;
  const resolvedScope = scope || (sessionRole === "teacher" ? "manage" : "view");
  return jwt.sign(
    {
      kind: "session_access",
      sessionId: session.id,
      shortCode: session.short_code,
      participantId,
      sessionRole,
      scope: resolvedScope
    },
    SESSION_ACCESS_SECRET,
    { expiresIn: SESSION_ACCESS_TTL }
  );
}

function verifySessionAccessToken(token, session) {
  if (!token || !session) return null;
  try {
    const payload = jwt.verify(token, SESSION_ACCESS_SECRET);
    if (payload.kind !== "session_access") return null;
    if (payload.sessionId !== session.id) return null;
    if (payload.shortCode !== session.short_code) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function getSessionAccessFromRequest(req, session) {
  const token = req.headers["x-session-access"] || req.query.sessionAccessToken;
  const payload = verifySessionAccessToken(token, session);
  if (!payload) return { canView: false, canManage: false, payload: null };
  const canManage = payload.scope === "manage" || payload.sessionRole === "teacher";
  return { canView: true, canManage, payload };
}

module.exports = {
  issueSessionAccessToken,
  verifySessionAccessToken,
  getSessionAccessFromRequest
};
