const db = require('../index');

async function save({
  sessionId,
  messageId,
  participantId = null,
  analyticsVersion = 1,
  specificity,
  profoundness,
  coherence,
  discussionValue,
  contributionWeight,
  engagementEstimate,
  respondedToPeer,
  referencedAnchor,
  reasoning,
  rawPayload
}) {
  const result = await db.query(
    `INSERT INTO message_analytics (
      session_id, message_id, participant_id, analytics_version,
      specificity, profoundness, coherence, discussion_value,
      contribution_weight, engagement_estimate, responded_to_peer,
      referenced_anchor, reasoning, raw_payload
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (message_id) DO UPDATE SET
      specificity = EXCLUDED.specificity,
      profoundness = EXCLUDED.profoundness,
      coherence = EXCLUDED.coherence,
      discussion_value = EXCLUDED.discussion_value,
      contribution_weight = EXCLUDED.contribution_weight,
      engagement_estimate = EXCLUDED.engagement_estimate,
      responded_to_peer = EXCLUDED.responded_to_peer,
      referenced_anchor = EXCLUDED.referenced_anchor,
      reasoning = EXCLUDED.reasoning,
      raw_payload = EXCLUDED.raw_payload
    RETURNING *`,
    [
      sessionId,
      messageId,
      participantId,
      analyticsVersion,
      specificity,
      profoundness,
      coherence,
      discussionValue,
      contributionWeight,
      engagementEstimate,
      respondedToPeer,
      referencedAnchor,
      reasoning,
      JSON.stringify(rawPayload || {})
    ]
  );
  return result.rows[0];
}

async function listBySession(sessionId, limit = 200) {
  const result = await db.query(
    `SELECT ma.*, m.content, m.created_at, COALESCE(p.name, m.sender_name) AS participant_name
     FROM message_analytics ma
     JOIN messages m ON m.id = ma.message_id
     LEFT JOIN participants p ON p.id = ma.participant_id
     WHERE ma.session_id = $1
     ORDER BY m.created_at ASC
     LIMIT $2`,
    [sessionId, limit]
  );
  return result.rows;
}

module.exports = {
  save,
  listBySession
};
