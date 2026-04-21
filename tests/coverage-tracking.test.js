const { buildSessionReport } = require('../server/reportBuilder');

describe('buildSessionReport with coverage', () => {
  const baseArgs = {
    session: {
      id: 'session-1',
      short_code: 'ABC123',
      title: 'Test Session',
      status: 'ended',
      created_at: '2025-01-01T00:00:00Z',
      started_at: '2025-01-01T00:00:00Z',
      ended_at: '2025-01-01T01:00:00Z',
    },
    memberships: [],
    analytics: [],
    messages: [
      { sender_type: 'participant', content: 'Hello' },
      { sender_type: 'facilitator', content: 'Welcome' },
    ],
  };

  test('includes coverage when coverageSummary provided', () => {
    const coverageSummary = {
      totalChunks: 10,
      coveredChunks: 7,
      coveragePercent: 70,
      uncoveredChunks: [
        { chunk_index: 3, content: 'This is the allegory of the cave, a famous philosophical metaphor about perception and reality.' },
        { chunk_index: 8, content: 'The divided line analogy distinguishes between the visible and intelligible worlds.' },
      ],
    };

    const report = buildSessionReport({ ...baseArgs, coverageSummary });

    expect(report.coverage).toBeDefined();
    expect(report.coverage.percentCovered).toBe(70);
    expect(report.coverage.totalChunks).toBe(10);
    expect(report.coverage.coveredChunks).toBe(7);
    expect(report.coverage.uncoveredSections).toHaveLength(2);
    expect(report.coverage.uncoveredSections[0].chunkIndex).toBe(3);
    expect(report.overview).toEqual(
      expect.arrayContaining([
        expect.stringContaining('7 of 10 source passages (70%)'),
      ])
    );
  });

  test('returns null coverage when no coverageSummary', () => {
    const report = buildSessionReport(baseArgs);
    expect(report.coverage).toBeNull();
  });

  test('returns null coverage when totalChunks is 0', () => {
    const report = buildSessionReport({
      ...baseArgs,
      coverageSummary: { totalChunks: 0, coveredChunks: 0, coveragePercent: 0, uncoveredChunks: [] },
    });
    expect(report.coverage).toBeNull();
  });

  test('truncates long snippets at 120 chars', () => {
    const longContent = 'A'.repeat(200);
    const coverageSummary = {
      totalChunks: 1,
      coveredChunks: 0,
      coveragePercent: 0,
      uncoveredChunks: [{ chunk_index: 0, content: longContent }],
    };

    const report = buildSessionReport({ ...baseArgs, coverageSummary });
    expect(report.coverage.uncoveredSections[0].snippet.length).toBe(123); // 120 + '...'
    expect(report.coverage.uncoveredSections[0].snippet.endsWith('...')).toBe(true);
  });

  test('does not add ellipsis to short snippets', () => {
    const coverageSummary = {
      totalChunks: 2,
      coveredChunks: 1,
      coveragePercent: 50,
      uncoveredChunks: [{ chunk_index: 1, content: 'Short text.' }],
    };

    const report = buildSessionReport({ ...baseArgs, coverageSummary });
    expect(report.coverage.uncoveredSections[0].snippet).toBe('Short text.');
    expect(report.coverage.uncoveredSections[0].snippet.endsWith('...')).toBe(false);
  });
});
