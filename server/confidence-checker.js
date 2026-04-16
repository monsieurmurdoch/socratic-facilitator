/**
 * Fast LLM confidence check for interim transcripts.
 * Determines if the utterance is a complete thought ready for AI response.
 * Uses fastLLM (Llama 3.1-8B) for lightweight analysis with fallback.
 */

const { fastLLM } = require('./analysis/fastLLMProvider');

class ConfidenceChecker {
  constructor() {
    // Uses fastLLM singleton - no API key needed, has built-in fallbacks
    this.fastLLM = fastLLM;
    this.lastTranscript = '';
    this.lastAssessmentAt = 0;
  }

  heuristicConfidence(transcript) {
    const text = String(transcript || '').trim();
    if (!text) {
      return { confidence: 0, reasoning: 'Empty transcript', isReady: false };
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const hasTerminalPunctuation = /[.?!]["']?$/.test(text);
    const soundsCompleteGreeting = /^(hi|hello|hey|howdy)\b.+[?!.]?$/i.test(text);
    const looksQuestion = /\?$/.test(text) || /^(can|could|would|will|do|did|is|are|what|why|how|when|where)\b/i.test(text);
    const trailingFragment = /\b(and|or|but|because|if|so|then|well)\s*$/i.test(text);

    if (wordCount <= 2 && !hasTerminalPunctuation) {
      return { confidence: 0.08, reasoning: 'Very short fragment', isReady: false };
    }
    if (trailingFragment) {
      return { confidence: 0.2, reasoning: 'Likely unfinished thought', isReady: false };
    }
    if (hasTerminalPunctuation || soundsCompleteGreeting || (looksQuestion && wordCount >= 3)) {
      return { confidence: 0.82, reasoning: 'Looks like a complete greeting or question', isReady: true };
    }
    if (wordCount >= 8) {
      return { confidence: 0.58, reasoning: 'Substantial utterance but no clear ending yet', isReady: false };
    }

    return { confidence: 0.28, reasoning: 'Still waiting for more speech', isReady: false };
  }

  /**
   * Assess confidence that interim transcript represents a complete thought
   * @param {string} transcript - The interim transcript text
   * @returns {Promise<{confidence: number, reasoning: string, isReady: boolean}>}
   */
  async assessConfidence(transcript) {
    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      return { confidence: 0, reasoning: 'Empty transcript', isReady: false };
    }

      const normalized = transcript.trim();
      const now = Date.now();
      if (normalized === this.lastTranscript && now - this.lastAssessmentAt < 400) {
        return { confidence: 0, reasoning: 'Duplicate interim transcript', isReady: false };
      }
      this.lastTranscript = normalized;
      this.lastAssessmentAt = now;

      const heuristic = this.heuristicConfidence(normalized);
      if (heuristic.isReady || normalized.split(/\s+/).length < 5) {
        return heuristic;
      }

      const startTime = Date.now();

      const prompt = `Analyze this interim speech-to-text transcript and determine if it represents a complete, meaningful thought or utterance that an AI should respond to immediately, rather than waiting for more speech.

Transcript: "${transcript.trim()}"

Respond with ONLY a JSON object in this exact format:
{"confidence": 0.XX, "reasoning": "brief explanation", "isReady": true/false}

Where:
- confidence: 0.00-1.00 (how certain you are this is complete)
- reasoning: 1-2 sentence explanation
- isReady: true if this should trigger immediate AI response, false if it needs more speech

Be conservative - only mark isReady=true for clearly complete thoughts, questions, or statements. Incomplete fragments should be false.`;

      const result = await this.fastLLM.completeJSON({
        prompt,
        maxTokens: 150,
        temperature: 0.1, // Low temperature for consistent assessment
        systemPrompt: 'You are a speech analysis expert. Analyze interim transcripts for completeness. Return only valid JSON.'
      });

      const duration = Date.now() - startTime;
      console.log(`[Confidence] Assessment took ${duration}ms`);

      if (duration > 120) {
        console.warn(`[Confidence] Assessment exceeded 120ms target: ${duration}ms`);
      }

      // fastLLM returns null on failure/timeout - graceful fallback
      if (!result) {
        return { confidence: 0, reasoning: 'Fast LLM unavailable or timed out', isReady: false };
      }

      const data = result.data;

      // Validate response structure
      if (typeof data.confidence !== 'number' ||
          typeof data.reasoning !== 'string' ||
          typeof data.isReady !== 'boolean') {
        console.warn('[Confidence] Invalid response format, falling back');
        return { confidence: 0, reasoning: 'Invalid response format', isReady: false };
      }

      // Ensure confidence is in valid range
      data.confidence = Math.max(0, Math.min(1, data.confidence));

      return data;
  }
}

module.exports = { ConfidenceChecker };
