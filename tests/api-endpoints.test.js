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
      const { status, body } = await testServer.post('/api/sessions', {
        title: 'Default Test Session'
      });
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

  describe('GET /api/parents/dashboard', () => {
    test('returns 401 without auth', async () => {
      const { status } = await testServer.get('/api/parents/dashboard');
      expect(status).toBe(401);
    });

    test('lets a parent create a managed child profile', async () => {
      const email = `parent-${Date.now()}@example.com`;
      const { body: regBody } = await testServer.post('/api/auth/register', {
        name: 'Parent Test',
        email,
        password: 'password123',
        role: 'Parent'
      });

      const headers = { Authorization: `Bearer ${regBody.token}` };
      const addResult = await testServer.post('/api/parents/children', {
        name: 'Child Test',
        gradeLevel: 'Grade 7'
      }, headers);

      expect(addResult.status).toBe(201);
      expect(addResult.body.mode).toBe('created_managed');

      const { status, body } = await testServer.get('/api/parents/dashboard', headers);
      expect(status).toBe(200);
      expect(body.children).toHaveLength(1);
      expect(body.children[0].name).toBe('Child Test');
      expect(body.billing.billing_status).toBeDefined();
    });
  });
});
