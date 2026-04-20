const sessionsRepo = require('./db/repositories/sessions');
const sessionMembershipsRepo = require('./db/repositories/sessionMemberships');
const messagesRepo = require('./db/repositories/messages');
const messageAnalyticsRepo = require('./db/repositories/messageAnalytics');
const sessionReportsRepo = require('./db/repositories/sessionReports');
const classesRepo = require('./db/repositories/classes');
const privacySettingsRepo = require('./db/repositories/privacySettings');
const { narrateReport } = require('./reportNarrator');

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function summarizePlatoMoves(messages) {
  const facilitator = messages.filter(m => m.sender_type === 'facilitator');
  const byMove = {};
  for (const m of facilitator) {
    const key = m.move_type || 'unspecified';
    byMove[key] = (byMove[key] || 0) + 1;
  }
  return { totalInterventions: facilitator.length, byMove };
}

function durationSeconds(session) {
  if (!session?.started_at || !session?.ended_at) return null;
  const start = new Date(session.started_at).getTime();
  const end = new Date(session.ended_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.round((end - start) / 1000);
}

function buildSessionReport({
  session,
  classInfo = null,
  memberships = [],
  analytics = [],
  messages = [],
  privacy = null
}) {
  const participantMessages = messages.filter(message => message.sender_type === 'participant');
  const facilitatorMessages = messages.filter(message => message.sender_type === 'facilitator');
  const sortedMemberships = [...memberships].sort((a, b) => (Number(b.contribution_score || 0) - Number(a.contribution_score || 0)));
  const topContributors = sortedMemberships.slice(0, 3).map(member => ({
    name: member.name_snapshot,
    role: member.role_snapshot,
    contributionScore: round(member.contribution_score),
    engagementScore: round(member.engagement_score),
    messageCount: Number(member.message_count || 0),
    estimatedSpeakingSeconds: round(member.estimated_speaking_seconds, 1)
  }));
  const quieterVoices = sortedMemberships
    .filter(member => Number(member.message_count || 0) <= 1)
    .map(member => member.name_snapshot)
    .slice(0, 4);
  const anchorComments = analytics
    .filter(item => item.raw_payload?.anchor?.isAnchor)
    .sort((a, b) => Number(b.discussion_value || 0) - Number(a.discussion_value || 0))
    .slice(0, 3)
    .map(item => ({
      participantName: item.participant_name || item.sender_name,
      summary: item.raw_payload?.anchor?.summary || item.content,
      content: item.content,
      discussionValue: round(item.discussion_value),
      reasoning: item.reasoning || ''
    }));
  const highValueComments = analytics
    .slice()
    .sort((a, b) => Number(b.discussion_value || 0) - Number(a.discussion_value || 0))
    .slice(0, 4)
    .map(item => ({
      participantName: item.participant_name || item.sender_name,
      content: item.content,
      discussionValue: round(item.discussion_value),
      coherence: round(item.coherence),
      specificity: round(item.specificity),
      reasoning: item.reasoning || ''
    }));

  const avgCoherence = analytics.length
    ? analytics.reduce((sum, item) => sum + Number(item.coherence || 0), 0) / analytics.length
    : 0;
  const anchorRate = analytics.length
    ? analytics.filter(item => item.raw_payload?.anchor?.isAnchor).length / analytics.length
    : 0;
  const peerBuildRate = analytics.length
    ? analytics.filter(item => item.responded_to_peer).length / analytics.length
    : 0;

  const overview = [];
  overview.push(`${participantMessages.length} participant comments and ${facilitatorMessages.length} Plato interventions were recorded.`);
  if (topContributors.length) {
    overview.push(`${topContributors[0].name} contributed most heavily by volume and weighted contribution.`);
  }
  if (quieterVoices.length) {
    overview.push(`Quieter voices in this session included ${quieterVoices.join(', ')}.`);
  }

  let nextPrompt = 'What idea from today still feels unresolved, and why does it matter?';
  if (avgCoherence < 0.55) {
    nextPrompt = 'Whose idea do you most want to build on or challenge from today, and what exactly are you responding to?';
  } else if (anchorRate < 0.2) {
    nextPrompt = 'What was the most important distinction anyone made today, and how should the group test it next?';
  } else if (peerBuildRate > 0.6) {
    nextPrompt = 'Which thread from today should the group press harder on, and what evidence would sharpen it?';
  }

  return {
    generatedAt: new Date().toISOString(),
    session: {
      id: session.id,
      shortCode: session.short_code,
      title: session.title,
      status: session.status,
      createdAt: session.created_at,
      startedAt: session.started_at,
      endedAt: session.ended_at,
      className: classInfo?.name || null
    },
    overview,
    metrics: {
      participantCommentCount: participantMessages.length,
      facilitatorCommentCount: facilitatorMessages.length,
      participantCount: memberships.length,
      avgCoherence: round(avgCoherence),
      anchorRate: round(anchorRate),
      peerBuildRate: round(peerBuildRate)
    },
    topContributors,
    quieterVoices,
    anchorComments,
    highValueComments,
    suggestedNextPrompt: nextPrompt,
    privacy: privacy ? {
      retentionDays: privacy.retention_days,
      allowAiScoring: privacy.allow_ai_scoring,
      parentViewMode: privacy.parent_view_mode,
      studentViewMode: privacy.student_view_mode
    } : null
  };
}

/**
 * Gather every input the report needs from the database, build the
 * deterministic skeleton, then ask the narrator (best-effort) for the
 * qualitative layer. Persists the resulting JSON to session_reports.
 */
async function assembleAndPersistReport({ sessionId, apiKey }) {
  const session = await sessionsRepo.findById(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const [memberships, analytics, messages] = await Promise.all([
    sessionMembershipsRepo.listBySession(sessionId),
    messageAnalyticsRepo.listBySession(sessionId, 500),
    messagesRepo.getBySession(sessionId, { limit: 1000, order: 'ASC' })
  ]);

  const classInfo = session.class_id ? await classesRepo.findById(session.class_id) : null;
  const privacy = session.class_id ? await privacySettingsRepo.getOrDefault(session.class_id) : null;

  const skeleton = buildSessionReport({ session, classInfo, memberships, analytics, messages, privacy });
  skeleton.metrics.durationSeconds = durationSeconds(session);
  skeleton.whatPlatoDid = summarizePlatoMoves(messages);

  let narrative = null;
  try {
    narrative = await narrateReport({ apiKey, session, skeleton, messages });
  } catch (err) {
    console.warn(`[Report] Narration failed for session ${sessionId}: ${err.message}`);
  }

  if (narrative) {
    if (narrative.tldr.length) skeleton.overview = narrative.tldr;
    skeleton.strongestMoments = narrative.strongestMoments;
    skeleton.unexploredTensions = narrative.unexploredTensions;
    if (narrative.suggestedNextPrompt) skeleton.suggestedNextPrompt = narrative.suggestedNextPrompt;
  } else {
    skeleton.strongestMoments = [];
    skeleton.unexploredTensions = [];
  }

  await sessionReportsRepo.upsert({ sessionId, reportType: 'teacher_debrief', reportJson: skeleton });
  return skeleton;
}

module.exports = {
  buildSessionReport,
  assembleAndPersistReport
};
