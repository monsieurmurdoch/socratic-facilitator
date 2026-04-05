const db = require('../index');

async function create({
  jobName,
  status = 'completed',
  result = {},
  startedAt = new Date(),
  finishedAt = new Date()
}) {
  const queryResult = await db.query(
    `INSERT INTO maintenance_runs (job_name, status, result_json, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [jobName, status, JSON.stringify(result || {}), startedAt, finishedAt]
  );
  return queryResult.rows[0];
}

async function listRecent(jobName = null, limit = 10) {
  const result = jobName
    ? await db.query(
        `SELECT *
         FROM maintenance_runs
         WHERE job_name = $1
         ORDER BY started_at DESC
         LIMIT $2`,
        [jobName, limit]
      )
    : await db.query(
        `SELECT *
         FROM maintenance_runs
         ORDER BY started_at DESC
         LIMIT $1`,
        [limit]
      );
  return result.rows;
}

module.exports = {
  create,
  listRecent
};
