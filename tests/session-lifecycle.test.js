const { setupTestServer, createWsClient } = require('./helpers/test-server');

describe('Session Lifecycle', () => {
  let testServer;

  beforeAll(async () => {
    testServer = await setupTestServer();
  });

  afterAll(async () => {
    if (testServer) await testServer.close();
  });

  test('full session flow: create via API, join via WS, send messages', async () => {
    // 1. Register a user
    const { body: regBody } = await testServer.post('/api/auth/register', {
      name: 'Teacher',
      email: `lifecycle-${Date.now()}@example.com`,
      password: 'password123',
    });
    const token = regBody.token;

    // 2. Create session via REST API
    const { status: createStatus, body: session } = await testServer.post(
      '/api/sessions',
      { title: 'Lifecycle Test Session', openingQuestion: 'What is truth?' },
      { Authorization: `Bearer ${token}` }
    );
    expect(createStatus).toBe(201);
    expect(session.shortCode).toBeDefined();
    const shortCode = session.shortCode;

    // 3. Connect WebSocket and join session
    const client = await createWsClient(testServer.wsUrl);
    const { ws, messages } = client;

    // Send join_session
    ws.send(JSON.stringify({
      type: 'join_session',
      sessionId: shortCode,
      name: 'Student1',
      age: 14,
      authToken: token,
    }));

    // Wait for session_joined
    await waitForMessageType(messages, 'session_joined', 3000);
    const joined = messages.find(m => m.type === 'session_joined');
    expect(joined).toBeDefined();
    expect(joined.sessionId).toBe(shortCode);
    expect(joined.participants.length).toBeGreaterThanOrEqual(1);

    // 4. Send a message (warmup mode since discussion not started)
    ws.send(JSON.stringify({
      type: 'message',
      text: 'Hello from the test!',
      source: 'text',
    }));

    // 5. Clean up
    ws.close();
  });

  test('join non-existent session returns error', async () => {
    const client = await createWsClient(testServer.wsUrl);
    const { ws, messages } = client;

    ws.send(JSON.stringify({
      type: 'join_session',
      sessionId: 'NONEXISTENT',
      name: 'Test',
      age: 12,
    }));

    await waitForMessageType(messages, 'error', 3000);
    const error = messages.find(m => m.type === 'error');
    expect(error).toBeDefined();
    expect(error.text).toMatch(/not found/i);

    ws.close();
  });

  test('rejoin session with invalid ID returns error', async () => {
    const client = await createWsClient(testServer.wsUrl);
    const { ws, messages } = client;

    ws.send(JSON.stringify({
      type: 'rejoin_session',
      sessionId: 'INVALID',
      oldClientId: 'fake-id',
    }));

    await waitForMessageType(messages, 'error', 3000);
    const error = messages.find(m => m.type === 'error');
    expect(error).toBeDefined();

    ws.close();
  });
});

function waitForMessageType(messages, type, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (messages.find(m => m.type === type)) {
        resolve();
        return;
      }
      if (timeoutMs <= 0) {
        reject(new Error(`Timeout waiting for message type: ${type}`));
        return;
      }
      setTimeout(() => {
        timeoutMs -= 100;
        check();
      }, 100);
    };
    check();
  });
}
