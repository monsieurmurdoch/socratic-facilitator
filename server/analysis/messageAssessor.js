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
const { fastLLM } = require('./fastLLMProvider');
const { stalenessGuard } = require('./stalenessGuard');
const { DEFAULT_ANTHROPIC_MODEL } = require('../models');

class MessageAssessor {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
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
  async assess(params, options = {}) {
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
  "referencesAnchors": [1, 3],
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

    // ── Strategy: Fast LLM first, Claude fallback, heuristic safety net ──
    const { strategy = 'auto', allowHeuristicFallback = true } = options;

    const parseAssessment = (assessment, meta = {}) => ({
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
      briefReasoning: assessment.briefReasoning || '',
      meta: {
        source: meta.source || 'unknown',
        model: meta.model || null,
        latencyMs: meta.latencyMs || null
      }
    });

    const heuristicFallback = this._heuristicAssessment(text, previousText, {
      topicTitle,
      openingQuestion,
      recentAnchors
    });

    if (strategy === 'heuristic_only') {
      return parseAssessment(heuristicFallback, { source: 'heuristic', model: 'heuristic' });
    }

    // Try fast LLM first
    if ((strategy === 'auto' || strategy === 'fast_only') && fastLLM.isAvailable()) {
      const fastResult = await stalenessGuard.guard(
        () => fastLLM.completeJSON({
          prompt,
          maxTokens: 800,
          temperature: 0.2,
          systemPrompt: 'Return only strict JSON. No markdown, no comments, no trailing commas.'
        }),
        { timeoutMs: 3000, fallback: null, label: 'fastLLM_messageAssess' }
      );

      if (!fastResult.stale && fastResult.result?.data) {
        console.log(`[MessageAssessor] Fast LLM assessment in ${fastResult.latencyMs}ms`);
        return parseAssessment(fastResult.result.data, {
          source: 'fast_llm',
          model: fastLLM.model,
          latencyMs: fastResult.latencyMs
        });
      }
    }

    if (strategy === 'fast_only' && !allowHeuristicFallback) {
      throw new Error('Fast LLM assessment unavailable');
    }

    // Fall back to Claude
    if (strategy === 'auto' || strategy === 'claude_only') {
      try {
        const claudeResult = await stalenessGuard.guard(
          async () => {
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
            return JSON.parse(jsonStr);
          },
          { timeoutMs: 8000, fallback: null, label: 'claude_messageAssess' }
        );

        if (!claudeResult.stale && claudeResult.result) {
          return parseAssessment(claudeResult.result, {
            source: 'claude',
            model: this.model,
            latencyMs: claudeResult.latencyMs
          });
        }
      } catch (error) {
        console.error('Message assessment error:', error.message);
      }
    }

    if (strategy === 'claude_only' && !allowHeuristicFallback) {
      throw new Error('Claude assessment unavailable');
    }

    // Ultimate fallback: heuristics
    return parseAssessment(heuristicFallback, { source: 'heuristic', model: 'heuristic' });
  }

  /**
   * Fallback heuristic assessment when LLM fails.
   */
  _heuristicAssessment(text, previousText, context = {}) {
    const normalizedText = String(text || '').trim();
    const lowerText = normalizedText.toLowerCase();
    const wordCount = normalizedText.split(/\s+/).filter(Boolean).length;
    const stopwords = new Set([
      'the', 'a', 'an', 'and', 'or', 'but', 'if', 'is', 'are', 'was', 'were', 'be', 'been',
      'to', 'of', 'in', 'on', 'for', 'with', 'that', 'this', 'it', 'he', 'she', 'they',
      'we', 'you', 'i', 'me', 'my', 'our', 'your', 'their', 'as', 'at', 'by', 'from',
      'so', 'than', 'then', 'into', 'about', 'really', 'just', 'also', 'maybe'
    ]);

    const tokenize = (value) => String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(token => token && token.length > 2 && !stopwords.has(token));

    const textTokens = tokenize(normalizedText);
    const previousTokens = tokenize(previousText || '');
    const topicTokens = tokenize(`${context.topicTitle || ''} ${context.openingQuestion || ''}`);
    const uniqueTextTokens = new Set(textTokens);
    const overlapRatio = (tokens) => {
      if (!tokens.length) return 0;
      const overlap = tokens.filter(token => uniqueTextTokens.has(token)).length;
      return overlap / tokens.length;
    };

    const prevOverlap = overlapRatio(previousTokens);
    const topicOverlap = overlapRatio(topicTokens);
    const previousUniqueTokens = new Set(previousTokens);
    const topicUniqueTokens = new Set(topicTokens);
    const sharedPreviousTerms = textTokens.filter(token => previousUniqueTokens.has(token));
    const sharedTopicTerms = textTokens.filter(token => topicUniqueTokens.has(token));
    const sharedContextTermCount = new Set([...sharedPreviousTerms, ...sharedTopicTerms]).size;

    const hasExample = /\b(for example|for instance|specifically|such as|chapter|scene|moment|line)\b/i.test(normalizedText);
    const hasReasoning = /\b(because|since|therefore|which means|that means|as a result|so that|instead of)\b/i.test(normalizedText);
    const hasQuestion = /\?$/.test(normalizedText) || /\b(why|how|what if|is the story|so is|are we|does that mean)\b/i.test(normalizedText);
    const hasContrast = /\b(but|however|although|instead|difference|distinction|on the other hand|rather than|less about|more about)\b/i.test(normalizedText);
    const hasSynthesis = /\b(building on|combine|both|together|what .+ said|like .+ said|what .+ and .+ said|synthesize)\b/i.test(normalizedText);
    const hasResponsibilityLanguage = /\b(responsibility|obligation|power|belong|meaning|justice|truth|identity|evil|accountable|neglect|choice|moral|harm|repair)\b/i.test(normalizedText);
    const isAgreement = /\b(yeah|yes|i agree|same|exactly|totally)\b/i.test(normalizedText);
    const isGenericOpinion = /\b(i (just )?(do not|don't|did not|didn't)? ?like|i hate|i love)\b/i.test(normalizedText);
    const referencesPreviousSpeaker = /\b(that|this|it|those|these)\b.*\b(said|mentioned|pointed|asked)\b/i.test(normalizedText);
    const hasContinuationPronoun = /^(he|she|they|it|this|that|these|those)\b/i.test(lowerText);

    const anchorReferences = (context.recentAnchors || [])
      .map((anchor, index) => ({ anchor, index }))
      .filter(({ anchor }) => {
        const summaryTokens = tokenize(anchor.summary || '');
        return summaryTokens.length > 0 && overlapRatio(summaryTokens) >= 0.22;
      })
      .map(({ index }) => index + 1);

    const isTopicallyGrounded = topicOverlap >= 0.08 || sharedContextTermCount >= 2;
    const topicDrift = !isTopicallyGrounded && prevOverlap < 0.05 && !hasSynthesis && !referencesPreviousSpeaker && !isAgreement && !hasContinuationPronoun;

    let specificity = 0.06;
    specificity += Math.min(wordCount / 55, 0.22);
    if (wordCount >= 10) specificity += 0.06;
    if (wordCount >= 22) specificity += 0.06;
    if (wordCount >= 6) specificity += 0.04;
    if (hasExample) specificity += 0.24;
    if (hasReasoning) specificity += 0.14;
    if (/\b(chapter|scene|moment|specific|chooses|refusing|after|before)\b/i.test(normalizedText)) specificity += 0.08;
    if (hasQuestion && wordCount >= 5) specificity += 0.08;
    if (isAgreement) specificity -= 0.18;
    if (isGenericOpinion) specificity -= 0.08;

    let profoundness = 0.08;
    profoundness += hasQuestion ? 0.16 : 0;
    profoundness += hasContrast ? 0.18 : 0;
    profoundness += hasSynthesis ? 0.18 : 0;
    profoundness += hasReasoning ? 0.1 : 0;
    profoundness += hasResponsibilityLanguage ? 0.12 : 0;
    if (/\b(less about|more about|difference between|instead of|what happens when)\b/i.test(normalizedText)) profoundness += 0.18;
    if (isAgreement) profoundness -= 0.16;
    if (isGenericOpinion) profoundness -= 0.12;
    if (topicDrift) profoundness -= 0.12;

    let coherence = 0.18;
    coherence += Math.min(prevOverlap * 0.9, 0.28);
    coherence += Math.min(topicOverlap * 0.9, 0.28);
    coherence += Math.min(sharedContextTermCount * 0.06, 0.18);
    if (hasSynthesis) coherence += 0.26;
    if (referencesPreviousSpeaker) coherence += 0.16;
    if (hasContinuationPronoun && previousText) coherence += 0.16;
    if (/\b(agree|disagree|but|however|building on|like you said|so is)\b/i.test(normalizedText)) coherence += 0.14;
    if (hasReasoning && isTopicallyGrounded) coherence += 0.08;
    if (hasQuestion && isTopicallyGrounded) coherence += 0.06;
    if (anchorReferences.length) coherence += 0.12;
    if (isAgreement && !hasReasoning && !hasExample) coherence = Math.max(coherence, 0.68);
    if (isGenericOpinion && isTopicallyGrounded) coherence = Math.max(coherence, 0.5);
    if (hasReasoning && !topicDrift) coherence = Math.max(coherence, 0.56);
    if ((hasExample || hasContrast) && !topicDrift) coherence = Math.max(coherence, 0.6);
    if (hasContinuationPronoun && previousText && !topicDrift) coherence = Math.max(coherence, 0.52);
    if (!topicDrift && isTopicallyGrounded && wordCount >= 6) coherence = Math.max(coherence, 0.44);
    if (topicDrift) coherence -= 0.36;
    if (/\bsnow days\b/i.test(normalizedText)) coherence -= 0.2;

    specificity = this._clamp(specificity);
    profoundness = this._clamp(profoundness);
    coherence = this._clamp(coherence);

    const isAnchor = (
      wordCount >= 16 &&
      (
        profoundness >= 0.62 ||
        hasSynthesis ||
        hasContrast ||
        (hasQuestion && profoundness >= 0.5) ||
        anchorReferences.length > 0
      ) &&
      !isAgreement &&
      !isGenericOpinion &&
      !topicDrift
    );

    let briefReasoning = 'Heuristic assessment (LLM unavailable)';
    if (topicDrift) {
      briefReasoning = 'Likely topic drift: low overlap with the discussion and little evidence of building on prior comments.';
    } else if (hasSynthesis) {
      briefReasoning = 'Likely strong contribution: synthesizes multiple earlier ideas and advances the discussion.';
    } else if (hasContrast || hasQuestion) {
      briefReasoning = 'Likely thoughtful contribution: introduces tension, distinction, or a generative question.';
    } else if (hasExample || hasReasoning) {
      briefReasoning = 'Likely substantive contribution: includes evidence or causal reasoning connected to the prompt.';
    } else if (isAgreement || isGenericOpinion) {
      briefReasoning = 'Likely lighter contribution: responds to the discussion but adds limited new substance.';
    }

    return {
      engagement: {
        specificity,
        profoundness,
        coherence
      },
      anchor: {
        isAnchor,
        profundness: isAnchor ? this._clamp((profoundness * 0.7) + (coherence * 0.3)) : profoundness,
        summary: isAnchor ? normalizedText.slice(0, 140) : null
      },
      claims: [],
      referencesAnchors: anchorReferences,
      briefReasoning
    };
  }

  _clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
  }
}

module.exports = { MessageAssessor };
