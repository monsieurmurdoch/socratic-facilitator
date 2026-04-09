const express = require('express');
const router = express.Router();
const classesRepo = require('../db/repositories/classes');
const classMembershipsRepo = require('../db/repositories/classMemberships');
const usersRepo = require('../db/repositories/users');
const { USER_ROLES, requireAuth, requireAnyRole } = require('../auth');

router.use(express.json({ limit: '1mb' }));
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const classes = ['Teacher', 'Admin', 'SuperAdmin'].includes(req.user.role)
      ? await classesRepo.listByOwner(req.user.id)
      : await classesRepo.listByUser(req.user.id);
    res.json(classes.map(c => ({
      id: c.id,
      name: c.name,
      description: c.description,
      ageRange: c.age_range,
      membershipRole: c.membership_role || req.user.role,
      sessionCount: parseInt(c.session_count, 10) || 0,
      createdAt: c.created_at
    })));
  } catch (error) {
    console.error('List classes error:', error);
    res.status(500).json({ error: 'Failed to load classes' });
  }
});

router.post('/', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const description = String(req.body.description || '').trim() || null;
    const ageRange = String(req.body.ageRange || '').trim() || null;

    if (!name) {
      return res.status(400).json({ error: 'Class name is required' });
    }

    const created = await classesRepo.create({
      ownerUserId: req.user.id,
      name,
      description,
      ageRange
    });
    await classMembershipsRepo.add({
      classId: created.id,
      userId: req.user.id,
      role: req.user.role
    });

    res.status(201).json({
      id: created.id,
      name: created.name,
      description: created.description,
      ageRange: created.age_range,
      membershipRole: req.user.role,
      sessionCount: 0,
      createdAt: created.created_at
    });
  } catch (error) {
    console.error('Create class error:', error);
    res.status(500).json({ error: 'Failed to create class' });
  }
});

router.patch('/reorder', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const orderedIds = req.body.order;
    if (!Array.isArray(orderedIds) || orderedIds.some(id => typeof id !== 'string')) {
      return res.status(400).json({ error: 'order must be an array of class IDs' });
    }
    await classesRepo.reorder(req.user.id, orderedIds);
    res.json({ ok: true });
  } catch (error) {
    console.error('Reorder classes error:', error);
    res.status(500).json({ error: 'Failed to reorder classes' });
  }
});

router.patch('/:id', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const cls = await classesRepo.findById(req.params.id);
    if (!cls) {
      return res.status(404).json({ error: 'Class not found' });
    }
    if (cls.owner_user_id !== req.user.id && !['Admin', 'SuperAdmin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const name = req.body.name !== undefined ? String(req.body.name).trim() : undefined;
    const description = req.body.description !== undefined ? String(req.body.description).trim() || null : undefined;
    const ageRange = req.body.ageRange !== undefined ? String(req.body.ageRange).trim() || null : undefined;

    if (name !== undefined && !name) {
      return res.status(400).json({ error: 'Class name cannot be empty' });
    }

    const updated = await classesRepo.update(req.params.id, { name, description, ageRange });
    res.json({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      ageRange: updated.age_range,
      sessionCount: parseInt(cls.session_count || '0', 10),
      createdAt: updated.created_at
    });
  } catch (error) {
    console.error('Update class error:', error);
    res.status(500).json({ error: 'Failed to update class' });
  }
});

router.get('/:id/members', requireAuth, async (req, res) => {
  try {
    const cls = await classesRepo.findById(req.params.id);
    if (!cls) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const isOwner = cls.owner_user_id === req.user.id;
    const isElevated = ['Admin', 'SuperAdmin'].includes(req.user.role);
    if (!isOwner && !isElevated) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const members = await classMembershipsRepo.listByClass(cls.id);
    res.json(members.map(member => ({
      id: member.id,
      userId: member.user_id,
      name: member.name,
      email: member.email,
      role: member.role,
      createdAt: member.created_at
    })));
  } catch (error) {
    console.error('List class members error:', error);
    res.status(500).json({ error: 'Failed to load class members' });
  }
});

router.post('/:id/members', requireAnyRole(['Teacher', 'Admin', 'SuperAdmin']), async (req, res) => {
  try {
    const cls = await classesRepo.findById(req.params.id);
    if (!cls) {
      return res.status(404).json({ error: 'Class not found' });
    }

    const isOwner = cls.owner_user_id === req.user.id;
    const isElevated = ['Admin', 'SuperAdmin'].includes(req.user.role);
    if (!isOwner && !isElevated) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const email = String(req.body.email || '').trim().toLowerCase();
    const role = String(req.body.role || '').trim();

    if (!email || !role) {
      return res.status(400).json({ error: 'Email and role are required' });
    }

    if (!USER_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const user = await usersRepo.findWithPasswordByEmail(email);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const membership = await classMembershipsRepo.add({
      classId: cls.id,
      userId: user.id,
      role
    });

    res.status(201).json({
      id: membership.id,
      classId: membership.class_id,
      userId: membership.user_id,
      role: membership.role
    });
  } catch (error) {
    console.error('Add class member error:', error);
    res.status(500).json({ error: 'Failed to add class member' });
  }
});

module.exports = router;
