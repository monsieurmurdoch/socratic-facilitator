const db = require('../index');

async function upsert({
  registrationId,
  userId,
  subject,
  email = null,
  contextId = null,
  contextTitle = null,
  deploymentId = null,
  lastLaunchPayload = {}
}) {
  const result = await db.query(
    `INSERT INTO lti_account_links (
      registration_id, user_id, lti_subject, lti_email, context_id, context_title, deployment_id, last_launch_payload, last_launched_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (registration_id, lti_subject) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       lti_email = EXCLUDED.lti_email,
       context_id = EXCLUDED.context_id,
       context_title = EXCLUDED.context_title,
       deployment_id = EXCLUDED.deployment_id,
       last_launch_payload = EXCLUDED.last_launch_payload,
       last_launched_at = NOW()
     RETURNING *`,
    [
      registrationId,
      userId,
      subject,
      email,
      contextId,
      contextTitle,
      deploymentId,
      JSON.stringify(lastLaunchPayload || {})
    ]
  );
  return result.rows[0];
}

async function findByUserInContext({ registrationId, userId, contextId }) {
  const result = await db.query(
    `SELECT *
     FROM lti_account_links
     WHERE registration_id = $1
       AND user_id = $2
       AND context_id = $3
     ORDER BY last_launched_at DESC
     LIMIT 1`,
    [registrationId, userId, contextId]
  );
  return result.rows[0] || null;
}

async function listByContext({ registrationId, contextId }) {
  const result = await db.query(
    `SELECT *
     FROM lti_account_links
     WHERE registration_id = $1
       AND context_id = $2
     ORDER BY last_launched_at DESC`,
    [registrationId, contextId]
  );
  return result.rows;
}

module.exports = {
  upsert,
  findByUserInContext,
  listByContext
};
