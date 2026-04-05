const db = require('../index');

async function create({
  requestedByUserId,
  evalKey,
  strategy,
  fixtureSet,
  modelLabel,
  totalCases,
  completedCases,
  overallScore,
  metrics
}) {
  const result = await db.query(
    `INSERT INTO model_eval_runs (
      requested_by_user_id, eval_key, strategy, fixture_set, model_label,
      total_cases, completed_cases, overall_score, metrics
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      requestedByUserId,
      evalKey,
      strategy,
      fixtureSet,
      modelLabel,
      totalCases,
      completedCases,
      overallScore,
      JSON.stringify(metrics || {})
    ]
  );
  return result.rows[0];
}

async function listRecent(evalKey, limit = 10) {
  const result = await db.query(
    `SELECT mer.*, u.name AS requested_by_name
     FROM model_eval_runs mer
     LEFT JOIN users u ON u.id = mer.requested_by_user_id
     WHERE mer.eval_key = $1
     ORDER BY mer.created_at DESC
     LIMIT $2`,
    [evalKey, limit]
  );
  return result.rows;
}

module.exports = {
  create,
  listRecent
};
