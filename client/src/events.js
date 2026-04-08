/**
 * Events Module
 *
 * Initializes all event listeners for the application.
 */

import { state, MAX_MATERIALS, clearState, saveState, getAge, saveAuthState, clearAuthState, abandonDraftSession, canManageClasses } from './state.js';
import { send } from './websocket.js';
import { showScreen, resetConversationFeed, clearLocalSpeechDraft, addTranscriptEntry } from './ui.js';
import { primeMaterials, renderMaterials } from './materials.js';
import { handleRegister, handleLogin, handleDemoTeacherLogin, handleCreateClass, handleLogout, refreshWorkspace, renderAuthState, renderClasses, renderSessionHistory, apiPost, showAuthCard } from './auth.js';

// Re-export apiPost for use in event handlers
export { apiPost };

// ---- Check URL for direct join ----

export function checkDirectJoin() {
  const params = new URLSearchParams(window.location.search);
  const joinCode = params.get("join");
  if (joinCode) {
    // Pre-fill the join code and show join section
    document.getElementById("join-code-input").value = joinCode;
    document.getElementById("join-section").style.display = "flex";
    // Focus on name input
    document.getElementById("name-input").focus();
  }
}

// ---- Initialize Event Listeners ----

export function initEventListeners() {
  // Auth event handlers
  document.getElementById("register-btn").addEventListener("click", handleRegister);
  document.getElementById("login-btn").addEventListener("click", handleLogin);
  document.getElementById("demo-login-btn")?.addEventListener("click", handleDemoTeacherLogin);
  document.getElementById("create-class-btn").addEventListener("click", handleCreateClass);
  document.getElementById("logout-btn").addEventListener("click", handleLogout);

  // Auth card opening - "Sign in" link
  document.getElementById("show-auth-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    showAuthCard('signin');
  });

  // Auth card opening - "create an account" link
  document.getElementById("show-signup-btn")?.addEventListener("click", (e) => {
    e.preventDefault();
    showAuthCard('signup');
  });

  // Auth tab switching
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.tab;
      // Toggle active class on tabs
      document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      // Show/hide tab content
      document.getElementById("auth-tab-signin").style.display = tabName === "signin" ? "block" : "none";
      document.getElementById("auth-tab-signup").style.display = tabName === "signup" ? "block" : "none";
    });
  });

  // Role chip selection
  document.querySelectorAll(".role-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const role = chip.dataset.role;
      // Set hidden input value
      document.getElementById("auth-role-select").value = role;

      // Toggle active class on chips
      document.querySelectorAll(".role-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");

      // Show/hide conditional fields
      const studentFields = document.getElementById("signup-student-fields");
      const parentFields = document.getElementById("signup-parent-fields");

      if (studentFields) studentFields.style.display = role === "Student" ? "block" : "none";
      if (parentFields) parentFields.style.display = role === "Parent" ? "block" : "none";
    });
  });

  // Show/hide join section
  document.getElementById("join-toggle-btn").addEventListener("click", () => {
    const section = document.getElementById("join-section");
    section.style.display = section.style.display === "none" ? "flex" : "none";
  });

  // Create button → setup screen
  document.getElementById("create-btn").addEventListener("click", () => {
    state.myName = document.getElementById("name-input").value.trim();
    if (!state.myName) { alert("Enter your name"); return; }
    if (state.accountUser && !canManageClasses()) {
      alert("Only teachers and admins can create sessions right now.");
      return;
    }
    abandonDraftSession(resetConversationFeed);
    showScreen("setup");
  });

  // Back from setup
  document.getElementById("back-to-welcome-btn")?.addEventListener("click", () => {
    abandonDraftSession(resetConversationFeed);
    showScreen("welcome");
  });

  // File upload
  const uploadArea = document.getElementById("upload-area");
  const fileInput = document.getElementById("file-input");

  uploadArea.addEventListener("click", () => {
    if (state.materials.length < MAX_MATERIALS) fileInput.click();
  });
  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
  });
  uploadArea.addEventListener("dragleave", () => {
    uploadArea.classList.remove("dragover");
  });
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove("dragover");
    handleFiles(e.dataTransfer.files);
  });
  // Block ALL drag-and-drop outside the upload area — prevents browser from
  // opening dragged files as a new page (which would destroy the session)
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // If dropped on the upload area, route through its handler
    if (uploadArea.contains(e.target) || e.target === uploadArea) {
      handleFiles(e.dataTransfer.files);
    }
  });
  fileInput.addEventListener("change", () => {
    handleFiles(fileInput.files);
  });

  // URL input
  document.getElementById("add-url-btn").addEventListener("click", () => {
    if (state.materials.length >= MAX_MATERIALS) return;
    const input = document.getElementById("url-input");
    const url = input.value.trim();
    if (url) {
      // Truncate display name
      const displayName = url.length > 50 ? url.substring(0, 47) + "..." : url;
      state.materials.push({ type: "url", name: displayName, url: url });
      input.value = "";
      renderMaterials();
    }
  });

  // Remove material
  document.getElementById("materials-list").addEventListener("click", (e) => {
    if (e.target.classList.contains("material-remove")) {
      const index = parseInt(e.target.dataset.index);
      state.materials.splice(index, 1);
      renderMaterials();
    }
  });

  // Create session
  document.getElementById("start-session-btn").addEventListener("click", () => {
    const title = document.getElementById("session-title").value.trim();
    const question = document.getElementById("opening-question").value.trim();
    const classId = document.getElementById("session-class-select").value || null;

    if (!title && state.materials.length === 0) {
      alert("Enter a discussion title or upload some materials");
      return;
    }

    const sessionTitle = title || "Open Discussion";
    const btn = document.getElementById("start-session-btn");
    btn.blur();
    btn.disabled = true;
    btn.textContent = "Creating...";

    console.log("[Session] Creating:", { title: sessionTitle, question });

    apiPost("/api/sessions", {
      title: sessionTitle,
      openingQuestion: question || null,
      conversationGoal: null,
      classId
    }).then(session => {
      console.log("[Session] Created:", session);
      if (!session.shortCode) {
        throw new Error("Server returned session without shortCode");
      }
      refreshWorkspace();
      state.currentSessionId = session.shortCode;
      state.isHost = true;
      send({
        type: "join_session",
        sessionId: session.shortCode,
        name: state.myName,
        age: getAge(),
        authToken: state.authToken
      });
    }).catch(error => {
      console.error("[Session] Creation error:", error);
      alert("Failed to create session: " + error.message);
      btn.disabled = false;
      btn.textContent = "Create Session";
    });
  });

  // Join existing session (guest panel)
  document.getElementById("join-btn").addEventListener("click", () => {
    state.myName = document.getElementById("name-input").value.trim();
    const code = document.getElementById("join-code-input").value.trim().toLowerCase();
    if (!state.myName) { alert("Enter your name"); return; }
    if (!code) { alert("Enter a session code"); return; }
    send({ type: "join_session", sessionId: code, name: state.myName, age: getAge(), authToken: state.authToken });
  });

  // ---- Teacher Dashboard Buttons ----

  // Create button → setup screen (teacher dashboard)
  document.getElementById("create-btn-teacher")?.addEventListener("click", () => {
    if (!state.accountUser?.name) { alert("Account name not found"); return; }
    state.myName = state.accountUser.name;
    abandonDraftSession(resetConversationFeed);
    showScreen("setup");
  });

  // Show/hide join section (teacher dashboard)
  document.getElementById("join-toggle-btn-teacher")?.addEventListener("click", () => {
    const section = document.getElementById("join-section-teacher");
    section.style.display = section.style.display === "none" ? "block" : "none";
  });

  // Join existing session (teacher dashboard)
  document.getElementById("join-btn-teacher")?.addEventListener("click", () => {
    if (!state.accountUser?.name) { alert("Account name not found"); return; }
    state.myName = state.accountUser.name;
    const code = document.getElementById("join-code-input-teacher").value.trim().toLowerCase();
    if (!code) { alert("Enter a session code"); return; }
    send({ type: "join_session", sessionId: code, name: state.myName, age: getAge(), authToken: state.authToken });
  });

  // ---- Student Dashboard Buttons ----

  // Join existing session (student dashboard)
  document.getElementById("join-btn-student")?.addEventListener("click", () => {
    if (!state.accountUser?.name) { alert("Account name not found"); return; }
    state.myName = state.accountUser.name;
    const code = document.getElementById("join-code-input-student").value.trim().toLowerCase();
    if (!code) { alert("Enter a session code"); return; }
    send({ type: "join_session", sessionId: code, name: state.myName, age: getAge(), authToken: state.authToken });
  });

  // ---- Parent Dashboard Buttons ----
  // (Parent linking is managed by teachers/admins — no client-side link button)

  // Enter video room (warmup mode)
  document.getElementById("enter-video-btn").addEventListener("click", () => {
    send({ type: "enter_video" });
  });

  // Start discussion (from within the video room)
  document.getElementById("start-discussion-btn").addEventListener("click", () => {
    send({ type: "start_discussion" });
  });

  // End discussion
  document.getElementById("video-end-btn").addEventListener("click", () => {
    if (confirm("End the discussion for everyone?")) {
      send({ type: "end_discussion" });
    }
  });

  // Chat text input (fallback when STT isn't available)
  document.getElementById("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    clearLocalSpeechDraft();
    addTranscriptEntry(state.myName, text, true, false);
    send({ type: "message", text, source: "text" });
    input.value = "";
  });
}

// ---- File Handling ----

function handleFiles(files) {
  for (const file of files) {
    if (state.materials.length >= MAX_MATERIALS) break;
    state.materials.push({ type: "file", name: file.name, file: file });
  }
  renderMaterials();
}

// ---- Collapsible Sections ----

export function initCollapsibleSections() {
  const toggleBtn = document.getElementById('session-history-toggle');
  const card = document.getElementById('recent-sessions-card');

  if (!toggleBtn || !card) return;

  // Load collapsed state from localStorage
  const isCollapsed = localStorage.getItem('sessionHistoryCollapsed') === 'true';
  if (isCollapsed) {
    card.classList.add('collapsed');
  }

  // Handle toggle click - horizontal arrow when collapsed, vertical when expanded
  toggleBtn.addEventListener('click', () => {
    const currentlyCollapsed = card.classList.contains('collapsed');
    card.classList.toggle('collapsed');

    // Save state to localStorage
    localStorage.setItem('sessionHistoryCollapsed', !currentlyCollapsed);
  });
}
