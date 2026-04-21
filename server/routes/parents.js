const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const parentLinksRepo = require('../db/repositories/parentStudentLinks');
const { requireAuth, requireAnyRole } = require('../auth');
const { normalizeEmail, hashPassword } = require('../auth');
const { logAudit } = require('../audit');

router.use(express.json({ limit: '1mb' }));

function requireParent(req, res) {
  if (req.user.role !== 'Parent') {
    res.status(403).json({ error: 'Only parent accounts can use this endpoint' });
    return false;
  }
  return true;
}

function cleanOptional(value, max = 120) {
  const trimmed = String(value || '').trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

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
 * GET /api/parents/dashboard
 * Parent-facing overview: linked children, child-safe progress, billing shell, and booking requests.
 */
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    if (!requireParent(req, res)) return;

    const dashboard = await parentLinksRepo.getParentDashboard(req.user.id);
    res.json({
      ...dashboard,
      roadmap: {
        next: [
          'Connect Stripe customer/subscription for parent-paid cohorts',
          'Add teacher availability and parent booking requests',
          'Recommend curriculum paths from age, grade, and discussion history'
        ]
      }
    });
  } catch (error) {
    console.error('[Parents] Dashboard error:', error);
    res.status(500).json({ error: 'Failed to load parent dashboard' });
  }
});

/**
 * POST /api/parents/children
 * Parent creates or links a child account. If the child email already exists,
 * it links that Student account. Otherwise, it creates a managed Student account.
 */
router.post('/children', requireAuth, async (req, res) => {
  try {
    if (!requireParent(req, res)) return;

    const name = cleanOptional(req.body.name, 100);
    const email = normalizeEmail(req.body.email || '');
    const gradeLevel = cleanOptional(req.body.gradeLevel, 40);
    const ageBand = cleanOptional(req.body.ageBand, 40);
    const readingLevel = cleanOptional(req.body.readingLevel, 80);
    const guardianNotes = cleanOptional(req.body.guardianNotes, 1000);

    if (!name && !email) {
      return res.status(400).json({ error: 'Enter a child name or an existing child email.' });
    }

    if (email) {
      const linked = await parentLinksRepo.linkExistingStudentToParent({
        parentUserId: req.user.id,
        studentEmail: email,
        profile: { gradeLevel, ageBand, readingLevel, guardianNotes }
      });
      if (linked.linked) {
        await logAudit({
          req,
          actorUserId: req.user.id,
          action: 'parent.child_linked',
          entityType: 'user',
          entityId: linked.student.id,
          metadata: { method: 'existing_email' }
        });
        return res.status(201).json({ success: true, student: linked.student, mode: 'linked_existing' });
      }
      if (linked.error !== 'Student not found') {
        return res.status(400).json({ error: linked.error });
      }
    }

    if (!name) {
      return res.status(404).json({ error: 'No student account exists for that email. Add a name to create a managed child profile.' });
    }

    const childEmail = email || `managed-${crypto.randomUUID()}@socratic.local`;
    const randomPassword = crypto.randomBytes(32).toString('hex');
    const passwordHash = await hashPassword(randomPassword);
    const student = await parentLinksRepo.createManagedStudent({
      parentUserId: req.user.id,
      name,
      email: childEmail,
      passwordHash,
      gradeLevel,
      ageBand,
      readingLevel
    });

    if (guardianNotes) {
      await parentLinksRepo.updateStudentProfile({
        parentUserId: req.user.id,
        studentUserId: student.id,
        gradeLevel,
        ageBand,
        readingLevel,
        guardianNotes
      });
    }

    await logAudit({
      req,
      actorUserId: req.user.id,
      action: 'parent.child_created',
      entityType: 'user',
      entityId: student.id,
      metadata: { managed: true, hasEmail: Boolean(email) }
    });

    res.status(201).json({
      success: true,
      student: { id: student.id, name: student.name, email: student.email },
      mode: 'created_managed'
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A user with that child email already exists.' });
    }
    console.error('[Parents] Add child error:', error);
    res.status(500).json({ error: 'Failed to add child' });
  }
});

router.patch('/children/:id/profile', requireAuth, async (req, res) => {
  try {
    if (!requireParent(req, res)) return;

    const profile = await parentLinksRepo.updateStudentProfile({
      parentUserId: req.user.id,
      studentUserId: req.params.id,
      gradeLevel: cleanOptional(req.body.gradeLevel, 40),
      ageBand: cleanOptional(req.body.ageBand, 40),
      readingLevel: cleanOptional(req.body.readingLevel, 80),
      guardianNotes: cleanOptional(req.body.guardianNotes, 1000)
    });

    if (!profile) {
      return res.status(404).json({ error: 'Linked child not found' });
    }

    await logAudit({
      req,
      actorUserId: req.user.id,
      action: 'parent.child_profile_updated',
      entityType: 'user',
      entityId: req.params.id,
      metadata: {}
    });

    res.json({ success: true, profile });
  } catch (error) {
    console.error('[Parents] Update child profile error:', error);
    res.status(500).json({ error: 'Failed to update child profile' });
  }
});

/**
 * GET /api/parents/children
 * List all students linked to the authenticated parent.
 */
router.get('/children', requireAuth, async (req, res) => {
  try {
    if (!requireParent(req, res)) return;

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
    if (!requireParent(req, res)) return;

    const sessions = await parentLinksRepo.getStudentSessionsForParent(req.user.id, req.params.id);
    res.json(sessions);
  } catch (error) {
    console.error('[Parents] Get student sessions error:', error);
    res.status(500).json({ error: 'Failed to get student sessions' });
  }
});

module.exports = router;
