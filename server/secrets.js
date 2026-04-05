const crypto = require('crypto');

const SECRET = process.env.ENCRYPTION_MASTER_KEY || process.env.LMS_CREDENTIALS_SECRET || process.env.JWT_SECRET;
if (!SECRET) {
  console.error('[Secrets] ENCRYPTION_MASTER_KEY, LMS_CREDENTIALS_SECRET, or JWT_SECRET must be set');
}

// Use scrypt for proper key derivation (brute-force resistant)
const KEY = SECRET
  ? crypto.scryptSync(String(SECRET), 'socratic-facilitator-kdf-salt', 32, { N: 16384, r: 8, p: 1 })
  : crypto.randomBytes(32); // fallback for dev — won't persist across restarts

function encryptSecret(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(payload) {
  if (!payload) return null;
  const [ivPart, tagPart, bodyPart] = String(payload).split(':');
  if (!ivPart || !tagPart || !bodyPart) return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      KEY,
      Buffer.from(ivPart, 'base64')
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(bodyPart, 'base64')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  } catch (error) {
    console.error('[Secrets] Decryption failed — key may have changed:', error.message);
    return null;
  }
}

module.exports = {
  encryptSecret,
  decryptSecret
};
