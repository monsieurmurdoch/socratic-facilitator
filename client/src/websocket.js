/**
 * WebSocket Module
 *
 * Manages WebSocket connection, message sending, and message routing.
 */

import { state, loadState, shouldAutoRestore, getAge } from './state.js';

let messageHandler = null;

/**
 * Connect to WebSocket server
 */
export function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}`;
  console.log("[WS] Connecting to:", url);
  state.ws = new WebSocket(url);
  state.ws.binaryType = "arraybuffer";
  state.wsConnectedToServer = false;

  state.ws.onopen = () => {
    console.log("[WS] Socket open (handshake complete)");

    // Try to restore saved session
    const saved = loadState();
    if (shouldAutoRestore(saved)) {
      console.log("[WS] Restoring session:", saved.currentSessionId, "as", saved.myName);
      state.myName = saved.myName;
      state.myId = saved.myId;
      state.currentSessionId = saved.currentSessionId;
      state.isHost = saved.isHost;
      send({
        type: "rejoin_session",
        sessionId: saved.currentSessionId,
        oldClientId: saved.myId,
        authToken: state.authToken
      });
      return;
    }

    // If we have a pending join from URL, auto-join once connected
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get("join");
    if (joinCode && state.myName) {
      send({ type: "join_session", sessionId: joinCode, name: state.myName, age: getAge(), authToken: state.authToken });
    }
  };

  state.ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      // TTS audio - pass to global handler
      if (window.playAudioBuffer) {
        window.playAudioBuffer(event.data);
      }
      return;
    }
    const msg = JSON.parse(event.data);
    if (messageHandler) {
      messageHandler(msg);
    }
  };

  state.ws.onclose = (event) => {
    console.log("[WS] Disconnected. Code:", event.code, "Reason:", event.reason, "— reconnecting in 2s...");
    setTimeout(connect, 2000);
  };

  state.ws.onerror = (event) => {
    console.error("[WS] Error:", event);
  };
}

/**
 * Send message to WebSocket server with retry logic
 */
export function send(msg) {
  console.log("[WS] Sending:", msg.type, "| readyState:", state.ws?.readyState);
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify(msg));
  } else {
    console.warn("[WS] Not connected (state:", state.ws?.readyState, ") — queuing retry for:", msg.type);
    // Retry once after reconnect
    const retryInterval = setInterval(() => {
      if (state.ws && state.ws.readyState === 1) {
        console.log("[WS] Retrying:", msg.type);
        state.ws.send(JSON.stringify(msg));
        clearInterval(retryInterval);
      }
    }, 500);
    // Give up after 10s
    setTimeout(() => clearInterval(retryInterval), 10000);
  }
}

/**
 * Register message handler callback
 */
export function onMessage(callback) {
  messageHandler = callback;
}

/**
 * Send raw binary data (for STT audio)
 */
export function sendBinary(data) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(data);
  }
}
