const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { encryptSecret, decryptSecret } = require('./secrets');

const NRPS_SCOPE = 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
const AGS_LINEITEM_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem';
const AGS_LINEITEM_READONLY_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly';
const AGS_SCORE_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
const JWKS_CACHE_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map();

function randomId(size = 16) {
  return crypto.randomBytes(size).toString('hex');
}

function normalizeLtiScopes(scopes = []) {
  return Array.from(new Set((scopes || []).filter(Boolean)));
}

function generateToolKeyMaterial() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomId(12);
  const publicJwk = publicKey.export({ format: 'jwk' });
  publicJwk.use = 'sig';
  publicJwk.alg = 'RS256';
  publicJwk.kid = kid;

  return {
    toolKeyId: kid,
    toolPrivateKeyEncrypted: encryptSecret(privateKey.export({ type: 'pkcs8', format: 'pem' })),
    toolPublicJwk: publicJwk
  };
}

async function getJwks(url) {
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.keys)) {
    throw new Error('Failed to fetch JWKS');
  }

  jwksCache.set(url, {
    keys: data.keys,
    expiresAt: Date.now() + JWKS_CACHE_TTL_MS
  });

  return data.keys;
}

async function verifyLtiIdToken({ idToken, registration, nonce }) {
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded?.header) {
    throw new Error('Invalid LTI id_token');
  }

  const jwks = await getJwks(registration.keyset_url);
  const jwk = decoded.header.kid
    ? jwks.find(key => key.kid === decoded.header.kid)
    : jwks[0];

  if (!jwk) {
    throw new Error('Matching platform JWK not found');
  }

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const payload = jwt.verify(idToken, publicKey, {
    algorithms: [decoded.header.alg || 'RS256'],
    issuer: registration.issuer,
    audience: registration.client_id,
    clockTolerance: 10
  });

  if (nonce && payload.nonce !== nonce) {
    throw new Error('LTI nonce mismatch');
  }

  const deploymentId = payload['https://purl.imsglobal.org/spec/lti/claim/deployment_id'];
  if (registration.deployment_id && deploymentId && registration.deployment_id !== deploymentId) {
    throw new Error('LTI deployment mismatch');
  }

  return payload;
}

function buildClientAssertion(registration) {
  const privateKey = decryptSecret(registration.tool_private_key_encrypted);
  if (!privateKey) {
    throw new Error('Tool private key is not configured for this registration');
  }

  const now = Math.floor(Date.now() / 1000);
  const audience = registration.oauth_audience || registration.auth_token_url;
  return jwt.sign(
    {
      iss: registration.client_id,
      sub: registration.client_id,
      aud: audience,
      jti: randomId(12),
      iat: now,
      exp: now + 300
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: registration.tool_key_id
    }
  );
}

async function getServiceAccessToken(registration, scopes = []) {
  const scope = normalizeLtiScopes(scopes).join(' ');
  if (!scope) {
    throw new Error('At least one LTI service scope is required');
  }

  const clientAssertion = buildClientAssertion(registration);
  const response = await fetch(registration.auth_token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
      scope
    }).toString()
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Failed to fetch LTI service token');
  }

  return data.access_token;
}

function parseLinkHeader(headerValue = '') {
  const links = {};
  for (const part of headerValue.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match) {
      links[match[2]] = match[1];
    }
  }
  return links;
}

async function fetchPagedJson({ url, accessToken, accept }) {
  let nextUrl = url;
  const pages = [];

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: accept
      }
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error_description || data.error || 'LTI service request failed');
    }
    pages.push(data);
    const links = parseLinkHeader(response.headers.get('link') || '');
    nextUrl = links.next || null;
  }

  return pages;
}

async function fetchNrpsMemberships({ registration, serviceUrl }) {
  const accessToken = await getServiceAccessToken(registration, [NRPS_SCOPE]);
  const pages = await fetchPagedJson({
    url: serviceUrl,
    accessToken,
    accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json'
  });

  return pages.flatMap(page => page.members || []);
}

async function createLineItem({ registration, lineitemsUrl, label, resourceId, scoreMaximum = 100, tag = 'socratic-session' }) {
  const accessToken = await getServiceAccessToken(registration, [AGS_LINEITEM_SCOPE]);
  const response = await fetch(lineitemsUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.ims.lis.v2.lineitem+json',
      'Content-Type': 'application/vnd.ims.lis.v2.lineitem+json'
    },
    body: JSON.stringify({
      scoreMaximum,
      label,
      resourceId,
      tag
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Failed to create LTI line item');
  }
  return data;
}

async function postScore({ registration, lineitemUrl, score }) {
  const accessToken = await getServiceAccessToken(registration, [AGS_SCORE_SCOPE, AGS_LINEITEM_READONLY_SCOPE]);
  const targetUrl = lineitemUrl.endsWith('/scores') ? lineitemUrl : `${lineitemUrl}/scores`;
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/vnd.ims.lis.v1.score+json'
    },
    body: JSON.stringify(score)
  });

  if (response.status >= 300) {
    let message = 'Failed to post AGS score';
    try {
      const data = await response.json();
      message = data.error_description || data.error || message;
    } catch (_error) {
      // ignore
    }
    throw new Error(message);
  }
}

module.exports = {
  NRPS_SCOPE,
  AGS_LINEITEM_SCOPE,
  AGS_LINEITEM_READONLY_SCOPE,
  AGS_SCORE_SCOPE,
  normalizeLtiScopes,
  generateToolKeyMaterial,
  verifyLtiIdToken,
  getServiceAccessToken,
  fetchNrpsMemberships,
  createLineItem,
  postScore
};
