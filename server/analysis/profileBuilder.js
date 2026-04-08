/**
 * Profile Builder
 *
 * Computes aggregate metrics from message_analytics and session_memberships
 * to build longitudinal learner profiles.
 */

const learnerProfilesRepo = require('../db/repositories/learnerProfiles');
const messageAnalyticsRepo = require('../db/repositories/messageAnalytics');
const sessionMembershipsRepo = require('../db/repositories/sessionMemberships');
const sessionsRepo = require('../db/repositories/sessions');

/**
 * Compute estimated level from average scores
 */
function computeEstimatedLevel(avgProfoundness, avgSpecificity) {
  if (avgProfoundness > 0.6 && avgSpecificity > 0.6) {
    return 'advanced';
  } else if (avgProfoundness > 0.4) {
    return 'intermediate';
  } else {
    return 'developing';
  }
}

/**
 * Build or update a learner profile from all session data
 * Called periodically or on-demand to rebuild aggregates
 */
async function buildProfile(userId) {
  try {
    // Get all session memberships for this user
    const memberships = await sessionMembershipsRepo.getByUserId(userId);
    if (!memberships || memberships.length === 0) {
      console.log(`[ProfileBuilder] No sessions found for user ${userId}`);
      return null;
    }

    // Get all message analytics for this user's sessions
    const sessionIds = memberships.map(m => m.session_id);
    const allAnalytics = [];
    for (const sessionId of sessionIds) {
      const analytics = await messageAnalyticsRepo.listBySession(sessionId);
      allAnalytics.push(...analytics);
    }

    // Compute aggregate metrics
    const totalSessions = memberships.length;
    const totalMessages = allAnalytics.length;
    const totalSpeakingSeconds = memberships.reduce((sum, m) => sum + (m.estimated_speaking_seconds || 0), 0);

    // Average scores across all messages
    const avgSpecificity = totalMessages > 0
      ? allAnalytics.reduce((sum, a) => sum + (a.specificity || 0), 0) / totalMessages
      : 0;

    const avgProfoundness = totalMessages > 0
      ? allAnalytics.reduce((sum, a) => sum + (a.profundness || 0), 0) / totalMessages
      : 0;

    const avgCoherence = totalMessages > 0
      ? allAnalytics.reduce((sum, a) => sum + (a.coherence || 0), 0) / totalMessages
      : 0;

    const avgContributionScore = memberships.length > 0
      ? memberships.reduce((sum, m) => sum + (m.contribution_score || 0), 0) / memberships.length
      : 0;

    // Compute estimated level
    const estimatedLevel = computeEstimatedLevel(avgProfoundness, avgSpecificity);

    // Get session info for topics
    const sessions = await Promise.all(
      sessionIds.map(id => sessionsRepo.findById(id))
    );

    const topicsDiscussed = sessions
      .filter(s => s && s.title)
      .map(s => s.title)
      .filter((title, index, self) => self.indexOf(title) === index); // unique

    // Build session summaries from existing data
    const sessionSummaries = await Promise.all(
      memberships.map(async (membership) => {
        const session = await sessionsRepo.findById(membership.session_id);
        if (!session) return null;

        const analytics = await messageAnalyticsRepo.listBySession(membership.session_id);
        const userAnalytics = analytics.filter(a => a.participant_id === membership.participant_id);

        const avgSpecificity = userAnalytics.length > 0
          ? userAnalytics.reduce((sum, a) => sum + (a.specificity || 0), 0) / userAnalytics.length
          : 0;

        const avgProfoundness = userAnalytics.length > 0
          ? userAnalytics.reduce((sum, a) => sum + (a.profundness || 0), 0) / userAnalytics.length
          : 0;

        const avgCoherence = userAnalytics.length > 0
          ? userAnalytics.reduce((sum, a) => sum + (a.coherence || 0), 0) / userAnalytics.length
          : 0;

        return {
          sessionId: membership.session_id,
          shortCode: session.short_code,
          date: session.created_at,
          title: session.title,
          messageCount: membership.message_count || 0,
          avgSpecificity: Math.round(avgSpecificity * 1000) / 1000,
          avgProfoundness: Math.round(avgProfoundness * 1000) / 1000,
          avgCoherence: Math.round(avgCoherence * 1000) / 1000
        };
      })
    ).then(s => s.filter(Boolean));

    // TODO: Compute strengths and growth areas from analytics patterns
    // For now, empty arrays
    const strengths = [];
    const growthAreas = [];

    const profileData = {
      totalSessions,
      totalMessages,
      totalSpeakingSeconds: Math.round(totalSpeakingSeconds),
      avgSpecificity: Math.round(avgSpecificity * 1000) / 1000,
      avgProfoundness: Math.round(avgProfoundness * 1000) / 1000,
      avgCoherence: Math.round(avgCoherence * 1000) / 1000,
      avgContributionScore: Math.round(avgContributionScore * 1000) / 1000,
      estimatedLevel,
      topicsDiscussed,
      strengths,
      growthAreas,
      sessionSummaries,
      sttCorrections: [] // Preserve existing
    };

    // Get existing profile to preserve STT corrections
    const existing = await learnerProfilesRepo.findByUser(userId);
    if (existing && existing.stt_corrections) {
      profileData.sttCorrections = Array.isArray(existing.stt_corrections)
        ? existing.stt_corrections
        : JSON.parse(existing.stt_corrections || '[]');
    }

    const profile = await learnerProfilesRepo.upsert(userId, profileData);
    console.log(`[ProfileBuilder] Built profile for user ${userId}: ${totalSessions} sessions, ${estimatedLevel} level`);

    return profile;
  } catch (error) {
    console.error('[ProfileBuilder] Error building profile:', error);
    throw error;
  }
}

/**
 * Add a session summary to a user's profile
 * Called when a session ends
 */
async function addSessionToProfile(userId, sessionId) {
  try {
    // Get session details
    const session = await sessionsRepo.findById(sessionId);
    if (!session) {
      console.log(`[ProfileBuilder] Session ${sessionId} not found`);
      return null;
    }

    // Get session membership for this user
    const memberships = await sessionMembershipsRepo.listBySession(sessionId);
    const membership = memberships.find(m => m.user_id === userId);
    if (!membership) {
      console.log(`[ProfileBuilder] No membership found for user ${userId} in session ${sessionId}`);
      return null;
    }

    // Get analytics for this session
    const analytics = await messageAnalyticsRepo.listBySession(sessionId);
    const userAnalytics = analytics.filter(a => a.participant_id === membership.participant_id);

    // Compute per-session metrics
    const avgSpecificity = userAnalytics.length > 0
      ? userAnalytics.reduce((sum, a) => sum + (a.specificity || 0), 0) / userAnalytics.length
      : 0;

    const avgProfoundness = userAnalytics.length > 0
      ? userAnalytics.reduce((sum, a) => sum + (a.profundness || 0), 0) / userAnalytics.length
      : 0;

    const avgCoherence = userAnalytics.length > 0
      ? userAnalytics.reduce((sum, a) => sum + (a.coherence || 0), 0) / userAnalytics.length
      : 0;

    const summary = {
      sessionId,
      shortCode: session.short_code,
      date: session.ended_at || session.created_at,
      title: session.title,
      messageCount: membership.message_count || 0,
      avgSpecificity: Math.round(avgSpecificity * 1000) / 1000,
      avgProfoundness: Math.round(avgProfoundness * 1000) / 1000,
      avgCoherence: Math.round(avgCoherence * 1000) / 1000
    };

    // Load existing profile (or start fresh)
    const existing = await learnerProfilesRepo.findByUser(userId);
    const sessionSummaries = existing
      ? (Array.isArray(existing.session_summaries)
          ? existing.session_summaries
          : JSON.parse(existing.session_summaries || '[]'))
      : [];

    // Avoid duplicate if this session was already recorded
    const allSummaries = sessionSummaries.some(s => s.sessionId === sessionId)
      ? sessionSummaries
      : [...sessionSummaries, summary];

    // Recompute aggregates
    const totalSessions = allSummaries.length;
    const totalMessages = allSummaries.reduce((sum, s) => sum + (s.messageCount || 0), 0);

    const weightedSpecificity = allSummaries.reduce(
      (sum, s) => sum + (s.avgSpecificity || 0) * (s.messageCount || 0),
      0
    );
    const weightedProfoundness = allSummaries.reduce(
      (sum, s) => sum + (s.avgProfoundness || 0) * (s.messageCount || 0),
      0
    );
    const weightedCoherence = allSummaries.reduce(
      (sum, s) => sum + (s.avgCoherence || 0) * (s.messageCount || 0),
      0
    );

    const newAvgSpecificity = totalMessages > 0 ? weightedSpecificity / totalMessages : 0;
    const newAvgProfoundness = totalMessages > 0 ? weightedProfoundness / totalMessages : 0;
    const newAvgCoherence = totalMessages > 0 ? weightedCoherence / totalMessages : 0;

    const estimatedLevel = computeEstimatedLevel(newAvgProfoundness, newAvgSpecificity);

    const topicsDiscussed = existing
      ? (Array.isArray(existing.topics_discussed)
          ? existing.topics_discussed
          : JSON.parse(existing.topics_discussed || '[]'))
      : [];

    if (session.title && !topicsDiscussed.includes(session.title)) {
      topicsDiscussed.push(session.title);
    }

    const profile = await learnerProfilesRepo.upsert(userId, {
      totalSessions,
      totalMessages,
      totalSpeakingSeconds: (existing?.total_speaking_seconds || 0) + (membership.estimated_speaking_seconds || 0),
      avgSpecificity: Math.round(newAvgSpecificity * 1000) / 1000,
      avgProfoundness: Math.round(newAvgProfoundness * 1000) / 1000,
      avgCoherence: Math.round(newAvgCoherence * 1000) / 1000,
      avgContributionScore: existing
        ? Math.round(
            ((existing.avg_contribution_score || 0) * (totalSessions - 1) + (membership.contribution_score || 0)) / totalSessions * 1000
          ) / 1000
        : Math.round((membership.contribution_score || 0) * 1000) / 1000,
      estimatedLevel,
      topicsDiscussed,
      strengths: existing?.strengths || [],
      growthAreas: existing?.growth_areas || [],
      sessionSummaries: allSummaries,
      sttCorrections: existing
        ? (Array.isArray(existing.stt_corrections)
            ? existing.stt_corrections
            : JSON.parse(existing.stt_corrections || '[]'))
        : []
    });

    console.log(`[ProfileBuilder] Added session ${sessionId} to profile for user ${userId}`);
    return profile;
  } catch (error) {
    console.error('[ProfileBuilder] Error adding session to profile:', error);
    throw error;
  }
}

module.exports = {
  buildProfile,
  addSessionToProfile
};
