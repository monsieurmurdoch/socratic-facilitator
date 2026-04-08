/**
 * Speech Recognition Module
 *
 * Handles Speech-to-Text (STT) via Deepgram through server relay.
 */

import { state } from './state.js';
import { send, sendBinary } from './websocket.js';
import { flushSttBatch, clearLocalSpeechDraft, addTranscriptEntry } from './ui.js';

/**
 * Pre-acquire camera+mic in a single getUserMedia call so Safari only
 * shows ONE permission prompt. The video track is immediately stopped
 * (Jitsi will open its own), but the permission grant persists for the
 * page lifetime, so Jitsi's subsequent getUserMedia won't re-prompt.
 * The audio track is kept alive and reused for STT.
 */
export async function preAcquireMedia() {
  try {
    if (state.sttStream && state.sttStream.getAudioTracks().some(t => t.readyState === 'live')) {
      console.log("[Media] Already have a live audio stream, skipping pre-acquire");
      return;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      video: true
    });
    // Stop the video track — we only needed it to grant the permission.
    // Jitsi manages its own video capture independently.
    stream.getVideoTracks().forEach(t => t.stop());
    // Keep the audio track for STT
    state.sttStream = new MediaStream(stream.getAudioTracks());
    console.log("[Media] Pre-acquired mic+camera permissions (single prompt)");
  } catch (e) {
    console.warn("[Media] Pre-acquire failed, will fall back to separate prompts:", e.message);
  }
}

export async function startSpeechRecognition() {
  if (state.sttActive) {
    console.log("[STT] Already active, skipping");
    return;
  }
  // Set flag IMMEDIATELY to prevent race condition with Jitsi's audioMuteStatusChanged event
  state.sttActive = true;

  try {
    // Reuse existing stream (from preAcquireMedia or previous STT session)
    if (!state.sttStream || state.sttStream.getAudioTracks().every(t => t.readyState === 'ended')) {
      state.sttStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
      });
      console.log("[STT] Mic access granted (new stream)");
    } else {
      console.log("[STT] Reusing existing mic stream");
    }
  } catch (e) {
    console.warn("[STT] Mic access denied:", e.message);
    state.sttActive = false; // Reset on failure
    return;
  }

  state.sttContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const source = state.sttContext.createMediaStreamSource(state.sttStream);

  // Tell server to open Deepgram connection
  send({ type: "stt_start" });

  // Try AudioWorklet, fall back to ScriptProcessor
  if (window.AudioWorkletNode) {
    try {
      await state.sttContext.audioWorklet.addModule('/src/audio-processor.js');
      state.sttNode = new AudioWorkletNode(state.sttContext, 'pcm-processor');
      state.sttNode.port.onmessage = (e) => {
        if (state.ws && state.ws.readyState === 1) {
          sendBinary(e.data); // send raw Int16 PCM buffer
        }
      };
      source.connect(state.sttNode);
      state.sttNode.connect(state.sttContext.destination); // required to keep processing alive
    } catch (e) {
      console.warn("[STT] AudioWorklet failed, using ScriptProcessor:", e.message);
      setupScriptProcessor(source);
    }
  } else {
    setupScriptProcessor(source);
  }

  console.log("[STT] Streaming to Deepgram via server, sampleRate:", state.sttContext.sampleRate);
}

function setupScriptProcessor(source) {
  state.sttNode = state.sttContext.createScriptProcessor(2048, 1, 1);
  state.sttNode.onaudioprocess = (e) => {
    if (state.ws && state.ws.readyState === 1) {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      sendBinary(int16.buffer);
    }
  };
  source.connect(state.sttNode);
  state.sttNode.connect(state.sttContext.destination);
}

export function stopSpeechRecognition() {
  flushSttBatch();
  if (state.sttNode) {
    try { state.sttNode.disconnect(); } catch (e) {}
    state.sttNode = null;
  }
  if (state.sttContext) {
    try { state.sttContext.close(); } catch (e) {}
    state.sttContext = null;
  }
  // Don't destroy the stream — keep it for reuse to avoid re-prompting mic
  if (state.sttActive) {
    send({ type: "stt_stop" });
  }
  // Always reset flag so reconnect can re-establish the Deepgram relay
  state.sttActive = false;
  console.log("[STT] Stopped (stream kept for reuse)");
}

export function destroySttStream() {
  stopSpeechRecognition();
  if (state.sttStream) {
    state.sttStream.getTracks().forEach(t => t.stop());
    state.sttStream = null;
  }
}
