/**
 * Sessions API Routes
 */

const express = require('express');
const router = express.Router();
const sessionsRepo = require('../db/repositories/sessions');
const participantsRepo = require('../db/repositories/participants');
const messagesRepo = require('../db/repositories/messages');
const messageAnalyticsRepo = require('../db/repositories/messageAnalytics');
const materialsRepo = require('../db/repositories/materials');
const materialChunksRepo = require('../db/repositories/materialChunks');
const primedContextRepo = require('../db/repositories/primedContext');
const sessionReportsRepo = require('../db/repositories/sessionReports');
const classesRepo = require('../db/repositories/classes');
const classMembershipsRepo = require('../db/repositories/classMemberships');
const storage = require('../storage');
const contentExtractor = require('../content/extractor');
const { getOCRAvailability } = require('../content/ocr');
const sessionPrimer = require('../content/primer');
const { DISCUSSION_TOPICS } = require('../config');
const { requireAuth } = require('../auth');
const { apiLimiter } = require('../middleware/rate-limit');
const { issueSessionAccessToken, getSessionAccessFromRequest } = require('../sessionAccess');

// Enable JSON body parsing
router.use(express.json({ limit: '10mb' }));
router.use(express.urlencoded({ extended: true }));

async function getSessionAccess(session, user) {
  if (!user) return { canView: false, canManage: false };
  if (user.role === 'Admin' || user.role === 'SuperAdmin') {
    return { canView: true, canManage: true };
  }

  if (session.owner_user_id === user.id) {
    return { canView: true, canManage: true };
  }

  if (session.class_id) {
    const cls = await classesRepo.findById(session.class_id);
    if (cls?.owner_user_id === user.id) {
      return { canView: true, canManage: true };
    }

    const membership = await classMembershipsRepo.findByClassAndUser(session.class_id, user.id);
    if (membership) {
      const canManage = membership.role === 'Teacher' || membership.role === 'Admin';
      return { canView: true, canManage };
    }
  }

  if (await sessionsRepo.userWasParticipant(session.id, user.id)) {
    return { canView: true, canManage: false };
  }

  return { canView: false, canManage: false };
}

async function requireSessionAccess(req, res, session, { manage = false } = {}) {
  const signedAccess = getSessionAccessFromRequest(req, session);
  if (signedAccess.canView && (!manage || signedAccess.canManage)) {
    return signedAccess;
  }

  const access = await getSessionAccess(session, req.user);
  if (manage ? !access.canManage : !access.canView) {
    res.status(req.user ? 403 : 401).json({ error: req.user ? 'Access denied' : 'Authentication or session access required' });
    return null;
  }
  return access;
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
      sessionAccessToken: issueSessionAccessToken(session, {
        sessionRole: 'teacher',
        scope: 'manage'
      }),
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

/**
 * Get available topics
 * GET /api/sessions/topics
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

    const access = await getSessionAccess(session, req.user);
    if (!access.canView) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get detailed session analytics
    const analytics = await sessionsRepo.getDetailedAnalytics(session.id, userId);
    const messages = await messagesRepo.getBySession(session.id, { limit: 500 });
    const messageAnalytics = await messageAnalyticsRepo.listBySession(session.id, 500);
    const analyticsByMessageId = new Map(messageAnalytics.map(row => [row.message_id, row]));
    const teacherNotesReport = access.canManage
      ? await sessionReportsRepo.getBySessionAndType(session.id, 'teacher_notes')
      : null;

    res.json({
      session: {
        id: session.id,
        shortCode: session.short_code,
        title: session.title,
        status: session.status,
        createdAt: session.created_at,
        endedAt: session.ended_at
      },
      canManage: access.canManage,
      teacherNotes: teacherNotesReport?.report_json?.notes || '',
      analytics,
      messages: messages.map(m => {
        const row = analyticsByMessageId.get(m.id);
        return {
          id: m.id,
          participantId: m.participant_id,
          senderType: m.sender_type,
          senderName: m.sender_name || m.participant_name,
          content: m.content,
          moveType: m.move_type,
          targetParticipantName: m.target_participant_name,
          createdAt: m.created_at,
          isViewerMessage: !access.canManage && m.participant_user_id === userId,
          analytics: row ? {
            specificity: Number(row.specificity || 0),
            profoundness: Number(row.profoundness || 0),
            coherence: Number(row.coherence || 0),
            discussionValue: Number(row.discussion_value || 0),
            contributionWeight: Number(row.contribution_weight || 0),
            engagementEstimate: Number(row.engagement_estimate || 0),
            respondedToPeer: !!row.responded_to_peer,
            referencedAnchor: !!row.referenced_anchor,
            isAnchor: !!row.is_anchor,
            reasoning: row.reasoning || null
          } : null
        };
      })
    });
  } catch (error) {
    console.error('Session analytics error:', error);
    res.status(500).json({ error: 'Failed to load session analytics' });
  }
});

router.post('/:shortCode/teacher-notes', requireAuth, async (req, res) => {
  try {
    const { shortCode } = req.params;
    const session = await sessionsRepo.findByShortCode(shortCode);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const access = await requireSessionAccess(req, res, session, { manage: true });
    if (!access) return;

    const notes = String(req.body?.notes || '').slice(0, 12000);
    const report = await sessionReportsRepo.upsert({
      sessionId: session.id,
      reportType: 'teacher_notes',
      reportJson: {
        notes,
        updatedByUserId: req.user.id,
        updatedAt: new Date().toISOString()
      }
    });

    res.json({
      notes: report.report_json?.notes || '',
      updatedAt: report.report_json?.updatedAt || report.generated_at
    });
  } catch (error) {
    console.error('Teacher notes error:', error);
    res.status(500).json({ error: 'Failed to save teacher notes' });
  }
});

router.get('/:code/source-text', async (req, res) => {
  try {
    const session = await sessionsRepo.findByShortCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!(await requireSessionAccess(req, res, session))) return;

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
    if (!(await requireSessionAccess(req, res, session))) return;

    const participants = await participantsRepo.getBySession(session.id);
    const materials = await materialsRepo.getBySession(session.id);
    const primedContext = await primedContextRepo.getBySession(session.id);

    res.json({
      id: session.id,
      shortCode: session.short_code,
      title: session.title,
      openingQuestion: session.opening_question,
      conversationGoal: session.conversation_goal,
      status: session.status,
      createdAt: session.created_at,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      participants: participants.map(p => ({
        id: p.id,
        name: p.name,
        age: p.age,
        role: p.role
      })),
      materials: materials.map(m => ({
        id: m.id,
        filename: m.filename,
        type: m.original_type
      })),
      primedContext: primedContext ? {
        status: primedContext.comprehension_status,
        summary: primedContext.summary,
        keyThemes: primedContext.key_themes,
        potentialTensions: primedContext.potential_tensions,
        suggestedAngles: primedContext.suggested_angles
      } : null
    });
  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * Upload materials to a session
 * POST /api/sessions/:code/materials
 */
router.post('/:code/materials', storage.upload.single('file'), async (req, res) => {
  try {
    const session = await sessionsRepo.findByShortCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!(await requireSessionAccess(req, res, session, { manage: true }))) return;

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
router.post('/:code/prime', async (req, res) => {
  try {
    const session = await sessionsRepo.findByShortCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!(await requireSessionAccess(req, res, session, { manage: true }))) return;

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

      // Score chunk importance (fire-and-forget, non-blocking)
      setImmediate(async () => {
        try {
          const chunks = await materialChunksRepo.getBySession(session.id);
          if (chunks.length > 0) {
            const scores = await sessionPrimer.scoreChunkImportance(chunks, session.conversation_goal);
            if (scores.length > 0) {
              await materialChunksRepo.updateImportanceBatch(scores);
            }
          }
        } catch (err) {
          console.warn('[Prime] Chunk importance scoring failed:', err.message);
        }
      });

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
router.get('/:code/messages', async (req, res) => {
  try {
    const session = await sessionsRepo.findByShortCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!(await requireSessionAccess(req, res, session))) return;

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
router.delete('/:code/materials/:materialId', async (req, res) => {
  try {
    const session = await sessionsRepo.findByShortCode(req.params.code);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    if (!(await requireSessionAccess(req, res, session, { manage: true }))) return;

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

module.exports = router;
