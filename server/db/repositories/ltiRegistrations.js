const db = require('../index');

async function listAll() {
  const result = await db.query(
    `SELECT *
     FROM lti_registrations
     ORDER BY created_at DESC`
  );
  return result.rows;
}

async function findById(id) {
  const result = await db.query(
    `SELECT *
     FROM lti_registrations
     WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function create({
  label,
  issuer,
  clientId,
  deploymentId,
  authLoginUrl,
  authTokenUrl,
  keysetUrl,
  deepLinkUrl = null,
  nrpsUrl = null,
  agsLineitemsUrl = null,
  toolKeyId = null,
  toolPrivateKeyEncrypted = null,
  toolPublicJwk = null,
  oauthAudience = null,
  status = 'draft',
  metadata = {}
}) {
  const result = await db.query(
    `INSERT INTO lti_registrations (
      label, issuer, client_id, deployment_id, auth_login_url,
      auth_token_url, keyset_url, deep_link_url, nrps_url, ags_lineitems_url,
      tool_key_id, tool_private_key_encrypted, tool_public_jwk, oauth_audience, status, metadata
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      label,
      issuer,
      clientId,
      deploymentId,
      authLoginUrl,
      authTokenUrl,
      keysetUrl,
      deepLinkUrl,
      nrpsUrl,
      agsLineitemsUrl,
      toolKeyId,
      toolPrivateKeyEncrypted,
      toolPublicJwk ? JSON.stringify(toolPublicJwk) : null,
      oauthAudience,
      status,
      JSON.stringify(metadata || {})
    ]
  );
  return result.rows[0];
}

async function updateKeyMaterial(id, {
  toolKeyId,
  toolPrivateKeyEncrypted,
  toolPublicJwk,
  oauthAudience = null
}) {
  const result = await db.query(
    `UPDATE lti_registrations
     SET tool_key_id = COALESCE($2, tool_key_id),
         tool_private_key_encrypted = COALESCE($3, tool_private_key_encrypted),
         tool_public_jwk = COALESCE($4, tool_public_jwk),
         oauth_audience = COALESCE($5, oauth_audience)
     WHERE id = $1
     RETURNING *`,
    [
      id,
      toolKeyId,
      toolPrivateKeyEncrypted,
      toolPublicJwk ? JSON.stringify(toolPublicJwk) : null,
      oauthAudience
    ]
  );
  return result.rows[0] || null;
}

module.exports = {
  findById,
  listAll,
  create,
  updateKeyMaterial
};
