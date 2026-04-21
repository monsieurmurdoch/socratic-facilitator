/**
 * Text grounding helpers
 *
 * Turns extracted text into stable, line-addressable chunks that can be
 * retrieved and shown back to the facilitator.
 */

function stripExistingLinePrefix(line) {
  return String(line || "").replace(/^\s*(?:\d+\s*[\]\).:\-]|\d+\.)\s*/u, "").trim();
}

function parseLinePrefix(line) {
  const match = String(line || "").match(/^\s*(\d+)\s*[\]\).:\-]?\s*(.*)$/u);
  if (!match) return null;
  return {
    number: Number(match[1]),
    text: String(match[2] || "").trim()
  };
}

function hasExplicitLineNumbering(text) {
  return String(text || "").split(/\r?\n/).some((line) => /^\s*\d+\s*[\]\).:\-]/u.test(line));
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

function extractCanonicalLines(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return [];

  const rawLines = raw.split("\n");
  const explicitNumbering = hasExplicitLineNumbering(raw);
  const extracted = [];
  let fallbackNumber = 1;

  for (const rawLine of rawLines) {
    if (!String(rawLine || "").trim()) continue;
    const parsed = parseLinePrefix(rawLine);
    const textOnly = parsed ? parsed.text : stripExistingLinePrefix(rawLine);
    if (!textOnly) continue;

    extracted.push({
      number: explicitNumbering
        ? (parsed?.number ?? fallbackNumber)
        : fallbackNumber,
      text: textOnly
    });
    fallbackNumber += 1;
  }

  if (explicitNumbering || extracted.length >= 3) {
    return extracted;
  }

  return wrapText(raw, 110).map((line, index) => ({
    number: index + 1,
    text: line
  }));
}

function normalizeToLines(text) {
  return extractCanonicalLines(text).map((line) => line.text);
}

function shouldPreferLineChunks(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return false;

  if (hasExplicitLineNumbering(raw)) return true;

  const nonEmptyLines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.length < 4) return false;

  const avgLineLength = nonEmptyLines.reduce((sum, line) => sum + line.length, 0) / nonEmptyLines.length;
  const shortLineCount = nonEmptyLines.filter((line) => line.length <= 90).length;
  return avgLineLength <= 80 && shortLineCount / nonEmptyLines.length >= 0.7;
}

function extractQuotedPhrases(text) {
  const matches = [];
  const regex = /["“”'`](.{3,160}?)["“”'`]/g;
  const value = String(text || "");
  let match;
  while ((match = regex.exec(value)) !== null) {
    const phrase = String(match[1] || "").trim();
    if (phrase) matches.push(phrase);
  }
  return matches.slice(0, 4);
}

function extractLineReference(text) {
  const value = String(text || "");
  const rangeMatch = value.match(/\blines?\s+(\d+)\s*(?:-|to|through)\s*(\d+)\b/i);
  if (rangeMatch) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return {
        start: Math.min(start, end),
        end: Math.max(start, end)
      };
    }
  }

  const singleMatch = value.match(/\bline\s+(\d+)\b/i);
  if (singleMatch) {
    const line = Number(singleMatch[1]);
    if (Number.isFinite(line)) {
      return { start: line, end: line };
    }
  }

  return null;
}

function buildChunksFromText(text, opts = {}) {
  const lines = extractCanonicalLines(text);
  const maxLines = opts.maxLines || 6;
  const maxChars = opts.maxChars || 650;

  const chunks = [];
  let current = [];
  let currentChars = 0;

  function flush() {
    if (!current.length) return;
    const lineStart = current[0].number;
    const lineEnd = current[current.length - 1].number;
    chunks.push({
      chunkIndex: chunks.length,
      lineStart,
      lineEnd,
      content: current.map((line) => line.text).join("\n")
    });
    current = [];
    currentChars = 0;
  }

  for (const line of lines) {
    const nextChars = currentChars + line.text.length;
    if (current.length >= maxLines || (current.length > 0 && nextChars > maxChars)) {
      flush();
    }
    current.push(line);
    currentChars += line.text.length;
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

// ---------------------------------------------------------------------------
// Semantic chunking — paragraph-aware, 400-800 token target, ~50-token overlap
// ---------------------------------------------------------------------------

/**
 * Rough token estimate. Voyage-3-lite tokenization is close to GPT-style BPE,
 * so ~4 chars per token is a reasonable heuristic for sizing.
 */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Split text into sentences. Respects common sentence boundaries.
 */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 0);
}

/**
 * Extract approximately targetTokens worth of text from the end of a string,
 * starting at the nearest sentence boundary.
 */
function extractOverlap(text, targetTokens) {
  const targetChars = targetTokens * 4;
  if (text.length <= targetChars) return null;
  const tail = text.slice(-targetChars);
  const sentenceStart = tail.search(/[.!?]\s/);
  if (sentenceStart === -1) return tail;
  return tail.slice(sentenceStart + 2);
}

/**
 * Split a long paragraph into sentence-based sub-chunks.
 */
function splitLongParagraph(text, maxTokens = 800) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentTokens = estimateTokens(sentence);
    if (currentTokens + sentTokens > maxTokens && current.length > 0) {
      chunks.push(current.join(' '));
      current = [];
      currentTokens = 0;
    }
    current.push(sentence);
    currentTokens += sentTokens;
  }

  if (current.length > 0) {
    chunks.push(current.join(' '));
  }

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Merge adjacent small paragraphs until they reach the target size range,
 * carrying forward ~50 tokens of overlap between consecutive chunks.
 */
function mergeSmallParagraphs(paragraphs, minTokens, maxTokens) {
  const merged = [];
  let buffer = [];
  let bufferTokens = 0;

  function flushBuffer() {
    if (buffer.length === 0) return;
    merged.push(buffer.join('\n\n'));
    const lastPara = buffer[buffer.length - 1];
    const overlapText = extractOverlap(lastPara, 50);
    buffer = overlapText ? [overlapText] : [];
    bufferTokens = overlapText ? estimateTokens(overlapText) : 0;
  }

  for (const para of paragraphs) {
    const paraTokens = estimateTokens(para);

    if (bufferTokens + paraTokens > maxTokens && buffer.length > 0) {
      flushBuffer();
    }

    buffer.push(para);
    bufferTokens += paraTokens;

    if (bufferTokens >= minTokens) {
      flushBuffer();
    }
  }

  if (buffer.length > 0) {
    merged.push(buffer.join('\n\n'));
  }

  return merged;
}

/**
 * Paragraph-aware chunking optimized for semantic retrieval.
 *
 * - Splits on paragraph boundaries (\n\n)
 * - Targets 400-800 tokens per chunk
 * - Includes ~50-token overlap between adjacent chunks
 * - Falls back to sentence-level splitting when paragraphs are too long
 *
 * @param {string} text - Raw text content.
 * @param {object} opts - { maxTokens: 800, minTokens: 200 }
 * @returns {Array<{chunkIndex: number, content: string, charStart: number, charEnd: number}>}
 */
function buildChunksFromTextSemantic(text, opts = {}) {
  const maxTokens = opts.maxTokens || 800;
  const minTokens = opts.minTokens || 200;

  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];

  // Step 1: Split on paragraph boundaries
  let paragraphs = raw.split(/\n\n+/).filter(p => p.trim().length > 0);

  // Step 2: If no paragraph breaks, fall back to sentences
  if (paragraphs.length <= 1) {
    paragraphs = splitSentences(raw);
  }

  // Step 3: Break up paragraphs that exceed maxTokens
  const expanded = [];
  for (const para of paragraphs) {
    if (estimateTokens(para) > maxTokens) {
      expanded.push(...splitLongParagraph(para, maxTokens));
    } else {
      expanded.push(para);
    }
  }

  // Step 4: Merge small paragraphs with overlap
  const merged = mergeSmallParagraphs(expanded, minTokens, maxTokens);

  // Step 5: Build chunk objects with stable indexing
  let charOffset = 0;
  return merged.map((content, i) => {
    const searchStart = Math.max(0, charOffset - 10);
    const charStart = raw.indexOf(content.trim(), searchStart);
    const actualStart = charStart === -1 ? charOffset : charStart;
    const chunk = {
      chunkIndex: i,
      content: content.trim(),
      charStart: actualStart,
      charEnd: actualStart + content.length,
    };
    charOffset = actualStart + content.length;
    return chunk;
  });
}

module.exports = {
  extractCanonicalLines,
  normalizeToLines,
  buildChunksFromText,
  buildChunksFromTextSemantic,
  estimateTokens,
  tokenizeForSearch,
  scoreChunk,
  formatChunksForPrompt,
  detectLikelySharedText,
  hasExplicitLineNumbering,
  shouldPreferLineChunks,
  extractQuotedPhrases,
  extractLineReference
};
