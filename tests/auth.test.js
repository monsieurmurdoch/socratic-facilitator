const { setupTestServer } = require('./helpers/test-server');

describe('Auth', () => {
  let testServer;

  beforeAll(async () => {
    testServer = await setupTestServer();
  });

  afterAll(async () => {
    if (testServer) await testServer.close();
  });

  describe('POST /api/auth/register', () => {
    test('registers a new user', async () => {
      const email = `test-${Date.now()}@example.com`;
      const { status, body } = await testServer.post('/api/auth/register', {
        name: 'Test User',
        email,
        password: 'password123',
      });
      expect(status).toBe(201);
      expect(body.token).toBeDefined();
      expect(body.user.name).toBe('Test User');
      expect(body.user.email).toBe(email);
    });

    test('rejects missing fields', async () => {
      const { status, body } = await testServer.post('/api/auth/register', {
        name: '',
        email: '',
        password: '',
      });
      expect(status).toBe(400);
      expect(body.error).toBeDefined();
    });

    test('rejects short password', async () => {
      const { status, body } = await testServer.post('/api/auth/register', {
        name: 'Test',
        email: `short-${Date.now()}@example.com`,
        password: 'short',
      });
      expect(status).toBe(400);
      expect(body.error).toMatch(/8 characters/);
    });

    test('rejects duplicate email', async () => {
      const email = `dup-${Date.now()}@example.com`;
      await testServer.post('/api/auth/register', {
        name: 'First',
        email,
        password: 'password123',
      });
      const { status, body } = await testServer.post('/api/auth/register', {
        name: 'Second',
        email,
        password: 'password123',
      });
      expect(status).toBe(409);
      expect(body.error).toMatch(/already exists/);
    });
  });

  describe('POST /api/auth/login', () => {
    let testEmail;
    let testPassword = 'loginpass123';

    beforeAll(async () => {
      testEmail = `login-${Date.now()}@example.com`;
      await testServer.post('/api/auth/register', {
        name: 'Login Test',
        email: testEmail,
        password: testPassword,
      });
    });

    test('logs in with correct credentials', async () => {
      const { status, body } = await testServer.post('/api/auth/login', {
        email: testEmail,
        password: testPassword,
      });
      expect(status).toBe(200);
      expect(body.token).toBeDefined();
      expect(body.user.email).toBe(testEmail);
    });

    test('rejects wrong password', async () => {
      const { status, body } = await testServer.post('/api/auth/login', {
        email: testEmail,
        password: 'wrongpassword',
      });
      expect(status).toBe(401);
      expect(body.error).toMatch(/Invalid/);
    });

    test('rejects missing fields', async () => {
      const { status } = await testServer.post('/api/auth/login', {
        email: '',
        password: '',
      });
      expect(status).toBe(400);
    });
  });

  describe('POST /api/auth/demo-teacher/login', () => {
    test('logs in as demo teacher', async () => {
      const { status, body } = await testServer.post('/api/auth/demo-teacher/login', {});
      // May be 200 or 403 depending on NODE_ENV
      if (status === 200) {
        expect(body.token).toBeDefined();
        expect(body.demoTeacher).toBeDefined();
      } else {
        expect(status).toBe(403);
      }
    });
  });

  describe('GET /api/auth/me', () => {
    test('returns user with valid token', async () => {
      const email = `me-${Date.now()}@example.com`;
      const { body: regBody } = await testServer.post('/api/auth/register', {
        name: 'Me Test',
        email,
        password: 'password123',
      });
      const token = regBody.token;

      const { status, body } = await testServer.get('/api/auth/me', {
        Authorization: `Bearer ${token}`,
      });
      expect(status).toBe(200);
      expect(body.user.email).toBe(email);
    });

    test('returns 401 with invalid token', async () => {
      const { status } = await testServer.get('/api/auth/me', {
        Authorization: 'Bearer invalid-token',
      });
      expect(status).toBe(401);
    });
  });
});
