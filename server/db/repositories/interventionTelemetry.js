const db = require('../index');

async function create({
  sessionId,
  triggerMessageId = null,
  facilitatorMessageId = null,
  model = null,
  promptVersion = null,
  move = null,
  latencyMs = null,
  inputTokens = null,
  outputTokens = null,
  estimatedCostUsd = null,
  sourceChunkIds = [],
  decisionJson = {}
}) {
  const result = await db.query(
    `INSERT INTO intervention_telemetry (
      session_id, trigger_message_id, facilitator_message_id, model, prompt_version,
      move, latency_ms, input_tokens, output_tokens, estimated_cost_usd,
      source_chunk_ids, decision_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      sessionId,
      triggerMessageId,
      facilitatorMessageId,
      model,
      promptVersion,
      move,
      latencyMs,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      sourceChunkIds,
      JSON.stringify(decisionJson || {})
    ]
  );
  return result.rows[0];
}

async function listBySession(sessionId, limit = 200) {
  const result = await db.query(
    `SELECT *
     FROM intervention_telemetry
     WHERE session_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, limit]
  );
  return result.rows;
}

module.exports = {
  create,
  listBySession
};
