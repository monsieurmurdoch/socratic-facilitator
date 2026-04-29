const { FacilitationOrchestrator } = require('../facilitationOrchestrator');
const { roundScore } = require('../scoring');
const { FACILITATION_POLICY_FIXTURES } = require('./facilitationPolicyFixtures');

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeMove(move) {
  return String(move || 'stay_silent').trim().toLowerCase();
}

function inferQuietTarget(fixture) {
  const participants = fixture.participants || Array.from(new Set(
    fixture.transcript.map(turn => turn.participantName)
  ));
  if (!participants.length) return null;

  const counts = new Map(participants.map(name => [name, 0]));
  for (const turn of fixture.transcript) {
    counts.set(turn.participantName, (counts.get(turn.participantName) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
}

function inferMoveFromAnalysis(analysis, fixture) {
  const decision = analysis?.decision || {};
  if (!decision.shouldSpeak) return 'stay_silent';

  const signals = decision.signals || {};
  const transcript = fixture.transcript || [];
  const finalTurn = transcript[transcript.length - 1] || {};
  const finalText = String(finalTurn.text || '').toLowerCase();
  const participantCount = new Set([
    ...(fixture.participants || []),
    ...transcript.map(turn => turn.participantName)
  ]).size;

  if ((signals.factualError || 0) >= 0.45) return 'correct_fact';
  if ((signals.dominanceImbalance || 0) >= 0.45 && participantCount >= 3) return 'redirect';
  if ((signals.silenceDepth || 0) >= 0.55) return 'prompt_after_silence';
  if ((signals.anchorDrift || 0) >= 0.62 && transcript.length >= 4) return 'revisit_anchor';
  if (/\b(maybe|i guess|yeah|same|i agree)\b/i.test(finalText) && finalText.split(/\s+/).length <= 6) return 'redirect';
  if ((signals.coherenceScore || 0) < 0.42) return 'clarify';
  if ((signals.engagementScore || 0) < 0.48) return 'deepen';
  if (analysis.phase === 'highEngagement') return 'affirm_process';

  return 'deepen';
}

function makePlatoPolicyCandidate() {
  return {
    id: 'plato_policy',
    label: 'Plato policy layer',
    run(fixture) {
      const orchestrator = new FacilitationOrchestrator({
        ageProfile: fixture.ageProfile || 'middle',
        topicTitle: fixture.topicTitle,
        openingQuestion: fixture.openingQuestion
      });

      // The eval point is after a settled turn, not while a student is mid-sentence.
      orchestrator.humanDeference.postSpeechBufferMs = 0;
      orchestrator.humanDeference.soloPostSpeechBufferMs = 0;

      let analysis = null;
      const baseTime = Date.parse('2026-04-29T12:00:00Z');
      for (const [index, turn] of fixture.transcript.entries()) {
        analysis = orchestrator.processMessage({
          participantName: turn.participantName,
          text: turn.text,
          timestamp: baseTime + (index * 15000),
          llmAssessment: turn.assessment || null
        });
      }

      const move = inferMoveFromAnalysis(analysis, fixture);
      return {
        shouldSpeak: Boolean(analysis?.decision?.shouldSpeak),
        move,
        targetParticipantName: move === 'redirect' ? inferQuietTarget(fixture) : null,
        rationale: analysis?.decision?.reason || null,
        activation: analysis?.decision?.activation ?? null,
        signals: analysis?.decision?.signals || null,
        phase: analysis?.phase || null
      };
    }
  };
}

function makeQuestionEveryTurnBaseline() {
  return {
    id: 'baseline_question_every_turn',
    label: 'Prompted model asks a question every turn',
    run(fixture) {
      return {
        shouldSpeak: true,
        move: 'deepen',
        targetParticipantName: fixture.transcript.at(-1)?.participantName || null,
        rationale: 'Baseline always asks a follow-up question after the latest turn.'
      };
    }
  };
}

function makeSilentBaseline() {
  return {
    id: 'baseline_silent',
    label: 'Never intervene baseline',
    run() {
      return {
        shouldSpeak: false,
        move: 'stay_silent',
        targetParticipantName: null,
        rationale: 'Baseline never intervenes.'
      };
    }
  };
}

function getDefaultFacilitationCandidates() {
  return [
    makePlatoPolicyCandidate(),
    makeQuestionEveryTurnBaseline(),
    makeSilentBaseline()
  ];
}

function scorePrediction(fixture, prediction) {
  const expected = fixture.expected || {};
  const expectedShouldSpeak = Boolean(expected.shouldSpeak);
  const actualShouldSpeak = Boolean(prediction.shouldSpeak);
  const actualMove = normalizeMove(prediction.move);
  const acceptableMoves = (expected.acceptableMoves || [])
    .map(normalizeMove);
  const prohibitedMoves = (expected.prohibitedMoves || [])
    .map(normalizeMove);

  const timing = actualShouldSpeak === expectedShouldSpeak ? 1 : 0;
  let move = 0;

  if (!expectedShouldSpeak) {
    move = !actualShouldSpeak ? 1 : 0;
  } else if (actualShouldSpeak && acceptableMoves.includes(actualMove)) {
    move = 1;
  } else if (actualShouldSpeak && !prohibitedMoves.includes(actualMove)) {
    move = 0.35;
  }

  let target = 1;
  if (expected.targetParticipantName) {
    target = prediction.targetParticipantName === expected.targetParticipantName ? 1 : 0;
  }

  const overtalkPenalty = !expectedShouldSpeak && actualShouldSpeak ? 1 : 0;
  const missPenalty = expectedShouldSpeak && !actualShouldSpeak ? 1 : 0;
  const weightedScore = Math.max(0, (
    timing * 0.45 +
    move * 0.4 +
    target * 0.15
  ) - (overtalkPenalty * 0.1) - (missPenalty * 0.1));

  return {
    timing,
    move,
    target,
    overtalkPenalty,
    missPenalty,
    score: roundScore(weightedScore)
  };
}

async function runFacilitationPolicyEval({
  fixtures = FACILITATION_POLICY_FIXTURES,
  candidates = getDefaultFacilitationCandidates()
} = {}) {
  const candidateResults = [];

  for (const candidate of candidates) {
    const results = [];
    const failures = [];

    for (const fixture of fixtures) {
      try {
        const prediction = await candidate.run(fixture);
        const scores = scorePrediction(fixture, prediction);
        results.push({
          id: fixture.id,
          title: fixture.title,
          expected: fixture.expected,
          predicted: prediction,
          scores
        });
      } catch (error) {
        failures.push({ id: fixture.id, error: error.message });
      }
    }

    const completed = results.length;
    const metrics = {
      overallScore: roundScore(average(results.map(result => result.scores.score))),
      timingAccuracy: roundScore(average(results.map(result => result.scores.timing))),
      moveAccuracy: roundScore(average(results.map(result => result.scores.move))),
      targetAccuracy: roundScore(average(results.map(result => result.scores.target))),
      overtalkRate: roundScore(average(results.map(result => result.scores.overtalkPenalty))),
      missedInterventionRate: roundScore(average(results.map(result => result.scores.missPenalty)))
    };

    candidateResults.push({
      candidateId: candidate.id,
      label: candidate.label || candidate.id,
      totalCases: fixtures.length,
      completedCases: completed,
      failureCount: failures.length,
      metrics,
      failures,
      results
    });
  }

  const sorted = [...candidateResults]
    .sort((a, b) => b.metrics.overallScore - a.metrics.overallScore);
  const plato = candidateResults.find(result => result.candidateId === 'plato_policy');
  const bestBaseline = sorted.find(result => result.candidateId !== 'plato_policy') || null;
  const liftVsBestBaseline = plato && bestBaseline
    ? roundScore(plato.metrics.overallScore - bestBaseline.metrics.overallScore)
    : null;

  return {
    evalKey: 'facilitation_policy',
    fixtureSet: 'bootstrap-v1',
    totalCases: fixtures.length,
    generatedAt: new Date().toISOString(),
    metrics: {
      winner: sorted[0]?.candidateId || null,
      platoScore: plato?.metrics.overallScore ?? null,
      bestBaseline: bestBaseline?.candidateId || null,
      bestBaselineScore: bestBaseline?.metrics.overallScore ?? null,
      liftVsBestBaseline
    },
    candidates: candidateResults
  };
}

module.exports = {
  FACILITATION_POLICY_FIXTURES,
  getDefaultFacilitationCandidates,
  inferMoveFromAnalysis,
  runFacilitationPolicyEval,
  scorePrediction
};
