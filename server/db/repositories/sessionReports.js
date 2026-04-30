const db = require('../index');

async function getBySession(sessionId) {
  const result = await db.query(
    `SELECT *
     FROM session_reports
     WHERE session_id = $1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

async function getBySessionAndType(sessionId, reportType = 'teacher_debrief') {
  const result = await db.query(
    `SELECT *
     FROM session_reports
     WHERE session_id = $1 AND report_type = $2`,
    [sessionId, reportType]
  );
  return result.rows[0] || null;
}

async function upsert({ sessionId, reportType = 'teacher_debrief', reportJson }) {
  const result = await db.query(
    `INSERT INTO session_reports (session_id, report_type, report_json, generated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (session_id, report_type) DO UPDATE SET
       report_json = EXCLUDED.report_json,
       generated_at = NOW()
     RETURNING *`,
    [sessionId, reportType, JSON.stringify(reportJson || {})]
  );
  return result.rows[0];
}

module.exports = {
  getBySession,
  getBySessionAndType,
  upsert
};
