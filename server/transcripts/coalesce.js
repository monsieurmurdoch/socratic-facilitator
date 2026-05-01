function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function estimateSpeakingSeconds(text) {
  const words = countWords(text);
  if (!words) return 0;
  return Math.max(1, Math.round((words / 150) * 60));
}

function isParticipantMessage(message) {
  return message?.sender_type === 'participant';
}

function isSameParticipant(left, right) {
  if (!isParticipantMessage(left) || !isParticipantMessage(right)) return false;
  if (left.participant_id && right.participant_id) {
    return String(left.participant_id) === String(right.participant_id);
  }
  return (left.sender_name || left.participant_name) === (right.sender_name || right.participant_name);
}

function getTimestamp(message) {
  const time = new Date(message?._coalescedLastCreatedAt || message?.created_at || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function hasTerminalPunctuation(text) {
  return /[.!?]"?'?\s*$/.test(String(text || '').trim());
}

function looksLikeContinuation(previousText, nextText) {
  const previous = String(previousText || '').trim();
  const next = String(nextText || '').trim();
  if (!previous || !next) return false;

  const nextFirst = next.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g, '') || '';
  const connectorStarts = new Set([
    'and', 'but', 'or', 'so', 'because', 'then', 'that', 'the', 'a', 'an',
    'in', 'on', 'of', 'to', 'for', 'with', 'about', 'like', 'which', 'who'
  ]);
  const previousLast = previous.split(/\s+/).at(-1)?.toLowerCase().replace(/[^a-z']/g, '') || '';

  return (
    !hasTerminalPunctuation(previous) ||
    countWords(previous) <= 6 ||
    countWords(next) <= 6 ||
    connectorStarts.has(nextFirst) ||
    ['and', 'but', 'or', 'because', 'about', 'of', 'to', 'with'].includes(previousLast) ||
    /^[a-z]/.test(next)
  );
}

function canCoalesce(left, right, options = {}) {
  const {
    maxGapMs = 15000,
    sameSpeakerFastGapMs = 2500
  } = options;

  if (!isSameParticipant(left, right)) return false;
  const gapMs = Math.max(0, getTimestamp(right) - getTimestamp(left));
  if (gapMs > maxGapMs) return false;
  return gapMs <= sameSpeakerFastGapMs || looksLikeContinuation(left.content, right.content);
}

function mergeAnalytics(rows) {
  const available = rows.filter(Boolean);
  if (!available.length) return null;

  const average = (key) => {
    const values = available
      .map(row => Number(row[key]))
      .filter(Number.isFinite);
    if (!values.length) return 0;
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
  };

  return {
    specificity: average('specificity'),
    profoundness: average('profoundness'),
    coherence: average('coherence'),
    discussion_value: average('discussion_value'),
    contribution_weight: average('contribution_weight'),
    engagement_estimate: average('engagement_estimate'),
    responded_to_peer: available.some(row => row.responded_to_peer),
    referenced_anchor: available.some(row => row.referenced_anchor),
    is_anchor: available.some(row => row.is_anchor),
    reasoning: available.map(row => row.reasoning).filter(Boolean).join(' / ') || null
  };
}

function coalesceTranscriptMessages(messages, analyticsByMessageId = new Map(), options = {}) {
  const result = [];

  for (const message of messages || []) {
    const last = result.at(-1);
    if (!last || !canCoalesce(last, message, options)) {
      const analytics = analyticsByMessageId.get(message.id) || null;
      result.push({
        ...message,
        mergedMessageIds: [message.id],
        _coalescedLastCreatedAt: message.created_at,
        _analyticsRows: analytics ? [analytics] : [],
        _analytics: analytics
      });
      continue;
    }

    const analytics = analyticsByMessageId.get(message.id) || null;
    last.content = `${String(last.content || '').trim()} ${String(message.content || '').trim()}`
      .replace(/\s+/g, ' ')
      .trim();
    last.created_at = last.created_at || message.created_at;
    last._coalescedLastCreatedAt = message.created_at || last._coalescedLastCreatedAt;
    last.mergedMessageIds.push(message.id);
    if (analytics) last._analyticsRows.push(analytics);
    last._analytics = mergeAnalytics(last._analyticsRows);
  }

  return result;
}

function buildAnalyticsFromTranscript(baseAnalytics, messages) {
  const analytics = JSON.parse(JSON.stringify(baseAnalytics || {}));
  const participantMessages = (messages || []).filter(isParticipantMessage);
  const participantStats = new Map();

  for (const message of participantMessages) {
    const participantId = message.participant_id;
    if (!participantId) continue;
    if (!participantStats.has(participantId)) {
      participantStats.set(participantId, {
        messageCount: 0,
        totalWords: 0,
        speakingSeconds: 0,
        contributionScore: 0
      });
    }
    const stats = participantStats.get(participantId);
    const words = countWords(message.content);
    stats.messageCount += 1;
    stats.totalWords += words;
    stats.speakingSeconds += estimateSpeakingSeconds(message.content);
    stats.contributionScore += Number(message._analytics?.contribution_weight || 0);
  }

  const totalSpeaking = Array.from(participantStats.values())
    .reduce((sum, stats) => sum + stats.speakingSeconds, 0);

  analytics.overview = {
    ...(analytics.overview || {}),
    messageCount: messages.length,
    totalSpeakingTimeSeconds: totalSpeaking,
    avgMessagesPerParticipant: Number(analytics.overview?.participantCount || 0) > 0
      ? Math.round((messages.length / Number(analytics.overview.participantCount)) * 10) / 10
      : 0,
    avgSpeakingTimePerParticipant: Number(analytics.overview?.participantCount || 0) > 0
      ? Math.round((totalSpeaking / Number(analytics.overview.participantCount)) * 10) / 10
      : 0
  };

  analytics.participants = (analytics.participants || []).map(participant => {
    const stats = participantStats.get(participant.id) || {
      messageCount: 0,
      totalWords: 0,
      speakingSeconds: 0,
      contributionScore: 0
    };
    return {
      ...participant,
      messageCount: stats.messageCount,
      totalWords: stats.totalWords,
      speakingSeconds: stats.speakingSeconds,
      contributionScore: Math.round(stats.contributionScore * 1000) / 1000,
      speakingPercentage: totalSpeaking > 0
        ? Math.round((stats.speakingSeconds / totalSpeaking) * 100)
        : 0
    };
  });

  const scored = participantMessages.map(message => message._analytics).filter(Boolean);
  const average = (key) => {
    const values = scored.map(row => Number(row[key])).filter(Number.isFinite);
    if (!values.length) return 0;
    return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
  };

  analytics.quality = {
    ...(analytics.quality || {}),
    avgSpecificity: average('specificity'),
    avgProfoundness: average('profoundness'),
    avgCoherence: average('coherence'),
    avgDiscussionValue: average('discussion_value'),
    anchorReferences: scored.filter(row => row.referenced_anchor).length,
    peerResponses: scored.filter(row => row.responded_to_peer).length,
    anchorsCreated: scored.filter(row => row.is_anchor).length
  };

  return analytics;
}

module.exports = {
  buildAnalyticsFromTranscript,
  canCoalesce,
  coalesceTranscriptMessages,
  countWords,
  estimateSpeakingSeconds,
  looksLikeContinuation
};
