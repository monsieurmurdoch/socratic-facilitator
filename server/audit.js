const auditLogsRepo = require('./db/repositories/auditLogs');

function getRequestIp(req) {
  if (!req) return null;
  // X-Forwarded-For is comma-separated; first entry is the real client IP
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

async function logAudit({
  req = null,
  actorUserId = null,
  targetUserId = null,
  action,
  entityType = null,
  entityId = null,
  metadata = {}
}) {
  try {
    await auditLogsRepo.create({
      actorUserId,
      targetUserId,
      action,
      entityType,
      entityId,
      ipAddress: getRequestIp(req),
      userAgent: req?.headers?.['user-agent'] || null,
      metadata
    });
  } catch (error) {
    console.error('[Audit] Failed to log action:', action, error.message);
  }
}

module.exports = {
  logAudit,
  getRequestIp
};
