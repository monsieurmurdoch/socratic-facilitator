/**
 * Topics Routes
 *
 * REST API endpoints for discussion topics
 */

const express = require('express');
const router = express.Router();
const { DISCUSSION_TOPICS } = require('../config');

/**
 * Get available discussion topics
 * GET /api/topics
 */
router.get('/', (req, res) => {
  const topics = DISCUSSION_TOPICS.map(t => ({
    id: t.id,
    title: t.title,
    passage: t.passage,
    openingQuestion: t.openingQuestion,
    ageRange: t.ageRange
  }));
  res.json(topics);
});

/**
 * Get a specific topic
 * GET /api/topics/:id
 */
router.get('/:id', (req, res) => {
  const topic = DISCUSSION_TOPICS.find(t => t.id === req.params.id);
  if (!topic) {
    return res.status(404).json({ error: 'Topic not found' });
  }
  res.json({
    id: topic.id,
    title: topic.title,
    passage: topic.passage,
    openingQuestion: topic.openingQuestion,
    followUpAngles: topic.followUpAngles,
    ageRange: topic.ageRange
  });
});

module.exports = router;
