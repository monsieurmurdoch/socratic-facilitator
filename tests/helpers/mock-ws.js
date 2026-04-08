/**
 * Lightweight WebSocket mock for testing server message handling.
 */
class MockWebSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.sentMessages = [];
    this.handlers = {};
    this._dashInterval = null;
  }

  send(data) {
    if (typeof data !== 'string') {
      this.sentMessages.push({ binary: true, length: data.byteLength || data.length });
      return;
    }
    this.sentMessages.push(JSON.parse(data));
  }

  on(event, handler) {
    this.handlers[event] = handler;
  }

  simulateMessage(raw) {
    const data = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (this.handlers.message) {
      this.handlers.message(data, false);
    }
  }

  simulateBinaryMessage(buffer) {
    if (this.handlers.message) {
      this.handlers.message(buffer, true);
    }
  }

  simulateClose() {
    this.readyState = 3; // CLOSED
    if (this.handlers.close) {
      this.handlers.close({ code: 1000, reason: '' });
    }
  }

  getLastSent() {
    return this.sentMessages[this.sentMessages.length - 1] || null;
  }

  findSent(type) {
    return this.sentMessages.find(m => m.type === type) || null;
  }

  close() {
    this.readyState = 3;
  }
}

module.exports = { MockWebSocket };
