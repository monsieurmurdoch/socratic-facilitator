const db = require('../index');

async function enqueueFromSession(sessionId, { limit = 200, source = 'llm_prelabel' } = {}) {
  const result = await db.query(
    `INSERT INTO label_queue_items (
      session_id, message_id, participant_id, source, prelabel_json
     )
     SELECT
       m.session_id,
       m.id,
       m.participant_id,
       $3,
       jsonb_build_object(
         'specificity', ma.specificity,
         'profoundness', ma.profoundness,
         'coherence', ma.coherence,
         'discussionValue', ma.discussion_value,
         'respondedToPeer', ma.responded_to_peer,
         'referencedAnchor', ma.referenced_anchor,
         'isAnchor', ma.is_anchor,
         'reasoning', ma.reasoning
       )
     FROM messages m
     JOIN participants p ON p.id = m.participant_id
     LEFT JOIN message_analytics ma ON ma.message_id = m.id
     WHERE m.session_id = $1
       AND m.sender_type = 'participant'
       AND p.eval_consent_granted IS TRUE
     ORDER BY m.created_at ASC
     LIMIT $2
     ON CONFLICT (message_id) DO NOTHING
     RETURNING *`,
    [sessionId, limit, source]
  );
  return result.rows;
}

async function list({ status = 'pending', limit = 100 } = {}) {
  const result = await db.query(
    `SELECT lqi.*, m.content, COALESCE(p.name, m.sender_name) AS participant_name, s.title AS session_title
     FROM label_queue_items lqi
     JOIN messages m ON m.id = lqi.message_id
     LEFT JOIN participants p ON p.id = lqi.participant_id
     LEFT JOIN sessions s ON s.id = lqi.session_id
     WHERE ($1::text IS NULL OR lqi.status = $1)
     ORDER BY lqi.created_at ASC
     LIMIT $2`,
    [status || null, limit]
  );
  return result.rows;
}

async function review(id, {
  reviewerUserId,
  status = 'verified',
  humanLabelJson = {},
  reviewNotes = null
}) {
  const result = await db.query(
    `UPDATE label_queue_items
     SET status = $2,
         human_label_json = $3,
         reviewer_user_id = $4,
         review_notes = $5,
         reviewed_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id, status, JSON.stringify(humanLabelJson || {}), reviewerUserId, reviewNotes]
  );
  return result.rows[0] || null;
}

module.exports = {
  enqueueFromSession,
  list,
  review
};
