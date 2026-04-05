const db = require('../index');
const { encryptSecret, decryptSecret } = require('../../secrets');

async function listByUser(userId) {
  const result = await db.query(
    `SELECT *
     FROM external_integrations
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

async function findByUserAndProvider(userId, provider) {
  const result = await db.query(
    `SELECT *
     FROM external_integrations
     WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );
  return result.rows[0] || null;
}

async function upsertGoogleClassroomConnection({
  userId,
  externalUserId,
  externalEmail,
  scopes = [],
  accessToken,
  refreshToken,
  tokenExpiresAt,
  metadata = {}
}) {
  const existing = await findByUserAndProvider(userId, 'google_classroom');
  const encryptedAccessToken = encryptSecret(accessToken);
  const encryptedRefreshToken = encryptSecret(refreshToken);

  const result = await db.query(
    `INSERT INTO external_integrations (
      user_id, provider, status, external_user_id, external_email,
      scopes, access_token_encrypted, refresh_token_encrypted, token_expires_at, metadata
     ) VALUES ($1, 'google_classroom', 'connected', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       status = 'connected',
       external_user_id = EXCLUDED.external_user_id,
       external_email = EXCLUDED.external_email,
       scopes = EXCLUDED.scopes,
       access_token_encrypted = COALESCE(EXCLUDED.access_token_encrypted, external_integrations.access_token_encrypted),
       refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, external_integrations.refresh_token_encrypted),
       token_expires_at = EXCLUDED.token_expires_at,
       metadata = COALESCE(external_integrations.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING *`,
    [
      userId,
      externalUserId,
      externalEmail,
      JSON.stringify(scopes || []),
      encryptedAccessToken || existing?.access_token_encrypted || null,
      encryptedRefreshToken || existing?.refresh_token_encrypted || null,
      tokenExpiresAt,
      JSON.stringify(metadata || {})
    ]
  );
  return result.rows[0];
}

async function updateTokens(id, { accessToken, refreshToken, tokenExpiresAt, scopes }) {
  const result = await db.query(
    `UPDATE external_integrations
     SET access_token_encrypted = COALESCE($2, access_token_encrypted),
         refresh_token_encrypted = COALESCE($3, refresh_token_encrypted),
         token_expires_at = COALESCE($4, token_expires_at),
         scopes = COALESCE($5, scopes),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      id,
      accessToken ? encryptSecret(accessToken) : null,
      refreshToken ? encryptSecret(refreshToken) : null,
      tokenExpiresAt || null,
      scopes ? JSON.stringify(scopes) : null
    ]
  );
  return result.rows[0] || null;
}

function withDecryptedTokens(integration) {
  if (!integration) return null;
  return {
    ...integration,
    access_token: decryptSecret(integration.access_token_encrypted),
    refresh_token: decryptSecret(integration.refresh_token_encrypted)
  };
}

module.exports = {
  listByUser,
  findByUserAndProvider,
  upsertGoogleClassroomConnection,
  updateTokens,
  withDecryptedTokens
};
