/**
 * Conversation State Repository
 *
 * Handles conversation state snapshots for analytics
 */

const db = require('../index');

/**
 * Save a conversation state snapshot
 */
async function save(sessionId, messageId, stateData) {
  const {
    topicDrift,
    trajectory,
    reasoningDepth,
    listeningScore,
    tensionProductivity,
    dominanceScore,
    inclusionScore,
    unchallengedClaims,
    unexploredTensions,
    ripeBranches,
    interventionThreshold,
    aiShouldSpeak,
    aiReasoning
  } = stateData;

  const result = await db.query(
    `INSERT INTO conversation_state (
      session_id, message_id,
      topic_drift, trajectory, reasoning_depth, listening_score,
      tension_productivity, dominance_score, inclusion_score,
      unchallenged_claims, unexplored_tensions, ripe_branches,
      intervention_threshold, ai_should_speak, ai_reasoning
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING *`,
    [
      sessionId, messageId,
      topicDrift, trajectory, reasoningDepth, listeningScore,
      tensionProductivity, dominanceScore, inclusionScore,
      JSON.stringify(unchallengedClaims || []),
      JSON.stringify(unexploredTensions || []),
      JSON.stringify(ripeBranches || []),
      interventionThreshold, aiShouldSpeak, aiReasoning
    ]
  );

  return result.rows[0];
}

/**
 * Get latest state for a session
 */
async function getLatest(sessionId) {
  const result = await db.query(
    `SELECT * FROM conversation_state
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

/**
 * Get state history for a session
 */
async function getHistory(sessionId, limit = 50) {
  const result = await db.query(
    `SELECT * FROM conversation_state
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, limit]
  );
  return result.rows.reverse();
}

/**
 * Get state summary for dashboard
 */
async function getSummary(sessionId) {
  const result = await db.query(
    `SELECT
      AVG(topic_drift) as avg_drift,
      AVG(reasoning_depth) as avg_depth,
      AVG(listening_score) as avg_listening,
      AVG(dominance_score) as avg_dominance,
      COUNT(*) as total_snapshots,
      COUNT(*) FILTER (WHERE ai_should_speak = true) as interventions
     FROM conversation_state
     WHERE session_id = $1`,
    [sessionId]
  );
  return result.rows[0];
}

module.exports = {
  save,
  getLatest,
  getHistory,
  getSummary
};
