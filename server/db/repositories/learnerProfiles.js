/**
 * Learner Profiles Repository
 *
 * Handles longitudinal tracking of learner progress across sessions.
 */

const db = require('../index');

/**
 * Get profile by user ID
 */
async function findByUser(userId) {
  const result = await db.query(
    'SELECT * FROM learner_profiles WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

/**
 * Create or update profile using INSERT ON CONFLICT
 */
async function upsert(userId, data) {
  const {
    totalSessions = 0,
    totalMessages = 0,
    totalSpeakingSeconds = 0,
    avgSpecificity = 0,
    avgProfoundness = 0,
    avgCoherence = 0,
    avgContributionScore = 0,
    estimatedLevel = 'unknown',
    topicsDiscussed = [],
    strengths = [],
    growthAreas = [],
    sessionSummaries = [],
    sttCorrections = []
  } = data;

  const result = await db.query(
    `INSERT INTO learner_profiles (
      user_id,
      total_sessions,
      total_messages,
      total_speaking_seconds,
      avg_specificity,
      avg_profoundness,
      avg_coherence,
      avg_contribution_score,
      estimated_level,
      topics_discussed,
      strengths,
      growth_areas,
      session_summaries,
      stt_corrections,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET total_sessions = EXCLUDED.total_sessions,
        total_messages = EXCLUDED.total_messages,
        total_speaking_seconds = EXCLUDED.total_speaking_seconds,
        avg_specificity = EXCLUDED.avg_specificity,
        avg_profoundness = EXCLUDED.avg_profoundness,
        avg_coherence = EXCLUDED.avg_coherence,
        avg_contribution_score = EXCLUDED.avg_contribution_score,
        estimated_level = EXCLUDED.estimated_level,
        topics_discussed = EXCLUDED.topics_discussed,
        strengths = EXCLUDED.strengths,
        growth_areas = EXCLUDED.growth_areas,
        session_summaries = EXCLUDED.session_summaries,
        stt_corrections = EXCLUDED.stt_corrections,
        updated_at = NOW()
    RETURNING *`,
    [
      userId,
      totalSessions,
      totalMessages,
      totalSpeakingSeconds,
      avgSpecificity,
      avgProfoundness,
      avgCoherence,
      avgContributionScore,
      estimatedLevel,
      JSON.stringify(topicsDiscussed),
      JSON.stringify(strengths),
      JSON.stringify(growthAreas),
      JSON.stringify(sessionSummaries),
      JSON.stringify(sttCorrections)
    ]
  );
  return result.rows[0];
}

/**
 * Append a session summary to the session_summaries JSONB array
 */
async function addSessionSummary(userId, sessionId, summary) {
  // Wrap in array for JSONB || operator (appends element to JSONB array)
  const result = await db.query(
    `UPDATE learner_profiles
     SET session_summaries = session_summaries || $1::jsonb,
         updated_at = NOW()
     WHERE user_id = $2
     RETURNING *`,
    [JSON.stringify([summary]), userId]
  );
  return result.rows[0] || null;
}

/**
 * Append an STT correction to the stt_corrections JSONB array
 */
async function addSttCorrection(userId, from, to, context) {
  const correction = {
    from,
    to,
    context,
    timestamp: new Date().toISOString()
  };

  // Wrap in array for JSONB || operator
  const result = await db.query(
    `UPDATE learner_profiles
     SET stt_corrections = stt_corrections || $1::jsonb,
         updated_at = NOW()
     WHERE user_id = $2
     RETURNING *`,
    [JSON.stringify([correction]), userId]
  );
  return result.rows[0] || null;
}

/**
 * Get memory context for prompt injection
 * Returns the last N session summaries for a user
 */
async function getMemoryContext(userId, limit = 5) {
  const profile = await findByUser(userId);
  if (!profile || !profile.session_summaries || profile.session_summaries.length === 0) {
    return [];
  }

  // Return the last N summaries (most recent first)
  const summaries = Array.isArray(profile.session_summaries)
    ? profile.session_summaries
    : JSON.parse(profile.session_summaries || '[]');

  return summaries.slice(-limit).reverse();
}

module.exports = {
  findByUser,
  upsert,
  addSessionSummary,
  addSttCorrection,
  getMemoryContext
};
