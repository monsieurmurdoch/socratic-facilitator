/**
 * Sessions API Routes
 */

const express = require('express');
const router = express.Router();
const sessionsRepo = require('../db/repositories/sessions');
const participantsRepo = require('../db/repositories/participants');
const messagesRepo = require('../db/repositories/messages');
const sessionReportsRepo = require('../db/repositories/sessionReports');
const reportBuilder = require('../reportBuilder');
const materialsRepo = require('../db/repositories/materials');
const materialChunksRepo = require('../db/repositories/materialChunks');
const primedContextRepo = require('../db/repositories/primedContext');
const classesRepo = require('../db/repositories/classes');
const classMembershipsRepo = require('../db/repositories/classMemberships');
const storage = require('../storage');
const contentExtractor = require('../content/extractor');
const { getOCRAvailability } = require('../content/ocr');
const sessionPrimer = require('../content/primer');
const { DISCUSSION_TOPICS } = require('../config');
const { requireAuth } = require('../auth');
const { apiLimiter } = require('../middleware/rate-limit');

// Enable JSON body parsing
router.use(express.json({ limit: '10mb' }));
router.use(express.urlencoded({ extended: true }));

/**
 * Resolve session by short code and verify the authenticated user has access
 * (owner, in the session's class, or was a participant). Returns the session
 * row on success, or null after writing the appropriate error response.
 */
async function loadSessionForUser(req, res, { ownerOnly = false } = {}) {
  const session = await sessionsRepo.findByShortCode(req.params.code);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  const userId = req.user.id;
  const isOwner = session.owner_user_id === userId;
  if (ownerOnly) {
    if (!isOwner) {
      res.status(403).json({ error: 'Access denied' });
      return null;
    }
    return session;
  }
  const hasAccess = isOwner ||
    (session.class_id && await sessionsRepo.userInClass(session.class_id, userId)) ||
    await sessionsRepo.userWasParticipant(session.id, userId);
  if (!hasAccess) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return session;
}

/**
 * Create a new session
 * POST /api/sessions
 */
router.post('/', apiLimiter, async (req, res) => {
  try {
    const { title, openingQuestion, conversationGoal, topicId, classId = null, previousSessionShortCode = null } = req.body;

    // If topicId provided, use that topic's data
    let sessionTitle = title;
    let sessionQuestion = openingQuestion;

    if (topicId) {
      const topic = DISCUSSION_TOPICS.find(t => t.id === topicId);
      if (topic) {
        sessionTitle = sessionTitle || topic.title;
        sessionQuestion = sessionQuestion || topic.openingQuestion;
      }
    }

    if (!sessionTitle) {
      return res.status(400).json({ error: 'Title is required' });
    }

    if (req.user && classId) {
      const cls = await classesRepo.findById(classId);
      if (!cls) {
        return res.status(404).json({ error: 'Class not found' });
      }

      const membership = await classMembershipsRepo.findByClassAndUser(classId, req.user.id);
      const isOwner = cls.owner_user_id === req.user.id;
      if (!membership && !isOwner) {
        return res.status(403).json({ error: 'You do not have access to that class' });
      }
    }

    const session = await sessionsRepo.create({
      title: sessionTitle,
      openingQuestion: sessionQuestion,
      conversationGoal,
      ownerUserId: req.user?.id || null,
      classId: req.user ? classId : null,
      previousSessionShortCode
    });

    res.status(201).json({
      id: session.id,
      shortCode: session.short_code,
      title: session.title,
      openingQuestion: session.opening_question,
      conversationGoal: session.conversation_goal,
      status: session.status,
      createdAt: session.created_at
    });
  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

router.get('/history', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const classId = req.query.classId ? String(req.query.classId).trim() : null;
    const history = await sessionsRepo.listHistoryByUser(req.user.id, 80, { q, classId });
    res.json(history.map(session => ({
      id: session.id,
      shortCode: session.short_code,
      title: session.title,
      status: session.status,
      className: session.class_name,
      classId: session.class_id || null,
      viewerRole: session.viewer_role,
      participantCount: Number(session.participant_count || 0),
      messageCount: Number(session.message_count || 0),
      viewerMessageCount: Number(session.viewer_message_count || 0),
      viewerSpeakingSeconds: Number(session.viewer_speaking_seconds || 0),
      viewerContributionScore: Number(session.viewer_contribution_score || 0),
      matchedParticipant: session.matched_participant || null,
      searchExcerpt: session.search_excerpt || null,
      createdAt: session.created_at
    })));
  } catch (error) {
    console.error('Session history error:', error);
    res.status(500).json({ error: 'Failed to load session history' });
  }
});

router.get('/resolve/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toLowerCase();
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }

    const session = await sessionsRepo.findByShortCode(code);
    if (session) {
      return res.json({
        type: 'session',
        code,
        sessionShortCode: session.short_code,
        title: session.title,
        status: session.status
      });
    }

    const cls = await classesRepo.findByRoomCode(code);
    if (!cls) {
      return res.status(404).json({ error: 'No room or session found for that code' });
    }

    const liveSession = await sessionsRepo.findLatestLiveByClassId(cls.id);
    return res.json({
      type: 'room',
      code,
      roomCode: cls.room_code,
      classId: cls.id,
      className: cls.name,
      classDescription: cls.description || null,
      ageRange: cls.age_range || null,
      hasLiveSession: !!liveSession,
      sessionShortCode: liveSession?.short_code || null,
      sessionStatus: liveSession?.status || null,
      sessionTitle: liveSession?.title || null
    });
  } catch (error) {
    console.error('Resolve session code error:', error);
    res.status(500).json({ error: 'Failed to resolve code' });
  }
});

router.get('/ocr/status', async (_req, res) => {
  try {
    const availability = await getOCRAvailability();
    res.json(availability);
  } catch (error) {
    console.error('OCR status error:', error);
    res.status(500).json({ error: 'Failed to inspect OCR availability' });
  }
});

// Get detailed analytics for a specific session
router.get('/:shortCode/analytics', requireAuth, async (req, res) => {
  try {
    const { shortCode } = req.params;
    const userId = req.user.id;

    // Verify user has access to this session
    const session = await sessionsRepo.findByShortCode(shortCode);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Check if user is the owner, in the class, or was a participant
    const hasAccess = session.owner_user_id === userId ||
      (session.class_id && await sessionsRepo.userInClass(session.class_id, userId)) ||
      await sessionsRepo.userWasParticipant(session.id, userId);

    if (!hasAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get detailed session analytics
    const analytics = await sessionsRepo.getDetailedAnalytics(session.id, userId);

    res.json({
      session: {
        id: session.id,
        shortCode: session.short_code,
        title: session.title,
        status: session.status,
        createdAt: session.created_at,
        endedAt: session.ended_at
      },
      analytics
    });
  } catch (error) {
    console.error('Session analytics error:', error);
    res.status(500).json({ error: 'Failed to load session analytics' });
  }
});

/**
 * Get the post-session report for a session.
 * Returns the persisted JSON if one exists; if the session has ended but no
 * report has been generated yet, lazily generates one. Auth-gated to users
 * who own, teach, or participated in the session.
 */
router.get('/:code/report', requireAuth, async (req, res) => {
  try {
    const { code } = req.params;
    const userId = req.user.id;

    const session = await sessionsRepo.findByShortCode(code);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const hasAccess = session.owner_user_id === userId ||
      (session.class_id && await sessionsRepo.userInClass(session.class_id, userId)) ||
      await sessionsRepo.userWasParticipant(session.id, userId);
    if (!hasAccess) return res.status(403).json({ error: 'Access denied' });

    let report = await sessionReportsRepo.getBySession(session.id);
    if (!report && session.status === 'ended') {
      const generated = await reportBuilder.assembleAndPersistReport({
        sessionId: session.id,
        apiKey: process.env.ANTHROPIC_API_KEY
      });
      return res.json({ status: 'ready', report: generated, generatedAt: new Date().toISOString() });
    }
    if (!report) {
      return res.status(409).json({ error: 'Report not yet available; session is still active.' });
    }
    res.json({ status: 'ready', report: report.report_json, generatedAt: report.generated_at });
  } catch (error) {
    console.error('Get session report error:', error);
    res.status(500).json({ error: 'Failed to load session report' });
  }
});

router.get('/:code/source-text', requireAuth, async (req, res) => {
  try {
    const session = await loadSessionForUser(req, res);
    if (!session) return;

    const materials = await materialChunksRepo.getViewerBySession(session.id);
    res.json({
      sessionId: session.short_code,
      sessionTitle: session.title,
      materials
    });
  } catch (error) {
    console.error('Get source text error:', error);
    res.status(500).json({ error: 'Failed to load source text' });
  }
});

/**
 * Get session by short code
 * GET /api/sessions/:code
 */
router.get('/:code', async (req, res) => {
  try {
    const session = await sessionsRepo.findByShortCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const userId = req.user?.id || null;
    const isOwner = userId && session.owner_user_id === userId;
    const hasFullAccess = isOwner ||
      (userId && session.class_id && await sessionsRepo.userInClass(session.class_id, userId)) ||
      (userId && await sessionsRepo.userWasParticipant(session.id, userId));

    // Public minimal payload — enough for an anonymous joiner to land on the
    // lobby. Sensitive fields (participants, materials, primed context) are
    // gated behind hasFullAccess.
    const payload = {
      id: session.id,
      shortCode: session.short_code,
      title: session.title,
      openingQuestion: session.opening_question,
      conversationGoal: session.conversation_goal,
      status: session.status,
      createdAt: session.created_at,
      startedAt: session.started_at,
      endedAt: session.ended_at
    };

    if (hasFullAccess) {
      const [participants, materials, primedContext] = await Promise.all([
        participantsRepo.getBySession(session.id),
        materialsRepo.getBySession(session.id),
        primedContextRepo.getBySession(session.id)
      ]);
      payload.participants = participants.map(p => ({
        id: p.id,
        name: p.name,
        age: p.age,
        role: p.role
      }));
      payload.materials = materials.map(m => ({
        id: m.id,
        filename: m.filename,
        type: m.original_type
      }));
      payload.primedContext = primedContext ? {
        status: primedContext.comprehension_status,
        summary: primedContext.summary,
        keyThemes: primedContext.key_themes,
        potentialTensions: primedContext.potential_tensions,
        suggestedAngles: primedContext.suggested_angles
      } : null;
    }

    res.json(payload);
  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * Upload materials to a session
 * POST /api/sessions/:code/materials
 */
router.post('/:code/materials', requireAuth, storage.upload.single('file'), async (req, res) => {
  try {
    const session = await loadSessionForUser(req, res, { ownerOnly: true });
    if (!session) return;

    const { type, url, text, filename: bodyFilename } = req.body;
    let extractedText = '';
    let extractionMetadata = {};
    let filename = null;
    let storagePath = null;
    let originalType = type || 'other';

    if (req.file) {
      filename = req.file.sanitizedFilename;
      storagePath = req.file.path;
      originalType = contentExtractor.getFileType(filename, req.file.mimetype);
      const extracted = await contentExtractor.extract(req.file.buffer, originalType);
      extractedText = extracted.text || '';
      extractionMetadata = extracted.metadata || {};
    } else if (text) {
      // Pre-extracted text (e.g. carried over from a previous session's materials)
      filename = bodyFilename || 'class-material.txt';
      originalType = type || 'txt';
      extractedText = text;
    } else if (url) {
      originalType = 'url';
      filename = url.substring(0, 255);
      const extracted = await contentExtractor.extract(null, 'url', { url });
      extractedText = extracted.text || '';
      extractionMetadata = extracted.metadata || {};
    } else {
      return res.status(400).json({ error: 'Either file or URL is required' });
    }

    // Note: Full text stored for analysis; truncation happens only in LLM prompt construction (see enhancedFacilitator + primer)

    const material = await materialsRepo.add(session.id, {
      filename,
      originalType,
      storagePath,
      url: originalType === 'url' ? url : null,
      extractedText
    });

    try {
      await materialChunksRepo.replaceForMaterial(material.id, session.id, extractedText, {
        sourceKind: text ? 'pasted' : originalType === 'url' ? 'url' : 'material'
      });
    } catch (chunkError) {
      console.warn('Material chunking warning:', chunkError.message);
    }

    res.status(201).json({
      id: material.id,
      filename: material.filename,
      type: material.original_type,
      extractedLength: extractedText.length,
      extractionMethod: extractionMetadata.extractionMethod || null,
      extractionMetadata,
      uploadedAt: material.uploaded_at
    });
  } catch (error) {
    console.error('Upload material error:', error);
    res.status(500).json({ error: 'Failed to upload material: ' + error.message });
  }
});

/**
 * Prime session materials
 * POST /api/sessions/:code/prime
 */
router.post('/:code/prime', requireAuth, async (req, res) => {
  try {
    const session = await loadSessionForUser(req, res, { ownerOnly: true });
    if (!session) return;

    let primedContext = await primedContextRepo.getBySession(session.id);
    if (primedContext?.comprehension_status === 'complete') {
      return res.json({
        status: 'complete',
        context: {
          summary: primedContext.summary,
          keyThemes: primedContext.key_themes,
          potentialTensions: primedContext.potential_tensions,
          suggestedAngles: primedContext.suggested_angles
        }
      });
    }

    const combinedText = await materialsRepo.getCombinedText(session.id);
    if (!combinedText) {
      return res.json({
        status: 'ready',
        message: 'No materials to prime',
        context: null
      });
    }

    if (!primedContext) {
      primedContext = await primedContextRepo.create(session.id);
    }

    await primedContextRepo.markProcessing(primedContext.id);

    try {
      const result = await sessionPrimer.prime(combinedText, session.conversation_goal);
      const updated = await primedContextRepo.complete(primedContext.id, result);

      res.json({
        status: 'complete',
        context: {
          summary: updated.summary,
          keyThemes: updated.key_themes,
          potentialTensions: updated.potential_tensions,
          suggestedAngles: updated.suggested_angles
        }
      });
    } catch (primeError) {
      await primedContextRepo.markFailed(primedContext.id, primeError.message);
      throw primeError;
    }
  } catch (error) {
    console.error('Prime session error:', error);
    res.status(500).json({ error: 'Failed to prime session: ' + error.message });
  }
});

/**
 * Get session messages
 * GET /api/sessions/:code/messages
 */
router.get('/:code/messages', requireAuth, async (req, res) => {
  try {
    const session = await loadSessionForUser(req, res);
    if (!session) return;

    const limit = parseInt(req.query.limit) || 100;
    const offset = parseInt(req.query.offset) || 0;
    const messages = await messagesRepo.getBySession(session.id, { limit, offset });

    res.json(messages.map(m => ({
      id: m.id,
      senderType: m.sender_type,
      senderName: m.sender_name || m.participant_name,
      content: m.content,
      moveType: m.move_type,
      targetParticipantName: m.target_participant_name,
      createdAt: m.created_at
    })));
  } catch (error) {
    console.error('Get messages error:', error);
    res.status(500).json({ error: 'Failed to get messages' });
  }
});

/**
 * Delete a material
 * DELETE /api/sessions/:code/materials/:materialId
 */
router.delete('/:code/materials/:materialId', requireAuth, async (req, res) => {
  try {
    const session = await loadSessionForUser(req, res, { ownerOnly: true });
    if (!session) return;

    const material = await materialsRepo.findById(req.params.materialId);
    if (!material) {
      return res.status(404).json({ error: 'Material not found' });
    }
    if (material.session_id !== session.id) {
      return res.status(404).json({ error: 'Material not found' });
    }

    if (material.storage_path) {
      await storage.delete(material.storage_path);
    }

    await materialsRepo.remove(material.id);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete material error:', error);
    res.status(500).json({ error: 'Failed to delete material' });
  }
});

/**
 * Get available topics
 * GET /api/topics
 */
router.get('/topics', (req, res) => {
  res.json(DISCUSSION_TOPICS.map(t => ({
    id: t.id,
    title: t.title,
    passage: t.passage,
    ageRange: t.ageRange,
    openingQuestion: t.openingQuestion
  })));
});

module.exports = router;
