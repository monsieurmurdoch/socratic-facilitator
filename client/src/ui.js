/**
 * UI Module
 *
 * Handles UI updates, screen management, and conversation feed rendering.
 */

import { state, STT_FLUSH_MS_WARMUP, STT_FLUSH_MS_DISCUSSION } from './state.js';
import { send } from './websocket.js';

// ---- Screen Management ----

export function showScreen(name) {
  state.currentScreen = name;
  const screens = {
    welcome: document.getElementById("welcome-screen"),
    setup: document.getElementById("setup-screen"),
    lobby: document.getElementById("lobby-screen"),
    video: document.getElementById("video-screen")
  };
  Object.values(screens).forEach(s => s && s.classList.remove("active"));
  if (screens[name]) screens[name].classList.add("active");
  document.body.classList.toggle("video-active", name === "video");
}

// ---- Security: Escape HTML ----

export function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ---- Conversation Feed ----

export function resetConversationFeed() {
  const container = document.getElementById("conversation-feed");
  if (container) container.innerHTML = "";
  state.sttBatchBuffer = "";
  state.lastInterimTranscript = "";
  clearTimeout(state.sttBatchTimer);
  state.sttBatchTimer = null;
}

export function addFacilitatorMessage(text, move) {
  const container = document.getElementById("conversation-feed");
  if (!container) return;

  // Remove any interim entry before adding facilitator message
  const interim = container.querySelector('.transcript-interim');
  if (interim) interim.remove();

  const div = document.createElement("div");
  div.className = "facilitator-bubble";
  div.innerHTML = `
    <div class="facilitator-label"><span class="plato-avatar-tiny">P</span> Plato <span class="facilitator-move">${move || ''}</span></div>
    <span class="facilitator-text">${escapeHtml(text)}</span>
  `;
  container.appendChild(div);
  scrollChatToBottom();
}

export function addTranscriptEntry(name, text, isSelf, isInterim) {
  const container = document.getElementById("conversation-feed");
  if (!container) return;

  // For interim (partial) STT results, update in place
  if (isInterim) {
    let partial = container.querySelector('.transcript-interim');
    if (!partial) {
      partial = document.createElement("div");
      partial.className = "transcript-entry self transcript-interim";
      container.appendChild(partial);
    }
    partial.innerHTML = `<strong>${escapeHtml(name)}:</strong> <em>${escapeHtml(text)}</em>`;
    scrollChatToBottom();
    return;
  }

  // Remove interim element when we get a final result
  const interim = container.querySelector('.transcript-interim');
  if (interim) interim.remove();

  if (name === "system") {
    const div = document.createElement("div");
    div.className = "transcript-system";
    div.textContent = text;
    container.appendChild(div);
  } else {
    // Batch consecutive messages from the same speaker into one bubble
    const last = container.lastElementChild;
    if (last && last.classList.contains('transcript-entry') && last.dataset.speaker === name) {
      // Append to existing bubble
      last.querySelector('.transcript-lines').insertAdjacentHTML(
        'beforeend', `<span class="transcript-line">${escapeHtml(text)}</span>`
      );
    } else {
      // New speaker — create a new entry
      const div = document.createElement("div");
      div.className = `transcript-entry ${isSelf ? "self" : ""}`;
      div.dataset.speaker = name;
      div.innerHTML = `<strong>${escapeHtml(name)}:</strong> <span class="transcript-lines"><span class="transcript-line">${escapeHtml(text)}</span></span>`;
      container.appendChild(div);
    }
  }
  scrollChatToBottom();
}

export function updateParticipantList() {
  const container = document.getElementById("participant-chips");
  container.innerHTML = "";
  state.participants.forEach(p => {
    const chip = document.createElement("span");
    chip.className = "participant-chip";
    chip.textContent = p.name;
    container.appendChild(chip);
  });
}

export function setFacilitatorStatus(status) {
  const badge = document.getElementById("facilitator-status");
  if (!badge) return;
  if (state.platoMicMuted && status !== "speaking") {
    badge.className = "status-badge muted";
    badge.textContent = "Muted";
    return;
  }
  badge.className = `status-badge ${status}`;
  badge.textContent = status === "speaking" ? "Speaking" : status === "muted" ? "Muted" : "Listening";
}

export function renderPlatoMicState() {
  const button = document.getElementById("plato-mic-toggle");
  if (button) {
    button.classList.toggle("muted", state.platoMicMuted);
    button.setAttribute("aria-pressed", String(state.platoMicMuted));
    button.textContent = state.platoMicMuted ? "Unmute Mic" : "Mute Mic";
  }

  const tile = document.getElementById("plato-tile");
  const tileStatus = document.getElementById("plato-tile-status");
  if (state.platoMicMuted && tileStatus && !tile?.classList.contains("speaking")) {
    tileStatus.textContent = "Muted";
  } else if (!state.platoMicMuted && tileStatus?.textContent === "Muted") {
    tileStatus.textContent = "Listening";
  }
  if (state.platoMicMuted) {
    setFacilitatorStatus("muted");
  } else if (document.getElementById("facilitator-status")?.textContent === "Muted") {
    setFacilitatorStatus("listening");
  }
}

export function setPlatoTileSpeaking(text) {
  const tile = document.getElementById("plato-tile");
  const tileStatus = document.getElementById("plato-tile-status");
  const tileText = document.getElementById("plato-tile-text");
  if (!tile) return;

  // Clear any existing timer
  if (state.platoSpeakingTimer) clearTimeout(state.platoSpeakingTimer);

  tile.classList.add("speaking");
  if (tileStatus) tileStatus.textContent = "Speaking";
  if (tileText) {
    // Show a preview of what Plato is saying
    const preview = text.length > 100 ? text.substring(0, 97) + "..." : text;
    tileText.textContent = preview;
  }

  // Estimate speaking duration: ~150 words per minute for TTS
  const words = text.split(/\s+/).length;
  const speakingMs = Math.max(3000, (words / 150) * 60 * 1000);

  state.platoSpeakingTimer = setTimeout(() => {
    tile.classList.remove("speaking");
    if (tileStatus) tileStatus.textContent = state.platoMicMuted ? "Muted" : "Listening";
    if (tileText) tileText.textContent = "";
    setFacilitatorStatus("listening");
  }, speakingMs);
}

export function scrollChatToBottom() {
  const scrollable = document.querySelector('.sidebar-transcript');
  if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
}

// ---- STT Batching ----

export function updateLocalSpeechDraft(text, isInterim) {
  const container = document.getElementById("conversation-feed");
  if (!container) return;

  let draft = container.querySelector('.transcript-interim');
  if (!draft) {
    draft = document.createElement("div");
    draft.className = "transcript-entry self transcript-interim";
    container.appendChild(draft);
  }

  const suffix = isInterim ? " ..." : "";
  const body = isInterim
    ? `<em>${escapeHtml(text + suffix)}</em>`
    : escapeHtml(text);
  draft.innerHTML = `<strong>${escapeHtml(state.myName)}:</strong> ${body}`;
  scrollChatToBottom();
}

export function clearLocalSpeechDraft() {
  const container = document.getElementById("conversation-feed");
  if (!container) return;
  const draft = container.querySelector('.transcript-interim');
  if (draft) draft.remove();
}

export function flushSttBatch() {
  clearTimeout(state.sttBatchTimer);
  state.sttBatchTimer = null;
  const text = state.sttBatchBuffer.trim();
  if (!text) return;
  state.sttBatchBuffer = '';
  state.lastInterimTranscript = "";
  clearLocalSpeechDraft();
  addTranscriptEntry(state.myName, text, true, false);
  send({ type: "message", text, source: "stt" });
  console.log("[STT] Batched final:", text);
}

export function scheduleSttFlush() {
  clearTimeout(state.sttBatchTimer);
  state.sttBatchTimer = setTimeout(() => {
    flushSttBatch();
  }, getSttFlushDelay());
}

export function updatePartialTranscript(name, text) {
  const container = document.getElementById("conversation-feed");
  if (!container) return;
  let partial = container.querySelector(`.transcript-partial[data-name="${name}"]`);
  if (!partial) {
    partial = document.createElement("div");
    partial.className = "transcript-partial";
    partial.dataset.name = name;
    container.appendChild(partial);
  }
  partial.innerHTML = `<strong>${escapeHtml(name)}:</strong> <em>${escapeHtml(text)}</em>`;
  scrollChatToBottom();
}

export function mergeTranscriptText(base, incoming) {
  const left = String(base || "").trim();
  const right = String(incoming || "").trim();
  if (!left) return right;
  if (!right) return left;
  if (right === left) return left;
  if (right.startsWith(left)) return right;
  if (left.startsWith(right)) return left;
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;

  const maxOverlap = Math.min(left.length, right.length);
  for (let i = maxOverlap; i >= 1; i -= 1) {
    if (left.slice(-i).toLowerCase() === right.slice(0, i).toLowerCase()) {
      return `${left}${right.slice(i)}`.trim();
    }
  }

  return `${left} ${right}`.trim();
}

function getSttFlushDelay() {
  return state.discussionActive ? STT_FLUSH_MS_DISCUSSION : STT_FLUSH_MS_WARMUP;
}

// ---- Share Link ----

export function showShareInfo(sessionId) {
  document.getElementById("session-code").textContent = sessionId;

  // Show dashboard link for host
  const dashLink = document.getElementById("dashboard-link");
  if (dashLink && state.isHost) {
    dashLink.href = `/dashboard?session=${sessionId}`;
    dashLink.style.display = "";
  }

  // Update URL without reload
  const shareUrl = getShareLink(sessionId);
  window.history.replaceState({}, '', `?join=${sessionId}`);

  // Create or update share link display
  let shareEl = document.getElementById("share-link");
  if (!shareEl) {
    shareEl = document.createElement("div");
    shareEl.id = "share-link";
    shareEl.className = "share-link";
    document.getElementById("session-code").after(shareEl);
  }
  shareEl.innerHTML = `
    <input type="text" value="${shareUrl}" readonly id="share-url-input" class="share-url-input">
    <button class="btn btn-small btn-secondary" id="copy-link-btn">Copy</button>
  `;

  document.getElementById("copy-link-btn").addEventListener("click", () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      document.getElementById("copy-link-btn").textContent = "Copied!";
      setTimeout(() => {
        document.getElementById("copy-link-btn").textContent = "Copy";
      }, 2000);
    });
  });
}

function getShareLink(sessionId) {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?join=${sessionId}`;
}
