/**
 * Message Assessor
 *
 * Uses LLM to extract all dimensions from a participant message:
 * - Engagement dimensions: specificity, profoundness, coherence
 * - Anchor detection: is this a load-bearing statement?
 * - Claim extraction: factual vs normative claims, accuracy
 *
 * Designed to be used standalone — no dependency on the main app.
 */

const Anthropic = require('@anthropic-ai/sdk');

class MessageAssessor {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.model = 'claude-sonnet-4-5-20250514';
  }

  /**
   * Assess a single message.
   *
   * @param {object} params
   * @param {string} params.text  The message text
   * @param {string} params.participantName  Who said it
   * @param {string} params.previousText  The previous message (for coherence)
   * @param {string} params.topicTitle  Current discussion topic
   * @param {string} params.openingQuestion  The opening question
   * @param {object[]} params.recentAnchors  Recent anchor summaries for reference detection
   * @returns {Promise<MessageAssessment>}
   */
  async assess(params) {
    const {
      text,
      participantName,
      previousText,
      topicTitle,
      openingQuestion,
      recentAnchors = []
    } = params;

    const anchorContext = recentAnchors.length > 0
      ? `\nEXISTING ANCHORS IN THIS CONVERSATION:\n${recentAnchors.map((a, i) =>
          `${i + 1}. [${a.participantName}]: "${a.summary}"`
        ).join('\n')}`
      : '';

    const prompt = `Analyze this message from a Socratic discussion participant.

TOPIC: ${topicTitle}
OPENING QUESTION: ${openingQuestion}
${anchorContext}

PARTICIPANT: ${participantName}
MESSAGE: "${text}"
${previousText ? `\nPREVIOUS MESSAGE: "${previousText}"` : ''}

Assess this message on multiple dimensions and respond with ONLY a JSON object:

{
  "engagement": {
    "specificity": 0.XX,
    "profoundness": 0.XX,
    "coherence": 0.XX
  },
  "anchor": {
    "isAnchor": true/false,
    "profundness": 0.XX,
    "summary": "1-sentence summary of the core idea (only if anchor)"
  },
  "claims": [
    {
      "text": "the factual or normative claim",
      "classification": "factual|normative|mixed",
      "isAccurate": true|false|null,
      "correction": "suggested correction if false (optional)",
      "confidence": 0.XX
    }
  ],
  "referencesAnchors": [1, 3],  // indices of existing anchors referenced, or []
  "briefReasoning": "1-2 sentences on what makes this message notable (or not)"
}

DIMENSION DEFINITIONS:

specificity (0-1): How concrete and detailed is this?
- 0.2: Vague agreement ("yeah", "I think so too")
- 0.4: General statement without examples
- 0.6: Specific point with some detail
- 0.8: Detailed with examples or reasoning
- 1.0: Highly specific with concrete examples, reasoning, and detail

profoundness (0-1): Does this push thinking forward?
- 0.2: Restates obvious or repeats
- 0.4: Minor contribution, stays surface-level
- 0.6: Adds something new to consider
- 0.8: Introduces distinction, tension, or novel angle
- 1.0: Profound insight that reframes the question

coherence (0-1): Does this build on the conversation?
- 0.2: Disconnected, changes topic abruptly
- 0.4: Tangentially related
- 0.6: Acknowledges previous point
- 0.8: Directly responds to or builds on previous
- 1.0: Synthesizes multiple previous points

isAnchor: Is this a load-bearing statement likely to be referenced later?
- true if: introduces key distinction, makes novel argument, asks generative question
- false if: agreement, restatement, minor comment

claim classification:
- "factual": verifiable statement about the world (can be true/false)
- "normative": value judgment, opinion, or preference (no correction needed)
- "mixed": factual claim embedded in normative argument

Only flag factual claims as inaccurate if you're confident (>70%). Never correct normative claims.

Respond with ONLY the JSON object, no other text.`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }]
      });

      const responseText = response.content[0].text.trim();
      const jsonStr = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const assessment = JSON.parse(jsonStr);

      // Normalize and validate
      return {
        engagement: {
          specificity: this._clamp(assessment.engagement?.specificity ?? 0.5),
          profoundness: this._clamp(assessment.engagement?.profoundness ?? 0.5),
          coherence: this._clamp(assessment.engagement?.coherence ?? 0.5)
        },
        anchor: {
          isAnchor: assessment.anchor?.isAnchor ?? false,
          profundness: this._clamp(assessment.anchor?.profundness ?? 0.5),
          summary: assessment.anchor?.summary || null
        },
        claims: (assessment.claims || []).map(c => ({
          text: c.text,
          classification: c.classification || 'normative',
          isAccurate: c.isAccurate ?? null,
          correction: c.correction || null,
          confidence: this._clamp(c.confidence ?? 0.5)
        })),
        referencesAnchors: assessment.referencesAnchors || [],
        briefReasoning: assessment.briefReasoning || ''
      };
    } catch (error) {
      console.error('Message assessment error:', error.message);

      // Return fallback heuristics
      return this._heuristicAssessment(text, previousText);
    }
  }

  /**
   * Fallback heuristic assessment when LLM fails.
   */
  _heuristicAssessment(text, previousText) {
    const wordCount = text.split(/\s+/).length;

    // Specificity heuristic
    let specificity = 0.4;
    if (wordCount > 20) specificity += 0.15;
    if (wordCount > 40) specificity += 0.15;
    if (/for example|for instance|specifically|such as/i.test(text)) specificity += 0.2;
    if (/because|since|therefore|the reason/i.test(text)) specificity += 0.1;

    // Profoundness heuristic
    let profoundness = 0.4;
    if (/\b(why|how|what if|what makes|what would happen)\b/i.test(text)) profoundness += 0.2;
    if (/difference between|distinction|on the other hand/i.test(text)) profoundness += 0.15;
    if (/identity|consciousness|truth|meaning|purpose|value|essence/i.test(text)) profoundness += 0.15;

    // Coherence heuristic
    let coherence = 0.5;
    if (previousText) {
      if (/agree|disagree|yes|no|but|however|building on|like you said/i.test(text)) {
        coherence = 0.7;
      }
      if (/\b(that|this|it|those|these)\b.*\b(said|mentioned|pointed|asked)\b/i.test(text)) {
        coherence = 0.8;
      }
    }

    // Anchor detection
    const isAnchor = wordCount > 25 &&
      (profoundness > 0.6 || /\b(what if|imagine|suppose|the key question|here's the thing)\b/i.test(text));

    return {
      engagement: {
        specificity: Math.min(1, specificity),
        profoundness: Math.min(1, profoundness),
        coherence: Math.min(1, coherence)
      },
      anchor: {
        isAnchor,
        profundness: Math.min(1, profoundness),
        summary: isAnchor ? text.substring(0, 100) : null
      },
      claims: [],
      referencesAnchors: [],
      briefReasoning: 'Heuristic assessment (LLM unavailable)'
    };
  }

  _clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
  }
}

module.exports = { MessageAssessor };
