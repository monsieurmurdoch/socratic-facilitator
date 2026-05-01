const {
  buildAnalyticsFromTranscript,
  coalesceTranscriptMessages
} = require('../server/transcripts/coalesce');

function message(id, content, createdAt, participantId = 'p1') {
  return {
    id,
    session_id: 'session-1',
    participant_id: participantId,
    sender_type: 'participant',
    sender_name: 'Demo Teacher',
    participant_name: 'Demo Teacher',
    content,
    created_at: createdAt
  };
}

describe('transcript coalescing', () => {
  test('repairs adjacent STT fragments from legacy post-mortem transcripts', () => {
    const rawMessages = [
      message('m1', "It doesn't seem depressing to me. I mean, there's something really unique about", '2026-05-01T21:45:00.000Z'),
      message('m2', 'the the cyclical of life', '2026-05-01T21:45:01.000Z'),
      message('m3', 'and', '2026-05-01T21:45:02.000Z'),
      message('m4', 'In this case, the cyclical of civilization', '2026-05-01T21:45:03.000Z'),
      message('m5', 'but I think really inspires all kinds of', '2026-05-01T21:45:04.000Z'),
      message('m6', 'surprising feeling.', '2026-05-01T21:45:05.000Z')
    ];
    const analyticsByMessageId = new Map(rawMessages.map((row, index) => [
      row.id,
      {
        message_id: row.id,
        specificity: 0.5 + (index * 0.01),
        profoundness: 0.6,
        coherence: 0.7,
        discussion_value: 0.61,
        contribution_weight: 0.6,
        engagement_estimate: 0.65
      }
    ]));

    const coalesced = coalesceTranscriptMessages(rawMessages, analyticsByMessageId);

    expect(coalesced).toHaveLength(1);
    expect(coalesced[0].content).toBe(
      "It doesn't seem depressing to me. I mean, there's something really unique about the the cyclical of life and In this case, the cyclical of civilization but I think really inspires all kinds of surprising feeling."
    );
    expect(coalesced[0].mergedMessageIds).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  test('analytics counts are recalculated from displayed speaker turns', () => {
    const coalesced = coalesceTranscriptMessages([
      message('m1', 'I think the poem is about ruins', '2026-05-01T21:45:00.000Z'),
      message('m2', 'and memory.', '2026-05-01T21:45:01.000Z'),
      message('m3', 'That connects to power.', '2026-05-01T21:45:20.000Z', 'p2')
    ], new Map([
      ['m1', { contribution_weight: 0.6, specificity: 0.5, profoundness: 0.6, coherence: 0.7, discussion_value: 0.6 }],
      ['m2', { contribution_weight: 0.8, specificity: 0.7, profoundness: 0.8, coherence: 0.9, discussion_value: 0.8 }],
      ['m3', { contribution_weight: 0.4, specificity: 0.4, profoundness: 0.4, coherence: 0.4, discussion_value: 0.4 }]
    ]));
    const analytics = buildAnalyticsFromTranscript({
      overview: { participantCount: 2, durationSeconds: 60 },
      participants: [{ id: 'p1', name: 'Demo Teacher' }, { id: 'p2', name: 'Chris' }],
      quality: {}
    }, coalesced);

    expect(analytics.overview.messageCount).toBe(2);
    expect(analytics.participants.find(p => p.id === 'p1').messageCount).toBe(1);
    expect(analytics.participants.find(p => p.id === 'p2').messageCount).toBe(1);
    expect(analytics.participants.find(p => p.id === 'p1').contributionScore).toBe(0.7);
  });
});
