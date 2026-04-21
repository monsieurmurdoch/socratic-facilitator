const { MOVES, getMoveTaxonomyPrompt } = require('../server/moves');

describe('SURFACE_UNEXPLORED move', () => {
  test('is defined in move taxonomy', () => {
    expect(MOVES.SURFACE_UNEXPLORED).toBeDefined();
    expect(MOVES.SURFACE_UNEXPLORED.id).toBe('surface_unexplored');
    expect(MOVES.SURFACE_UNEXPLORED.priority).toBe(4);
  });

  test('has required fields', () => {
    const move = MOVES.SURFACE_UNEXPLORED;
    expect(move.name).toBeTruthy();
    expect(move.description).toBeTruthy();
    expect(move.conditions.length).toBeGreaterThan(0);
    expect(move.examples.length).toBeGreaterThan(0);
  });

  test('appears in group mode taxonomy prompt', () => {
    const prompt = getMoveTaxonomyPrompt({ solo: false });
    expect(prompt).toContain('surface_unexplored');
    expect(prompt).toContain('Surface Unexplored');
  });

  test('appears in solo mode taxonomy prompt', () => {
    const prompt = getMoveTaxonomyPrompt({ solo: true });
    expect(prompt).toContain('surface_unexplored');
  });
});

describe('steering eligibility logic', () => {
  // We test the pure eligibility conditions directly
  // These mirror the logic in _checkSteeringEligibility

  function checkEligibility({ coveragePercent, totalChunks, turnCount, silenceDepth, engagementScore, lastSteeringAt, uncoveredChunks }) {
    // No materials or everything is covered
    if (!totalChunks || totalChunks === 0 || coveragePercent >= 50) {
      return { eligible: false };
    }

    // Not enough turns and conversation isn't stalled
    const isStalled = (silenceDepth || 0) > 0.5 || (engagementScore ?? 1) < 0.4;
    if (turnCount < 8 && !isStalled) {
      return { eligible: false };
    }

    // Rate limit: at most one steering move per 5 minutes
    if (lastSteeringAt && Date.now() - lastSteeringAt < 5 * 60 * 1000) {
      return { eligible: false };
    }

    // Pick the first uncovered chunk
    const uncovered = (uncoveredChunks || [])[0];
    if (!uncovered) {
      return { eligible: false };
    }

    return { eligible: true, uncoveredChunk: uncovered };
  }

  test('not eligible when coverage >= 50%', () => {
    const result = checkEligibility({ coveragePercent: 60, totalChunks: 10, turnCount: 10, uncoveredChunks: [{ content: 'test' }] });
    expect(result.eligible).toBe(false);
  });

  test('not eligible when no materials', () => {
    const result = checkEligibility({ coveragePercent: 0, totalChunks: 0, turnCount: 10 });
    expect(result.eligible).toBe(false);
  });

  test('not eligible when turnCount < 8 and conversation is active', () => {
    const result = checkEligibility({
      coveragePercent: 20, totalChunks: 10, turnCount: 5,
      silenceDepth: 0.1, engagementScore: 0.7,
      uncoveredChunks: [{ content: 'test' }],
    });
    expect(result.eligible).toBe(false);
  });

  test('eligible when turnCount >= 8 and coverage < 50%', () => {
    const chunk = { chunk_index: 3, content: 'The cave allegory explores perception.' };
    const result = checkEligibility({
      coveragePercent: 20, totalChunks: 10, turnCount: 10,
      silenceDepth: 0.1, engagementScore: 0.7,
      uncoveredChunks: [chunk],
    });
    expect(result.eligible).toBe(true);
    expect(result.uncoveredChunk).toBe(chunk);
  });

  test('eligible when conversation is stalled even with turnCount < 8', () => {
    const result = checkEligibility({
      coveragePercent: 20, totalChunks: 10, turnCount: 4,
      silenceDepth: 0.8, engagementScore: 0.3,
      uncoveredChunks: [{ content: 'test' }],
    });
    expect(result.eligible).toBe(true);
  });

  test('eligible when engagement is low even with turnCount < 8', () => {
    const result = checkEligibility({
      coveragePercent: 20, totalChunks: 10, turnCount: 4,
      silenceDepth: 0.1, engagementScore: 0.2,
      uncoveredChunks: [{ content: 'test' }],
    });
    expect(result.eligible).toBe(true);
  });

  test('not eligible within 5-minute cooldown', () => {
    const result = checkEligibility({
      coveragePercent: 20, totalChunks: 10, turnCount: 10,
      lastSteeringAt: Date.now() - 60000, // 1 minute ago
      uncoveredChunks: [{ content: 'test' }],
    });
    expect(result.eligible).toBe(false);
  });

  test('eligible after 5-minute cooldown expires', () => {
    const result = checkEligibility({
      coveragePercent: 20, totalChunks: 10, turnCount: 10,
      lastSteeringAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
      uncoveredChunks: [{ content: 'test' }],
    });
    expect(result.eligible).toBe(true);
  });

  test('not eligible when no uncovered chunks remain', () => {
    const result = checkEligibility({
      coveragePercent: 20, totalChunks: 10, turnCount: 10,
      uncoveredChunks: [],
    });
    expect(result.eligible).toBe(false);
  });

  test('picks first uncovered chunk by chunk_index', () => {
    const chunks = [
      { chunk_index: 5, content: 'Fifth chunk' },
      { chunk_index: 2, content: 'Second chunk' },
    ];
    const result = checkEligibility({
      coveragePercent: 20, totalChunks: 10, turnCount: 10,
      uncoveredChunks: chunks,
    });
    expect(result.eligible).toBe(true);
    expect(result.uncoveredChunk).toBe(chunks[0]);
  });
});

describe('surface_unexplored intervention guidance', () => {
  // We test that the _getInterventionGuidance returns the right format
  // by importing and calling it directly on a minimal engine instance

  test('includes passage snippet in guidance text', () => {
    const { EnhancedFacilitationEngine } = require('../server/enhancedFacilitator');
    const engine = new EnhancedFacilitationEngine('test-key');
    engine._pendingSteeringChunk = { content: 'The cave allegory demonstrates that perception is limited by experience.' };

    const guidance = engine._getInterventionGuidance('surface_unexplored', {});

    expect(guidance).toContain('UNEXPLORED PASSAGE');
    expect(guidance).toContain('cave allegory');
    expect(guidance).toContain('Do NOT force it');
    expect(guidance).toContain('suggestion, not an obligation');

    // Should have consumed the pending chunk
    expect(engine._pendingSteeringChunk).toBeNull();
  });

  test('handles null chunk gracefully', () => {
    const { EnhancedFacilitationEngine } = require('../server/enhancedFacilitator');
    const engine = new EnhancedFacilitationEngine('test-key');
    engine._pendingSteeringChunk = null;

    const guidance = engine._getInterventionGuidance('surface_unexplored', {});

    expect(guidance).toContain('UNEXPLORED PASSAGE');
  });

  test('truncates long content to 300 chars', () => {
    const { EnhancedFacilitationEngine } = require('../server/enhancedFacilitator');
    const engine = new EnhancedFacilitationEngine('test-key');
    const longContent = 'A'.repeat(500);
    engine._pendingSteeringChunk = { content: longContent };

    const guidance = engine._getInterventionGuidance('surface_unexplored', {});

    // The snippet within the quotes should be at most 300 chars
    const match = guidance.match(/"(.+?)"/s);
    expect(match).toBeTruthy();
    expect(match[1].length).toBeLessThanOrEqual(300);
  });
});
