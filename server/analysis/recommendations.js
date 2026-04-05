function buildClassRecommendations({ summary = {}, sessions = [], students = [], commentLens = [] }) {
  const recommendations = [];
  const orderedStudents = [...students].sort((a, b) => (b.avgContribution || 0) - (a.avgContribution || 0));
  const topStudent = orderedStudents[0];
  const secondStudent = orderedStudents[1];
  const avgCoherence = commentLens.length
    ? commentLens.reduce((sum, comment) => sum + Number(comment.coherence || 0), 0) / commentLens.length
    : 0;
  const avgAnchorRate = commentLens.length
    ? commentLens.filter(comment => comment.isAnchor).length / commentLens.length
    : 0;

  if (topStudent && secondStudent && (topStudent.totalMessages || 0) > ((secondStudent.totalMessages || 0) * 1.8)) {
    recommendations.push({
      id: 'rebalance-voices',
      title: 'Rebalance airtime',
      priority: 'high',
      detail: `${topStudent.name} is carrying much more of the discussion volume than peers. Try opening with a round-robin or ask for two quieter voices before follow-ups.`
    });
  }

  if ((summary.avgEngagement || 0) < 0.52) {
    recommendations.push({
      id: 'tighten-openings',
      title: 'Tighten the opening prompt',
      priority: 'medium',
      detail: 'Recent sessions are reading as fairly flat. Narrower opening questions or a concrete passage excerpt may improve uptake.'
    });
  }

  if (avgCoherence > 0 && avgCoherence < 0.56) {
    recommendations.push({
      id: 'build-peer-reference',
      title: 'Push peer-to-peer building',
      priority: 'high',
      detail: 'Students are contributing, but they are not connecting strongly to one another. Prompt them to name whose point they are extending or challenging.'
    });
  }

  if (avgAnchorRate > 0 && avgAnchorRate < 0.18) {
    recommendations.push({
      id: 'surface-anchor-thoughts',
      title: 'Surface anchor thoughts sooner',
      priority: 'medium',
      detail: 'Few comments are being scored as load-bearing. Ask students to name the distinction or tension they think matters most before moving on.'
    });
  }

  if (!recommendations.length && sessions.length >= 2) {
    recommendations.push({
      id: 'keep-pattern',
      title: 'Keep the current structure',
      priority: 'low',
      detail: 'Participation and engagement look reasonably healthy. Preserve the current format and use the comment lens to highlight standout reasoning after class.'
    });
  }

  return recommendations.slice(0, 4);
}

function buildStudentRecommendations({ student = {}, sessions = [], commentLens = [] }) {
  const recommendations = [];
  const avgSpecificity = commentLens.length
    ? commentLens.reduce((sum, comment) => sum + Number(comment.specificity || 0), 0) / commentLens.length
    : 0;
  const avgCoherence = commentLens.length
    ? commentLens.reduce((sum, comment) => sum + Number(comment.coherence || 0), 0) / commentLens.length
    : 0;
  const anchorCount = commentLens.filter(comment => comment.isAnchor).length;

  if ((student.avgContribution || 0) < 0.45 && (student.avgEngagement || 0) >= 0.5) {
    recommendations.push({
      id: 'invite-earlier',
      title: 'Invite earlier in the seminar',
      priority: 'medium',
      detail: `${student.name} appears engaged but relatively quiet. Calling on them during the first third of the discussion may increase their contribution.`
    });
  }

  if (avgSpecificity >= 0.6 && avgCoherence < 0.58) {
    recommendations.push({
      id: 'connect-to-peers',
      title: 'Coach connection to peers',
      priority: 'high',
      detail: `${student.name}'s comments have substance, but they are not consistently tethered to classmates' ideas. Encourage explicit callbacks and named responses.`
    });
  }

  if (anchorCount >= 2) {
    recommendations.push({
      id: 'highlight-anchor-thinking',
      title: 'Highlight anchor thinking',
      priority: 'low',
      detail: `${student.name} is producing multiple load-bearing comments. Consider using one of them in your debrief or follow-up writing prompt.`
    });
  }

  if (!recommendations.length && sessions.length >= 2) {
    recommendations.push({
      id: 'steady-growth',
      title: 'Keep reinforcing current habits',
      priority: 'low',
      detail: `${student.name}'s recent pattern looks steady. Reinforce whatever prompt structure is helping them stay engaged.`
    });
  }

  return recommendations.slice(0, 3);
}

module.exports = {
  buildClassRecommendations,
  buildStudentRecommendations
};
