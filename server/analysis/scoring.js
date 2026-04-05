function clampScore(value, min = 0, max = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.max(min, Math.min(max, numeric));
}

function roundScore(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(clampScore(value) * factor) / factor;
}

function computeMessageMetrics(assessment = {}) {
  const specificity = clampScore(assessment.engagement?.specificity);
  const profoundness = clampScore(assessment.engagement?.profoundness);
  const coherence = clampScore(assessment.engagement?.coherence);
  const discussionValue = roundScore((specificity * 0.35) + (profoundness * 0.4) + (coherence * 0.25));
  const contributionWeight = roundScore((specificity + profoundness + coherence) / 3);
  const engagementEstimate = roundScore((coherence * 0.5) + (profoundness * 0.3) + (specificity * 0.2));

  return {
    specificity,
    profoundness,
    coherence,
    discussionValue,
    contributionWeight,
    engagementEstimate,
    respondedToPeer: coherence >= 0.65,
    referencedAnchor: Array.isArray(assessment.referencesAnchors) && assessment.referencesAnchors.length > 0
  };
}

function getScoreBand(score) {
  const normalized = clampScore(score);
  if (normalized < 0.34) {
    return { id: 'emerging', label: 'Emerging' };
  }
  if (normalized < 0.67) {
    return { id: 'developing', label: 'Developing' };
  }
  return { id: 'strong', label: 'Strong' };
}

function getConfidenceBand(source, score) {
  const normalized = clampScore(score);
  const distanceToBoundary = Math.min(
    Math.abs(normalized - 0.34),
    Math.abs(normalized - 0.67)
  );

  const baseBySource = {
    heuristic: 0.42,
    fast_llm: 0.62,
    claude: 0.78,
    unknown: 0.52
  };

  const base = baseBySource[source] ?? baseBySource.unknown;
  const confidence = Math.max(0, Math.min(1, base + Math.min(distanceToBoundary * 0.8, 0.14)));

  if (confidence < 0.5) {
    return { value: Math.round(confidence * 100) / 100, id: 'low', label: 'Low confidence' };
  }
  if (confidence < 0.72) {
    return { value: Math.round(confidence * 100) / 100, id: 'medium', label: 'Medium confidence' };
  }
  return { value: Math.round(confidence * 100) / 100, id: 'high', label: 'High confidence' };
}

function buildSignalDisplay(score, source = 'unknown') {
  const value = roundScore(score);
  const band = getScoreBand(value);
  const confidence = getConfidenceBand(source, value);

  return {
    score: value,
    band: band.id,
    label: band.label,
    confidence: confidence.value,
    confidenceBand: confidence.id,
    confidenceLabel: confidence.label
  };
}

function decorateAnalyticsComment(comment) {
  const source = comment?.raw_payload?.meta?.source || 'unknown';

  return {
    specificity: Number(comment.specificity || 0),
    profoundness: Number(comment.profoundness || 0),
    coherence: Number(comment.coherence || 0),
    discussionValue: Number(comment.discussion_value || 0),
    contributionWeight: Number(comment.contribution_weight || 0),
    engagementEstimate: Number(comment.engagement_estimate || 0),
    displays: {
      specificity: buildSignalDisplay(comment.specificity, source),
      profoundness: buildSignalDisplay(comment.profoundness, source),
      coherence: buildSignalDisplay(comment.coherence, source),
      discussionValue: buildSignalDisplay(comment.discussion_value, source)
    },
    source
  };
}

module.exports = {
  clampScore,
  roundScore,
  computeMessageMetrics,
  getScoreBand,
  getConfidenceBand,
  buildSignalDisplay,
  decorateAnalyticsComment
};
