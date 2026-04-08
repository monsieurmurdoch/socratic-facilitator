/**
 * Message Router Module
 *
 * Central message handler that routes WebSocket messages to appropriate handlers.
 * This module avoids circular dependencies by being the central router.
 */

import { state, getAge, clearState, saveState } from './state.js';
import { send } from './websocket.js';
import {
  resetConversationFeed,
  addFacilitatorMessage,
  addTranscriptEntry,
  updateParticipantList,
  setFacilitatorStatus,
  setPlatoTileSpeaking,
  updateLocalSpeechDraft,
  clearLocalSpeechDraft,
  flushSttBatch,
  scheduleSttFlush,
  updatePartialTranscript,
  mergeTranscriptText,
  showScreen
} from './ui.js';
import { launchJitsi, destroyJitsi } from './jitsi.js';
import { preAcquireMedia, startSpeechRecognition, destroySttStream } from './speech.js';
import { primeMaterials } from './materials.js';
import { refreshWorkspace } from './auth.js';

// ---- Message Router ----

export async function handleServerMessage(msg) {
  console.log("[WS] Received:", msg.type, msg);

  switch (msg.type) {
    case "connected":
      state.wsConnectedToServer = true;
      console.log("[WS] Server confirmed connection, clientId:", msg.clientId);
      break;

    case "session_created":
      state.currentSessionId = msg.sessionId;
      send({ type: "join_session", sessionId: msg.sessionId, name: state.myName, age: getAge(), authToken: state.authToken });
      state.isHost = true;
      break;

    case "session_joined": {
      const isRejoin = state.currentSessionId === msg.sessionId && state.myId === msg.yourId;
      state.currentSessionId = msg.sessionId;
      state.discussionActive = false;
      // Only reset feed on fresh join — preserve transcript on reconnect
      if (!isRejoin) {
        resetConversationFeed();
      }
      state.myId = msg.yourId;
      state.participants = msg.participants;
      updateParticipantList();
      import('./ui.js').then(({ showShareInfo }) => {
        showShareInfo(msg.sessionId);
      });
      if (msg.topicTitle) {
        document.getElementById("lobby-topic").textContent = msg.topicTitle;
        document.getElementById("lobby-topic-section").style.display = "block";
      }
      showScreen("lobby");
      saveState();

      // Pre-fill name input in case we need it
      document.getElementById("name-input").value = state.myName;

      // If host, prime materials now that session exists
      if (state.isHost && state.materials.length > 0) {
        primeMaterials();
      }
      break;
    }

    case "session_restored": {
      console.log("[WS] Session restored from DB:", msg.sessionStatus, "readOnly:", msg.readOnly);
      state.currentSessionId = msg.sessionId;
      state.myId = msg.yourId;
      state.discussionActive = msg.sessionStatus === 'active';
      state.readOnly = msg.readOnly;

      // Reset and rebuild conversation feed from history
      resetConversationFeed();

      // Replay all messages in order
      if (msg.messages && Array.isArray(msg.messages)) {
        for (const message of msg.messages) {
          if (message.type === 'facilitator_message') {
            addFacilitatorMessage(message.text, message.move);
          } else if (message.type === 'participant_message') {
            // Skip own messages in transcript (they'll be added locally)
            if (message.participantId !== state.myId) {
              addTranscriptEntry(message.participantName, message.text, false);
            }
          }
        }
      }

      // Set topic title if present
      if (msg.topicTitle) {
        document.getElementById("lobby-topic").textContent = msg.topicTitle;
        document.getElementById("lobby-topic-section").style.display = "block";
      }

      // Show appropriate screen based on session state
      if (msg.sessionStatus === 'ended') {
        // Show video screen but with read-only indication
        showScreen("video");
        // Optionally show a "This session has ended" message
        addTranscriptEntry("system", "Session restored from archive (read-only)");
      } else if (state.discussionActive) {
        // Session is active, go to video screen
        showScreen("video");
        // Don't auto-start STT for restored sessions - let user decide
      } else {
        // Warmup mode
        showScreen("lobby");
      }

      saveState();
      break;
    }

    case "participant_joined":
      state.participants.push({ name: msg.name });
      updateParticipantList();
      document.getElementById("participant-count").textContent = `${msg.participantCount} participants`;
      break;

    case "participant_left":
      state.participants = state.participants.filter(p => p.name !== msg.name);
      updateParticipantList();
      addTranscriptEntry("system", `${msg.name} left the discussion`);
      break;

    case "enter_video":
      state.discussionActive = false;
      if (!document.getElementById("video-screen").classList.contains("active")) {
        showScreen("video");
        await preAcquireMedia();          // single permission prompt
        launchJitsi(state.currentSessionId, state.myName);
        startSpeechRecognition();
      } else if (!state.sttActive) {
        startSpeechRecognition();
      }
      document.getElementById("start-discussion-btn").style.display = state.isHost ? "" : "none";
      saveState();
      break;

    case "discussion_started":
      state.discussionActive = true;
      if (!document.getElementById("video-screen").classList.contains("active")) {
        showScreen("video");
        await preAcquireMedia();          // single permission prompt
        launchJitsi(state.currentSessionId, state.myName);
        startSpeechRecognition();
      } else if (!state.sttActive) {
        startSpeechRecognition();
      }
      document.getElementById("start-discussion-btn").style.display = "none";
      saveState();
      break;

    case "participant_message":
      if (msg.senderId && msg.senderId === state.myId) break;
      addTranscriptEntry(msg.name, msg.text, false);
      break;

    case "participant_partial":
      updatePartialTranscript(msg.name, msg.text);
      break;

    case "facilitator_message":
      addFacilitatorMessage(msg.text, msg.move);
      setFacilitatorStatus("speaking");
      setPlatoTileSpeaking(msg.text);
      // TTS disabled for beta — uncomment when voice quality improves
      // speakWithBrowserTTS(msg.text);
      break;

    case "stt_transcript":
      if (msg.isFinal) {
        if (msg.text && msg.text.trim().length > 2) {
          // Batch consecutive STT finals into a single utterance.
          state.sttBatchBuffer = mergeTranscriptText(state.sttBatchBuffer, msg.text.trim());
          state.lastInterimTranscript = "";
          updateLocalSpeechDraft(state.sttBatchBuffer, false);
          scheduleSttFlush();
        }
      } else {
        if (msg.text && msg.text.trim()) {
          state.lastInterimTranscript = msg.text.trim();
          const preview = mergeTranscriptText(state.sttBatchBuffer, state.lastInterimTranscript);
          updateLocalSpeechDraft(preview, true);
          scheduleSttFlush();
        }
      }
      break;

    case "stt_error":
      console.warn("[STT] Server error:", msg.text);
      break;

    case "stt_flush_now":
      // Server indicates this interim transcript is ready for immediate processing
      console.log(`[STT] Predictive flush triggered: ${msg.confidence?.toFixed(2)} - ${msg.reasoning}`);
      flushSttBatch();
      break;

    case "discussion_ended":
      state.discussionActive = false;
      destroySttStream();
      destroyJitsi();
      clearState();
      showScreen("welcome");
      refreshWorkspace();
      break;

    case "error":
      console.error("[Server] Error:", msg.text);
      // If rejoin failed, clear stale state and go to welcome
      if (msg.text.includes("not found") || msg.text.includes("expired")) {
        clearState();
        showScreen("welcome");
      }
      alert(msg.text);
      break;
  }
}
