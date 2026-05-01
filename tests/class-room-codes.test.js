describe('class room codes', () => {
  let queries;
  let repo;

  beforeEach(() => {
    jest.resetModules();
    queries = [];

    jest.doMock('../server/db', () => ({
      query: jest.fn(async (sql, params = []) => {
        const text = String(sql);
        queries.push({ sql: text, params });

        if (text.includes('FROM classes') && text.includes('WHERE id = $1')) {
          return {
            rows: [{
              id: params[0],
              owner_user_id: 'owner-1',
              name: 'Demo Class',
              room_code: 'RM-4K7P'
            }],
            rowCount: 1
          };
        }

        if (text.includes('FROM classes') || text.includes('FROM sessions')) {
          return { rows: [], rowCount: 0 };
        }

        if (text.includes('INSERT INTO classes')) {
          return {
            rows: [{ id: 'class-1', name: params[1], room_code: params[4] }],
            rowCount: 1
          };
        }

        if (text.includes('UPDATE classes')) {
          return {
            rows: [{ id: params[0] || params[1], room_code: params[1] || params[0] }],
            rowCount: 1
          };
        }

        return { rows: [], rowCount: 0 };
      })
    }));

    repo = require('../server/db/repositories/classes');
  });

  afterEach(() => {
    jest.dontMock('../server/db');
  });

  test('new classes get readable two-word room codes instead of legacy RM codes', async () => {
    const created = await repo.create({ ownerUserId: 'owner-1', name: 'Humanities' });

    expect(created.room_code).toMatch(/^[a-z]+-[a-z]+(?:-[2-9])?$/);
    expect(created.room_code).not.toMatch(/^RM-/);
  });

  test('legacy RM room codes are regenerated when a class is loaded', async () => {
    const loaded = await repo.findById('class-1');

    expect(loaded.room_code).toMatch(/^[a-z]+-[a-z]+(?:-[2-9])?$/);
    expect(loaded.room_code).not.toBe('RM-4K7P');
    expect(queries.some(q => q.sql.includes('UPDATE classes') && q.params.includes(loaded.room_code))).toBe(true);
  });

  test('teacher-edited room codes are normalized for display', () => {
    expect(repo.normalizeRoomCodeForDisplay('  Maple River!  ')).toBe('maple-river');
    expect(repo.normalizeRoomCodeForDisplay('Socratic Seminar 9')).toBe('socratic-seminar-9');
  });
});
