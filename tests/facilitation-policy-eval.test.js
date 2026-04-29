const {
  FACILITATION_POLICY_FIXTURES,
  runFacilitationPolicyEval,
  scorePrediction
} = require('../server/analysis/evals/facilitationPolicyEval');

describe('facilitation policy eval harness', () => {
  test('scores silence correctly when the conversation is healthy', () => {
    const fixture = FACILITATION_POLICY_FIXTURES.find(item => item.id === 'flowing-peer-build');

    const silentScore = scorePrediction(fixture, {
      shouldSpeak: false,
      move: 'stay_silent'
    });
    const overtalkScore = scorePrediction(fixture, {
      shouldSpeak: true,
      move: 'deepen'
    });

    expect(silentScore.score).toBe(1);
    expect(overtalkScore.overtalkPenalty).toBe(1);
    expect(overtalkScore.score).toBeLessThan(silentScore.score);
  });

  test('runs default candidates over the bootstrap fixtures', async () => {
    const result = await runFacilitationPolicyEval();

    expect(result.evalKey).toBe('facilitation_policy');
    expect(result.totalCases).toBeGreaterThanOrEqual(5);
    expect(result.candidates.map(candidate => candidate.candidateId)).toEqual([
      'plato_policy',
      'baseline_question_every_turn',
      'baseline_silent'
    ]);

    const plato = result.candidates.find(candidate => candidate.candidateId === 'plato_policy');
    expect(plato.completedCases).toBe(result.totalCases);
    expect(plato.metrics.overallScore).toBeGreaterThanOrEqual(0);
    expect(plato.metrics.overallScore).toBeLessThanOrEqual(1);
    expect(plato.results[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      expected: expect.any(Object),
      predicted: expect.any(Object),
      scores: expect.any(Object)
    }));
  });

  test('question-every-turn baseline is penalized for overtalking healthy groups', async () => {
    const result = await runFacilitationPolicyEval();
    const baseline = result.candidates.find(candidate => candidate.candidateId === 'baseline_question_every_turn');
    const healthyCase = baseline.results.find(item => item.id === 'flowing-peer-build');

    expect(healthyCase.scores.overtalkPenalty).toBe(1);
    expect(healthyCase.scores.score).toBeLessThan(0.5);
  });
});
