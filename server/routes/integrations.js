const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const router = express.Router();
const integrationsRepo = require('../db/repositories/integrations');
const ltiRegistrationsRepo = require('../db/repositories/ltiRegistrations');
const ltiAccountLinksRepo = require('../db/repositories/ltiAccountLinks');
const ltiGradebookLinksRepo = require('../db/repositories/ltiGradebookLinks');
const classesRepo = require('../db/repositories/classes');
const classMembershipsRepo = require('../db/repositories/classMemberships');
const privacySettingsRepo = require('../db/repositories/privacySettings');
const sessionMembershipsRepo = require('../db/repositories/sessionMemberships');
const sessionsRepo = require('../db/repositories/sessions');
const usersRepo = require('../db/repositories/users');
const { requireAuth, requireAnyRole, hashPassword, normalizeEmail, issueAuthToken } = require('../auth');
const { logAudit, getRequestIp } = require('../audit');
const {
  generateToolKeyMaterial,
  verifyLtiIdToken,
  fetchNrpsMemberships,
  createLineItem,
  postScore
} = require('../lti');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || '';
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.rosters.readonly'
];

const STATE_SECRET = process.env.OAUTH_STATE_SECRET || process.env.JWT_SECRET;
if (!STATE_SECRET) {
  console.error('[Integrations] OAUTH_STATE_SECRET or JWT_SECRET must be set');
}

router.use(express.json({ limit: '1mb' }));

function signOAuthState(payload) {
  return jwt.sign(payload, STATE_SECRET, { expiresIn: '10m' });
}

function verifyOAuthState(token) {
  return jwt.verify(token, STATE_SECRET);
}

function assertGoogleConfigured() {
  return GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI;
}

function summarizeIntegration(integration) {
  return {
    id: integration.id,
    provider: integration.provider,
    status: integration.status,
    externalEmail: integration.external_email,
    scopes: integration.scopes || [],
    metadata: integration.metadata || {},
    connectedAt: integration.created_at,
    updatedAt: integration.updated_at
  };
}

function buildRegistrationUrls(req, registration) {
  const jwksUrl = `${req.protocol}://${req.get('host')}/api/integrations/lti/registrations/${registration.id}/jwks`;
  return {
    jwksUrl,
    loginUrl: `${req.protocol}://${req.get('host')}/api/integrations/lti/login`
  };
}

function summarizeLtiRegistration(req, item) {
  return {
    id: item.id,
    label: item.label,
    issuer: item.issuer,
    clientId: item.client_id,
    deploymentId: item.deployment_id,
    status: item.status,
    createdAt: item.created_at,
    ...buildRegistrationUrls(req, item)
  };
}

async function ensureRegistrationKeys(registration) {
  if (registration.tool_key_id && registration.tool_private_key_encrypted && registration.tool_public_jwk) {
    return registration;
  }

  const keyMaterial = generateToolKeyMaterial();
  return ltiRegistrationsRepo.updateKeyMaterial(registration.id, {
    toolKeyId: keyMaterial.toolKeyId,
    toolPrivateKeyEncrypted: keyMaterial.toolPrivateKeyEncrypted,
    toolPublicJwk: keyMaterial.toolPublicJwk,
    oauthAudience: registration.oauth_audience || registration.auth_token_url
  });
}

function normalizeLtiRole(roles = []) {
  const joined = Array.isArray(roles) ? roles.join(' ').toLowerCase() : String(roles || '').toLowerCase();
  if (joined.includes('administrator')) return 'Admin';
  if (joined.includes('instructor') || joined.includes('teacher')) return 'Teacher';
  if (joined.includes('guardian') || joined.includes('parent')) return 'Parent';
  return 'Student';
}

function getLtiContextMetadata(context, registration, launch) {
  return {
    issuer: registration.issuer,
    registrationId: registration.id,
    deploymentId: launch['https://purl.imsglobal.org/spec/lti/claim/deployment_id'] || null,
    nrps: launch['https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice'] || null,
    ags: launch['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint'] || null
  };
}

function computeGradebookScore(member) {
  const contribution = Number(member.contribution_score || member.contributionScore || 0);
  const engagement = Number(member.engagement_score || member.engagementScore || 0);
  const messages = Number(member.message_count || member.messageCount || 0);
  const speakingSeconds = Number(member.estimated_speaking_seconds || member.estimatedSpeakingSeconds || 0);

  const normalizedParticipation = Math.min(1, (messages / 6) * 0.6 + (speakingSeconds / 180) * 0.4);
  const blended = Math.min(1, (contribution * 0.45) + (engagement * 0.35) + (normalizedParticipation * 0.2));
  return Math.round(blended * 10000) / 100;
}

async function getGoogleAccessToken(userId) {
  const integration = await integrationsRepo.findByUserAndProvider(userId, 'google_classroom');
  if (!integration) {
    throw new Error('Google Classroom is not connected');
  }

  const decrypted = integrationsRepo.withDecryptedTokens(integration);
  const expiresAt = integration.token_expires_at ? new Date(integration.token_expires_at).getTime() : 0;
  if (decrypted.access_token && expiresAt > Date.now() + 30_000) {
    return { integration, accessToken: decrypted.access_token };
  }

  if (!decrypted.refresh_token) {
    throw new Error('Google Classroom connection needs to be reconnected');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: decrypted.refresh_token,
      grant_type: 'refresh_token'
    }).toString()
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || 'Failed to refresh Google token');
  }

  const tokenExpiresAt = data.expires_in ? new Date(Date.now() + (data.expires_in * 1000)) : null;
  await integrationsRepo.updateTokens(integration.id, {
    accessToken: data.access_token,
    tokenExpiresAt,
    scopes: integration.scopes
  });

  return {
    integration,
    accessToken: data.access_token
  };
}

async function classroomApi(accessToken, path) {
  const response = await fetch(`https://classroom.googleapis.com/v1${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || data.error || 'Google Classroom request failed');
  }
  return data;
}

async function ensureImportedUser({ name, email, role }) {
  const normalized = normalizeEmail(email || '');
  if (!normalized) return null;

  const existing = await usersRepo.findWithPasswordByEmail(normalized);
  if (existing) return existing;

  const randomPassword = crypto.randomBytes(24).toString('hex');
  const passwordHash = await hashPassword(randomPassword);
  return usersRepo.create({
    name: name || normalized.split('@')[0],
    email: normalized,
    role,
    passwordHash
  });
}

router.get('/lti/login', async (req, res) => {
  try {
    const issuer = String(req.query.iss || '').trim();
    const loginHint = String(req.query.login_hint || '').trim();
    const targetLinkUri = String(req.query.target_link_uri || '').trim();
    const clientId = String(req.query.client_id || '').trim();

    const registrations = await ltiRegistrationsRepo.listAll();
    const registration = registrations.find(item => item.issuer === issuer && item.client_id === clientId);
    if (!registration) {
      return res.status(404).send('LTI registration not found');
    }
    const readyRegistration = await ensureRegistrationKeys(registration);

    const nonce = crypto.randomBytes(12).toString('hex');
    const state = signOAuthState({
      provider: 'lti',
      registrationId: registration.id,
      nonce,
      targetLinkUri
    });

    const redirect = new URL(readyRegistration.auth_login_url);
    redirect.searchParams.set('scope', 'openid');
    redirect.searchParams.set('response_type', 'id_token');
    redirect.searchParams.set('response_mode', 'form_post');
    redirect.searchParams.set('client_id', readyRegistration.client_id);
    redirect.searchParams.set('redirect_uri', `${req.protocol}://${req.get('host')}/api/integrations/lti/launch`);
    redirect.searchParams.set('login_hint', loginHint);
    redirect.searchParams.set('state', state);
    redirect.searchParams.set('nonce', nonce);
    if (req.query.lti_message_hint) {
      redirect.searchParams.set('lti_message_hint', String(req.query.lti_message_hint));
    }

    res.redirect(redirect.toString());
  } catch (error) {
    console.error('LTI login error:', error);
    res.status(500).send('Failed to start LTI login');
  }
});

router.post('/lti/launch', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const statePayload = verifyOAuthState(String(req.body.state || ''));
    const idToken = String(req.body.id_token || '');
    if (!idToken) {
      return res.status(400).send('Missing id_token');
    }

    const registration = await ltiRegistrationsRepo.findById(statePayload.registrationId);
    if (!registration) {
      return res.status(404).send('LTI registration not found');
    }
    const readyRegistration = await ensureRegistrationKeys(registration);

    const launch = await verifyLtiIdToken({
      idToken,
      registration: readyRegistration,
      nonce: statePayload.nonce
    });

    const email = launch.email || launch['https://purl.imsglobal.org/spec/lti/claim/ext']?.user_username || null;
    const name = launch.name || [launch.given_name, launch.family_name].filter(Boolean).join(' ') || email || 'LTI User';
    const ltiRoles = launch['https://purl.imsglobal.org/spec/lti/claim/roles'] || [];
    const localRole = normalizeLtiRole(ltiRoles);
    const user = await ensureImportedUser({
      name,
      email: email || `${launch.sub}@lti.local`,
      role: localRole
    });

    await ltiAccountLinksRepo.upsert({
      registrationId: registration.id,
      userId: user.id,
      subject: launch.sub,
      email,
      contextId: launch['https://purl.imsglobal.org/spec/lti/claim/context']?.id || null,
      contextTitle: launch['https://purl.imsglobal.org/spec/lti/claim/context']?.title || null,
      deploymentId: launch['https://purl.imsglobal.org/spec/lti/claim/deployment_id'] || null,
      lastLaunchPayload: launch
    });

    const context = launch['https://purl.imsglobal.org/spec/lti/claim/context'];
    if (context?.id && context?.title) {
      let cls = await classesRepo.findByExternalCourse('lti', context.id);
      const externalMetadata = getLtiContextMetadata(context, registration, launch);
      if (!cls) {
        cls = await classesRepo.create({
          ownerUserId: user.id,
          name: context.title,
          description: `Imported from ${readyRegistration.label}`,
          externalProvider: 'lti',
          externalCourseId: context.id,
          externalMetadata
        });
      } else {
        cls = await classesRepo.updateExternalMetadata(cls.id, {
          externalProvider: 'lti',
          externalCourseId: context.id,
          externalMetadata
        });
      }
      await classMembershipsRepo.add({
        classId: cls.id,
        userId: user.id,
        role: localRole
      });
    }

    const { token: appToken, session } = await issueAuthToken(user, {
      ipAddress: getRequestIp(req),
      userAgent: req.headers['user-agent'] || 'LTI launch',
      sessionLabel: `LTI launch via ${readyRegistration.label}`
    });
    await logAudit({
      req,
      actorUserId: user.id,
      targetUserId: user.id,
      action: 'lti.launch_authenticated',
      entityType: 'auth_session',
      entityId: session.id,
      metadata: {
        registrationId: readyRegistration.id,
        contextId: context?.id || null
      }
    });
    res.redirect(`/?lti_launch=1&authToken=${encodeURIComponent(appToken)}`);
  } catch (error) {
    console.error('LTI launch error:', error);
    res.status(500).send(`LTI launch failed: ${error.message}`);
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const integrations = await integrationsRepo.listByUser(req.user.id);
    const registrations = ['Admin', 'SuperAdmin'].includes(req.user.role)
      ? await Promise.all((await ltiRegistrationsRepo.listAll()).map(ensureRegistrationKeys))
      : [];

    const payload = {
      integrations: integrations.map(summarizeIntegration),
      googleClassroom: {
        configured: Boolean(assertGoogleConfigured())
      },
      lti: {
        enabled: true
      }
    };

    if (['Admin', 'SuperAdmin'].includes(req.user.role)) {
      payload.lti.registrations = registrations.map(item => summarizeLtiRegistration(req, item));
    }

    res.json(payload);
  } catch (error) {
    console.error('List integrations error:', error);
    res.status(500).json({ error: 'Failed to load integrations' });
  }
});

router.get('/google-classroom/auth-url', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  if (!assertGoogleConfigured()) {
    return res.status(400).json({ error: 'Google Classroom OAuth is not configured' });
  }

  const state = signOAuthState({
    provider: 'google_classroom',
    userId: req.user.id,
    returnTo: req.query.returnTo || '/'
  });

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', GOOGLE_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  url.searchParams.set('state', state);

  res.json({ url: url.toString() });
});

router.get('/google-classroom/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).send('Missing code or state');
    }

    const verified = verifyOAuthState(state);
    if (verified.provider !== 'google_classroom') {
      return res.status(400).send('Invalid provider state');
    }

    if (!assertGoogleConfigured()) {
      return res.status(400).send('Google Classroom OAuth is not configured');
    }

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        code: String(code),
        grant_type: 'authorization_code'
      }).toString()
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(tokenData.error_description || tokenData.error || 'Google OAuth exchange failed');
    }

    const profile = await classroomApi(tokenData.access_token, '/userProfiles/me');
    const tokenExpiresAt = tokenData.expires_in ? new Date(Date.now() + (tokenData.expires_in * 1000)) : null;
    await integrationsRepo.upsertGoogleClassroomConnection({
      userId: verified.userId,
      externalUserId: profile.id,
      externalEmail: profile.emailAddress,
      scopes: (tokenData.scope || '').split(/\s+/).filter(Boolean),
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      tokenExpiresAt,
      metadata: {
        fullName: profile.name?.fullName || null,
        photoUrl: profile.photoUrl || null
      }
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const redirectUrl = new URL(String(verified.returnTo || '/'), baseUrl);
    redirectUrl.searchParams.set('integration', 'google_classroom_connected');
    res.redirect(redirectUrl.pathname + redirectUrl.search);
  } catch (error) {
    console.error('Google Classroom callback error:', error);
    res.status(500).send(`Google Classroom connection failed: ${error.message}`);
  }
});

router.get('/google-classroom/courses', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const { accessToken } = await getGoogleAccessToken(req.user.id);
    const [coursesData, profile] = await Promise.all([
      classroomApi(accessToken, '/courses?pageSize=100&teacherId=me&courseStates=ACTIVE'),
      classroomApi(accessToken, '/userProfiles/me')
    ]);

    res.json({
      connectedProfile: {
        id: profile.id,
        email: profile.emailAddress,
        name: profile.name?.fullName || null
      },
      courses: (coursesData.courses || []).map(course => ({
        id: course.id,
        name: course.name,
        section: course.section,
        descriptionHeading: course.descriptionHeading,
        description: course.description,
        room: course.room,
        ownerId: course.ownerId,
        courseState: course.courseState
      }))
    });
  } catch (error) {
    console.error('Google Classroom courses error:', error);
    res.status(500).json({ error: error.message || 'Failed to load Google Classroom courses' });
  }
});

router.post('/google-classroom/import-course', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const courseId = String(req.body.courseId || '').trim();
    if (!courseId) {
      return res.status(400).json({ error: 'courseId is required' });
    }

    const existingClass = await classesRepo.findByExternalCourse('google_classroom', courseId);
    if (existingClass) {
      return res.json({
        imported: false,
        class: {
          id: existingClass.id,
          name: existingClass.name
        },
        message: 'This Google Classroom course is already linked to a class.'
      });
    }

    const { accessToken } = await getGoogleAccessToken(req.user.id);
    const [course, teachersData, studentsData] = await Promise.all([
      classroomApi(accessToken, `/courses/${encodeURIComponent(courseId)}`),
      classroomApi(accessToken, `/courses/${encodeURIComponent(courseId)}/teachers?pageSize=100`),
      classroomApi(accessToken, `/courses/${encodeURIComponent(courseId)}/students?pageSize=100`)
    ]);

    const createdClass = await classesRepo.create({
      ownerUserId: req.user.id,
      name: course.name,
      description: course.descriptionHeading || course.description || null,
      ageRange: null,
      externalProvider: 'google_classroom',
      externalCourseId: course.id,
      externalMetadata: {
        section: course.section || null,
        room: course.room || null,
        courseState: course.courseState || null
      }
    });

    await classMembershipsRepo.add({
      classId: createdClass.id,
      userId: req.user.id,
      role: req.user.role
    });

    let importedTeacherCount = 0;
    let importedStudentCount = 0;
    const teacherProfiles = teachersData.teachers || [];
    const studentProfiles = studentsData.students || [];

    for (const teacher of teacherProfiles) {
      const email = teacher.profile?.emailAddress;
      if (!email) continue;
      const user = await ensureImportedUser({
        name: teacher.profile?.name?.fullName,
        email,
        role: 'Teacher'
      });
      if (!user) continue;
      await classMembershipsRepo.add({
        classId: createdClass.id,
        userId: user.id,
        role: 'Teacher'
      });
      importedTeacherCount += 1;
    }

    for (const student of studentProfiles) {
      const email = student.profile?.emailAddress;
      if (!email) continue;
      const user = await ensureImportedUser({
        name: student.profile?.name?.fullName,
        email,
        role: 'Student'
      });
      if (!user) continue;
      await classMembershipsRepo.add({
        classId: createdClass.id,
        userId: user.id,
        role: 'Student'
      });
      importedStudentCount += 1;
    }

    res.status(201).json({
      imported: true,
      provider: 'google_classroom',
      class: {
        id: createdClass.id,
        name: createdClass.name
      },
      roster: {
        teachers: importedTeacherCount,
        students: importedStudentCount
      }
    });
  } catch (error) {
    console.error('Google Classroom import error:', error);
    res.status(500).json({ error: error.message || 'Failed to import Google Classroom course' });
  }
});

router.get('/roadmap', requireAuth, async (_req, res) => {
  res.json({
    items: [
      { id: 'lti-launch', title: 'LTI 1.3 launch + account linking', status: 'in_progress' },
      { id: 'nrps-sync', title: 'NRPS roster sync into classes and memberships', status: 'in_progress' },
      { id: 'deep-linking', title: 'Deep Linking for placing sessions in LMS courses', status: 'in_progress' },
      { id: 'google-classroom', title: 'Google Classroom importer/add-on', status: 'in_progress' },
      { id: 'ags-passback', title: 'AGS gradebook passback after scoring policy is finalized', status: 'in_progress' }
    ]
  });
});

router.get('/lti/registrations/:id/jwks', async (req, res) => {
  try {
    const registration = await ltiRegistrationsRepo.findById(req.params.id);
    if (!registration || !registration.tool_public_jwk) {
      const refreshed = registration ? await ensureRegistrationKeys(registration) : null;
      if (!refreshed?.tool_public_jwk) {
        return res.status(404).json({ error: 'JWKS not found' });
      }
      return res.json({ keys: [refreshed.tool_public_jwk] });
    }

    res.json({
      keys: [registration.tool_public_jwk]
    });
  } catch (error) {
    console.error('LTI JWKS error:', error);
    res.status(500).json({ error: 'Failed to load JWKS' });
  }
});

router.get('/lti/registrations', requireAnyRole(['Admin', 'SuperAdmin']), async (_req, res) => {
  try {
    const registrations = await Promise.all((await ltiRegistrationsRepo.listAll()).map(ensureRegistrationKeys));
    res.json(registrations.map(item => summarizeLtiRegistration(_req, item)));
  } catch (error) {
    console.error('List LTI registrations error:', error);
    res.status(500).json({ error: 'Failed to load LTI registrations' });
  }
});

router.post('/lti/registrations', requireAnyRole(['Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const label = String(req.body.label || '').trim();
    const issuer = String(req.body.issuer || '').trim();
    const clientId = String(req.body.clientId || '').trim();
    const deploymentId = String(req.body.deploymentId || '').trim();
    const authLoginUrl = String(req.body.authLoginUrl || '').trim();
    const authTokenUrl = String(req.body.authTokenUrl || '').trim();
    const keysetUrl = String(req.body.keysetUrl || '').trim();

    if (!label || !issuer || !clientId || !deploymentId || !authLoginUrl || !authTokenUrl || !keysetUrl) {
      return res.status(400).json({ error: 'Missing required LTI registration fields' });
    }

    const keyMaterial = generateToolKeyMaterial();
    const created = await ltiRegistrationsRepo.create({
      label,
      issuer,
      clientId,
      deploymentId,
      authLoginUrl,
      authTokenUrl,
      keysetUrl,
      deepLinkUrl: req.body.deepLinkUrl || null,
      nrpsUrl: req.body.nrpsUrl || null,
      agsLineitemsUrl: req.body.agsLineitemsUrl || null,
      toolKeyId: keyMaterial.toolKeyId,
      toolPrivateKeyEncrypted: keyMaterial.toolPrivateKeyEncrypted,
      toolPublicJwk: keyMaterial.toolPublicJwk,
      oauthAudience: req.body.oauthAudience || authTokenUrl,
      status: req.body.status || 'draft',
      metadata: req.body.metadata || {}
    });

    await logAudit({
      req,
      actorUserId: req.user.id,
      action: 'lti.registration_created',
      entityType: 'lti_registration',
      entityId: created.id,
      metadata: { label, issuer, deploymentId }
    });
    res.status(201).json(summarizeLtiRegistration(req, created));
  } catch (error) {
    console.error('Create LTI registration error:', error);
    res.status(500).json({ error: 'Failed to create LTI registration' });
  }
});

router.post('/lti/classes/:classId/nrps-sync', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const cls = await classesRepo.findAccessibleByUser(req.params.classId, req.user.id);
    if (!cls) {
      return res.status(404).json({ error: 'Class not found' });
    }

    if (cls.external_provider !== 'lti') {
      return res.status(400).json({ error: 'This class is not linked to an LTI context' });
    }

    const privacy = await privacySettingsRepo.getOrDefault(cls.id);
    if (privacy.allow_lms_sync === false) {
      return res.status(403).json({ error: 'LMS sync is disabled for this class' });
    }

    const registrationId = cls.external_metadata?.registrationId;
    const contextId = cls.external_course_id;
    if (!registrationId || !contextId) {
      return res.status(400).json({ error: 'Missing LTI registration or context metadata' });
    }

    const registration = await ltiRegistrationsRepo.findById(registrationId);
    if (!registration) {
      return res.status(404).json({ error: 'LTI registration not found' });
    }
    const readyRegistration = await ensureRegistrationKeys(registration);

    const contextLinks = await ltiAccountLinksRepo.listByContext({ registrationId, contextId });
    const contextLaunch = contextLinks[0];
    const nrpsServiceUrl = contextLaunch?.last_launch_payload?.['https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice']?.context_memberships_url
      || registration.nrps_url;

    if (!nrpsServiceUrl) {
      return res.status(400).json({ error: 'NRPS service URL is unavailable for this context' });
    }

    const members = await fetchNrpsMemberships({ registration: readyRegistration, serviceUrl: nrpsServiceUrl });
    let imported = 0;

    for (const member of members) {
      const memberEmail = member.email || member.emailAddress || `${member.user_id || member.userId || member.sub}@lti.local`;
      const role = normalizeLtiRole(member.roles || []);
      const user = await ensureImportedUser({
        name: member.name || `${member.given_name || ''} ${member.family_name || ''}`.trim() || memberEmail,
        email: memberEmail,
        role
      });
      if (!user) continue;

      await classMembershipsRepo.add({
        classId: cls.id,
        userId: user.id,
        role
      });

      if (member.user_id || member.sub) {
        await ltiAccountLinksRepo.upsert({
          registrationId,
          userId: user.id,
          subject: member.user_id || member.sub,
          email: memberEmail,
          contextId,
          contextTitle: cls.name,
          deploymentId: cls.external_metadata?.deploymentId || null,
          lastLaunchPayload: {
            nrpsImported: true,
            member
          }
        });
      }

      imported += 1;
    }

    res.json({
      success: true,
      importedCount: imported,
      class: {
        id: cls.id,
        name: cls.name
      }
    });
    await logAudit({
      req,
      actorUserId: req.user.id,
      action: 'lti.nrps_synced',
      entityType: 'class',
      entityId: cls.id,
      metadata: { importedCount: imported, registrationId, contextId }
    });
  } catch (error) {
    console.error('LTI NRPS sync error:', error);
    res.status(500).json({ error: error.message || 'Failed to sync NRPS roster' });
  }
});

router.post('/lti/sessions/:sessionCode/ags-sync', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const session = await sessionsRepo.findByShortCode(req.params.sessionCode);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const cls = session.class_id ? await classesRepo.findAccessibleByUser(session.class_id, req.user.id) : null;
    if (!cls) {
      return res.status(404).json({ error: 'LTI grade sync requires a linked class you can access' });
    }
    if (cls.external_provider !== 'lti') {
      return res.status(400).json({ error: 'This session is not attached to an LTI class' });
    }

    const privacy = await privacySettingsRepo.getOrDefault(cls.id);
    if (privacy.allow_lms_sync === false) {
      return res.status(403).json({ error: 'LMS sync is disabled for this class' });
    }

    const registrationId = cls.external_metadata?.registrationId;
    const contextId = cls.external_course_id;
    const registration = registrationId ? await ltiRegistrationsRepo.findById(registrationId) : null;
    if (!registration) {
      return res.status(404).json({ error: 'LTI registration not found for this class' });
    }
    const readyRegistration = await ensureRegistrationKeys(registration);

    const launchLinks = await ltiAccountLinksRepo.listByContext({ registrationId, contextId });
    const latestLaunch = launchLinks[0];
    const agsEndpoint = latestLaunch?.last_launch_payload?.['https://purl.imsglobal.org/spec/lti-ags/claim/endpoint'];
    const lineitemsUrl = agsEndpoint?.lineitems || registration.ags_lineitems_url;
    if (!lineitemsUrl) {
      return res.status(400).json({ error: 'AGS lineitems endpoint is unavailable for this context' });
    }

    let gradebookLink = await ltiGradebookLinksRepo.findBySession(session.id);
    if (!gradebookLink) {
      const lineitem = await createLineItem({
        registration: readyRegistration,
        lineitemsUrl,
        label: session.title,
        resourceId: session.id,
        scoreMaximum: 100
      });
      gradebookLink = await ltiGradebookLinksRepo.upsert({
        sessionId: session.id,
        registrationId,
        contextId,
        lineitemUrl: lineitem.id || lineitem.lineitem || lineitem.url,
        resourceId: session.id,
        label: session.title,
        scoreMaximum: Number(lineitem.scoreMaximum || 100),
        lastSyncResult: { lineitemCreated: true }
      });
    }

    const memberships = await sessionMembershipsRepo.listBySession(session.id);
    const postedScores = [];

    for (const member of memberships) {
      if (!member.user_id || member.role_snapshot !== 'Student') continue;

      const accountLink = await ltiAccountLinksRepo.findByUserInContext({
        registrationId,
        userId: member.user_id,
        contextId
      });
      if (!accountLink) continue;

      const scoreGiven = computeGradebookScore(member);
      const scorePayload = {
        timestamp: new Date().toISOString(),
        scoreGiven,
        scoreMaximum: Number(gradebookLink.score_maximum || 100),
        comment: `Socratic Facilitator discussion score for ${session.title}`,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
        userId: accountLink.lti_subject
      };

      await postScore({
        registration: readyRegistration,
        lineitemUrl: gradebookLink.lineitem_url,
        score: scorePayload
      });

      postedScores.push({
        name: member.name_snapshot,
        userId: member.user_id,
        scoreGiven
      });
    }

    await ltiGradebookLinksRepo.upsert({
      sessionId: session.id,
      registrationId,
      contextId,
      lineitemUrl: gradebookLink.lineitem_url,
      resourceId: gradebookLink.resource_id || session.id,
      label: gradebookLink.label || session.title,
      scoreMaximum: Number(gradebookLink.score_maximum || 100),
      lastSyncResult: {
        syncedAt: new Date().toISOString(),
        postedCount: postedScores.length
      }
    });

    res.json({
      success: true,
      postedCount: postedScores.length,
      lineitemUrl: gradebookLink.lineitem_url,
      scores: postedScores
    });
    await logAudit({
      req,
      actorUserId: req.user.id,
      action: 'lti.ags_synced',
      entityType: 'session',
      entityId: session.id,
      metadata: { postedCount: postedScores.length, lineitemUrl: gradebookLink.lineitem_url }
    });
  } catch (error) {
    console.error('LTI AGS sync error:', error);
    res.status(500).json({ error: error.message || 'Failed to sync AGS gradebook' });
  }
});

router.get('/lti/deep-links/:sessionCode', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const session = await sessionsRepo.findByShortCode(req.params.sessionCode);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const registrationId = String(req.query.registrationId || '').trim();
    const registrations = await ltiRegistrationsRepo.listAll();
    const registration = registrations.find(item => item.id === registrationId) || registrations[0];
    if (!registration) {
      return res.status(404).json({ error: 'No LTI registration available' });
    }

    res.json({
      registration: {
        id: registration.id,
        label: registration.label,
        issuer: registration.issuer
      },
      deepLink: {
        title: session.title,
        text: `Launch ${session.title} in Socratic Facilitator`,
        launchUrl: `${req.protocol}://${req.get('host')}/api/integrations/lti/login?iss=${encodeURIComponent(registration.issuer)}&client_id=${encodeURIComponent(registration.client_id)}&target_link_uri=${encodeURIComponent(`${req.protocol}://${req.get('host')}/?join=${session.short_code}`)}`,
        custom: {
          sessionCode: session.short_code,
          classId: session.class_id || null
        }
      }
    });
  } catch (error) {
    console.error('Generate LTI deep link error:', error);
    res.status(500).json({ error: 'Failed to generate LTI deep link' });
  }
});

module.exports = router;
