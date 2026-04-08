/**
 * Main Entry Point
 *
 * Initializes the Socratic Facilitator client application.
 */

import {
  state,
  loadAuthState,
  loadState,
  shouldAutoRestore,
  clearState,
  saveState,
  getAge
} from './state.js';
import { connect, onMessage } from './websocket.js';
import { handleServerMessage } from './message-router.js';
import {
  renderAuthState,
  loadDemoTeacherConfig,
  refreshWorkspace,
  renderClasses,
  renderSessionHistory
} from './auth.js';
import {
  showScreen,
  renderMaterials,
  resetConversationFeed
} from './ui.js';
import {
  initEventListeners,
  initCollapsibleSections,
  checkDirectJoin
} from './events.js';
import { initAnalyticsModal, initTranscriptModal } from './analytics.js';

// ---- Audio Context Unlock ----
// Unlock AudioContext on first user gesture (required by Safari)
let playbackContext;

function ensureAudioContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (playbackContext.state === "suspended") {
    playbackContext.resume().then(() => {
      console.log("[Audio] AudioContext resumed");
    });
  }
  return playbackContext;
}

// Unlock on any user interaction
["click", "touchstart", "keydown"].forEach(evt => {
  document.addEventListener(evt, () => ensureAudioContext(), { once: false });
});

// ---- Browser TTS fallback (when server ElevenLabs isn't available) ----
let serverTTSReceived = false;

function speakWithBrowserTTS(text) {
  if (!window.speechSynthesis) return;
  // Wait briefly to see if server sends audio first
  serverTTSReceived = false;
  setTimeout(() => {
    if (serverTTSReceived) return; // server audio arrived, skip browser TTS
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.95;
    utterance.pitch = 0.9;
    // Try to pick a good voice
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(v => v.name.includes('Daniel') || v.name.includes('Samantha') || (v.lang === 'en-US' && v.localService));
    if (preferred) utterance.voice = preferred;
    speechSynthesis.cancel(); // stop any previous
    speechSynthesis.speak(utterance);
    console.log("[TTS] Browser fallback speaking:", text.substring(0, 50) + "...");
  }, 500);
}

function playAudioBuffer(arrayBuffer) {
  serverTTSReceived = true;
  speechSynthesis?.cancel(); // stop browser TTS if it started
  const ctx = ensureAudioContext();
  console.log("[Audio] Received TTS buffer:", arrayBuffer.byteLength, "bytes, context state:", ctx.state);
  ctx.decodeAudioData(arrayBuffer.slice(0), (buffer) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    console.log("[Audio] Playing TTS, duration:", buffer.duration.toFixed(1), "s");
  }, (err) => {
    console.warn('[Audio] Failed to decode audio:', err);
  });
}

// ---- Initialization ----

// Load auth state first
loadAuthState();

// Load saved state
const savedState = loadState();

// Restore session if possible
if (shouldAutoRestore(savedState)) {
  // Show a loading state while we try to rejoin
  showScreen("lobby");
  document.getElementById("session-code").textContent = savedState.currentSessionId;
  document.getElementById("participant-count").textContent = "Reconnecting...";
} else {
  showScreen("welcome");
}

// Render UI
renderAuthState();
renderClasses();
renderSessionHistory();
loadDemoTeacherConfig();
refreshWorkspace();
renderMaterials();

// Connect to WebSocket
connect();

// Check for direct join URL
checkDirectJoin();

// Initialize event listeners
initEventListeners();
initCollapsibleSections();
initAnalyticsModal();
initTranscriptModal();

// Wire message handler
onMessage(handleServerMessage);

// Export for audio handling (used in WebSocket binary message handling)
window.playAudioBuffer = playAudioBuffer;
