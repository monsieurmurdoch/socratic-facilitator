const { MESSAGE_ASSESSMENT_FIXTURES } = require('./messageAssessmentFixtures');
const { clampScore, getScoreBand, roundScore } = require('../scoring');

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toBandValue(score) {
  return getScoreBand(score).id;
}

function computeAnchorStats(results) {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const result of results) {
    const expected = Boolean(result.expected.isAnchor);
    const actual = Boolean(result.predicted.isAnchor);

    if (expected && actual) truePositives += 1;
    if (!expected && actual) falsePositives += 1;
    if (expected && !actual) falseNegatives += 1;
  }

  const precision = truePositives + falsePositives === 0 ? 0 : truePositives / (truePositives + falsePositives);
  const recall = truePositives + falseNegatives === 0 ? 0 : truePositives / (truePositives + falseNegatives);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    precision: roundScore(precision),
    recall: roundScore(recall),
    f1: roundScore(f1),
    truePositives,
    falsePositives,
    falseNegatives
  };
}

async function runMessageAssessmentEval({
  assessor,
  fixtures = MESSAGE_ASSESSMENT_FIXTURES,
  strategy = 'heuristic_only',
  allowHeuristicFallback = false
}) {
  const results = [];
  const sourceBreakdown = {};
  const failures = [];

  for (const fixture of fixtures) {
    try {
      const assessment = await assessor.assess({
        text: fixture.text,
        participantName: fixture.participantName,
        previousText: fixture.previousText,
        topicTitle: fixture.topicTitle,
        openingQuestion: fixture.openingQuestion,
        recentAnchors: fixture.recentAnchors || []
      }, { strategy, allowHeuristicFallback });

      const predicted = {
        specificity: clampScore(assessment.engagement?.specificity),
        profoundness: clampScore(assessment.engagement?.profoundness),
        coherence: clampScore(assessment.engagement?.coherence),
        isAnchor: Boolean(assessment.anchor?.isAnchor)
      };

      const source = assessment.meta?.source || 'unknown';
      sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;

      results.push({
        id: fixture.id,
        participantName: fixture.participantName,
        text: fixture.text,
        expected: fixture.expected,
        predicted,
        bands: {
          specificity: {
            expected: toBandValue(fixture.expected.specificity),
            predicted: toBandValue(predicted.specificity)
          },
          profoundness: {
            expected: toBandValue(fixture.expected.profoundness),
            predicted: toBandValue(predicted.profoundness)
          },
          coherence: {
            expected: toBandValue(fixture.expected.coherence),
            predicted: toBandValue(predicted.coherence)
          }
        },
        absoluteError: {
          specificity: roundScore(Math.abs(predicted.specificity - fixture.expected.specificity)),
          profoundness: roundScore(Math.abs(predicted.profoundness - fixture.expected.profoundness)),
          coherence: roundScore(Math.abs(predicted.coherence - fixture.expected.coherence))
        },
        source,
        reasoning: assessment.briefReasoning || '',
        meta: assessment.meta || {}
      });
    } catch (error) {
      failures.push({ id: fixture.id, error: error.message });
    }
  }

  const completed = results.length;
  const mae = {
    specificity: roundScore(average(results.map(result => result.absoluteError.specificity))),
    profoundness: roundScore(average(results.map(result => result.absoluteError.profoundness))),
    coherence: roundScore(average(results.map(result => result.absoluteError.coherence)))
  };

  const bandAccuracy = {
    specificity: roundScore(average(results.map(result => result.bands.specificity.expected === result.bands.specificity.predicted ? 1 : 0))),
    profoundness: roundScore(average(results.map(result => result.bands.profoundness.expected === result.bands.profoundness.predicted ? 1 : 0))),
    coherence: roundScore(average(results.map(result => result.bands.coherence.expected === result.bands.coherence.predicted ? 1 : 0)))
  };

  const within015 = {
    specificity: roundScore(average(results.map(result => result.absoluteError.specificity <= 0.15 ? 1 : 0))),
    profoundness: roundScore(average(results.map(result => result.absoluteError.profoundness <= 0.15 ? 1 : 0))),
    coherence: roundScore(average(results.map(result => result.absoluteError.coherence <= 0.15 ? 1 : 0)))
  };

  const anchor = computeAnchorStats(results);
  const dimensionAgreement = average([bandAccuracy.specificity, bandAccuracy.profoundness, bandAccuracy.coherence]);
  const errorPenalty = average([1 - mae.specificity, 1 - mae.profoundness, 1 - mae.coherence]);
  const overallScore = completed > 0
    ? roundScore((dimensionAgreement * 0.45) + (errorPenalty * 0.35) + (anchor.f1 * 0.2))
    : null;

  return {
    fixtureSet: 'bootstrap-v1',
    strategy,
    totalCases: fixtures.length,
    completedCases: completed,
    failureCount: failures.length,
    availability: completed > 0
      ? { status: 'available' }
      : {
          status: 'unavailable',
          reason: failures[0]?.error || 'No assessments completed'
        },
    sourceBreakdown,
    metrics: {
      mae,
      bandAccuracy,
      within015,
      anchor,
      overallScore
    },
    failures,
    results
  };
}

module.exports = {
  runMessageAssessmentEval,
  MESSAGE_ASSESSMENT_FIXTURES
};
