const db = require('../index');

async function findBySession(sessionId) {
  const result = await db.query(
    `SELECT *
     FROM lti_gradebook_links
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function upsert({
  sessionId,
  registrationId,
  contextId = null,
  lineitemUrl,
  resourceId = null,
  label = null,
  scoreMaximum = 100,
  lastSyncResult = null
}) {
  const result = await db.query(
    `INSERT INTO lti_gradebook_links (
      session_id, registration_id, context_id, lineitem_url, resource_id, label,
      score_maximum, last_sync_result, last_synced_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
     ON CONFLICT (session_id, registration_id) DO UPDATE SET
       context_id = EXCLUDED.context_id,
       lineitem_url = EXCLUDED.lineitem_url,
       resource_id = EXCLUDED.resource_id,
       label = EXCLUDED.label,
       score_maximum = EXCLUDED.score_maximum,
       last_sync_result = EXCLUDED.last_sync_result,
       last_synced_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    [
      sessionId,
      registrationId,
      contextId,
      lineitemUrl,
      resourceId,
      label,
      scoreMaximum,
      lastSyncResult ? JSON.stringify(lastSyncResult) : null
    ]
  );
  return result.rows[0];
}

module.exports = {
  findBySession,
  upsert
};
