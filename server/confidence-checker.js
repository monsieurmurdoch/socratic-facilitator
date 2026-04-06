/**
 * Fast LLM confidence check for interim transcripts.
 * Determines if the utterance is a complete thought ready for AI response.
 * Uses Claude 3 Haiku for speed.
 */

const Anthropic = require('@anthropic-ai/sdk');

class ConfidenceChecker {
  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (!apiKey) {
      console.warn('[Confidence] ANTHROPIC_API_KEY not set - confidence checking disabled');
      this.disabled = true;
      return;
    }

    this.anthropic = new Anthropic({ apiKey });
    this.disabled = false;
  }

  /**
   * Assess confidence that interim transcript represents a complete thought
   * @param {string} transcript - The interim transcript text
   * @returns {Promise<{confidence: number, reasoning: string, isReady: boolean}>}
   */
  async assessConfidence(transcript) {
    if (this.disabled) {
      return { confidence: 0, reasoning: 'Confidence checker disabled', isReady: false };
    }

    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      return { confidence: 0, reasoning: 'Empty transcript', isReady: false };
    }

    try {
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

      const response = await this.anthropic.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 150,
        temperature: 0.1, // Low temperature for consistent assessment
        system: 'You are a speech analysis expert. Analyze interim transcripts for completeness.',
        messages: [{ role: 'user', content: prompt }]
      });

      const duration = Date.now() - startTime;
      console.log(`[Confidence] Assessment took ${duration}ms`);

      if (duration > 50) {
        console.warn(`[Confidence] Assessment exceeded 50ms target: ${duration}ms`);
      }

      const content = response.content[0]?.text?.trim();
      if (!content) {
        throw new Error('Empty response from Claude');
      }

      // Parse JSON response
      const result = JSON.parse(content);

      // Validate response structure
      if (typeof result.confidence !== 'number' ||
          typeof result.reasoning !== 'string' ||
          typeof result.isReady !== 'boolean') {
        throw new Error('Invalid response format');
      }

      // Ensure confidence is in valid range
      result.confidence = Math.max(0, Math.min(1, result.confidence));

      return result;

    } catch (error) {
      console.error('[Confidence] Error assessing transcript:', error.message);
      // Graceful fallback - assume not ready
      return {
        confidence: 0,
        reasoning: `Assessment failed: ${error.message}`,
        isReady: false
      };
    }
  }
}

module.exports = { ConfidenceChecker };