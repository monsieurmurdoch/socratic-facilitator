/**
 * Signal Computer
 *
 * Computes the three main input signals for the intervention neuron:
 * 1. onTopicHelpfulness (0-1)
 * 2. connectivity (0-1)
 * 3. anchorProximity (0-1)
 *
 * Also computes:
 * - Engagement score (recency-weighted)
 * - Inclusion urgency
 * - Dominance score
 */

const Anthropic = require('@anthropic-ai/sdk');

class SignalComputer {
  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = 'claude-sonnet-4-5-20250514';

    // Cache for expensive computations
    this.cache = new Map();
    this.cacheTimeout = 5000; // 5 seconds
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN COMPUTATION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute all signals for a conversation state
   */
  async computeAll(state) {
    const {
      messages = [],
      topic = {},
      anchors = [],
      participants = [],
      silenceDurationSec = 0
    } = state;

    // Run computations in parallel where possible
    const [
      onTopicHelpfulness,
      connectivity,
      anchorProximity,
      engagement,
      inclusionUrgency,
      dominanceScore
    ] = await Promise.all([
      this.computeOnTopicHelpfulness(messages, topic),
      this.computeConnectivity(messages),
      this.computeAnchorProximity(messages, anchors),
      this.computeEngagement(messages),
      this.computeInclusionUrgency(participants, messages),
      this.computeDominanceScore(participants, messages)
    ]);

    return {
      onTopicHelpfulness,
      connectivity,
      anchorProximity,
      engagement,
      inclusionUrgency,
      dominanceScore,
      silenceDurationSec
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. ON-TOPIC HELPFULNESS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute how helpfully on/off-topic the conversation is.
   *
   * High scores: on-topic & productive, or productively off-topic
   * Low scores: off-topic & disconnected, or circling/stalled
   */
  async computeOnTopicHelpfulness(messages, topic, useLLM = true) {
    if (messages.length < 2) return 0.7; // Default to slightly helpful for new conversations

    const recent = messages.slice(-8);

    // Quick heuristic check first (no LLM)
    const heuristicScore = this._heuristicHelpfulness(recent, topic);

    // If heuristic is very clear, skip LLM
    if (heuristicScore.confidence > 0.8) {
      return heuristicScore.score;
    }

    // Use LLM for nuanced assessment
    if (useLLM) {
      try {
        return await this._llmHelpfulness(recent, topic);
      } catch (error) {
        console.error('LLM helpfulness error:', error.message);
        return heuristicScore.score;
      }
    }

    return heuristicScore.score;
  }

  _heuristicHelpfulness(messages, topic) {
    let score = 0.5;
    let confidence = 0.3;

    // Check for topic-related keywords
    const topicWords = this._extractKeywords(topic.openingQuestion || topic.title || '');
    const messageText = messages.map(m => m.text || m.content || '').join(' ').toLowerCase();

    let topicWordMatches = 0;
    for (const word of topicWords) {
      if (messageText.includes(word.toLowerCase())) {
        topicWordMatches++;
      }
    }

    const topicRelevance = topicWords.length > 0 ? topicWordMatches / topicWords.length : 0.5;

    // Check for productive patterns
    const hasQuestions = messages.some(m => (m.text || '').includes('?'));
    const hasAgreement = messages.some(m => /agree|yes|right|exactly|that's true/i.test(m.text || ''));
    const hasDisagreement = messages.some(m => /disagree|but|however|not sure|don't think/i.test(m.text || ''));
    const hasBuilding = messages.some(m => /building on|adding to|also|and|furthermore|what you said/i.test(m.text || ''));

    // Compute score
    score = topicRelevance * 0.4;

    if (hasQuestions) score += 0.15;
    if (hasAgreement || hasDisagreement) score += 0.15;
    if (hasBuilding) score += 0.2;

    // Check for stalled patterns
    const lastThree = messages.slice(-3).map(m => (m.text || '').toLowerCase());
    const isRepeating = lastThree.length >= 3 &&
      this._textSimilarity(lastThree[0], lastThree[2]) > 0.7;

    if (isRepeating) {
      score -= 0.3;
      confidence = 0.6;
    }

    // Normalize
    score = Math.max(0, Math.min(1, score));
    confidence = Math.min(1, confidence + (messages.length * 0.05));

    return { score, confidence };
  }

  async _llmHelpfulness(messages, topic) {
    const conversationText = messages.map(m => {
      const name = m.participantName || m.sender_name || 'Speaker';
      const text = m.text || m.content || '';
      return `[${name}]: ${text}`;
    }).join('\n');

    const prompt = `Assess how helpfully on-topic this conversation is.

TOPIC: ${topic.title || 'General discussion'}
OPENING QUESTION: ${topic.openingQuestion || 'N/A'}

RECENT CONVERSATION:
${conversationText}

Score the "helpfulness" on a scale of 0.0 to 1.0 where:
- 0.9-1.0: On-topic AND productively deepening
- 0.7-0.9: On-topic OR productively off-topic (exploring related ideas)
- 0.5-0.7: Somewhat on-topic, moderate engagement
- 0.3-0.5: Circling, stalling, or mildly off-topic
- 0.0-0.3: Completely off-topic, stalled, or unproductive

Consider:
- Are they engaging with the core question?
- Are they building on each other's ideas?
- Even if "off-topic", is it productive exploration?

Respond with ONLY a JSON object: { "score": 0.XX, "reasoning": "brief explanation" }`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text.trim();
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result = JSON.parse(jsonStr);

    return Math.max(0, Math.min(1, result.score));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. CONNECTIVITY
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute how much comments build on each other.
   *
   * High scores: each message references or builds on previous ones
   * Low scores: fragmented, disconnected statements
   */
  async computeConnectivity(messages) {
    if (messages.length < 2) return 0.5;

    const recent = messages.slice(-10);
    let totalScore = 0;
    let connections = 0;

    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1];
      const curr = recent[i];

      const prevText = prev.text || prev.content || '';
      const currText = curr.text || curr.content || '';
      const prevSpeaker = prev.participantName || prev.sender_name || '';
      const currSpeaker = curr.participantName || curr.sender_name || '';

      // Skip facilitator messages for connectivity
      const prevIsFacilitator = prev.participantId === '__facilitator__' ||
                                 prev.sender_type === 'facilitator' ||
                                 prevSpeaker.toLowerCase() === 'facilitator';
      const currIsFacilitator = curr.participantId === '__facilitator__' ||
                                 curr.sender_type === 'facilitator' ||
                                 currSpeaker.toLowerCase() === 'facilitator';

      if (prevIsFacilitator || currIsFacilitator) continue;

      connections++;
      let score = 0;

      // Check for explicit references to previous speaker
      if (currText.toLowerCase().includes(prevSpeaker.toLowerCase())) {
        score += 0.3;
      }

      // Check for agreement/disagreement markers
      if (/\b(yes|yeah|agree|right|exactly|true|correct)\b/i.test(currText)) {
        score += 0.25;
      }
      if (/\b(but|however|disagree|not sure|don't think|no,)\b/i.test(currText)) {
        score += 0.25;
      }

      // Check for "building" phrases
      if (/(building on|adding to|also|like you said|as .* mentioned|following up)/i.test(currText)) {
        score += 0.35;
      }

      // Check for question followed by answer
      if (prevText.includes('?')) {
        // Check if current message seems to answer it
        const prevQuestion = this._extractQuestion(prevText);
        if (prevQuestion && this._seemsToAnswer(currText, prevQuestion)) {
          score += 0.4;
        }
      }

      // Check for thematic similarity
      const similarity = this._textSimilarity(prevText, currText);
      if (similarity > 0.3) {
        score += 0.2;
      }

      // Check for pronouns that reference previous content
      if (/\b(that|this|it|those|these|they)\b/i.test(currText) && currText.length < 100) {
        score += 0.15;
      }

      totalScore += Math.min(1, score);
    }

    if (connections === 0) return 0.5;

    return Math.round((totalScore / connections) * 100) / 100;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. ANCHOR PROXIMITY
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute how close the conversation is to load-bearing elements.
   *
   * High scores: recent messages reference or are thematically near anchors
   * Low scores: conversation has drifted far from all anchors
   */
  async computeAnchorProximity(messages, anchors) {
    if (anchors.length === 0) return 0.5; // No anchors yet
    if (messages.length === 0) return 0.5;

    const recent = messages.slice(-6);
    const recentText = recent.map(m => m.text || m.content || '').join(' ');

    let maxProximity = 0;
    let weightedSum = 0;
    let totalWeight = 0;

    for (const anchor of anchors) {
      // Direct reference in recent messages
      let proximity = this._computeAnchorProximity(anchor, recentText, recent);

      // Weight by anchor's load-bearingness
      const weight = anchor.loadBearingWeight || (anchor.referencesCount > 2 ? 1.5 : 1.0);

      weightedSum += proximity * weight;
      totalWeight += weight;

      maxProximity = Math.max(maxProximity, proximity);
    }

    // Combine max proximity with weighted average
    const avgProximity = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const combined = (maxProximity * 0.6) + (avgProximity * 0.4);

    return Math.round(combined * 100) / 100;
  }

  _computeAnchorProximity(anchor, recentText, recentMessages) {
    // Check for direct text reference
    if (anchor.summary && recentText.toLowerCase().includes(anchor.summary.toLowerCase().slice(0, 30))) {
      return 0.95;
    }

    // Check for speaker reference
    if (anchor.speaker) {
      const speakerReferenced = recentMessages.some(m =>
        (m.text || '').toLowerCase().includes(anchor.speaker.toLowerCase())
      );
      if (speakerReferenced) return 0.85;
    }

    // Check for thematic overlap
    if (anchor.themes && anchor.themes.length > 0) {
      const themeMatches = anchor.themes.filter(theme =>
        recentText.toLowerCase().includes(theme.toLowerCase())
      );
      if (themeMatches.length > 0) {
        return 0.5 + (themeMatches.length / anchor.themes.length) * 0.3;
      }
    }

    // Check for keyword overlap
    if (anchor.keywords && anchor.keywords.length > 0) {
      const keywordMatches = anchor.keywords.filter(kw =>
        recentText.toLowerCase().includes(kw.toLowerCase())
      );
      if (keywordMatches.length > 0) {
        return 0.3 + (keywordMatches.length / anchor.keywords.length) * 0.3;
      }
    }

    // No proximity detected
    return 0.1;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // ENGAGEMENT SCORE (Recency-Weighted)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute engagement score with exponential recency bias.
   *
   * Factors:
   * - Answer specificity
   * - Question profoundness
   * - Anchor references
   */
  async computeEngagement(messages) {
    if (messages.length === 0) {
      return { score: 0.5, trend: 'stable', signals: {} };
    }

    const recent = messages.slice(-8);

    // Exponential recency weights (newer = higher weight)
    const weights = recent.map((_, i) => Math.pow(1.3, i));
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    let weightedSum = 0;
    const signals = {
      highSpecificity: false,
      probingQuestions: false,
      referencingAnchors: false,
      buildingOnEachOther: false
    };

    for (let i = 0; i < recent.length; i++) {
      const msg = recent[i];
      const text = msg.text || msg.content || '';
      const w = weights[i] / totalWeight;

      // Skip facilitator messages
      if (msg.participantId === '__facilitator__' || msg.sender_type === 'facilitator') {
        continue;
      }

      let contribution = 0.4; // Base contribution

      // Check for question profoundness
      if (text.includes('?')) {
        const profoundness = this._assessQuestionProfoundness(text);
        contribution += profoundness * 0.3;
        if (profoundness > 0.6) signals.probingQuestions = true;
      }

      // Check for answer specificity
      const specificity = this._assessSpecificity(text);
      contribution += specificity * 0.2;
      if (specificity > 0.7) signals.highSpecificity = true;

      // Check for building patterns
      if (i > 0) {
        const prevText = recent[i - 1].text || recent[i - 1].content || '';
        if (this._textSimilarity(text, prevText) > 0.25) {
          contribution += 0.15;
          signals.buildingOnEachOther = true;
        }
      }

      weightedSum += contribution * w;
    }

    // Compute trend
    let trend = 'stable';
    if (recent.length >= 4) {
      const firstHalf = recent.slice(0, Math.floor(recent.length / 2));
      const secondHalf = recent.slice(Math.floor(recent.length / 2));

      const firstEngagement = this._avgEngagement(firstHalf);
      const secondEngagement = this._avgEngagement(secondHalf);

      if (secondEngagement > firstEngagement + 0.15) trend = 'rising';
      else if (secondEngagement < firstEngagement - 0.15) trend = 'falling';
    }

    return {
      score: Math.round(Math.min(1, weightedSum) * 100) / 100,
      trend,
      signals
    };
  }

  _avgEngagement(messages) {
    let total = 0;
    for (const msg of messages) {
      const text = msg.text || msg.content || '';
      let score = 0.4;
      score += this._assessSpecificity(text) * 0.3;
      if (text.includes('?')) score += 0.2;
      total += score;
    }
    return total / messages.length;
  }

  _assessQuestionProfoundness(text) {
    // Simple heuristic - can be enhanced with LLM
    const profoundIndicators = [
      /why do you think/i,
      /what if/i,
      /how do we know/i,
      /what makes something/i,
      /is there a difference/i,
      /can something be/i,
      /what would happen/i
    ];

    const basicIndicators = [
      /do you/i,
      /is it/i,
      /are there/i,
      /what is/i
    ];

    for (const pattern of profoundIndicators) {
      if (pattern.test(text)) return 0.8;
    }

    for (const pattern of basicIndicators) {
      if (pattern.test(text)) return 0.5;
    }

    return 0.3;
  }

  _assessSpecificity(text) {
    // Longer, more detailed responses indicate higher engagement
    const wordCount = text.split(/\s+/).length;

    // Contains examples or specific references
    const hasExamples = /for example|for instance|like when|specifically|such as/i.test(text);

    // Contains reasoning words
    const hasReasoning = /because|since|therefore|so|that's why|the reason/i.test(text);

    let score = 0.3;
    if (wordCount > 20) score += 0.2;
    if (wordCount > 40) score += 0.2;
    if (hasExamples) score += 0.2;
    if (hasReasoning) score += 0.1;

    return Math.min(1, score);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INCLUSION URGENCY
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute urgency of drawing in quiet participants.
   *
   * High scores: someone has been quiet for many turns
   * Low scores: all participants are roughly balanced
   */
  async computeInclusionUrgency(participants, messages) {
    if (participants.length < 2) return 0;

    const recent = messages.slice(-12);
    const participantMessageCounts = new Map();

    // Count recent messages per participant
    for (const p of participants) {
      participantMessageCounts.set(p.id || p.name, 0);
    }

    for (const msg of recent) {
      const id = msg.participantId || msg.participantName;
      if (participantMessageCounts.has(id)) {
        participantMessageCounts.set(id, participantMessageCounts.get(id) + 1);
      }
    }

    // Find the quietest participant
    let minMessages = Infinity;
    let quietestCount = 0;

    for (const [id, count] of participantMessageCounts) {
      if (count < minMessages) {
        minMessages = count;
        quietestCount = 1;
      } else if (count === minMessages) {
        quietestCount++;
      }
    }

    // Compute urgency
    const totalRecent = recent.length;
    const avgMessages = totalRecent / participants.length;

    // If someone has 0 messages in recent window and others have many
    if (minMessages === 0 && avgMessages > 3) {
      return 0.9;
    }

    // If someone has much fewer than average
    if (minMessages < avgMessages * 0.3 && avgMessages > 2) {
      return 0.7;
    }

    // Mild urgency
    if (minMessages < avgMessages * 0.5) {
      return 0.4;
    }

    return 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DOMINANCE SCORE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Compute if one participant is dominating.
   *
   * High scores: one person speaking way more than others
   * Low scores: balanced participation
   */
  async computeDominanceScore(participants, messages) {
    if (participants.length < 2) return 0;

    const recent = messages.slice(-15);
    const participantMessageCounts = new Map();

    for (const p of participants) {
      participantMessageCounts.set(p.id || p.name, 0);
    }

    for (const msg of recent) {
      const id = msg.participantId || msg.participantName;
      if (participantMessageCounts.has(id)) {
        participantMessageCounts.set(id, participantMessageCounts.get(id) + 1);
      }
    }

    const counts = Array.from(participantMessageCounts.values());
    const total = counts.reduce((a, b) => a + b, 0);

    if (total === 0) return 0;

    const maxCount = Math.max(...counts);
    const dominanceRatio = maxCount / total;

    // If one person has > 50% of messages in a multi-person conversation
    if (dominanceRatio > 0.5 && participants.length > 2) {
      return Math.min(1, dominanceRatio);
    }

    return 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPER METHODS
  // ─────────────────────────────────────────────────────────────────────────────

  _extractKeywords(text) {
    if (!text) return [];
    // Simple keyword extraction - remove common words
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of',
      'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then',
      'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
      'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
      'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while',
      'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
      'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 'yourself',
      'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it',
      'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves']);

    return text.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.has(word));
  }

  _textSimilarity(text1, text2) {
    const words1 = new Set(this._extractKeywords(text1));
    const words2 = new Set(this._extractKeywords(text2));

    if (words1.size === 0 || words2.size === 0) return 0;

    let intersection = 0;
    for (const word of words1) {
      if (words2.has(word)) intersection++;
    }

    const union = words1.size + words2.size - intersection;
    return intersection / union;
  }

  _extractQuestion(text) {
    const match = text.match(/([^.!?]*\?)/);
    return match ? match[1].trim() : null;
  }

  _seemsToAnswer(text, question) {
    // Simple heuristic: answer tends to be longer and doesn't contain question marks
    if (text.includes('?')) return false;
    if (text.split(/\s+/).length < 3) return false;
    return true;
  }
}

module.exports = new SignalComputer();
