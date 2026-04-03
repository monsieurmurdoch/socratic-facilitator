const db = require('../index');

async function recordJoin({ sessionId, participantId, userId = null, name, roleSnapshot = null }) {
  const result = await db.query(
    `INSERT INTO session_memberships (
      session_id, participant_id, user_id, name_snapshot, role_snapshot, joined_at, left_at, join_count
     ) VALUES ($1, $2, $3, $4, $5, NOW(), NULL, 1)
     ON CONFLICT (participant_id) DO UPDATE
     SET user_id = COALESCE(EXCLUDED.user_id, session_memberships.user_id),
         name_snapshot = EXCLUDED.name_snapshot,
         role_snapshot = COALESCE(EXCLUDED.role_snapshot, session_memberships.role_snapshot),
         left_at = NULL,
         join_count = session_memberships.join_count + 1,
         updated_at = NOW()
     RETURNING *`,
    [sessionId, participantId, userId, name, roleSnapshot]
  );
  return result.rows[0];
}

async function recordLeave(participantId) {
  await db.query(
    `UPDATE session_memberships
     SET left_at = NOW(), updated_at = NOW()
     WHERE participant_id = $1`,
    [participantId]
  );
}

async function recordMessage(participantId, metrics) {
  const {
    wordCount = 0,
    estimatedSpeakingSeconds = 0,
    contributionScore = 0,
    engagementScore = 0
  } = metrics;

  await db.query(
    `UPDATE session_memberships
     SET message_count = message_count + 1,
         total_word_count = total_word_count + $2,
         estimated_speaking_seconds = estimated_speaking_seconds + $3,
         contribution_score = contribution_score + $4,
         engagement_score = engagement_score + $5,
         updated_at = NOW()
     WHERE participant_id = $1`,
    [participantId, wordCount, estimatedSpeakingSeconds, contributionScore, engagementScore]
  );
}

async function listBySession(sessionId) {
  const result = await db.query(
    `SELECT *
     FROM session_memberships
     WHERE session_id = $1
     ORDER BY contribution_score DESC, estimated_speaking_seconds DESC`,
    [sessionId]
  );
  return result.rows;
}

module.exports = {
  recordJoin,
  recordLeave,
  recordMessage,
  listBySession
};
