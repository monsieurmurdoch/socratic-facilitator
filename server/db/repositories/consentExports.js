const db = require('../index');

function anonId(prefix, index) {
  return `${prefix}_${String(index + 1).padStart(3, '0')}`;
}

async function buildSessionEvalExport(sessionId) {
  const sessionResult = await db.query(
    `SELECT id, short_code, title, data_use_mode, allow_eval_export, created_at, ended_at
     FROM sessions
     WHERE id = $1`,
    [sessionId]
  );
  const session = sessionResult.rows[0];
  if (!session) return null;

  const messagesResult = await db.query(
    `SELECT
       m.id,
       m.sender_type,
       m.content,
       m.move_type,
       m.created_at,
       p.id AS participant_id,
       p.eval_consent_granted,
       ma.specificity,
       ma.profoundness,
       ma.coherence,
       ma.discussion_value,
       ma.responded_to_peer,
       ma.referenced_anchor,
       ma.is_anchor
     FROM messages m
     LEFT JOIN participants p ON p.id = m.participant_id
     LEFT JOIN message_analytics ma ON ma.message_id = m.id
     WHERE m.session_id = $1
     ORDER BY m.created_at ASC`,
    [sessionId]
  );

  const telemetryResult = await db.query(
    `SELECT
       id,
       trigger_message_id,
       facilitator_message_id,
       model,
       prompt_version,
       move,
       latency_ms,
       input_tokens,
       output_tokens,
       estimated_cost_usd,
       source_chunk_ids,
       decision_json,
       created_at
     FROM intervention_telemetry
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );

  const participantIds = Array.from(new Set(
    messagesResult.rows
      .filter(row => row.sender_type === 'participant')
      .map(row => row.participant_id)
      .filter(Boolean)
  ));
  const participantMap = new Map();
  let excludedUnconsented = 0;

  const turns = [];
  for (const row of messagesResult.rows) {
    if (row.sender_type === 'participant' && !row.eval_consent_granted) {
      excludedUnconsented += 1;
      continue;
    }
    if (row.sender_type === 'participant' && !participantMap.has(row.participant_id)) {
      participantMap.set(row.participant_id, anonId('speaker', participantMap.size));
    }
    turns.push({
      messageId: row.id,
      speakerId: row.sender_type === 'facilitator'
        ? 'facilitator'
        : participantMap.get(row.participant_id),
      senderType: row.sender_type,
      text: row.content,
      move: row.move_type,
      createdAt: row.created_at,
      analytics: row.specificity == null ? null : {
        specificity: Number(row.specificity || 0),
        profoundness: Number(row.profoundness || 0),
        coherence: Number(row.coherence || 0),
        discussionValue: Number(row.discussion_value || 0),
        respondedToPeer: !!row.responded_to_peer,
        referencedAnchor: !!row.referenced_anchor,
        isAnchor: !!row.is_anchor
      }
    });
  }

  return {
    exportVersion: 'eval-export-v1',
    session: {
      id: session.id,
      shortCode: session.short_code,
      title: session.title,
      dataUseMode: session.data_use_mode,
      allowEvalExport: !!session.allow_eval_export,
      createdAt: session.created_at,
      endedAt: session.ended_at
    },
    consent: {
      participantCount: participantIds.length,
      exportedSpeakerCount: participantMap.size,
      excludedUnconsentedTurns: excludedUnconsented
    },
    turns,
    interventions: telemetryResult.rows.map(row => ({
      id: row.id,
      triggerMessageId: row.trigger_message_id,
      facilitatorMessageId: row.facilitator_message_id,
      model: row.model,
      promptVersion: row.prompt_version,
      move: row.move,
      latencyMs: row.latency_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimatedCostUsd: row.estimated_cost_usd == null ? null : Number(row.estimated_cost_usd),
      sourceChunkIds: row.source_chunk_ids || [],
      decision: row.decision_json || {},
      createdAt: row.created_at
    }))
  };
}

module.exports = {
  buildSessionEvalExport
};
