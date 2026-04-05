import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const db = require('../server/db');
const usersRepo = require('../server/db/repositories/users');
const classesRepo = require('../server/db/repositories/classes');
const classMembershipsRepo = require('../server/db/repositories/classMemberships');
const sessionsRepo = require('../server/db/repositories/sessions');

async function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log(JSON.stringify({
      skipped: true,
      reason: 'DATABASE_URL is not configured in this environment'
    }, null, 2));
    return;
  }

  const stamp = Date.now();
  const email = `smoke-${stamp}@example.com`;
  let createdClass = null;
  let createdSession = null;
  let createdUser = null;

  try {
    await db.initializeSchema();
    const passwordHash = await hashPassword(`smoke-${stamp}-password`);
    createdUser = await usersRepo.create({
      name: 'Smoke User',
      email,
      role: 'Teacher',
      passwordHash
    });

    createdClass = await classesRepo.create({
      ownerUserId: createdUser.id,
      name: `Smoke Class ${stamp}`,
      description: 'Automated smoke test class'
    });

    await classMembershipsRepo.add({
      classId: createdClass.id,
      userId: createdUser.id,
      role: 'Teacher'
    });

    createdSession = await sessionsRepo.create({
      title: `Smoke Session ${stamp}`,
      openingQuestion: 'Does the smoke test work?',
      ownerUserId: createdUser.id,
      classId: createdClass.id
    });

    const history = await sessionsRepo.listAccessibleByUser(createdUser.id, 5);
    const found = history.find(session => session.id === createdSession.id);

    console.log(JSON.stringify({
      skipped: false,
      ok: Boolean(found),
      userId: createdUser.id,
      classId: createdClass.id,
      sessionCode: createdSession.short_code
    }, null, 2));
  } finally {
    if (createdSession) {
      await sessionsRepo.deleteSession(createdSession.id);
    }
    if (createdUser) {
      await db.query('DELETE FROM users WHERE id = $1', [createdUser.id]);
    }
    await db.end();
  }
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  try {
    await db.end();
  } catch (_error) {
    // ignore
  }
  process.exit(1);
});
