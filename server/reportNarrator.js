/**
 * Report narrator: LLM-driven qualitative layer for the post-session report.
 *
 * Takes the deterministic skeleton + a compact transcript and returns the
 * narrative fields a teacher actually wants to read: a TL;DR, the strongest
 * moments worth surfacing, tensions that didn't get pressed, and a next
 * prompt grounded in what actually happened.
 *
 * Best-effort: callers should treat failures as soft and fall back to the
 * skeleton's heuristic next-prompt.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { DEFAULT_ANTHROPIC_MODEL } = require('./models');

const MAX_TRANSCRIPT_CHARS = 14000;
const MAX_OUTPUT_TOKENS = 1200;

function compactTranscript(messages) {
  const lines = [];
  for (const msg of messages) {
    if (msg.sender_type === 'system') continue;
    const who = msg.sender_type === 'facilitator'
      ? 'Plato'
      : (msg.sender_name || 'participant');
    const text = String(msg.content || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    lines.push(`${who}: ${text}`);
  }
  let joined = lines.join('\n');
  if (joined.length > MAX_TRANSCRIPT_CHARS) {
    joined = joined.slice(joined.length - MAX_TRANSCRIPT_CHARS);
    joined = `[...earlier omitted...]\n${joined}`;
  }
  return joined;
}

function stripJsonFence(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function buildSystemPrompt() {
  return `You write post-session debriefs for teachers using a Socratic discussion tool. Be specific, concrete, and honest. Quote participants verbatim when you cite them. Never invent quotes. If the transcript is too thin to support a field, return an empty array (or empty string). Never lecture. Never editorialize about what students "should" have done. Output strict JSON only.`;
}

function buildUserPrompt({ session, skeleton, transcript }) {
  const opening = session.opening_question || skeleton.session?.title || 'the discussion topic';
  const goal = session.conversation_goal || '';
  return `Discussion title: ${skeleton.session?.title || ''}
Opening question: ${opening}
${goal ? `Teacher's goal: ${goal}\n` : ''}
Quantitative snapshot: ${JSON.stringify(skeleton.metrics)}
Top contributors: ${JSON.stringify(skeleton.topContributors.map(c => c.name))}
Quieter voices: ${JSON.stringify(skeleton.quieterVoices)}

Transcript (verbatim, "Speaker: text" per line):
${transcript}

Return JSON with exactly these keys:
{
  "tldr": [string, string, string],            // 3 sentences. What was actually explored, where the group landed, what's still open. Concrete; name people and ideas.
  "strongestMoments": [                          // 0-3 items. Pick comments that genuinely moved the discussion.
    { "participant": string, "quote": string, "whyItMattered": string }
  ],
  "unexploredTensions": [                        // 0-3 items. Disagreements or distinctions that didn't get pressed. If none, return [].
    { "summary": string, "betweenWhom": string, "suggestedFollowUp": string }
  ],
  "suggestedNextPrompt": string                  // One question to open the next session, grounded in what was said today. Specific, not generic.
}

Rules:
- Quotes must appear verbatim in the transcript above. If you can't quote, omit the moment.
- "betweenWhom" should name participants by the names used in the transcript.
- Do not include any text outside the JSON object.`;
}

async function narrateReport({ apiKey, session, skeleton, messages }) {
  if (!apiKey) {
    throw new Error('Missing Anthropic API key for report narration');
  }
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const transcript = compactTranscript(messages);
  if (!transcript.trim()) {
    return { tldr: [], strongestMoments: [], unexploredTensions: [], suggestedNextPrompt: null };
  }

  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserPrompt({ session, skeleton, transcript }) }]
  });

  const raw = response?.content?.[0]?.text || '';
  const parsed = JSON.parse(stripJsonFence(raw));
  return {
    tldr: Array.isArray(parsed.tldr) ? parsed.tldr.filter(Boolean).slice(0, 3) : [],
    strongestMoments: Array.isArray(parsed.strongestMoments)
      ? parsed.strongestMoments.filter(m => m && m.quote).slice(0, 3)
      : [],
    unexploredTensions: Array.isArray(parsed.unexploredTensions)
      ? parsed.unexploredTensions.filter(t => t && t.summary).slice(0, 3)
      : [],
    suggestedNextPrompt: typeof parsed.suggestedNextPrompt === 'string' && parsed.suggestedNextPrompt.trim()
      ? parsed.suggestedNextPrompt.trim()
      : null
  };
}

module.exports = { narrateReport };
