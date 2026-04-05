const db = require('../index');

const DEFAULT_PRIVACY_SETTINGS = {
  retention_days: 180,
  allow_ai_scoring: true,
  allow_lms_sync: true,
  parent_view_mode: 'summary',
  student_view_mode: 'self_only',
  allow_exports: false
};

async function getByClass(classId) {
  const result = await db.query(
    `SELECT *
     FROM class_privacy_settings
     WHERE class_id = $1`,
    [classId]
  );
  return result.rows[0] || null;
}

async function getOrDefault(classId) {
  return (await getByClass(classId)) || { class_id: classId, ...DEFAULT_PRIVACY_SETTINGS };
}

async function upsert({
  classId,
  retentionDays,
  allowAiScoring,
  allowLmsSync,
  parentViewMode,
  studentViewMode,
  allowExports,
  updatedByUserId = null
}) {
  const result = await db.query(
    `INSERT INTO class_privacy_settings (
      class_id, retention_days, allow_ai_scoring, allow_lms_sync,
      parent_view_mode, student_view_mode, allow_exports, updated_by_user_id, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (class_id) DO UPDATE SET
       retention_days = EXCLUDED.retention_days,
       allow_ai_scoring = EXCLUDED.allow_ai_scoring,
       allow_lms_sync = EXCLUDED.allow_lms_sync,
       parent_view_mode = EXCLUDED.parent_view_mode,
       student_view_mode = EXCLUDED.student_view_mode,
       allow_exports = EXCLUDED.allow_exports,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = NOW()
     RETURNING *`,
    [
      classId,
      retentionDays,
      allowAiScoring,
      allowLmsSync,
      parentViewMode,
      studentViewMode,
      allowExports,
      updatedByUserId
    ]
  );
  return result.rows[0];
}

module.exports = {
  DEFAULT_PRIVACY_SETTINGS,
  getByClass,
  getOrDefault,
  upsert
};
