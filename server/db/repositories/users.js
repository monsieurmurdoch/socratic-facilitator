const db = require('../index');

async function create({ name, email, role, passwordHash }) {
  const result = await db.query(
    `INSERT INTO users (name, email, role, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, email, role, created_at`,
    [name, email, role, passwordHash]
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await db.query(
    `SELECT id, name, email, created_at
      , role
     FROM users
     WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function findWithPasswordByEmail(email) {
  const result = await db.query(
    `SELECT *
     FROM users
     WHERE email = $1`,
    [email]
  );
  return result.rows[0] || null;
}

async function updatePassword(userId, passwordHash) {
  const result = await db.query(
    `UPDATE users
     SET password_hash = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, email, role, created_at`,
    [userId, passwordHash]
  );
  return result.rows[0] || null;
}

async function upsertDemoTeacher({ name, email, passwordHash }) {
  const result = await db.query(
    `INSERT INTO users (name, email, role, password_hash)
     VALUES ($1, $2, 'Teacher', $3)
     ON CONFLICT (email)
     DO UPDATE SET
       name = EXCLUDED.name,
       role = 'Teacher',
       password_hash = EXCLUDED.password_hash,
       updated_at = NOW()
     RETURNING id, name, email, role, created_at`,
    [name, email, passwordHash]
  );
  return result.rows[0] || null;
}

module.exports = {
  create,
  findById,
  findWithPasswordByEmail,
  updatePassword,
  upsertDemoTeacher
};
