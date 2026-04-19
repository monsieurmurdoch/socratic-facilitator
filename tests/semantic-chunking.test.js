const {
  buildChunksFromTextSemantic,
  buildChunksFromText,
  extractCanonicalLines,
  extractLineReference,
  estimateTokens,
  shouldPreferLineChunks,
} = require('../server/content/textGrounding');
const { cosineSimilarity, EMBEDDING_DIMENSIONS } = require('../server/content/embeddings');
const {
  getEmbedding,
  normalizeScore,
  lineReferenceBoost,
  buildRetrievalQuery,
} = require('../server/db/repositories/materialChunks');

describe('semantic chunking', () => {
  test('splits on paragraph boundaries', () => {
    const text = 'Para one has some text.\n\nPara two has more text.\n\nPara three is here.';
    const chunks = buildChunksFromTextSemantic(text, { minTokens: 1, maxTokens: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every(c => c.content.length > 0)).toBe(true);
  });

  test('merges small paragraphs', () => {
    // Each paragraph is ~5 tokens; with minTokens=20, several should merge
    const shortParas = Array(10).fill('Short sentence here.').join('\n\n');
    const chunks = buildChunksFromTextSemantic(shortParas, { minTokens: 20, maxTokens: 200 });
    // 10 small paragraphs should merge into fewer chunks
    expect(chunks.length).toBeLessThan(10);
  });

  test('handles text with no paragraph breaks', () => {
    const text = 'Sentence one. Sentence two. Sentence three. Sentence four.';
    const chunks = buildChunksFromTextSemantic(text, { minTokens: 1, maxTokens: 10 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every(c => c.content.length > 0)).toBe(true);
  });

  test('each chunk has chunkIndex and content', () => {
    const text = Array(20).fill('A paragraph of moderate length for testing purposes. It has several words.').join('\n\n');
    const chunks = buildChunksFromTextSemantic(text, { maxTokens: 200 });
    chunks.forEach((chunk, i) => {
      expect(chunk.chunkIndex).toBe(i);
      expect(chunk.content.length).toBeGreaterThan(0);
    });
  });

  test('returns empty array for empty input', () => {
    expect(buildChunksFromTextSemantic('')).toEqual([]);
    expect(buildChunksFromTextSemantic(null)).toEqual([]);
  });

  test('handles single paragraph without splitting unnecessarily', () => {
    const text = 'A single paragraph that is not very long at all.';
    const chunks = buildChunksFromTextSemantic(text);
    expect(chunks.length).toBe(1);
    expect(chunks[0].content).toContain('single paragraph');
  });
});

describe('line-aware chunking', () => {
  test('preserves explicit numbered line ranges', () => {
    const text = [
      '7. Sing, goddess, the anger of Achilles, son of Peleus,',
      '8. that brought countless ills upon the Achaeans,',
      '9. and sent many valiant souls of warriors down to Hades.'
    ].join('\n');

    const lines = extractCanonicalLines(text);
    expect(lines.map(line => line.number)).toEqual([7, 8, 9]);

    const chunks = buildChunksFromText(text, { maxLines: 2 });
    expect(chunks[0].lineStart).toBe(7);
    expect(chunks[0].lineEnd).toBe(8);
    expect(chunks[1].lineStart).toBe(9);
  });

  test('prefers line chunking for numbered or poem-like text', () => {
    const numbered = '1. First line\n2. Second line\n3. Third line';
    const poemLike = 'Whose woods these are I think I know\nHis house is in the village though\nHe will not see me stopping here\nTo watch his woods fill up with snow';
    const prose = 'This is a normal prose paragraph that should usually be semantically chunked rather than treated as strict line-by-line text because the line breaks are not meaningful.';

    expect(shouldPreferLineChunks(numbered)).toBe(true);
    expect(shouldPreferLineChunks(poemLike)).toBe(true);
    expect(shouldPreferLineChunks(prose)).toBe(false);
  });
});

describe('line reference extraction', () => {
  test('extracts single line references', () => {
    expect(extractLineReference('What happens in line 8?')).toEqual({ start: 8, end: 8 });
  });

  test('extracts line ranges', () => {
    expect(extractLineReference('Compare lines 8-10 with lines 20-22')).toEqual({ start: 8, end: 10 });
    expect(extractLineReference('Look at lines 14 to 16')).toEqual({ start: 14, end: 16 });
  });
});

describe('estimateTokens', () => {
  test('approximates 4 chars per token', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('hello')).toBe(2); // 5 chars / 4 = 1.25 -> ceil = 2
    expect(estimateTokens('a '.repeat(100).trim())).toBe(50); // ~200 chars
  });
});

describe('cosineSimilarity', () => {
  test('returns 1 for identical vectors', () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  test('returns 0 for orthogonal vectors', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  test('returns -1 for opposite vectors', () => {
    const a = [1, 0];
    const b = [-1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  test('handles null inputs', () => {
    expect(cosineSimilarity(null, [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], null)).toBe(0);
    expect(cosineSimilarity(null, null)).toBe(0);
  });

  test('handles mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  test('handles zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe('EMBEDDING_DIMENSIONS', () => {
  test('is 512 for voyage-3-lite', () => {
    expect(EMBEDDING_DIMENSIONS).toBe(512);
  });
});

describe('getEmbedding', () => {
  test('extracts from pgvector string format', () => {
    const chunk = { embedding: '[1,2,3]', embedding_json: null };
    expect(getEmbedding(chunk)).toEqual([1, 2, 3]);
  });

  test('extracts from array format', () => {
    const chunk = { embedding: [1, 2, 3], embedding_json: null };
    expect(getEmbedding(chunk)).toEqual([1, 2, 3]);
  });

  test('extracts from JSON fallback column', () => {
    const chunk = { embedding: null, embedding_json: '[4,5,6]' };
    expect(getEmbedding(chunk)).toEqual([4, 5, 6]);
  });

  test('returns null when no embedding available', () => {
    const chunk = { embedding: null, embedding_json: null };
    expect(getEmbedding(chunk)).toBeNull();
  });

  test('prefers pgvector over JSON', () => {
    const chunk = { embedding: '[1,2,3]', embedding_json: '[4,5,6]' };
    expect(getEmbedding(chunk)).toEqual([1, 2, 3]);
  });
});

describe('normalizeScore', () => {
  test('normalizes to [0, 1] range', () => {
    const all = [0, 2, 4, 6, 8, 10];
    expect(normalizeScore(0, all)).toBeCloseTo(0);
    expect(normalizeScore(10, all)).toBeCloseTo(1);
    expect(normalizeScore(5, all)).toBeCloseTo(0.5);
  });

  test('returns 1 when all scores are equal and positive', () => {
    expect(normalizeScore(5, [5, 5, 5])).toBe(1);
  });

  test('returns 0 when all scores are zero', () => {
    expect(normalizeScore(0, [0, 0, 0])).toBe(0);
  });
});

describe('retrieval helpers', () => {
  test('boosts chunks that overlap requested lines', () => {
    const chunk = { line_start: 7, line_end: 9 };
    expect(lineReferenceBoost(chunk, { start: 8, end: 8 })).toBeGreaterThan(0);
    expect(lineReferenceBoost(chunk, { start: 11, end: 12 })).toBe(0);
  });

  test('expands retrieval query with quoted phrases', () => {
    const query = buildRetrievalQuery('What does "countless ills" mean in line 8?');
    expect(query).toContain('countless ills');
  });
});
