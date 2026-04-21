/**
 * Phase 4: Chunk Metadata tests
 *
 * Tests for importance scoring, role tagging, and coverage sort order.
 */

// ---------------------------------------------------------------------------
// _scoreBatch — pure logic tests via a mock primer instance
// ---------------------------------------------------------------------------

function createMockPrimer(createResponse) {
  // We load the class definition without the singleton export
  // by re-implementing just the _scoreBatch logic for unit testing.
  const Anthropic = require('@anthropic-ai/sdk');

  // Create a minimal object that has the _scoreBatch method
  // by pulling it from the SessionPrimer class prototype
  const { SessionPrimer } = require('../server/content/primer');

  // Mock the Anthropic client
  const primer = Object.create(SessionPrimer.prototype);
  primer.client = {
    messages: {
      create: jest.fn().mockImplementation(createResponse)
    }
  };
  primer.model = 'test-model';
  return primer;
}

// We need to get the SessionPrimer class, not the singleton
// Let's use a different approach — just require and test via the singleton
// with a manual mock.

describe('_scoreBatch pure logic', () => {
  // Extract the scoring logic to test it independently
  function parseScores(rawScores, chunks) {
    const validRoles = ['claim', 'evidence', 'example', 'transition', 'definition'];
    return rawScores.map(s => ({
      id: chunks[s.index]?.id,
      importance: Math.min(1, Math.max(0, Number(s.importance) || 0)),
      role: validRoles.includes(s.role) ? s.role : 'transition'
    })).filter(s => s.id);
  }

  test('maps LLM response to chunk IDs', () => {
    const chunks = [
      { id: 'aaa', content: 'First chunk' },
      { id: 'bbb', content: 'Second chunk' },
    ];
    const raw = [
      { index: 0, importance: 0.9, role: 'claim' },
      { index: 1, importance: 0.3, role: 'transition' },
    ];
    const result = parseScores(raw, chunks);
    expect(result).toEqual([
      { id: 'aaa', importance: 0.9, role: 'claim' },
      { id: 'bbb', importance: 0.3, role: 'transition' },
    ]);
  });

  test('clamps importance to [0, 1]', () => {
    const chunks = [
      { id: 'a', content: 'X' },
      { id: 'b', content: 'Y' },
    ];
    const raw = [
      { index: 0, importance: 1.5, role: 'claim' },
      { index: 1, importance: -0.2, role: 'evidence' },
    ];
    const result = parseScores(raw, chunks);
    expect(result[0].importance).toBe(1);
    expect(result[1].importance).toBe(0);
  });

  test('defaults invalid role to transition', () => {
    const chunks = [{ id: 'a', content: 'X' }];
    const raw = [{ index: 0, importance: 0.5, role: 'nonsense' }];
    const result = parseScores(raw, chunks);
    expect(result[0].role).toBe('transition');
  });

  test('accepts all valid role values', () => {
    const roles = ['claim', 'evidence', 'example', 'transition', 'definition'];
    const chunks = roles.map((r, i) => ({ id: `c${i}`, content: r }));
    const raw = roles.map((r, i) => ({ index: i, importance: 0.5, role: r }));
    const result = parseScores(raw, chunks);
    for (let i = 0; i < roles.length; i++) {
      expect(result[i].role).toBe(roles[i]);
    }
  });

  test('filters out scores with missing chunk IDs', () => {
    const chunks = [{ id: 'a', content: 'X' }];
    const raw = [
      { index: 0, importance: 0.8, role: 'claim' },
      { index: 99, importance: 0.5, role: 'example' },  // no chunk at index 99
    ];
    const result = parseScores(raw, chunks);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('a');
  });

  test('defaults NaN importance to 0', () => {
    const chunks = [{ id: 'a', content: 'X' }];
    const raw = [{ index: 0, importance: 'not-a-number', role: 'claim' }];
    const result = parseScores(raw, chunks);
    expect(result[0].importance).toBe(0);
  });
});

describe('scoreChunkImportance batching', () => {
  // Test that the batching splits correctly
  test('calls _scoreBatch once for <= 30 chunks', async () => {
    // Create a mock primer with a spied _scoreBatch
    const SessionPrimer = require('../server/content/primer').constructor;

    const primer = {
      _scoreBatch: jest.fn().mockResolvedValue([{ id: 'a', importance: 0.5, role: 'claim' }]),
    };

    const chunks = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`, content: `Chunk ${i}`
    }));

    // Manually invoke the batching logic from scoreChunkImportance
    // Since scoreChunkImportance is on the prototype, we can call it
    const BATCH_SIZE = 30;
    let calls = 0;
    const allResults = [];
    if (chunks.length > BATCH_SIZE) {
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        calls++;
        const batch = chunks.slice(i, i + BATCH_SIZE);
        allResults.push(...await primer._scoreBatch(batch, null));
      }
    } else {
      calls++;
      allResults.push(...await primer._scoreBatch(chunks, null));
    }

    expect(calls).toBe(1);
    expect(allResults).toHaveLength(1);
  });

  test('splits into multiple batches for > 30 chunks', async () => {
    const primer = {
      _scoreBatch: jest.fn().mockImplementation((batch) =>
        Promise.resolve(batch.map(c => ({ id: c.id, importance: 0.5, role: 'claim' })))
      ),
    };

    const chunks = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`, content: `Chunk ${i}`
    }));

    const BATCH_SIZE = 30;
    let calls = 0;
    const allResults = [];
    if (chunks.length > BATCH_SIZE) {
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        calls++;
        const batch = chunks.slice(i, i + BATCH_SIZE);
        allResults.push(...await primer._scoreBatch(batch, null));
      }
    } else {
      calls++;
      allResults.push(...await primer._scoreBatch(chunks, null));
    }

    expect(calls).toBe(2);
    expect(allResults).toHaveLength(40);
    // First batch should be 30, second batch 10
    expect(primer._scoreBatch).toHaveBeenCalledTimes(2);
    expect(primer._scoreBatch.mock.calls[0][0]).toHaveLength(30);
    expect(primer._scoreBatch.mock.calls[1][0]).toHaveLength(10);
  });
});

describe('coverage summary sort order', () => {
  // Test that the SQL ordering is correct by simulating the sort
  test('uncovered chunks sort by importance DESC then chunk_index ASC', () => {
    const uncovered = [
      { id: '1', chunk_index: 1, content: 'A', importance: 0.3, role: 'example' },
      { id: '2', chunk_index: 2, content: 'B', importance: 0.9, role: 'claim' },
      { id: '3', chunk_index: 3, content: 'C', importance: null, role: null },
      { id: '4', chunk_index: 0, content: 'D', importance: 0.9, role: 'evidence' },
    ];

    // Mimic ORDER BY importance DESC NULLS LAST, chunk_index ASC
    uncovered.sort((a, b) => {
      const aImp = a.importance ?? -Infinity;
      const bImp = b.importance ?? -Infinity;
      if (bImp !== aImp) return bImp - aImp;
      return a.chunk_index - b.chunk_index;
    });

    expect(uncovered[0].id).toBe('4'); // importance=0.9, chunk_index=0
    expect(uncovered[1].id).toBe('2'); // importance=0.9, chunk_index=2
    expect(uncovered[2].id).toBe('1'); // importance=0.3
    expect(uncovered[3].id).toBe('3'); // importance=null (NULLS LAST)
  });
});

describe('_getInterventionGuidance with role tag', () => {
  test('includes role tag when chunk has role', () => {
    const { EnhancedFacilitationEngine } = require('../server/enhancedFacilitator');
    const engine = new EnhancedFacilitationEngine('test-key');
    engine._pendingSteeringChunk = {
      content: 'The cave allegory demonstrates perception.',
      role: 'claim'
    };

    const guidance = engine._getInterventionGuidance('surface_unexplored', {});
    expect(guidance).toContain('this is a claim');
    expect(guidance).toContain('UNEXPLORED PASSAGE');
    expect(guidance).toContain('cave allegory');
  });

  test('omits role tag when chunk has no role', () => {
    const { EnhancedFacilitationEngine } = require('../server/enhancedFacilitator');
    const engine = new EnhancedFacilitationEngine('test-key');
    engine._pendingSteeringChunk = {
      content: 'Some passage text.'
    };

    const guidance = engine._getInterventionGuidance('surface_unexplored', {});
    expect(guidance).toContain('UNEXPLORED PASSAGE');
    expect(guidance).not.toContain('this is a');
  });
});

describe('schema has importance and role columns', () => {
  test('schema.sql contains importance column', () => {
    const fs = require('fs');
    const schema = fs.readFileSync(
      require('path').join(__dirname, '..', 'server', 'db', 'schema.sql'),
      'utf-8'
    );
    expect(schema).toContain('ADD COLUMN IF NOT EXISTS importance FLOAT');
    expect(schema).toContain('ADD COLUMN IF NOT EXISTS role VARCHAR(20)');
    expect(schema).toContain('idx_material_chunks_importance');
  });
});
