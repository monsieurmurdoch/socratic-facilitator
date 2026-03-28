/**
 * Conversation State Analyzer
 *
 * Analyzes conversation state after each message
 */

const Anthropic = require('@anthropic-ai/sdk');

class StateAnalyzer {
  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = 'claude-sonnet-4-5-20250514';
  }

  async analyze({ openingQuestion, recentMessages, participants, primedContext }) {
    const participantInfo = participants.map(p =>
      `- ${p.name}: ${p.messageCount || 0} messages, last spoke ${p.messagesSinceLastSpoke || '?'} turns ago`
    ).join('\n');

    const themesContext = primedContext?.keyThemes?.length
      ? `\nSOURCE MATERIAL THEMES: ${primedContext.keyThemes.join(', ')}`
      : '';

    const prompt = `Analyze this Socratic discussion state.

OPENING QUESTION: ${openingQuestion}

RECENT MESSAGES:
${recentMessages}

PARTICIPANTS:
${participantInfo}${themesContext}

Output a JSON state assessment:
{
  "topicDrift": <float 0.0-1.0>,
  "trajectory": "<deepening|drifting|circling|stalled|branching>",
  "reasoningDepth": <float 0.0-1.0>,
  "listeningScore": <float 0.0-1.0>,
  "dominanceScore": <float 0.0-1.0>,
  "inclusionScore": <float 0.0-1.0>,
  "lastTurnType": "<assertion|question|agreement|challenge|deflection>",
  "unchallengedClaims": ["claim1", "claim2"],
  "unexploredTensions": [{"between": ["A", "B"], "about": "X"}],
  "ripeBranches": ["tangent1"],
  "reasoning": "<1-2 sentences>"
}

Output ONLY valid JSON.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      });

      const text = response.content[0].text.trim();
      const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      return JSON.parse(jsonStr);
    } catch (error) {
      console.error('State analysis error:', error.message);
      return this.getDefaultState();
    }
  }

  getDefaultState() {
    return {
      topicDrift: 0.5,
      trajectory: 'deepening',
      reasoningDepth: 0.5,
      listeningScore: 0.5,
      dominanceScore: 0.3,
      inclusionScore: 0.5,
      lastTurnType: 'assertion',
      unchallengedClaims: [],
      unexploredTensions: [],
      ripeBranches: [],
      reasoning: 'State analysis failed'
    };
  }

  calculateInterventionThreshold(state) {
    let threshold = 0;

    if (state.topicDrift > 0.7) threshold += 0.15;
    if (state.reasoningDepth < 0.3) threshold += 0.15;
    if (state.dominanceScore > 0.7) threshold += 0.15;
    if (state.inclusionScore < 0.4) threshold += 0.1;
    if (state.trajectory === 'stalled') threshold += 0.2;
    if (state.trajectory === 'circling') threshold += 0.15;
    if (state.unchallengedClaims?.length > 0) threshold += 0.05;
    if (state.unexploredTensions?.length > 0) threshold += 0.05;

    return Math.min(Math.max(threshold, 0), 1);
  }
}

module.exports = new StateAnalyzer();
