/**
 * Text grounding helpers
 *
 * Turns extracted text into stable, line-addressable chunks that can be
 * retrieved and shown back to the facilitator.
 */

function stripExistingLinePrefix(line) {
  return String(line || "").replace(/^\s*(?:\d+\s*[\]\).:\-]|\d+\.)\s*/u, "").trim();
}

function wrapText(text, maxChars = 110) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }

  if (current) lines.push(current);
  return lines;
}

function normalizeToLines(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];

  const rawLines = raw.split("\n");
  const explicitLines = rawLines.map(stripExistingLinePrefix).filter(Boolean);
  const hasExplicitNumbering = rawLines.some((line) => /^\s*(?:\d+\s*[\]\).:\-]|\d+\.)\s*/u.test(line));

  if (explicitLines.length >= 3 || hasExplicitNumbering) {
    return explicitLines;
  }

  return wrapText(raw, 110);
}

function buildChunksFromText(text, opts = {}) {
  const lines = normalizeToLines(text);
  const maxLines = opts.maxLines || 6;
  const maxChars = opts.maxChars || 650;

  const chunks = [];
  let current = [];
  let currentChars = 0;

  function flush() {
    if (!current.length) return;
    const lineStart = chunks.reduce((sum, chunk) => sum + (chunk.lineEnd - chunk.lineStart + 1), 0) + 1;
    const lineEnd = lineStart + current.length - 1;
    chunks.push({
      chunkIndex: chunks.length,
      lineStart,
      lineEnd,
      content: current.join("\n")
    });
    current = [];
    currentChars = 0;
  }

  for (const line of lines) {
    const nextChars = currentChars + line.length;
    if (current.length >= maxLines || (current.length > 0 && nextChars > maxChars)) {
      flush();
    }
    current.push(line);
    currentChars += line.length;
  }
  flush();

  return chunks;
}

function tokenizeForSearch(query) {
  return String(query || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3);
}

function scoreChunk(chunk, tokens) {
  if (!tokens.length) return 0;
  const text = String(chunk.content || "").toLowerCase();
  let score = 0;

  for (const token of tokens) {
    if (text.includes(token)) {
      score += token.length > 6 ? 2 : 1;
    }
  }

  if (tokens.length && text.includes(tokens.join(" "))) {
    score += 2;
  }

  return score;
}

function formatChunksForPrompt(chunks, heading = "RELEVANT SOURCE EXCERPTS") {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  const body = chunks.map(chunk => {
    const range = `lines ${chunk.lineStart}-${chunk.lineEnd}`;
    return `[${range}]\n${chunk.content}`;
  }).join("\n\n");
  return `${heading}:\n${body}`;
}

function detectLikelySharedText(text) {
  const value = String(text || "");
  const lineCount = value.split(/\r?\n/).filter(Boolean).length;
  return lineCount >= 3 || value.length >= 420 || /^\s*\d+\s*[\]\).:-]\s+/m.test(value);
}

module.exports = {
  normalizeToLines,
  buildChunksFromText,
  tokenizeForSearch,
  scoreChunk,
  formatChunksForPrompt,
  detectLikelySharedText
};
