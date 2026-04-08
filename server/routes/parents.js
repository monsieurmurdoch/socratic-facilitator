const express = require('express');
const router = express.Router();
const parentLinksRepo = require('../db/repositories/parentStudentLinks');
const { requireAuth, requireAnyRole } = require('../auth');

router.use(express.json({ limit: '1mb' }));

/**
 * POST /api/parents/link
 * Link a parent to a student by email.
 * Only teachers and admins can create parent-student links.
 */
router.post('/link', requireAuth, requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const { parentEmail, childEmail } = req.body;
    if (!parentEmail || !childEmail) {
      return res.status(400).json({ error: 'parentEmail and childEmail are required' });
    }

    const result = await parentLinksRepo.linkByEmails(parentEmail, childEmail);

    if (!result.linked) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ success: true, parent: result.parent, student: result.student, linksCreated: result.linksCreated });
  } catch (error) {
    console.error('[Parents] Link error:', error);
    res.status(500).json({ error: 'Failed to link parent to student' });
  }
});

/**
 * GET /api/parents/children
 * List all students linked to the authenticated parent.
 */
router.get('/children', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'Parent') {
      return res.status(403).json({ error: 'Only parent accounts can view linked students' });
    }

    const students = await parentLinksRepo.listLinkedStudents(req.user.id);
    res.json(students);
  } catch (error) {
    console.error('[Parents] List children error:', error);
    res.status(500).json({ error: 'Failed to list children' });
  }
});

/**
 * GET /api/parents/children/:id/sessions
 * Get session history for a specific linked student.
 */
router.get('/children/:id/sessions', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'Parent') {
      return res.status(403).json({ error: 'Only parent accounts can view student sessions' });
    }

    const sessions = await parentLinksRepo.getStudentSessionsForParent(req.user.id, req.params.id);
    res.json(sessions);
  } catch (error) {
    console.error('[Parents] Get student sessions error:', error);
    res.status(500).json({ error: 'Failed to get student sessions' });
  }
});

module.exports = router;
