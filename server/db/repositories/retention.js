const db = require('../index');

function getDefaultUnlinkedRetentionDays() {
  const configured = parseInt(process.env.DEFAULT_UNLINKED_SESSION_RETENTION_DAYS || '30', 10);
  return Number.isFinite(configured) ? Math.max(0, configured) : 30;
}

async function listExpiredSessions(limit = 100) {
  const defaultDays = getDefaultUnlinkedRetentionDays();
  const result = await db.query(
    `SELECT
      s.id,
      s.short_code,
      s.title,
      s.class_id,
      s.status,
      COALESCE(s.ended_at, s.started_at, s.created_at) AS reference_time,
      CASE
        WHEN s.class_id IS NULL THEN $1
        ELSE COALESCE(cps.retention_days, 180)
      END AS retention_days
     FROM sessions s
     LEFT JOIN class_privacy_settings cps ON cps.class_id = s.class_id
     WHERE s.status <> 'active'
       AND (
         (s.class_id IS NOT NULL AND COALESCE(s.ended_at, s.started_at, s.created_at) < NOW() - make_interval(days => COALESCE(cps.retention_days, 180)))
         OR
         (s.class_id IS NULL AND $1 > 0 AND COALESCE(s.ended_at, s.started_at, s.created_at) < NOW() - make_interval(days => $1))
       )
     ORDER BY reference_time ASC
     LIMIT $2`,
    [defaultDays, limit]
  );
  return result.rows;
}

async function deleteExpiredSessions(limit = 100) {
  const expired = await listExpiredSessions(limit);
  const deleted = [];

  for (const session of expired) {
    await db.query('DELETE FROM sessions WHERE id = $1', [session.id]);
    deleted.push({
      id: session.id,
      shortCode: session.short_code,
      title: session.title,
      classId: session.class_id,
      retentionDays: Number(session.retention_days || 0)
    });
  }

  return {
    scanned: expired.length,
    deletedCount: deleted.length,
    deleted
  };
}

module.exports = {
  getDefaultUnlinkedRetentionDays,
  listExpiredSessions,
  deleteExpiredSessions
};
