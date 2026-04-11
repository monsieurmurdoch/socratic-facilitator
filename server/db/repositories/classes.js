const db = require('../index');

function normalizeCode(code = '') {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i += 1) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `RM-${code}`;
}

async function codeExistsAnywhere(code) {
  const normalized = normalizeCode(code);
  let classResult = { rowCount: 0 };
  try {
    classResult = await db.query(
      `SELECT id
       FROM classes
       WHERE room_code IS NOT NULL
         AND LOWER(REGEXP_REPLACE(room_code, '[^a-z0-9]', '', 'g')) = $1
       LIMIT 1`,
      [normalized]
    );
  } catch (error) {
    if (error?.code !== '42703') throw error;
  }

  const sessionResult = await db.query(
    `SELECT id
     FROM sessions
     WHERE LOWER(REGEXP_REPLACE(short_code, '[^a-z0-9]', '', 'g')) = $1
     LIMIT 1`,
    [normalized]
  );

  return classResult.rowCount > 0 || sessionResult.rowCount > 0;
}

async function reserveRoomCode() {
  let attempts = 0;
  while (attempts < 20) {
    const baseCode = generateRoomCode();
    if (!(await codeExistsAnywhere(baseCode))) {
      return baseCode;
    }

    for (let suffix = 2; suffix <= 9; suffix += 1) {
      const candidate = `${baseCode}${suffix}`;
      if (!(await codeExistsAnywhere(candidate))) {
        return candidate;
      }
    }

    attempts += 1;
  }
  throw new Error('Failed to generate unique room code');
}

async function persistRoomCode(classId, roomCode) {
  try {
    const result = await db.query(
      `UPDATE classes
       SET room_code = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [classId, roomCode]
    );
    return result.rows[0] || null;
  } catch (error) {
    if (error?.code === '42703') {
      return null;
    }
    throw error;
  }
}

async function ensureRoomCode(row) {
  if (!row || row.room_code) return row;
  const roomCode = await reserveRoomCode();
  const updated = await persistRoomCode(row.id, roomCode);
  return updated
    ? { ...row, ...updated, room_code: updated.room_code || roomCode }
    : { ...row, room_code: roomCode };
}

async function create({ ownerUserId, name, description = null, ageRange = null }) {
  const roomCode = await reserveRoomCode();
  try {
    const result = await db.query(
      `INSERT INTO classes (owner_user_id, name, description, age_range, room_code)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [ownerUserId, name, description, ageRange, roomCode]
    );
    return result.rows[0];
  } catch (error) {
    if (error?.code !== '42703') throw error;
    const legacyResult = await db.query(
      `INSERT INTO classes (owner_user_id, name, description, age_range)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [ownerUserId, name, description, ageRange]
    );
    return { ...legacyResult.rows[0], room_code: roomCode };
  }
}

async function listByOwner(ownerUserId) {
  const result = await db.query(
    `SELECT
      c.*,
      COUNT(s.id) AS session_count,
      MAX(s.created_at) AS latest_session_at
     FROM classes c
     LEFT JOIN sessions s ON s.class_id = c.id
     WHERE c.owner_user_id = $1
     GROUP BY c.id
     ORDER BY c.sort_order NULLS LAST, c.created_at DESC`,
    [ownerUserId]
  );
  return Promise.all(result.rows.map(ensureRoomCode));
}

async function listByUser(userId) {
  const result = await db.query(
    `SELECT
      c.*,
      COALESCE(cm.role, 'Teacher') AS membership_role,
      COUNT(DISTINCT s.id) AS session_count,
      MAX(s.created_at) AS latest_session_at
     FROM classes c
     JOIN class_memberships cm ON cm.class_id = c.id
     LEFT JOIN sessions s ON s.class_id = c.id
     WHERE cm.user_id = $1
     GROUP BY c.id, cm.role
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return Promise.all(result.rows.map(ensureRoomCode));
}

async function findOwnedByUser(classId, ownerUserId) {
  const result = await db.query(
    `SELECT *
     FROM classes
     WHERE id = $1 AND owner_user_id = $2`,
    [classId, ownerUserId]
  );
  return result.rows[0] || null;
}

async function findById(classId) {
  const result = await db.query(
    `SELECT *
     FROM classes
     WHERE id = $1`,
    [classId]
  );
  return ensureRoomCode(result.rows[0] || null);
}

async function findByRoomCode(roomCode) {
  try {
    const result = await db.query(
      `SELECT *
       FROM classes
       WHERE room_code IS NOT NULL
         AND LOWER(REGEXP_REPLACE(room_code, '[^a-z0-9]', '', 'g')) = $1`,
      [normalizeCode(roomCode)]
    );
    return ensureRoomCode(result.rows[0] || null);
  } catch (error) {
    if (error?.code === '42703') {
      return null;
    }
    throw error;
  }
}

async function update(classId, fields) {
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, col] of [['name', 'name'], ['description', 'description'], ['ageRange', 'age_range']]) {
    if (fields[key] !== undefined) {
      sets.push(`${col} = $${i}`);
      values.push(fields[key]);
      i++;
    }
  }
  if (sets.length === 0) return findById(classId);
  values.push(classId);
  const result = await db.query(
    `UPDATE classes SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  return result.rows[0] || null;
}

async function reorder(ownerUserId, orderedIds) {
  // Only update classes owned by this user
  for (let i = 0; i < orderedIds.length; i++) {
    await db.query(
      `UPDATE classes SET sort_order = $1 WHERE id = $2 AND owner_user_id = $3`,
      [i, orderedIds[i], ownerUserId]
    );
  }
}

module.exports = {
  create,
  listByOwner,
  listByUser,
  findOwnedByUser,
  findById,
  findByRoomCode,
  update,
  reorder
};
