/**
 * Test helpers for starting an Express + WebSocket server on a random port.
 */
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

/**
 * Set up a test server with the real app routes but without starting the full
 * monolith. Mounts Express routes and returns a server for testing.
 */
async function setupTestServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '../../client/public')));
  app.use('/src', express.static(path.join(__dirname, '../../client/src')));

  const { attachUser } = require('../../server/auth');
  app.use(attachUser);

  // Mount API routes
  const authRouter = require('../../server/routes/auth');
  const classesRouter = require('../../server/routes/classes');
  const sessionsRouter = require('../../server/routes/sessions');
  const adminRouter = require('../../server/routes/admin');
  const integrationsRouter = require('../../server/routes/integrations');

  app.use('/api/auth', authRouter);
  app.use('/api/classes', classesRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/integrations', integrationsRouter);

  // Health check
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  // Listen on random port
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://localhost:${port}`;
  const wsUrl = `ws://localhost:${port}`;

  return {
    app,
    server,
    wss,
    url,
    wsUrl,
    port,
    async close() {
      wss.clients.forEach(ws => {
        if (ws.readyState === 1) ws.close();
      });
      await new Promise(resolve => server.close(resolve));
    },
    /**
     * Helper for HTTP requests to the test server.
     */
    async request(method, path, body = null, headers = {}) {
      const nodeFetch = require('node-fetch');
      const opts = {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
      };
      if (body) opts.body = JSON.stringify(body);
      const res = await nodeFetch(`${url}${path}`, opts);
      const json = await res.json();
      return { status: res.status, body: json, headers: res.headers };
    },
    async post(path, body, headers) {
      return this.request('POST', path, body, headers);
    },
    async get(path, headers) {
      return this.request('GET', path, null, headers);
    },
  };
}

/**
 * Create a WebSocket client connected to the test server.
 */
function createWsClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    const messages = [];

    ws.on('message', (data) => {
      try {
        messages.push(JSON.parse(data.toString()));
      } catch {
        messages.push({ binary: true });
      }
    });

    ws.on('open', () => {
      // Wait for the "connected" message from server
      const waitForConnected = () => {
        const connected = messages.find(m => m.type === 'connected');
        if (connected) {
          resolve({ ws, messages, clientId: connected.clientId });
          return;
        }
        setTimeout(waitForConnected, 50);
      };
      waitForConnected();
    });

    ws.on('error', reject);

    // Timeout
    setTimeout(() => reject(new Error('WS connection timeout')), 5000);
  });
}

module.exports = { setupTestServer, createWsClient };
