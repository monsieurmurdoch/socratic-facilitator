const { setupTestServer } = require('./helpers/test-server');

describe('API Endpoints', () => {
  let testServer;

  beforeAll(async () => {
    testServer = await setupTestServer();
  });

  afterAll(async () => {
    if (testServer) await testServer.close();
  });

  describe('GET /health', () => {
    test('returns ok status', async () => {
      const { status, body } = await testServer.get('/health');
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
    });
  });

  describe('POST /api/sessions', () => {
    test('creates a session with title', async () => {
      const { status, body } = await testServer.post('/api/sessions', {
        title: 'Test Discussion',
        openingQuestion: 'What is justice?',
      });
      expect(status).toBe(201);
      expect(body.shortCode).toBeDefined();
      expect(body.title).toBe('Test Discussion');
      expect(typeof body.shortCode).toBe('string');
    });

    test('creates a session with default title', async () => {
      const { status, body } = await testServer.post('/api/sessions', {});
      expect(status).toBe(201);
      expect(body.shortCode).toBeDefined();
    });
  });

  describe('GET /api/classes', () => {
    test('returns 401 without auth', async () => {
      const { status } = await testServer.get('/api/classes');
      expect(status).toBe(401);
    });
  });

  describe('GET /api/auth/me', () => {
    test('returns 401 without auth', async () => {
      const { status } = await testServer.get('/api/auth/me');
      expect(status).toBe(401);
    });
  });

  describe('GET /api/auth/demo-teacher', () => {
    test('returns demo teacher config', async () => {
      const { status, body } = await testServer.get('/api/auth/demo-teacher');
      expect(status).toBe(200);
      expect(body).toHaveProperty('enabled');
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('email');
    });
  });
});
