/**
 * Session Primer
 *
 * AI comprehension of source materials before discussion
 */

const Anthropic = require('@anthropic-ai/sdk');

class SessionPrimer {
  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
  }

  /**
   * Prime a session with source materials
   * @param {string} combinedText - All extracted text from materials
   * @param {string} goal - Optional conversation goal
   * @returns {Object} Primed context (summary, themes, tensions, angles)
   */
  async prime(combinedText, goal = null) {
    // Handle empty materials
    if (!combinedText || combinedText.trim().length === 0) {
      return {
        summary: 'No source materials were provided for this discussion.',
        keyThemes: [],
        potentialTensions: [],
        suggestedAngles: []
      };
    }

    // Truncate if too long (keep within reasonable context)
    const maxLength = 80000;
    const text = combinedText.length > maxLength
      ? combinedText.substring(0, maxLength) + '\n\n... [materials truncated for length]'
      : combinedText;

    const prompt = `You are preparing to facilitate a Socratic discussion. Read and understand the following source materials.

${goal ? `DISCUSSION GOAL:\n${goal}\n\n` : ''}

SOURCE MATERIALS:
${text}

Analyze these materials and provide:
1. A concise summary (2-3 paragraphs) of what the materials discuss
2. Key themes worth exploring in discussion (3-5 themes)
3. Potential tensions or disagreements students might have (2-4 tensions)
4. Suggested discussion angles or questions (2-3 angles)

Respond in JSON format only:
{
  "summary": "A 2-3 paragraph summary...",
  "keyThemes": ["theme 1", "theme 2", "theme 3"],
  "potentialTensions": ["tension 1", "tension 2"],
  "suggestedAngles": ["angle 1", "angle 2"]
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });

      const responseText = response.content[0].text.trim();
      const jsonStr = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      return JSON.parse(jsonStr);
    } catch (error) {
      console.error('Priming error:', error.message);
      throw new Error(`Failed to prime session: ${error.message}`);
    }
  }

  /**
   * Get context snippet for system prompt
   */
  getContextSnippet(primedContext) {
    if (!primedContext || primedContext.comprehension_status !== 'complete') {
      return null;
    }

    const { summary, key_themes, potential_tensions, suggested_angles } = primedContext;

    let snippet = `SOURCE MATERIAL SUMMARY:\n${summary}\n\n`;

    if (key_themes && key_themes.length > 0) {
      snippet += `KEY THEMES: ${key_themes.join(', ')}\n\n`;
    }

    if (potential_tensions && potential_tensions.length > 0) {
      snippet += `POTENTIAL TENSIONS:\n${potential_tensions.map(t => `- ${t}`).join('\n')}\n\n`;
    }

    if (suggested_angles && suggested_angles.length > 0) {
      snippet += `SUGGESTED ANGLES:\n${suggested_angles.map(a => `- ${a}`).join('\n')}`;
    }

    return snippet;
  }
}

module.exports = new SessionPrimer();
