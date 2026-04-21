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

  /**
   * Score chunk importance and role using a single LLM call per batch.
   * Called once per upload, after priming. Fire-and-forget.
   *
   * @param {Array<{id: string, content: string}>} chunks
   * @param {string|null} goal - Conversation goal for context
   * @returns {Array<{id: string, importance: number, role: string}>}
   */
  async scoreChunkImportance(chunks, goal = null) {
    if (!chunks || chunks.length === 0) return [];

    const BATCH_SIZE = 30;
    if (chunks.length > BATCH_SIZE) {
      const allResults = [];
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const results = await this._scoreBatch(batch, goal);
        allResults.push(...results);
      }
      return allResults;
    }

    return this._scoreBatch(chunks, goal);
  }

  /**
   * Score a single batch of chunks (max ~30).
   * @private
   */
  async _scoreBatch(chunks, goal) {
    const chunkList = chunks.map((c, i) =>
      `[${i}] ${c.content.substring(0, 400)}`
    ).join('\n\n');

    const prompt = `You are analyzing passages from source material for a Socratic discussion.

${goal ? `DISCUSSION GOAL: ${goal}\n\n` : ''}PASSAGES:
${chunkList}

For each passage, score:
- "importance": 0.0-1.0 — how central is this passage to the core ideas? Key claims and pivotal arguments score highest. Tangential details and transitions score lowest.
- "role": one of "claim" (central argument/thesis), "evidence" (supporting data/example), "example" (illustrative case), "transition" (connecting/metadata text), "definition" (defines a key term)

Respond in JSON only — an array of objects with "index", "importance", and "role":
[{"index": 0, "importance": 0.9, "role": "claim"}, ...]`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      });

      const text = response.content[0].text.trim();
      const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const scores = JSON.parse(jsonStr);

      const validRoles = ['claim', 'evidence', 'example', 'transition', 'definition'];
      return scores.map(s => ({
        id: chunks[s.index]?.id,
        importance: Math.min(1, Math.max(0, Number(s.importance) || 0)),
        role: validRoles.includes(s.role) ? s.role : 'transition'
      })).filter(s => s.id);
    } catch (err) {
      console.error('[Primer] Chunk importance scoring failed:', err.message);
      return [];
    }
  }
}

module.exports = new SessionPrimer();
