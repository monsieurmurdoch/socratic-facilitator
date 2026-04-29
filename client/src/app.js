/**
 * Socratic Facilitator — Client (Video Mode)
 *
 * Flow: Upload materials → Create room → Share link/code → Join Jitsi → Plato facilitates
 */

(function () {
  // ---- State ----
  let ws = null;
  let myName = "";
  let myId = "";
  let currentSessionId = null;
  let participants = [];
  let isHost = false;
  let jitsiApi = null;
  let materials = [];
  let sessionAccessTokens = loadSessionAccessTokens();
  let materialsClassId = null;
  let authToken = null;
  let accountUser = null;
  let savedClasses = [];
  let sessionHistory = [];
  let classTimeline = [];
  let parentDashboard = null;
  let parentChildrenSessions = [];
  let selectedClassSummary = null;
  let selectedClassLiveSession = null;
  let pendingRoomJoin = null;
  let sessionHistoryQuery = "";
  let sessionSearchTimer = null;
  let selectedClassId = null;
  let editingClassId = null;
  let expandedClassId = null;
  let demoTeacherConfig = null; // null until server responds
  const MAX_MATERIALS = 5;
  let sttBatchBuffer = '';
  let sttBatchTimer = null;
  let lastInterimTranscript = '';
  let discussionActive = false;
  let currentScreen = "welcome";
  let teacherSpeechPatienceMode = "balanced";
  let slowSpeakerMode = false;
  let wsReconnectDelay = 1000; // exponential backoff starting at 1s
  const WS_RECONNECT_MAX = 30000; // cap at 30s
  let jitsiMicMuted = false;
  let platoMicMuted = false;
  let jitsiMuteTimer = null;
  let jitsiMutePoller = null;
  let jitsiLaunchingRoom = null;
  let activeJitsiRoom = null;

  const SPEECH_PATIENCE_PRESETS = {
    quick: { warmup: 260, discussion: 220, vadFlush: 110 },
    balanced: { warmup: 450, discussion: 350, vadFlush: 180 },
    patient: { warmup: 900, discussion: 720, vadFlush: 320 }
  };

  // ---- State Persistence ----
  const STORAGE_KEY = "socratic_state";
  const AUTH_TOKEN_KEY = "socratic_auth_token";
  const AUTH_USER_KEY = "socratic_auth_user";
  const SESSION_ACCESS_TOKEN_KEY = "socratic_session_access_tokens";

  function loadSessionAccessTokens() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_ACCESS_TOKEN_KEY) || "{}");
    } catch (_error) {
      return {};
    }
  }

  function saveSessionAccessTokens() {
    try {
      localStorage.setItem(SESSION_ACCESS_TOKEN_KEY, JSON.stringify(sessionAccessTokens));
    } catch (_error) { /* storage unavailable */ }
  }

  function setSessionAccessToken(sessionId, token) {
    if (!sessionId || !token) return;
    sessionAccessTokens[sessionId] = token;
    saveSessionAccessTokens();
  }

  function getSessionAccessToken(sessionId = currentSessionId) {
    return sessionId ? sessionAccessTokens[sessionId] || null : null;
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        myName,
        myId,
        currentSessionId,
        isHost,
        participants,
        currentScreen,
        savedAt: Date.now()
      }));
    } catch (e) { /* storage full or unavailable */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      // Expire after 4 hours
      if (Date.now() - state.savedAt > 4 * 60 * 60 * 1000) {
        clearState();
        return null;
      }
      return state;
    } catch (e) { return null; }
  }

  function clearState() {
    localStorage.removeItem(STORAGE_KEY);
    currentSessionId = null;
    myId = "";
    participants = [];
    isHost = false;
    discussionActive = false;
    currentScreen = "welcome";
    teacherSpeechPatienceMode = "balanced";
    sttBatchBuffer = "";
    lastInterimTranscript = "";
    clearTimeout(sttBatchTimer);
    sttBatchTimer = null;
    resetJitsiMuteState();
    clearLocalSpeechDraft();
  }

  function resetConversationFeed() {
    const container = document.getElementById("conversation-feed");
    if (container) container.innerHTML = "";
    sttBatchBuffer = "";
    lastInterimTranscript = "";
    clearTimeout(sttBatchTimer);
    sttBatchTimer = null;
  }

  function clearSessionUrlState() {
    const url = new URL(window.location.href);
    url.searchParams.delete("join");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function abandonDraftSession() {
    clearState();
    resetConversationFeed();
    clearSessionUrlState();
  }

  function loadAuthState() {
    try {
      authToken = localStorage.getItem(AUTH_TOKEN_KEY);
      const rawUser = localStorage.getItem(AUTH_USER_KEY);
      accountUser = rawUser ? JSON.parse(rawUser) : null;
    } catch (e) {
      authToken = null;
      accountUser = null;
    }
  }

  function saveAuthState(user, token) {
    authToken = token;
    accountUser = user;
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
  }

  function clearAuthState() {
    authToken = null;
    accountUser = null;
    savedClasses = [];
    sessionHistory = [];
    classTimeline = [];
    parentDashboard = null;
    parentChildrenSessions = [];
    selectedClassSummary = null;
    selectedClassLiveSession = null;
    sessionHistoryQuery = "";
    selectedClassId = null;
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  }

  // ---- DOM Elements ----
  const screens = {
    welcome: document.getElementById("welcome-screen"),
    roomWait: document.getElementById("room-wait-screen"),
    setup: document.getElementById("setup-screen"),
    lobby: document.getElementById("lobby-screen"),
    video: document.getElementById("video-screen")
  };

  function showScreen(name) {
    currentScreen = name;
    Object.values(screens).forEach(s => s && s.classList.remove("active"));
    if (screens[name]) screens[name].classList.add("active");
    document.body.classList.toggle("video-active", name === "video");
  }

  // Navigate to a screen and push browser history so the back button works
  function navigateTo(name, pushHistory = true) {
    const prev = currentScreen;
    showScreen(name);
    if (pushHistory && prev !== name) {
      window.history.pushState({ screen: name }, '');
    }
  }

  function leaveCurrentSession(nextScreen = "welcome") {
    destroySttStream();
    destroyJitsi();
    clearState();
    clearSessionUrlState();
    pendingRoomJoin = null;
    showScreen(nextScreen);
    refreshWorkspace();
    if (ws && ws.readyState === 1) {
      try { ws.close(1000, "user_left_session"); } catch (error) {}
    }
  }

  // Handle browser back/forward buttons
  window.addEventListener('popstate', (e) => {
    const targetScreen = e.state?.screen || 'welcome';

    if (currentScreen === "video" && targetScreen === "lobby") {
      destroySttStream();
      destroyJitsi();
      discussionActive = false;
      showScreen("lobby");
      saveState();
      return;
    }

    if (["lobby", "video"].includes(currentScreen) && ["welcome", "setup", "roomWait"].includes(targetScreen)) {
      leaveCurrentSession(targetScreen);
      return;
    }

    showScreen(targetScreen);
  });

  // Set initial history state so back button from first navigation works
  window.history.replaceState({ screen: 'welcome' }, '');

  function shouldAutoRestore(saved) {
    return !!(saved && saved.currentSessionId && saved.myId && ["lobby", "video"].includes(saved.currentScreen));
  }

  function getAuthHeaders(extra = {}) {
    const headers = { ...extra };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    const sessionAccessToken = getSessionAccessToken();
    if (sessionAccessToken) {
      headers["X-Session-Access"] = sessionAccessToken;
    }
    return headers;
  }

  function getDisplayNameFromAccount() {
    if (!accountUser?.name) return "";
    return accountUser.name;
  }

  function canManageClasses() {
    return ["Teacher", "Admin", "SuperAdmin"].includes(accountUser?.role);
  }

  // ---- Check URL for direct join ----
  function checkDirectJoin() {
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

  // ---- WebSocket ----
  let wsConnectedToServer = false;

  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${location.host}`;
    console.log("[WS] Connecting to:", url);
    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsConnectedToServer = false;

    ws.onopen = () => {
      console.log("[WS] Socket open (handshake complete)");
      wsReconnectDelay = 1000; // reset backoff on successful connect

      // Try to restore saved session
      const saved = loadState();
      if (shouldAutoRestore(saved)) {
        console.log("[WS] Restoring session:", saved.currentSessionId, "as", saved.myName);
        myName = saved.myName;
        myId = saved.myId;
        currentSessionId = saved.currentSessionId;
        isHost = saved.isHost;
        send({
          type: "rejoin_session",
          sessionId: saved.currentSessionId,
          oldClientId: saved.myId,
          authToken,
          sessionAccessToken: getSessionAccessToken(saved.currentSessionId)
        });
        return;
      }

      // If we have a pending join from URL, auto-join once connected
      const params = new URLSearchParams(window.location.search);
      const joinCode = params.get("join");
      if (joinCode && myName) {
        send({ type: "join_session", sessionId: joinCode, name: myName, age: getAge(), authToken, sessionAccessToken: getSessionAccessToken(joinCode) });
      }
    };
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // TTS disabled for beta
        // playAudioBuffer(event.data);
        return;
      }
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    };
    ws.onclose = (event) => {
      console.log("[WS] Disconnected. Code:", event.code, "Reason:", event.reason, "— reconnecting in", wsReconnectDelay + "ms...");
      setTimeout(connect, wsReconnectDelay);
      wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX);
    };
    ws.onerror = (event) => {
      console.error("[WS] Error:", event);
    };
  }

  function send(msg) {
    console.log("[WS] Sending:", msg.type, "| readyState:", ws?.readyState);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn("[WS] Not connected (state:", ws?.readyState, ") — queuing retry for:", msg.type);
      // Retry once after reconnect
      const retryInterval = setInterval(() => {
        if (ws && ws.readyState === 1) {
          console.log("[WS] Retrying:", msg.type);
          ws.send(JSON.stringify(msg));
          clearInterval(retryInterval);
        }
      }, 500);
      // Give up after 10s
      setTimeout(() => clearInterval(retryInterval), 10000);
    }
  }

  // ---- API Helpers ----
  async function apiPost(endpoint, data) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `Server error ${res.status}`);
    }
    return json;
  }

  async function apiGet(endpoint) {
    const res = await fetch(endpoint, {
      headers: getAuthHeaders()
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `Server error ${res.status}`);
    }
    return json;
  }

  async function apiPatch(endpoint, data) {
    const res = await fetch(endpoint, {
      method: "PATCH",
      headers: getAuthHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `Server error ${res.status}`);
    }
    return json;
  }

  function renderAuthState() {
    const unsignedHeader = document.getElementById("unsigned-header");
    const signedInHeader = document.getElementById("signed-in-header");
    const authCard = document.getElementById("auth-card");
    const guestPanel = document.getElementById("guest-panel");
    const dashboardTeacher = document.getElementById("dashboard-teacher");
    const dashboardStudent = document.getElementById("dashboard-student");
    const dashboardParent = document.getElementById("dashboard-parent");
    const accountNameEl = document.getElementById("account-name");
    const accountRoleBadge = document.getElementById("account-role-badge");
    const avatarInitial = document.getElementById("user-avatar-initial");
    const classHelp = document.getElementById("session-class-help");
    const demoLoginSection = document.getElementById("demo-login-section");
    const demoLoginCopy = document.getElementById("demo-login-copy");

    // Demo teacher button visibility
    if (demoLoginSection) {
      const demoDisabled = demoTeacherConfig && !demoTeacherConfig.enabled;
      demoLoginSection.style.display = !accountUser && !demoDisabled ? "block" : "none";
    }
    if (demoLoginCopy && demoTeacherConfig && demoTeacherConfig.enabled) {
      demoLoginCopy.textContent = `Use ${demoTeacherConfig.name} (${demoTeacherConfig.email}) for quick teacher access.`;
    }

    if (accountUser) {
      // Signed in — show header bar, hide guest panel, show role dashboard
      if (unsignedHeader) unsignedHeader.style.display = "none";
      if (signedInHeader) signedInHeader.style.display = "";
      if (authCard) authCard.style.display = "none";
      if (guestPanel) guestPanel.style.display = "none";

      // Set user info in header
      if (accountNameEl) accountNameEl.textContent = accountUser.name;
      if (accountRoleBadge) accountRoleBadge.textContent = accountUser.role || "";
      if (avatarInitial) avatarInitial.textContent = (accountUser.name || "?")[0].toUpperCase();

      // Show role-appropriate dashboard
      const role = accountUser.role || "Teacher";
      if (dashboardTeacher) dashboardTeacher.style.display = role === "Teacher" || role === "Admin" || role === "SuperAdmin" ? "" : "none";
      if (dashboardStudent) dashboardStudent.style.display = role === "Student" ? "" : "none";
      if (dashboardParent) dashboardParent.style.display = role === "Parent" ? "" : "none";

      // Pre-fill name for session
      const nameInput = document.getElementById("name-input-teacher");
      if (nameInput && !nameInput.value.trim()) {
        nameInput.value = getDisplayNameFromAccount();
      }

      if (classHelp) {
        classHelp.textContent = canManageClasses()
          ? "Choose a class room to reuse one stable code and build a clear memory across sessions."
          : "Your account can join sessions and keep history, but class room management is limited.";
      }
    } else {
      // Not signed in — show unsigned header + guest panel
      if (unsignedHeader) unsignedHeader.style.display = "";
      if (signedInHeader) signedInHeader.style.display = "none";
      if (guestPanel) guestPanel.style.display = "";

      // Hide all dashboards
      if (dashboardTeacher) dashboardTeacher.style.display = "none";
      if (dashboardStudent) dashboardStudent.style.display = "none";
      if (dashboardParent) dashboardParent.style.display = "none";

      // Auth card always visible when signed out (side-by-side with guest panel)
      if (authCard) authCard.style.display = "";
      if (classHelp) {
        classHelp.textContent = "Sign in to create class rooms, reuse one stable code, and search across session memory.";
      }
    }
  }

  function formatDateTime(value) {
    if (!value) return "Not started";
    return new Date(value).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function normalizeJoinCode(raw) {
    const cleaned = String(raw || "")
      .replace(/\s+/g, "")
      .replace(/[^a-zA-Z0-9-]/g, "");
    if (!cleaned) return "";

    const compact = cleaned.replace(/-/g, "");
    if (/^rm/i.test(compact)) {
      const suffix = compact.slice(2).toUpperCase().slice(0, 6);
      return suffix ? `RM-${suffix}` : "RM-";
    }

    return compact.toLowerCase().slice(0, 10);
  }

  function applyJoinCodeFormatting(input) {
    if (!input) return;
    input.value = normalizeJoinCode(input.value);
  }

  function normalizeSpeechPatienceMode(mode) {
    const value = String(mode || "").trim().toLowerCase();
    if (value === "quick" || value === "patient" || value === "balanced") {
      return value;
    }
    return "balanced";
  }

  function getSpeechPatienceProfile() {
    const base = SPEECH_PATIENCE_PRESETS[normalizeSpeechPatienceMode(teacherSpeechPatienceMode)] || SPEECH_PATIENCE_PRESETS.balanced;
    if (!slowSpeakerMode) return base;
    return {
      warmup: Math.round(base.warmup * 1.8),
      discussion: Math.round(base.discussion * 1.8),
      vadFlush: Math.round(base.vadFlush * 1.7)
    };
  }

  function applyTeacherParams(params = {}) {
    if (params.speechPatienceMode) {
      teacherSpeechPatienceMode = normalizeSpeechPatienceMode(params.speechPatienceMode);
    } else {
      teacherSpeechPatienceMode = "balanced";
    }
  }

  function openSetupForClass(classId = null, options = {}) {
    const { suggestedTitle = "" } = options;
    abandonDraftSession();
    resetSetupDraft();
    navigateTo("setup");

    const select = document.getElementById("session-class-select");
    const titleInput = document.getElementById("session-title");

    if (titleInput && suggestedTitle && !titleInput.value.trim()) {
      titleInput.value = suggestedTitle;
    }

    if (classId) {
      selectedClassId = classId;
      loadClassMaterials(classId);
    } else {
      materials = materials.filter(m => !m.fromClass);
      renderMaterials();
    }
    renderClasses();
    if (select) {
      select.value = classId || "";
    }
    renderSetupContext();
  }

  function resetSetupDraft() {
    const titleInput = document.getElementById("session-title");
    const questionInput = document.getElementById("opening-question");
    const pasteTextInput = document.getElementById("paste-text-input");
    const preview = document.getElementById("primed-preview");
    const themes = document.getElementById("primed-themes");
    if (titleInput) titleInput.value = "";
    if (questionInput) questionInput.value = "";
    if (pasteTextInput) pasteTextInput.value = "";
    if (preview) preview.style.display = "none";
    if (themes) themes.innerHTML = "";
    materials = [];
    materialsClassId = null;
    renderMaterials();
  }

  function getSelectedClass() {
    return savedClasses.find(cls => cls.id === selectedClassId) || null;
  }

  function escapeAttribute(value) {
    return escapeHtml(String(value || "")).replace(/"/g, "&quot;");
  }

  function renderClasses() {
    const grid = document.getElementById("class-grid");
    const select = document.getElementById("session-class-select");
    const previousValue = select.value;

    // Always populate the setup-screen dropdown
    select.innerHTML = '<option value="">Not linked to a class</option>';
    savedClasses.forEach(cls => {
      const option = document.createElement("option");
      option.value = cls.id;
      option.textContent = cls.name;
      select.appendChild(option);
    });

    // Preserve previous selection or use selectedClassId
    if (selectedClassId && savedClasses.some(cls => cls.id === selectedClassId)) {
      select.value = selectedClassId;
    } else if (savedClasses.some(cls => cls.id === previousValue)) {
      select.value = previousValue;
    }

    if (!accountUser) {
      grid.innerHTML = '<p class="empty-state">Sign in to create and reuse classes.</p>';
      return;
    }

    if (savedClasses.length === 0) {
      grid.innerHTML = '<p class="empty-state">No classes yet. Create your first class to get started.</p>';
      return;
    }

    if (!selectedClassId) {
      selectedClassId = savedClasses[0].id;
    }

    // Render class card grid
    grid.innerHTML = savedClasses.map(cls => {
      const isExpanded = cls.id === expandedClassId;
      const isEditing = cls.id === editingClassId;
      const liveTag = selectedClassLiveSession && selectedClassId === cls.id
        ? '<span class="class-card-live">LIVE</span>'
        : '';
      return `
        <div class="class-card${isExpanded ? ' class-card-expanded' : ''}" data-class-id="${escapeHtml(cls.id)}" draggable="${isExpanded ? 'false' : 'true'}">
          <div class="class-card-header">
            <div class="class-card-info">
              <strong class="class-card-name">${escapeHtml(cls.name)}</strong>
              <div class="class-card-meta">${cls.sessionCount} session${cls.sessionCount === 1 ? '' : 's'}${cls.ageRange ? ` &middot; Ages ${escapeHtml(cls.ageRange)}` : ''}</div>
            </div>
            ${liveTag}
          </div>
          <div class="class-card-code">
            <span class="code-badge code-badge-room">${escapeHtml(cls.roomCode || "pending")}</span>
          </div>
        </div>`;
    }).join("");

    // Bind card click → expand
    grid.querySelectorAll('.class-card').forEach(card => {
      const classId = card.dataset.classId;

      card.addEventListener('click', () => {
        if (expandedClassId === classId) {
          // Collapse
          expandedClassId = null;
          selectedClassId = classId;
        } else {
          // Expand this card
          expandedClassId = classId;
          selectedClassId = classId;
          materials = [];
          materialsClassId = classId;
          renderMaterials();
          loadClassMaterials(classId).catch(err => {
            console.warn('[Materials] Could not pre-load class materials:', err.message);
          });
        }
        renderClasses();
        renderExpandedClass();
        loadSelectedClassTimeline();
      });

      // Drag and drop (only on collapsed cards)
      card.addEventListener('dragstart', (e) => {
        card.classList.add('class-card-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', classId);
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('class-card-dragging');
        grid.querySelectorAll('.class-card').forEach(el => el.classList.remove('class-card-drop-above', 'class-card-drop-below'));
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = card.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        grid.querySelectorAll('.class-card').forEach(el => el.classList.remove('class-card-drop-above', 'class-card-drop-below'));
        card.classList.add(e.clientY < midY ? 'class-card-drop-above' : 'class-card-drop-below');
      });
      card.addEventListener('dragleave', () => {
        card.classList.remove('class-card-drop-above', 'class-card-drop-below');
      });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const draggedId = e.dataTransfer.getData('text/plain');
        if (draggedId === classId) return;
        const ids = savedClasses.map(c => c.id);
        const fromIdx = ids.indexOf(draggedId);
        if (fromIdx === -1) return;
        ids.splice(fromIdx, 1);
        const rect = card.getBoundingClientRect();
        const toIdx = ids.indexOf(classId);
        const insertIdx = e.clientY < rect.top + rect.height / 2 ? toIdx : toIdx + 1;
        ids.splice(insertIdx, 0, draggedId);
        const draggedCls = savedClasses.find(c => c.id === draggedId);
        savedClasses.splice(savedClasses.indexOf(draggedCls), 1);
        savedClasses.splice(insertIdx, 0, draggedCls);
        renderClasses();
        apiPatch('/api/classes/reorder', { order: ids }).catch(err => {
          console.warn('[Classes] Reorder failed:', err.message);
          refreshWorkspace();
        });
      });
    });

    renderExpandedClass();
    renderSetupContext();
  }

  function renderExpandedClass() {
    const section = document.getElementById("class-expanded-section");
    const card = document.getElementById("class-expanded-card");
    if (!section || !card) return;

    if (!expandedClassId) {
      section.style.display = "none";
      return;
    }

    const cls = savedClasses.find(c => c.id === expandedClassId);
    if (!cls) {
      section.style.display = "none";
      expandedClassId = null;
      return;
    }

    const liveSession = (selectedClassId === expandedClassId) ? selectedClassLiveSession : null;
    const isEditing = editingClassId === expandedClassId;
    section.style.display = "";

    if (isEditing) {
      card.innerHTML = `
        <div class="class-expanded-edit">
          <h3>Edit Class</h3>
          <div class="form-group">
            <label>Class Name</label>
            <input type="text" class="class-edit-name" value="${escapeHtml(cls.name)}" placeholder="Class name">
          </div>
          <div class="form-group">
            <label>Age Range</label>
            <input type="text" class="class-edit-age" value="${escapeHtml(cls.ageRange || '')}" placeholder="e.g. 14-15">
          </div>
          <div class="form-group">
            <label>Notes</label>
            <textarea class="class-edit-desc" placeholder="Optional notes">${escapeHtml(cls.description || '')}</textarea>
          </div>
          <div class="class-edit-actions">
            <button class="btn btn-primary btn-small class-save-btn">Save</button>
            <button class="btn btn-secondary btn-small class-cancel-btn">Cancel</button>
          </div>
        </div>`;
      card.querySelector('.class-save-btn').addEventListener('click', async () => {
        const name = card.querySelector('.class-edit-name').value.trim();
        const ageRange = card.querySelector('.class-edit-age').value.trim() || null;
        const description = card.querySelector('.class-edit-desc').value.trim() || null;
        if (!name) { alert("Class name cannot be empty"); return; }
        const btn = card.querySelector('.class-save-btn');
        btn.disabled = true;
        btn.textContent = "Saving...";
        try {
          const updated = await apiPatch(`/api/classes/${cls.id}`, { name, ageRange, description });
          const idx = savedClasses.findIndex(c => c.id === cls.id);
          if (idx !== -1) savedClasses[idx] = { ...savedClasses[idx], ...updated };
          editingClassId = null;
          renderClasses();
        } catch (err) {
          alert("Failed to save: " + err.message);
          btn.disabled = false;
          btn.textContent = "Save";
        }
      });
      card.querySelector('.class-cancel-btn').addEventListener('click', () => {
        editingClassId = null;
        renderClasses();
      });
      return;
    }

    card.innerHTML = `
      <div class="class-expanded-layout">
        <div class="class-expanded-left">
          <div class="class-expanded-title-row">
            <h3>${escapeHtml(cls.name)}</h3>
            <button class="class-expanded-edit-btn" title="Edit class">&#9998;</button>
            <button class="class-expanded-close-btn" title="Collapse">&times;</button>
          </div>
          <p class="class-expanded-desc">${escapeHtml(cls.description || "A persistent room for this class.")}</p>
          <div class="class-expanded-code-row">
            <span class="room-code-label">Room code</span>
            <strong class="room-code-value">${escapeHtml(cls.roomCode || "pending")}</strong>
            <button id="expanded-copy-code-btn" class="btn btn-secondary btn-small">Copy</button>
          </div>
          <div class="class-expanded-stats">
            <div class="room-stat">
              <span class="room-stat-label">Sessions</span>
              <strong>${cls.sessionCount || 0}</strong>
            </div>
            <div class="room-stat">
              <span class="room-stat-label">Age Range</span>
              <strong>${escapeHtml(cls.ageRange || "Flexible")}</strong>
            </div>
            <div class="room-stat">
              <span class="room-stat-label">Live Status</span>
              <strong>${liveSession ? `${liveSession.status} now` : "No session open"}</strong>
            </div>
          </div>
        </div>
        <div class="class-expanded-right">
          ${liveSession ? `
            <div class="class-live-panel">
              <span class="class-live-dot"></span>
              <strong>Session is live</strong>
              <p>${escapeHtml(liveSession.title)}</p>
              <button id="expanded-join-live-btn" class="btn btn-primary">Join Live Session</button>
            </div>
          ` : `
            <div class="class-start-panel">
              <h4>Start Today's Discussion</h4>
              <p class="class-start-help">Add readings right here, confirm what’s attached, and then go live when the room is ready.</p>
              <div class="form-group">
                <input type="text" id="expanded-title-input" placeholder="Discussion title" value="${escapeHtml(cls.name)} Discussion">
              </div>
              <div class="form-group">
                <textarea id="expanded-question-input" placeholder="Opening question (optional)" rows="2"></textarea>
              </div>
              <div class="class-materials-panel">
                <div class="class-materials-heading">
                  <h5>Source Text</h5>
                  <span id="expanded-material-count" class="material-count">(${materials.length}/${MAX_MATERIALS})</span>
                </div>
                <div id="expanded-upload-area" class="upload-area upload-area-compact">
                  <div class="upload-icon">+</div>
                  <p>Upload file</p>
                  <p class="upload-hint">PDF, TXT, DOCX</p>
                </div>
                <input type="file" id="expanded-file-input" accept=".pdf,.txt,.docx,.doc" multiple hidden>
                <div class="url-input-row url-input-row-compact">
                  <input type="text" id="expanded-url-input" placeholder="Paste a link to a poem, article, or excerpt">
                  <button id="expanded-add-url-btn" class="btn btn-small btn-secondary">Add Link</button>
                </div>
                <div class="paste-text-panel paste-text-panel-compact">
                  <label for="expanded-paste-text-input">Paste Source Text</label>
                  <textarea id="expanded-paste-text-input" placeholder="Paste a poem, excerpt, or passage here."></textarea>
                  <div class="paste-text-actions">
                    <span class="helper-text">These materials will be attached to the next live session for this class.</span>
                    <button id="expanded-add-text-btn" class="btn btn-small btn-secondary">Add Text</button>
                  </div>
                </div>
                <div id="expanded-materials-list" class="materials-list materials-list-compact"></div>
              </div>
              <div class="class-start-actions">
                <button id="expanded-start-btn" class="btn btn-primary">Go Live</button>
                <button id="expanded-clear-materials-btn" class="btn btn-secondary">Clear Source Text</button>
              </div>
            </div>
          `}
        </div>
      </div>
      <p class="room-code-note">Room codes stay the same for the class. Live session codes change each time you start a new session.</p>`;

    // Wire up buttons
    card.querySelector('.class-expanded-edit-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      editingClassId = expandedClassId;
      renderClasses();
    });
    card.querySelector('.class-expanded-close-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      expandedClassId = null;
      renderClasses();
    });
    document.getElementById("expanded-copy-code-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(cls.roomCode || "").then(() => {
        const btn = document.getElementById("expanded-copy-code-btn");
        if (!btn) return;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = "Copy"; }, 1200);
      });
    });
    document.getElementById("expanded-start-btn")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      myName = accountUser?.name || "";
      if (!myName) { alert("Sign in first."); return; }

      const titleInput = document.getElementById("expanded-title-input");
      const questionInput = document.getElementById("expanded-question-input");
      const title = (titleInput?.value || "").trim() || `${cls.name} Discussion`;
      const question = (questionInput?.value || "").trim() || null;
      const btn = document.getElementById("expanded-start-btn");
      if (btn) { btn.disabled = true; btn.textContent = "Creating..."; }

      try {
        const session = await apiPost("/api/sessions", {
          title,
          openingQuestion: question,
          conversationGoal: null,
          classId: cls.id
        });
        if (!session.shortCode) {
          throw new Error("Server returned session without shortCode");
        }
        setSessionAccessToken(session.shortCode, session.sessionAccessToken);
        currentSessionId = session.shortCode;
        isHost = true;
        materialsClassId = cls.id;
        refreshWorkspace();
        send({
          type: "join_session",
          sessionId: session.shortCode,
          name: myName,
          age: getAge(),
          authToken,
          sessionAccessToken: getSessionAccessToken(session.shortCode)
        });
      } catch (error) {
        console.error("[Session] Creation error:", error);
        alert("Failed to create session: " + error.message);
        if (btn) { btn.disabled = false; btn.textContent = "Go Live"; }
      }
    });
    document.getElementById("expanded-join-live-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!liveSession?.shortCode) return;
      myName = accountUser?.name || "";
      send({ type: "join_session", sessionId: liveSession.shortCode, name: myName, age: getAge(), authToken, sessionAccessToken: getSessionAccessToken(liveSession.shortCode) });
    });
    document.getElementById("expanded-clear-materials-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      materials = [];
      materialsClassId = cls.id;
      renderMaterials();
    });
    bindExpandedMaterialsControls(cls.id);
  }

  function renderSessionHistory() {
    const list = document.getElementById("session-history-list");
    const context = document.getElementById("session-history-context");

    if (!accountUser) {
      list.innerHTML = '<p class="empty-state">Sign in to see session history.</p>';
      if (context) context.textContent = "Select a class to see its classroom memory.";
      return;
    }

    const selectedClass = getSelectedClass();
    const source = selectedClass ? classTimeline : sessionHistory;
    if (context) {
      context.textContent = selectedClass
        ? `Session trail for ${selectedClass.name}${sessionHistoryQuery ? ` · search: “${sessionHistoryQuery}”` : ""}`
        : "Showing recent sessions across your classes.";
    }

    if (source.length === 0) {
      list.innerHTML = selectedClass
        ? '<p class="empty-state">No sessions yet in this class room. Start one and the trail will appear here.</p>'
        : '<p class="empty-state">No saved sessions yet. Your newly created sessions will show up here.</p>';
      return;
    }

    function buildSessionSummary(session) {
      const participantCount = Number(session.participantCount || 0);
      const messageCount = Number(session.messageCount || 0);
      const speakingSeconds = Math.round(Number(session.viewerSpeakingSeconds || 0));
      const contribution = Number(session.viewerContributionScore || 0);

      const sizeLabel = participantCount <= 2
        ? "a focused exchange"
        : participantCount <= 5
          ? "a small-group discussion"
          : "a full-room conversation";
      const paceLabel = messageCount >= 40
        ? "with a fast conversational pace"
        : messageCount >= 18
          ? "with steady participation"
          : "with a quieter rhythm";
      const contributionLabel = contribution >= 0.75
        ? "You were one of the stronger voices."
        : contribution >= 0.4
          ? "You were meaningfully present throughout."
          : "There is room to draw more of your voice in next time.";

      return `${sizeLabel} ${paceLabel}. ${speakingSeconds ? `You spoke for about ${speakingSeconds}s.` : "Your speaking time was limited."} ${contributionLabel}`;
    }

    list.innerHTML = source.map((session, index) => `
      <div class="workspace-item session-item timeline-card" data-shortcode="${escapeHtml(session.shortCode)}">
        <div class="timeline-marker">
          <span class="timeline-dot"></span>
          <span class="timeline-stem${index === source.length - 1 ? ' timeline-stem-end' : ''}"></span>
        </div>
        <div class="timeline-body">
          <div class="timeline-header timeline-toggle-row" data-shortcode="${escapeHtml(session.shortCode)}">
            <div>
              <strong>${selectedClass ? `Session ${String(session.ordinal || source.length - index).padStart(2, '0')}` : escapeHtml(session.title)}</strong>
              <div class="workspace-item-meta timeline-subtitle">
                ${selectedClass ? escapeHtml(session.title) : escapeHtml(session.className || "Quick Session")} · ${formatDateTime(session.createdAt)}
              </div>
            </div>
            <span class="workspace-item-tag timeline-status-tag">${escapeHtml(session.status)}</span>
            <span class="timeline-expand-icon">▼</span>
          </div>
          <div class="timeline-details" style="display:none;">
            <div class="workspace-item-meta timeline-stats">
              ${session.participantCount} participants · ${session.messageCount} messages · You spoke about ${Math.round(Number(session.viewerSpeakingSeconds || 0))}s · contribution ${Number(session.viewerContributionScore || 0).toFixed(2)}
            </div>
            <p class="timeline-summary">${escapeHtml(buildSessionSummary(session))}</p>
            ${(session.matchedParticipant || session.searchExcerpt) ? `
              <div class="timeline-search-hit">
                ${session.matchedParticipant ? `<span class="search-hit-pill">Matched student: ${escapeHtml(session.matchedParticipant)}</span>` : ""}
                ${session.searchExcerpt ? `<p>"${escapeHtml(session.searchExcerpt)}${session.searchExcerpt.length >= 220 ? "…" : ""}"</p>` : ""}
              </div>
            ` : ""}
            <div class="timeline-actions">
              <button class="btn btn-secondary btn-small timeline-open-btn" data-shortcode="${escapeAttribute(session.shortCode)}">Open Analytics</button>
              <span class="workspace-item-tag code-badge code-badge-session">${escapeHtml(session.shortCode)}</span>
            </div>
          </div>
        </div>
      </div>
    `).join("");

    // Toggle expand/collapse on header click
    list.querySelectorAll('.timeline-toggle-row').forEach(header => {
      header.addEventListener('click', () => {
        const details = header.nextElementSibling;
        const icon = header.querySelector('.timeline-expand-icon');
        if (details) {
          const isHidden = details.style.display === 'none';
          details.style.display = isHidden ? '' : 'none';
          if (icon) icon.textContent = isHidden ? '▲' : '▼';
        }
      });
      header.style.cursor = 'pointer';
    });

    document.querySelectorAll('.timeline-open-btn').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        showSessionAnalytics(btn.dataset.shortcode);
      });
    });
  }

  function renderClassRoomSummary() {
    // Now rendered inside the expanded class card — just delegate
    renderExpandedClass();
  }

  async function loadSelectedClassTimeline(query = sessionHistoryQuery) {
    if (!authToken || !selectedClassId) {
      classTimeline = [];
      selectedClassSummary = getSelectedClass();
      selectedClassLiveSession = null;
      renderClassRoomSummary();
      renderSessionHistory();
      return;
    }

    const q = String(query || '').trim();
    try {
      const data = await apiGet(`/api/classes/${selectedClassId}/timeline${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      selectedClassSummary = { ...(getSelectedClass() || {}), ...(data.class || {}) };
      selectedClassLiveSession = data.latestLiveSession;
      classTimeline = data.timeline || [];
    } catch (error) {
      console.warn("[Timeline] Failed to load selected class timeline:", error.message);
      classTimeline = [];
      selectedClassSummary = getSelectedClass();
      selectedClassLiveSession = null;
    }
    renderClassRoomSummary();
    renderSessionHistory();
  }

  async function refreshParentDashboard() {
    try {
      parentDashboard = await apiGet("/api/parents/dashboard");
      const sessions = [];
      for (const child of parentDashboard.children || []) {
        try {
          const childSessions = await apiGet(`/api/parents/children/${child.id}/sessions`);
          childSessions.forEach(session => {
            sessions.push({
              ...session,
              childName: child.name,
              childId: child.id
            });
          });
        } catch (error) {
          console.warn("[Parent] Failed to load child sessions:", error.message);
        }
      }
      parentChildrenSessions = sessions.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    } catch (error) {
      console.warn("[Parent] Failed to load parent dashboard:", error.message);
      parentDashboard = { children: [], billing: null, bookings: [] };
      parentChildrenSessions = [];
    }
    renderParentDashboard();
  }

  function formatChildEmail(email) {
    const value = String(email || "");
    return value.endsWith("@socratic.local") ? "Managed profile" : value;
  }

  function describeProgress(child) {
    const sessions = Number(child.sessionCount || 0);
    const avg = Number(child.avgContribution || 0);
    if (!sessions) return "No discussion history yet. Once they join a session, parent-safe progress will appear here.";
    if (avg >= 0.7) return "Often contributing load-bearing comments. Keep inviting evidence and callbacks to classmates.";
    if (avg >= 0.35) return "Participating steadily. A good next goal is more explicit textual grounding.";
    return "Present but still finding a voice. Smaller prompts or early warmup questions may help.";
  }

  function renderParentDashboard() {
    const overview = document.getElementById("parent-overview-grid");
    const childrenList = document.getElementById("linked-children-list");
    const sessionList = document.getElementById("parent-session-history-list");
    const schedulingBilling = document.getElementById("parent-scheduling-billing");

    if (!overview && !childrenList && !sessionList && !schedulingBilling) return;

    const children = parentDashboard?.children || [];
    const bookings = parentDashboard?.bookings || [];
    const billing = parentDashboard?.billing || {};
    const totalSessions = children.reduce((sum, child) => sum + Number(child.sessionCount || 0), 0);
    const totalSpeaking = children.reduce((sum, child) => sum + Number(child.speakingSeconds || 0), 0);

    if (overview) {
      overview.innerHTML = `
        <div class="metric-card">
          <span class="metric-label">Linked Children</span>
          <strong>${children.length}</strong>
          <small>Family-level links, independent of class rooms</small>
        </div>
        <div class="metric-card">
          <span class="metric-label">Sessions Seen</span>
          <strong>${totalSessions}</strong>
          <small>Across all linked student accounts</small>
        </div>
        <div class="metric-card">
          <span class="metric-label">Speaking Time</span>
          <strong>${Math.round(totalSpeaking / 60)}m</strong>
          <small>Approximate child speaking time</small>
        </div>
      `;
    }

    if (childrenList) {
      if (!children.length) {
        childrenList.innerHTML = '<p class="empty-state">No linked students yet. Add a child profile above, or attach an existing student email.</p>';
      } else {
        childrenList.innerHTML = children.map(child => `
          <div class="workspace-item parent-child-card">
            <div class="parent-child-main">
              <strong>${escapeHtml(child.name)}</strong>
              <div class="workspace-item-meta">
                ${escapeHtml(formatChildEmail(child.email))}
                ${child.grade_level ? ` · ${escapeHtml(child.grade_level)}` : ""}
                ${child.reading_level ? ` · ${escapeHtml(child.reading_level)}` : ""}
              </div>
              <p class="parent-progress-note">${escapeHtml(describeProgress(child))}</p>
            </div>
            <div class="parent-child-stats">
              <span>${Number(child.sessionCount || 0)} sessions</span>
              <span>${Math.round(Number(child.speakingSeconds || 0) / 60)}m spoke</span>
              <span>contribution ${Number(child.avgContribution || 0).toFixed(2)}</span>
            </div>
          </div>
        `).join("");
      }
    }

    if (schedulingBilling) {
      const billingStatus = billing.billing_status || "setup_needed";
      schedulingBilling.innerHTML = `
        <div class="workspace-item">
          <strong>Billing</strong>
          <div class="workspace-item-meta">
            ${billing.connected ? "Stripe customer connected" : "Stripe not connected yet"} · ${escapeHtml(billingStatus.replace(/_/g, " "))}
            ${billing.plan_label ? ` · ${escapeHtml(billing.plan_label)}` : ""}
          </div>
          <p class="parent-progress-note">Next build step: connect this wrapper to Stripe Checkout and subscriptions without mixing payment state into learning records.</p>
        </div>
        <div class="workspace-item">
          <strong>Scheduling</strong>
          <div class="workspace-item-meta">${bookings.length ? `${bookings.length} booking request${bookings.length === 1 ? "" : "s"}` : "No booking requests yet"}</div>
          <p class="parent-progress-note">Next build step: teacher availability blocks, parent booking requests, and calendar reminders.</p>
        </div>
      `;
    }

    if (sessionList) {
      if (!parentChildrenSessions.length) {
        sessionList.innerHTML = '<p class="empty-state">No sessions yet. As children participate, their parent-safe timeline appears here.</p>';
      } else {
        sessionList.innerHTML = parentChildrenSessions.map(session => `
          <div class="workspace-item">
            <strong>${escapeHtml(session.title || "Untitled Session")}</strong>
            <div class="workspace-item-meta">
              ${escapeHtml(session.childName || "Student")} · ${formatDateTime(session.created_at)} · ${escapeHtml(session.status || "")}<br>
              ${Number(session.message_count || 0)} comments · ${Math.round(Number(session.estimated_speaking_seconds || 0) / 60)}m speaking · contribution ${Number(session.contribution_score || 0).toFixed(2)}
            </div>
          </div>
        `).join("");
      }
    }
  }

  async function refreshWorkspace() {
    renderAuthState();

    if (!authToken) {
      savedClasses = [];
      sessionHistory = [];
      classTimeline = [];
      parentDashboard = null;
      parentChildrenSessions = [];
      selectedClassSummary = null;
      selectedClassLiveSession = null;
      renderClasses();
      renderSessionHistory();
      renderClassRoomSummary();
      renderParentDashboard();
      return;
    }

    try {
      const me = await apiGet("/api/auth/me");
      accountUser = me.user;
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(accountUser));

      if (accountUser.role === "Parent") {
        savedClasses = [];
        sessionHistory = [];
        classTimeline = [];
        selectedClassId = null;
        selectedClassSummary = null;
        selectedClassLiveSession = null;
        await refreshParentDashboard();
        renderAuthState();
        renderClasses();
        renderSessionHistory();
        renderClassRoomSummary();
        renderSetupContext();
        return;
      }

      const historyPath = `/api/sessions/history${sessionHistoryQuery ? `?q=${encodeURIComponent(sessionHistoryQuery)}` : ''}`;
      const [classes, history] = await Promise.all([
        apiGet("/api/classes"),
        apiGet(historyPath)
      ]);
      savedClasses = classes;
      sessionHistory = history;
      parentDashboard = null;
      parentChildrenSessions = [];
      if (selectedClassId && !savedClasses.some(cls => cls.id === selectedClassId)) {
        selectedClassId = null;
      }
      if (!selectedClassId && savedClasses.length > 0) {
        selectedClassId = savedClasses[0].id;
      }
      renderAuthState();
      renderClasses();
      renderSessionHistory();
      renderParentDashboard();
      loadSelectedClassTimeline();
      renderSetupContext();
    } catch (error) {
      console.warn("[Auth] Workspace refresh failed:", error.message);
      clearAuthState();
      renderAuthState();
      renderClasses();
      renderSessionHistory();
      renderClassRoomSummary();
      renderParentDashboard();
      renderSetupContext();
    }
  }

  // ---- Jitsi / JaaS Integration ----
  const JAAS_APP_ID = "vpaas-magic-cookie-44bf27b66fab458bae6a8c271ea52a82";
  let jitsiScriptLoaded = false;

  function loadJitsiScript() {
    return new Promise((resolve, reject) => {
      if (jitsiScriptLoaded || window.JitsiMeetExternalAPI) {
        jitsiScriptLoaded = true;
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = `https://8x8.vc/${JAAS_APP_ID}/external_api.js`;
      script.onload = () => {
        jitsiScriptLoaded = true;
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load JaaS API"));
      document.head.appendChild(script);
    });
  }

  async function launchJitsi(roomName, displayName) {
    const fullRoomName = `${JAAS_APP_ID}/socratic-${roomName}`;
    if ((jitsiApi && activeJitsiRoom === fullRoomName) || jitsiLaunchingRoom === fullRoomName) {
      console.log("[Jitsi] Already launched or launching room:", roomName);
      return;
    }
    jitsiLaunchingRoom = fullRoomName;

    try {
      await loadJitsiScript();
    } catch (e) {
      console.error("[Jitsi] Failed to load script:", e);
      alert("Failed to load video call. Check your connection and try again.");
      jitsiLaunchingRoom = null;
      return;
    }

    const container = document.getElementById("jitsi-container");
    if (jitsiApi) {
      jitsiApi.dispose();
      jitsiApi = null;
    }
    if (container) container.replaceChildren();

    // Fetch JWT from server for authenticated access
    let jwt = null;
    try {
      const tokenData = await apiGet(`/api/jitsi-token?room=socratic-${roomName}&name=${encodeURIComponent(displayName)}&moderator=${isHost}`);
      jwt = tokenData.token;
      console.log("[Jitsi] Got JWT token");
    } catch (e) {
      console.warn("[Jitsi] No JWT token, joining without auth:", e.message);
    }

    const options = {
      roomName: fullRoomName,
      parentNode: container,
      userInfo: {
        displayName: displayName
      },
      configOverwrite: {
        startWithAudioMuted: false,
        startWithVideoMuted: false,
        prejoinConfig: { enabled: false },
        prejoinPageEnabled: false,
        disableDeepLinking: true,
        enableInsecureRoomNameWarning: false,
        toolbarButtons: [
          'camera', 'desktop', 'fullscreen',
          'raisehand', 'tileview', 'participants-pane',
          'toggle-camera'
        ],
        disableInviteFunctions: true,
        hideConferenceSubject: true,
        disableThirdPartyRequests: false,
        p2p: { enabled: true }
      },
      interfaceConfigOverwrite: {
        SHOW_JITSI_WATERMARK: false,
        SHOW_WATERMARK_FOR_GUESTS: false,
        SHOW_BRAND_WATERMARK: false,
        TOOLBAR_ALWAYS_VISIBLE: true,
        DISABLE_JOIN_LEAVE_NOTIFICATIONS: false,
        MOBILE_APP_PROMO: false,
        HIDE_INVITE_MORE_HEADER: true
      }
    };

    if (jwt) {
      options.jwt = jwt;
    }

    jitsiApi = new JitsiMeetExternalAPI("8x8.vc", options);
    activeJitsiRoom = fullRoomName;
    jitsiLaunchingRoom = null;

    // Ensure iframe has audio/video permissions (Safari requires this)
    const iframe = jitsiApi.getIFrame();
    if (iframe) {
      iframe.setAttribute('allow', 'camera *; microphone *; autoplay *; display-capture *; clipboard-write *');
      console.log('[Jitsi] iframe permissions set');
    }

    jitsiApi.addEventListener('participantJoined', (event) => {
      console.log('[Jitsi] Participant joined:', event);
    });

    jitsiApi.addEventListener('participantLeft', (event) => {
      console.log('[Jitsi] Participant left:', event);
    });

    jitsiApi.addEventListener('readyToClose', () => {
      console.log('[Jitsi] Conference ended');
    });

    jitsiApi.addEventListener('videoConferenceLeft', () => {
      console.log('[Jitsi] Left conference');
    });

    jitsiApi.addEventListener('audioMuteStatusChanged', (event) => {
      console.log('[Jitsi] Audio mute:', event.muted);
      scheduleJitsiMuteState(event.muted);
    });
    jitsiApi.addEventListener('toolbarButtonClicked', (event) => {
      if (event.key === 'microphone') {
        setTimeout(syncJitsiMuteState, 80);
      }
    });

    syncJitsiMuteState();
    startJitsiMutePolling();

    jitsiApi.addEventListener('errorOccurred', (event) => {
      console.error('[Jitsi] Error:', event);
    });

    console.log('[Jitsi] Launched room:', roomName);
  }

  function destroyJitsi() {
    stopJitsiMutePolling();
    resetJitsiMuteState();
    if (jitsiApi) {
      jitsiApi.dispose();
      jitsiApi = null;
    }
    activeJitsiRoom = null;
    jitsiLaunchingRoom = null;
    document.getElementById("jitsi-container")?.replaceChildren();
  }

  function resetJitsiMuteState() {
    jitsiMicMuted = false;
    if (jitsiMuteTimer) {
      clearTimeout(jitsiMuteTimer);
      jitsiMuteTimer = null;
    }
  }

  function isVideoScreenActive() {
    return !!document.getElementById("video-screen")?.classList.contains("active");
  }

  function isPlatoInputMuted() {
    return platoMicMuted;
  }

  function setPlatoMicMuted(muted, options = {}) {
    const { syncJitsi = true, source = "app" } = options;
    platoMicMuted = !!muted;
    renderPlatoMicState();
    applyPlatoMicGate(source);
    if (syncJitsi) {
      setJitsiAudioMuted(platoMicMuted);
    }
  }

  function applyPlatoMicGate(source = "app") {
    renderPlatoMicState();
    if (!isVideoScreenActive()) return;

    if (isPlatoInputMuted()) {
      console.log(`[STT] Pausing because Plato mic is muted (${source})`);
      stopSpeechRecognition({ flush: false, releaseStream: true });
      return;
    }

    if (!sttActive && currentSessionId) {
      console.log(`[STT] Resuming because Plato mic is unmuted (${source})`);
      startSpeechRecognition();
    }
  }

  function renderPlatoMicState() {
    const muted = isPlatoInputMuted();
    const button = document.getElementById("plato-mic-toggle");
    if (button) {
      button.classList.toggle("muted", muted);
      button.setAttribute("aria-pressed", String(muted));
      button.textContent = muted ? "Unmute Mic" : "Mute Mic";
    }

    const tileStatus = document.getElementById("plato-tile-status");
    if (tileStatus && muted && !document.getElementById("plato-tile")?.classList.contains("speaking")) {
      tileStatus.textContent = "Muted";
    } else if (tileStatus && !muted && tileStatus.textContent === "Muted") {
      tileStatus.textContent = "Listening";
    }

    if (muted) {
      setFacilitatorStatus("muted");
    } else if (document.getElementById("facilitator-status")?.textContent === "Muted") {
      setFacilitatorStatus("listening");
    }
  }

  async function setJitsiAudioMuted(shouldMute) {
    if (!jitsiApi || typeof jitsiApi.executeCommand !== "function") return;
    try {
      let currentMuted = jitsiMicMuted;
      if (typeof jitsiApi.isAudioMuted === "function") {
        currentMuted = await jitsiApi.isAudioMuted();
      }
      if (!!currentMuted !== !!shouldMute) {
        jitsiApi.executeCommand("toggleAudio");
      }
    } catch (error) {
      console.warn("[Jitsi] Could not sync Jitsi mic with Plato mic:", error?.message || error);
    }
  }

  function scheduleJitsiMuteState(muted) {
    if (jitsiMuteTimer) clearTimeout(jitsiMuteTimer);
    if (muted) {
      applyJitsiMuteState(true);
      jitsiMuteTimer = null;
      return;
    }
    jitsiMuteTimer = setTimeout(() => {
      applyJitsiMuteState(muted);
      jitsiMuteTimer = null;
    }, 180);
  }

  function startJitsiMutePolling() {
    stopJitsiMutePolling();
    jitsiMutePoller = setInterval(syncJitsiMuteState, 750);
  }

  function stopJitsiMutePolling() {
    if (jitsiMutePoller) {
      clearInterval(jitsiMutePoller);
      jitsiMutePoller = null;
    }
  }

  function syncJitsiMuteState() {
    if (!jitsiApi || typeof jitsiApi.isAudioMuted !== "function") return;
    try {
      const muteState = jitsiApi.isAudioMuted();
      if (muteState && typeof muteState.then === "function") {
        muteState
          .then((muted) => scheduleJitsiMuteState(muted))
          .catch((error) => console.warn("[Jitsi] Could not read audio mute state:", error?.message || error));
      } else {
        scheduleJitsiMuteState(muteState);
      }
    } catch (error) {
      console.warn("[Jitsi] Could not read audio mute state:", error?.message || error);
    }
  }

  function applyJitsiMuteState(muted) {
    jitsiMicMuted = !!muted;
    setPlatoMicMuted(jitsiMicMuted, { syncJitsi: false, source: "jitsi" });
  }

  // ---- Share Link ----
  function getShareLink(sessionId) {
    const base = `${window.location.origin}${window.location.pathname}`;
    return `${base}?join=${sessionId}`;
  }

  function showShareInfo(sessionId) {
    document.getElementById("session-code").textContent = sessionId;

    // Show dashboard link for host (lobby)
    const dashLink = document.getElementById("dashboard-link");
    if (dashLink && isHost) {
      dashLink.href = `/dashboard?session=${sessionId}`;
      dashLink.style.display = "";
    }

    // Show dashboard button for logged-in teachers (video sidebar)
    const videoDashBtn = document.getElementById("video-dashboard-btn");
    if (videoDashBtn && (isHost || accountUser?.role === 'Teacher' || accountUser?.role === 'Admin' || accountUser?.role === 'SuperAdmin')) {
      videoDashBtn.href = `/dashboard?session=${sessionId}`;
      videoDashBtn.style.display = "";
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

  // ---- Message Handlers ----
  async function handleServerMessage(msg) {
    console.log("[WS] Received:", msg.type, msg);
    switch (msg.type) {
      case "connected":
        wsConnectedToServer = true;
        console.log("[WS] Server confirmed connection, clientId:", msg.clientId);
        break;

      case "session_created":
        currentSessionId = msg.sessionId;
        setSessionAccessToken(msg.sessionId, msg.sessionAccessToken);
        send({ type: "join_session", sessionId: msg.sessionId, name: myName, age: getAge(), authToken, sessionAccessToken: getSessionAccessToken(msg.sessionId) });
        isHost = true;
        break;

      case "session_ended_readonly": {
        // Tried to join an ended session — show read-only transcript
        const overlay = document.getElementById("readonly-overlay");
        const feed = document.getElementById("readonly-feed");
        const titleEl = document.getElementById("readonly-title");
        clearState();
        clearSessionUrlState();
        pendingRoomJoin = null;
        showScreen("welcome");
        if (overlay && feed) {
          titleEl.textContent = msg.title || "Past Discussion";
          feed.innerHTML = msg.messages.map(m => {
            const isPlato = m.senderType === 'ai';
            const name = isPlato ? 'Plato' : (m.senderName || 'Participant');
            const cls = isPlato ? 'facilitator_message' : 'participant_message';
            return `<div class="${cls}"><strong>${escapeHtml(name)}</strong>: ${escapeHtml(m.content)}</div>`;
          }).join("");
          overlay.style.display = "flex";
        }
        break;
      }

      case "room_not_live":
        clearState();
        clearSessionUrlState();
        showRoomWaitScreen({
          roomCode: msg.roomCode,
          classId: msg.classId,
          className: msg.className,
          classDescription: msg.classDescription
        });
        break;

      case "session_restored": {
        currentSessionId = msg.sessionId;
        setSessionAccessToken(msg.sessionId, msg.sessionAccessToken);
        myId = msg.yourId;
        participants = msg.participants || [];
        discussionActive = msg.sessionStatus === "active";
        if (msg.sessionRole === "teacher") {
          isHost = true;
        }
        resetConversationFeed();
        for (const restored of msg.messages || []) {
          if (restored.type === "facilitator_message") {
            addFacilitatorMessage(restored.text, restored.move);
          } else {
            addTranscriptEntry(restored.participantName || "Participant", restored.text, restored.participantId === myId, false);
          }
        }
        updateParticipantList();
        showShareInfo(msg.sessionId);
        if (msg.topicTitle) {
          document.getElementById("lobby-topic").textContent = msg.topicTitle;
          document.getElementById("lobby-topic-section").style.display = "block";
        }
        navigateTo(discussionActive ? "video" : "lobby");
        if (discussionActive) {
          await preAcquireMedia();
          launchJitsi(currentSessionId, myName);
          startSpeechRecognition();
          document.getElementById("start-discussion-btn").style.display = "none";
        }
        saveState();
        break;
      }

      case "session_joined": {
        const isRejoin = currentSessionId === msg.sessionId && myId === msg.yourId;
        currentSessionId = msg.sessionId;
        setSessionAccessToken(msg.sessionId, msg.sessionAccessToken);
        discussionActive = false;
        if (msg.sessionRole === "teacher") {
          isHost = true;
        }
        applyTeacherParams(msg.currentParams || {});
        // Only reset feed on fresh join — preserve transcript on reconnect
        if (!isRejoin) {
          resetConversationFeed();
        }
        myId = msg.yourId;
        participants = msg.participants;
        updateParticipantList();
        showShareInfo(msg.sessionId);
        if (msg.topicTitle) {
          document.getElementById("lobby-topic").textContent = msg.topicTitle;
          document.getElementById("lobby-topic-section").style.display = "block";
        }
        navigateTo("lobby");
        saveState();

        // Pre-fill name input in case we need it
        document.getElementById("name-input").value = myName;

        // If host, prime materials now that session exists
        if (isHost && materials.length > 0) {
          primeMaterials();
        }
        break;
      }

      case "teacher_params_updated":
        applyTeacherParams(msg.params || {});
        break;

      case "participant_joined":
        if (msg.participantId
          ? !participants.some(p => p.id === msg.participantId)
          : !participants.some(p => p.name === msg.name)) {
          participants.push({ name: msg.name, id: msg.participantId || null });
        }
        updateParticipantList();
        document.getElementById("participant-count").textContent = `${msg.participantCount} participants`;
        break;

      case "participant_left":
        participants = msg.participantId
          ? participants.filter(p => p.id !== msg.participantId)
          : participants.filter(p => p.name !== msg.name);
        updateParticipantList();
        addTranscriptEntry("system", `${msg.name} left the discussion`);
        break;

      case "enter_video":
        discussionActive = false;
        if (!document.getElementById("video-screen").classList.contains("active")) {
          navigateTo("video");
          await preAcquireMedia();          // single permission prompt
          launchJitsi(currentSessionId, myName);
          startSpeechRecognition();
        } else if (!sttActive) {
          startSpeechRecognition();
        }
        document.getElementById("start-discussion-btn").style.display = isHost ? "" : "none";
        saveState();
        break;

      case "discussion_started":
        discussionActive = true;
        if (!document.getElementById("video-screen").classList.contains("active")) {
          navigateTo("video");
          await preAcquireMedia();          // single permission prompt
          launchJitsi(currentSessionId, myName);
          startSpeechRecognition();
        } else if (!sttActive) {
          startSpeechRecognition();
        }
        document.getElementById("start-discussion-btn").style.display = "none";
        saveState();
        break;

      case "participant_message":
        if (msg.senderId && msg.senderId === myId) break;
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
            sttBatchBuffer = mergeTranscriptText(sttBatchBuffer, msg.text.trim());
            lastInterimTranscript = "";
            updateLocalSpeechDraft(sttBatchBuffer, false);
            scheduleSttFlush();
          }
        } else {
          if (msg.text && msg.text.trim()) {
            lastInterimTranscript = msg.text.trim();
            const preview = mergeTranscriptText(sttBatchBuffer, lastInterimTranscript);
            updateLocalSpeechDraft(preview, true);
          }
        }
        break;

      case "vad_event":
        if (msg.event === "speech_started") {
          setFacilitatorStatus("listening");
        } else if (msg.event === "speech_stopped" && sttBatchBuffer.trim()) {
          scheduleSttFlush(Math.min(getSpeechPatienceProfile().vadFlush, getSttFlushDelay()));
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
        discussionActive = false;
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

  // ---- Materials Upload & Priming ----

  async function primeMaterials() {
    if (!currentSessionId || materials.length === 0) return;

    const primingStatus = document.getElementById("priming-status");
    if (primingStatus) primingStatus.style.display = "flex";

    try {
      // Upload each material
      for (const m of materials) {
        if (m.fromClass && m.extractedText) {
          // Pre-loaded from a previous session — send as text
          await apiPost(`/api/sessions/${currentSessionId}/materials`, {
            type: m.type === 'url' ? 'url' : 'txt',
            url: m.url || null,
            text: m.extractedText,
            filename: m.name
          });
        } else if (m.type === "file") {
          const formData = new FormData();
          formData.append("file", m.file);
          const response = await fetch(`/api/sessions/${currentSessionId}/materials`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: formData
          });
          if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error.error || `Upload failed ${response.status}`);
          }
        } else if (m.type === "url") {
          await apiPost(`/api/sessions/${currentSessionId}/materials`, { url: m.url });
        } else if (m.type === "text") {
          await apiPost(`/api/sessions/${currentSessionId}/materials`, {
            type: "txt",
            text: m.text,
            filename: m.name
          });
        }
      }

      // Prime the session
      const result = await apiPost(`/api/sessions/${currentSessionId}/prime`, {});

      if (primingStatus) primingStatus.style.display = "none";

      if (result.status === "complete" && result.context) {
        showPrimedContext(result.context);
      }
    } catch (error) {
      console.error("Priming error:", error);
      if (primingStatus) {
        primingStatus.innerHTML = "Failed to process materials — Plato will discuss the topic directly.";
      }
    }
  }

  function showPrimedContext(context) {
    const preview = document.getElementById("primed-preview");
    const themes = document.getElementById("primed-themes");
    if (preview && themes && context.keyThemes && context.keyThemes.length > 0) {
      themes.innerHTML = context.keyThemes.map(t => `<span class="theme-chip">${escapeHtml(t)}</span>`).join("");
      preview.style.display = "block";
    }
  }

  function renderMaterials() {
    const containers = [
      document.getElementById("materials-list"),
      document.getElementById("expanded-materials-list")
    ].filter(Boolean);
    const countEls = [
      document.getElementById("material-count"),
      document.getElementById("expanded-material-count")
    ].filter(Boolean);
    const uploadAreas = [
      document.getElementById("upload-area"),
      document.getElementById("expanded-upload-area")
    ].filter(Boolean);

    countEls.forEach(el => {
      el.textContent = `(${materials.length}/${MAX_MATERIALS})`;
    });

    containers.forEach(container => {
      container.innerHTML = "";
      materials.forEach((m, i) => {
        const div = document.createElement("div");
        div.className = "material-item";
        const icon = m.type === "url" ? "&#128279;" : m.type === "text" ? "&#182;" : "&#128196;";
        const badge = m.fromClass ? ' <span class="material-badge">saved</span>' : ' <span class="material-badge">new</span>';
        div.innerHTML = `
          <span class="material-icon">${icon}</span>
          <span class="material-name">${escapeHtml(m.name)}${badge}</span>
          <button class="material-remove" data-index="${i}">&times;</button>
        `;
        container.appendChild(div);
      });

      if (materials.length === 0) {
        container.innerHTML = '<p class="empty-state empty-state-tight">No source text attached yet.</p>';
      }
    });

    uploadAreas.forEach(uploadArea => {
      if (!uploadArea) return;
      if (materials.length >= MAX_MATERIALS) {
        uploadArea.style.opacity = "0.5";
        uploadArea.style.pointerEvents = "none";
      } else {
        uploadArea.style.opacity = "1";
        uploadArea.style.pointerEvents = "auto";
      }
    });
  }

  function addUrlMaterial(url) {
    if (materials.length >= MAX_MATERIALS) return false;
    if (!url) return false;
    const displayName = url.length > 50 ? url.substring(0, 47) + "..." : url;
    materials.push({ type: "url", name: displayName, url });
    renderMaterials();
    return true;
  }

  function addPastedMaterial(text) {
    if (materials.length >= MAX_MATERIALS) return false;
    const cleanText = String(text || "").trim();
    if (!cleanText) return false;
    const firstLine = cleanText.split(/\r?\n/).find(Boolean) || "Pasted text";
    const name = firstLine.length > 42 ? `${firstLine.slice(0, 39)}...` : firstLine;
    materials.push({
      type: "text",
      name: name || "Pasted source text",
      text: cleanText,
      extractedText: cleanText
    });
    renderMaterials();
    return true;
  }

  function bindExpandedMaterialsControls(classId) {
    const uploadArea = document.getElementById("expanded-upload-area");
    const fileInput = document.getElementById("expanded-file-input");
    const urlInput = document.getElementById("expanded-url-input");
    const addUrlBtn = document.getElementById("expanded-add-url-btn");
    const textInput = document.getElementById("expanded-paste-text-input");
    const addTextBtn = document.getElementById("expanded-add-text-btn");
    const list = document.getElementById("expanded-materials-list");

    if (uploadArea && fileInput) {
      uploadArea.addEventListener("click", () => {
        materialsClassId = classId;
        if (materials.length < MAX_MATERIALS) fileInput.click();
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
        materialsClassId = classId;
        handleFiles(e.dataTransfer.files);
      });
      fileInput.addEventListener("change", () => {
        materialsClassId = classId;
        handleFiles(fileInput.files);
      });
    }

    addUrlBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      materialsClassId = classId;
      if (addUrlMaterial(urlInput?.value?.trim())) {
        urlInput.value = "";
      }
    });

    addTextBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      materialsClassId = classId;
      if (addPastedMaterial(textInput?.value || "")) {
        textInput.value = "";
      }
    });

    list?.addEventListener("click", (e) => {
      if (e.target.classList.contains("material-remove")) {
        const index = parseInt(e.target.dataset.index, 10);
        materials.splice(index, 1);
        materialsClassId = classId;
        renderMaterials();
      }
    });
  }

  function renderSetupContext() {
    const titleEl = document.getElementById("setup-context-title");
    const copyEl = document.getElementById("setup-context-copy");
    const roomCodeEl = document.getElementById("setup-context-room-code");
    const sessionCodeEl = document.getElementById("setup-context-session-code");
    const noteEl = document.getElementById("setup-context-note");
    if (!titleEl || !copyEl || !roomCodeEl || !sessionCodeEl || !noteEl) return;

    const classSelect = document.getElementById("session-class-select");
    const selectedId = classSelect ? classSelect.value : (selectedClassId || "");
    const cls = savedClasses.find(item => item.id === selectedId) || null;

    if (!cls) {
      titleEl.textContent = "Quick Session";
      copyEl.textContent = "This will create a one-off discussion with a fresh live code for today only.";
      roomCodeEl.textContent = "Not used";
      sessionCodeEl.textContent = "Generated when created";
      noteEl.textContent = "Quick sessions are best for demos, tutoring, office hours, and spontaneous conversations.";
      return;
    }

    titleEl.textContent = cls.name;
    copyEl.textContent = "This session will live inside a persistent class room, so the same room code keeps working across the semester.";
    roomCodeEl.textContent = cls.roomCode || "Pending";
    sessionCodeEl.textContent = "Fresh code for today’s meeting";
    noteEl.textContent = `Students can keep joining ${cls.roomCode || "this room"} every week. Each actual class meeting becomes a new session in the timeline.`;
  }

  function showRoomWaitScreen(room) {
    pendingRoomJoin = room;
    const titleEl = document.getElementById("room-wait-title");
    const copyEl = document.getElementById("room-wait-copy");
    const codeEl = document.getElementById("room-wait-code");
    const noteEl = document.getElementById("room-wait-note");
    const startBtn = document.getElementById("room-wait-start-btn");

    if (titleEl) titleEl.textContent = `${room.className} Is Not Live Yet`;
    if (copyEl) copyEl.textContent = "This class room is ready, but there is no active session open right now. Once a teacher starts today’s discussion, the same room code will let everyone in.";
    if (codeEl) codeEl.textContent = room.roomCode || room.code || "";
    if (noteEl) noteEl.textContent = room.classDescription
      ? room.classDescription
      : "Think of the room code as the classroom door. The teacher opens a fresh session inside it when class begins.";

    const canStartHere = !!(
      accountUser &&
      canManageClasses() &&
      savedClasses.some(cls => cls.id === room.classId)
    );
    if (startBtn) {
      startBtn.style.display = canStartHere ? "" : "none";
    }

    showScreen("roomWait");
  }

  async function refreshPendingRoomJoin() {
    if (!pendingRoomJoin?.roomCode) return;
    try {
      const resolved = await apiGet(`/api/sessions/resolve/${encodeURIComponent(pendingRoomJoin.roomCode)}`);
      if (resolved.type === "room" && resolved.hasLiveSession && resolved.sessionShortCode) {
        send({ type: "join_session", sessionId: resolved.sessionShortCode, name: myName, age: getAge(), authToken, sessionAccessToken: getSessionAccessToken(resolved.sessionShortCode) });
        return;
      }
      showRoomWaitScreen(resolved);
    } catch (error) {
      alert(error.message);
    }
  }

  async function loadClassMaterials(classId) {
    if (!classId || !authToken) {
      return;
    }
    try {
      const result = await apiGet(`/api/classes/${classId}/materials`);
      if (result.materials && result.materials.length > 0) {
        // Replace current materials with class's saved materials
        materials = result.materials.map(m => ({
          type: m.type === 'url' ? 'url' : 'file',
          name: m.filename || m.url || 'Material',
          url: m.url,
          extractedText: m.extractedText,
          fromClass: true
        }));
      } else {
        materials = [];
      }
      materialsClassId = classId;
      renderMaterials();
    } catch (err) {
      console.warn('[Materials] Could not load class materials:', err.message);
    }
  }

  // ---- UI Updates ----
  function updateParticipantList() {
    const container = document.getElementById("participant-chips");
    container.innerHTML = "";
    participants.forEach(p => {
      const chip = document.createElement("span");
      chip.className = "participant-chip";
      chip.textContent = p.name;
      container.appendChild(chip);
    });
  }

  function addFacilitatorMessage(text, move) {
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

  function addTranscriptEntry(name, text, isSelf, isInterim) {
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

  function getSttFlushDelay() {
    const profile = getSpeechPatienceProfile();
    return discussionActive ? profile.discussion : profile.warmup;
  }

  function mergeTranscriptText(base, incoming) {
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

  function updateLocalSpeechDraft(text, isInterim) {
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
    draft.innerHTML = `<strong>${escapeHtml(myName)}:</strong> ${body}`;
    scrollChatToBottom();
  }

  function clearLocalSpeechDraft() {
    const container = document.getElementById("conversation-feed");
    if (!container) return;
    const draft = container.querySelector('.transcript-interim');
    if (draft) draft.remove();
  }

  function flushSttBatch() {
    clearTimeout(sttBatchTimer);
    sttBatchTimer = null;
    const text = sttBatchBuffer.trim();
    if (!text) return;
    sttBatchBuffer = '';
    lastInterimTranscript = "";
    clearLocalSpeechDraft();
    addTranscriptEntry(myName, text, true, false);
    send({ type: "message", text, source: "stt" });
    console.log("[STT] Batched final:", text);
  }

  function discardSttBatch() {
    clearTimeout(sttBatchTimer);
    sttBatchTimer = null;
    sttBatchBuffer = '';
    lastInterimTranscript = "";
    clearLocalSpeechDraft();
  }

  function scheduleSttFlush(delayOverride = null) {
    clearTimeout(sttBatchTimer);
    sttBatchTimer = setTimeout(() => {
      flushSttBatch();
    }, delayOverride == null ? getSttFlushDelay() : delayOverride);
  }

  function updatePartialTranscript(name, text) {
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

  let platoSpeakingTimer = null;

  function setFacilitatorStatus(status) {
    const badge = document.getElementById("facilitator-status");
    if (!badge) return;
    if (isPlatoInputMuted() && status !== "speaking") {
      badge.className = "status-badge muted";
      badge.textContent = "Muted";
      return;
    }
    badge.className = `status-badge ${status}`;
    badge.textContent = status === "speaking" ? "Speaking" : status === "muted" ? "Muted" : "Listening";
  }

  function setPlatoTileSpeaking(text) {
    const tile = document.getElementById("plato-tile");
    const tileStatus = document.getElementById("plato-tile-status");
    const tileText = document.getElementById("plato-tile-text");
    if (!tile) return;

    // Clear any existing timer
    if (platoSpeakingTimer) clearTimeout(platoSpeakingTimer);

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

    platoSpeakingTimer = setTimeout(() => {
      tile.classList.remove("speaking");
      if (tileStatus) tileStatus.textContent = isPlatoInputMuted() ? "Muted" : "Listening";
      if (tileText) tileText.textContent = "";
      setFacilitatorStatus("listening");
    }, speakingMs);
  }

  function scrollChatToBottom() {
    const scrollable = document.querySelector('.sidebar-transcript');
    if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function getAge() {
    return 25; // Default age — age input removed from UI
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  async function handleRegister() {
    const name = document.getElementById("auth-name-input").value.trim();
    const email = document.getElementById("auth-email-input").value.trim();
    const password = document.getElementById("auth-password-input").value;
    const role = document.getElementById("auth-role-select").value;

    if (!name || !email || !password) {
      alert("Enter your name, email, and password to create an account.");
      return;
    }
    if (name.length > 100) { alert("Name is too long (max 100 characters)."); return; }
    if (!EMAIL_RE.test(email)) { alert("Enter a valid email address."); return; }
    if (password.length < 8) { alert("Password must be at least 8 characters."); return; }

    try {
      const result = await apiPost("/api/auth/register", { name, email, password, role });
      saveAuthState(result.user, result.token);
      document.getElementById("auth-password-input").value = "";
      document.getElementById("login-password-input").value = "";
      document.getElementById("name-input").value = result.user.name;
      await refreshWorkspace();
    } catch (error) {
      alert(error.message);
    }
  }

  async function handleLogin() {
    const email = document.getElementById("login-email-input").value.trim();
    const password = document.getElementById("login-password-input").value;

    if (!email || !password) {
      alert("Enter your email and password to sign in.");
      return;
    }
    if (!EMAIL_RE.test(email)) { alert("Enter a valid email address."); return; }

    try {
      const result = await apiPost("/api/auth/login", { email, password });
      saveAuthState(result.user, result.token);
      document.getElementById("name-input").value = result.user.name;
      document.getElementById("login-password-input").value = "";
      await refreshWorkspace();
    } catch (error) {
      alert(error.message);
    }
  }

  async function loadDemoTeacherConfig() {
    try {
      demoTeacherConfig = await apiGet("/api/auth/demo-teacher");
    } catch (_error) {
      demoTeacherConfig = { enabled: false, name: "", email: "" };
    }
    renderAuthState();
  }

  async function handleDemoTeacherLogin() {
    try {
      const result = await apiPost("/api/auth/demo-teacher/login", {});
      saveAuthState(result.user, result.token);
      document.getElementById("name-input").value = result.user.name;
      document.getElementById("login-email-input").value = result.user.email;
      document.getElementById("login-password-input").value = "";
      await refreshWorkspace();
    } catch (error) {
      alert(error.message);
    }
  }

  async function handleParentAddChild() {
    const nameInput = document.getElementById("parent-child-name");
    const emailInput = document.getElementById("parent-child-email");
    const gradeInput = document.getElementById("parent-child-grade");
    const btn = document.getElementById("parent-add-child-btn");
    const name = nameInput?.value.trim() || "";
    const email = emailInput?.value.trim() || "";
    const gradeLevel = gradeInput?.value.trim() || "";

    if (!name && !email) {
      alert("Enter a child name, or enter an existing student email to attach.");
      return;
    }
    if (email && !EMAIL_RE.test(email)) {
      alert("Enter a valid child email, or leave it blank for a managed child profile.");
      return;
    }

    try {
      if (btn) { btn.disabled = true; btn.textContent = "Adding..."; }
      await apiPost("/api/parents/children", {
        name,
        email,
        gradeLevel,
        ageBand: gradeLevel
      });
      if (nameInput) nameInput.value = "";
      if (emailInput) emailInput.value = "";
      if (gradeInput) gradeInput.value = "";
      await refreshParentDashboard();
    } catch (error) {
      alert(error.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Add Child"; }
    }
  }

  async function handleCreateClass() {
    if (!accountUser || !canManageClasses()) {
      alert("Only teachers and admins can create classes.");
      return;
    }

    const name = document.getElementById("new-class-name").value.trim();
    const ageRange = document.getElementById("new-class-age-range").value.trim();
    const description = document.getElementById("new-class-description").value.trim();

    if (!name) {
      alert("Enter a class name.");
      return;
    }

    try {
      const created = await apiPost("/api/classes", { name, ageRange, description });
      savedClasses.unshift(created);
      selectedClassId = created.id;
      expandedClassId = created.id;
      closeCreateClassModal();
      renderClasses();
      loadSelectedClassTimeline();
    } catch (error) {
      alert(error.message);
    }
  }

  function handleLogout() {
    clearAuthState();
    renderAuthState();
    renderClasses();
    renderSessionHistory();
    renderClassRoomSummary();
    const classSelect = document.getElementById("session-class-select");
    if (classSelect) classSelect.value = "";
  }

  // ---- Event Listeners ----

  document.getElementById("register-btn").addEventListener("click", handleRegister);
  document.getElementById("login-btn").addEventListener("click", handleLogin);
  document.getElementById("demo-login-btn")?.addEventListener("click", handleDemoTeacherLogin);
  document.getElementById("create-class-btn").addEventListener("click", handleCreateClass);
  document.getElementById("parent-add-child-btn")?.addEventListener("click", handleParentAddChild);

  // Create class modal
  function openCreateClassModal() {
    const modal = document.getElementById("create-class-modal");
    if (!modal) return;
    modal.style.display = "";
    modal.classList.add("active");
    document.getElementById("new-class-name")?.focus();
  }
  function closeCreateClassModal() {
    const modal = document.getElementById("create-class-modal");
    if (!modal) return;
    modal.classList.remove("active");
    modal.style.display = "none";
    document.getElementById("new-class-name").value = "";
    document.getElementById("new-class-age-range").value = "";
    document.getElementById("new-class-description").value = "";
  }
  document.getElementById("open-create-class-modal-btn")?.addEventListener("click", openCreateClassModal);
  document.getElementById("create-class-backdrop")?.addEventListener("click", closeCreateClassModal);
  document.getElementById("create-class-close")?.addEventListener("click", closeCreateClassModal);
  document.getElementById("logout-btn").addEventListener("click", handleLogout);
  document.getElementById("session-history-search")?.addEventListener("input", (event) => {
    sessionHistoryQuery = event.target.value.trim();
    clearTimeout(sessionSearchTimer);
    sessionSearchTimer = setTimeout(() => {
      if (selectedClassId) {
        loadSelectedClassTimeline(sessionHistoryQuery);
      } else {
        refreshWorkspace();
      }
    }, 220);
  });

  ["join-code-input", "join-code-input-student"].forEach((id) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("input", () => applyJoinCodeFormatting(input));
    input.addEventListener("blur", () => applyJoinCodeFormatting(input));
  });

  // Auth tab switching
  document.querySelectorAll(".auth-tab").forEach(tab => {
    tab.addEventListener("click", () => switchAuthTab(tab.dataset.tab));
  });

  function switchAuthTab(tabName) {
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tabName));
    document.querySelectorAll(".auth-tab-content").forEach(c => c.classList.remove("active"));
    const target = document.getElementById(`auth-tab-${tabName}`);
    if (target) target.classList.add("active");
  }

  // Role chip selector in signup
  document.querySelectorAll(".role-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".role-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      document.getElementById("auth-role-select").value = chip.dataset.role;
      // Show/hide role-specific fields
      const role = chip.dataset.role;
      const studentFields = document.getElementById("signup-student-fields");
      const parentFields = document.getElementById("signup-parent-fields");
      if (studentFields) studentFields.style.display = role === "Student" ? "" : "none";
      if (parentFields) parentFields.style.display = role === "Parent" ? "" : "none";
    });
  });

  // Show/hide join section (guest only — teacher uses class cards)
  document.getElementById("join-toggle-btn")?.addEventListener("click", () => {
    const section = document.getElementById("join-section");
    if (section) section.style.display = section.style.display === "none" ? "flex" : "none";
  });

  // Create button → setup screen (guest panel)
  document.getElementById("create-btn")?.addEventListener("click", () => {
    myName = document.getElementById("name-input").value.trim();
    if (!myName) { alert("Enter your name"); return; }
    openSetupForClass(null);
  });

  // Create button → setup screen (guest panel only)
  // Teacher dashboard session launching is handled by class card "Go Live" buttons

  // Back from setup
  document.getElementById("back-to-welcome-btn")?.addEventListener("click", () => {
    abandonDraftSession();
    showScreen("welcome");
  });

  document.getElementById("room-wait-back-btn")?.addEventListener("click", () => {
    pendingRoomJoin = null;
    showScreen("welcome");
  });

  document.getElementById("room-wait-copy-btn")?.addEventListener("click", () => {
    const roomCode = pendingRoomJoin?.roomCode || "";
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode).then(() => {
      const btn = document.getElementById("room-wait-copy-btn");
      if (!btn) return;
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy Code"; }, 1200);
    });
  });

  document.getElementById("room-wait-refresh-btn")?.addEventListener("click", () => {
    refreshPendingRoomJoin();
  });

  document.getElementById("room-wait-start-btn")?.addEventListener("click", () => {
    if (!pendingRoomJoin?.classId) return;
    myName = accountUser?.name || "";
    if (!myName) {
      alert("Sign in first.");
      return;
    }
    openSetupForClass(pendingRoomJoin.classId, {
      suggestedTitle: `${pendingRoomJoin.className} Discussion`
    });
  });

  // Class dropdown change → load saved materials from that class
  document.getElementById("session-class-select")?.addEventListener("change", (e) => {
    const classId = e.target.value;
    if (classId) {
      loadClassMaterials(classId);
    } else {
      // Cleared class → clear pre-loaded materials
      materials = materials.filter(m => !m.fromClass);
      materialsClassId = null;
      renderMaterials();
    }
    renderSetupContext();
  });

  // File upload
  const uploadArea = document.getElementById("upload-area");
  const fileInput = document.getElementById("file-input");

  uploadArea.addEventListener("click", () => {
    if (materials.length < MAX_MATERIALS) fileInput.click();
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

  function handleFiles(files) {
    for (const file of files) {
      if (materials.length >= MAX_MATERIALS) break;
      materials.push({ type: "file", name: file.name, file: file });
    }
    renderMaterials();
  }

  // URL input
  document.getElementById("add-url-btn").addEventListener("click", () => {
    const input = document.getElementById("url-input");
    if (addUrlMaterial(input.value.trim())) {
      input.value = "";
    }
  });

  document.getElementById("add-text-btn")?.addEventListener("click", () => {
    const input = document.getElementById("paste-text-input");
    if (addPastedMaterial(input?.value || "")) {
      input.value = "";
    }
  });

  // Remove material
  document.getElementById("materials-list").addEventListener("click", (e) => {
    if (e.target.classList.contains("material-remove")) {
      const index = parseInt(e.target.dataset.index);
      materials.splice(index, 1);
      renderMaterials();
    }
  });

  // Create session
  document.getElementById("start-session-btn").addEventListener("click", () => {
    const title = document.getElementById("session-title").value.trim();
    const question = document.getElementById("opening-question").value.trim();
    const classId = document.getElementById("session-class-select").value || null;

    if (!title && materials.length === 0) {
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
      setSessionAccessToken(session.shortCode, session.sessionAccessToken);
      refreshWorkspace();
      currentSessionId = session.shortCode;
      isHost = true;
      send({
        type: "join_session",
        sessionId: session.shortCode,
        name: myName,
        age: getAge(),
        authToken,
        sessionAccessToken: getSessionAccessToken(session.shortCode)
      });
    }).catch(error => {
      console.error("[Session] Creation error:", error);
      alert("Failed to create session: " + error.message);
      btn.disabled = false;
      btn.textContent = "Create Session";
    });
  });

  // Join existing session (guest)
  async function handleJoinSession(nameSource, codeInputId) {
    myName = nameSource === "input" ? document.getElementById("name-input").value.trim() : (accountUser?.name || "");
    const input = document.getElementById(codeInputId);
    applyJoinCodeFormatting(input);
    const code = input?.value?.trim();
    if (!myName) { alert(nameSource === "input" ? "Enter your name" : "Sign in first"); return; }
    if (!code) { alert("Enter a room or session code"); return; }

    try {
      const resolved = await apiGet(`/api/sessions/resolve/${encodeURIComponent(code)}`);
      if (resolved.type === "room" && !resolved.hasLiveSession) {
        showRoomWaitScreen(resolved);
        return;
      }
      const joinCode = resolved.sessionShortCode || code;
      send({ type: "join_session", sessionId: joinCode, name: myName, age: getAge(), authToken, sessionAccessToken: getSessionAccessToken(joinCode) });
    } catch (error) {
      alert(error.message);
    }
  }

  document.getElementById("join-btn")?.addEventListener("click", () => handleJoinSession("input", "join-code-input"));
  document.getElementById("join-btn-student")?.addEventListener("click", () => handleJoinSession("account", "join-code-input-student"));

  // Enter video room (warmup mode)
  document.getElementById("enter-video-btn").addEventListener("click", () => {
    send({ type: "enter_video" });
  });

  // Start discussion (from within the video room)
  document.getElementById("start-discussion-btn").addEventListener("click", () => {
    send({ type: "start_discussion" });
  });

  // End discussion
  // Chat text input (fallback when STT isn't available)
  document.getElementById("chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;
    clearLocalSpeechDraft();
    addTranscriptEntry(myName, text, true, false);
    send({ type: "message", text, source: "text" });
    input.value = "";
  });

  document.getElementById("slow-speaker-toggle")?.addEventListener("change", (e) => {
    slowSpeakerMode = !!e.target.checked;
  });

  document.getElementById("plato-mic-toggle")?.addEventListener("click", () => {
    setPlatoMicMuted(!platoMicMuted, { syncJitsi: true, source: "app" });
  });
  renderPlatoMicState();

  document.getElementById("video-end-btn").addEventListener("click", () => {
    if (confirm("End the discussion for everyone?")) {
      flushSttBatch();
      send({ type: "end_discussion" });
    }
  });

  // ---- Speech Recognition (Deepgram via server relay) ----
  let sttStream = null;  // MediaStream (audio-only, for STT)
  let sttNode = null;    // AudioWorklet or ScriptProcessor
  let sttContext = null;  // AudioContext
  let sttActive = false;

  /**
   * Pre-acquire camera+mic in a single getUserMedia call so Safari only
   * shows ONE permission prompt. The video track is immediately stopped
   * (Jitsi will open its own), but the permission grant persists for the
   * page lifetime, so Jitsi's subsequent getUserMedia won't re-prompt.
   * The audio track is kept alive and reused for STT.
   */
  async function preAcquireMedia() {
    try {
      if (sttStream && sttStream.getAudioTracks().some(t => t.readyState === 'live')) {
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
      sttStream = new MediaStream(stream.getAudioTracks());
      console.log("[Media] Pre-acquired mic+camera permissions (single prompt)");
    } catch (e) {
      console.warn("[Media] Pre-acquire failed, will fall back to separate prompts:", e.message);
    }
  }

  async function startSpeechRecognition() {
    if (sttActive) {
      console.log("[STT] Already active, skipping");
      return;
    }
    if (isPlatoInputMuted()) {
      console.log("[STT] Plato mic is muted, not starting");
      return;
    }
    // Set flag immediately so duplicate start calls cannot open parallel STT streams.
    sttActive = true;

    try {
      // Reuse existing stream (from preAcquireMedia or previous STT session)
      if (!sttStream || sttStream.getAudioTracks().every(t => t.readyState === 'ended')) {
        sttStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
        });
        console.log("[STT] Mic access granted (new stream)");
      } else {
        console.log("[STT] Reusing existing mic stream");
      }
    } catch (e) {
      console.warn("[STT] Mic access denied:", e.message);
      sttActive = false; // Reset on failure
      return;
    }
    if (isPlatoInputMuted()) {
      console.log("[STT] Plato mic muted during startup, aborting stream");
      stopSpeechRecognition({ flush: false, releaseStream: true });
      return;
    }

    sttContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = sttContext.createMediaStreamSource(sttStream);
    const mutedSink = sttContext.createGain();
    mutedSink.gain.value = 0;
    mutedSink.connect(sttContext.destination);

    // Tell server to open Deepgram connection
    send({ type: "stt_start" });

    // Try AudioWorklet, fall back to ScriptProcessor
    if (window.AudioWorkletNode) {
      try {
        await sttContext.audioWorklet.addModule('/src/audio-processor.js');
        if (isPlatoInputMuted()) {
          stopSpeechRecognition({ flush: false, releaseStream: true });
          return;
        }
        sttNode = new AudioWorkletNode(sttContext, 'pcm-processor');
        sttNode.port.onmessage = (e) => {
          if (!isPlatoInputMuted() && sttActive && ws && ws.readyState === 1) {
            ws.send(e.data); // send raw Int16 PCM buffer
          }
        };
        source.connect(sttNode);
        sttNode.connect(mutedSink); // keep processing alive without locally monitoring the mic
      } catch (e) {
        console.warn("[STT] AudioWorklet failed, using ScriptProcessor:", e.message);
        setupScriptProcessor(source, mutedSink);
      }
    } else {
      setupScriptProcessor(source, mutedSink);
    }

    console.log("[STT] Streaming to Deepgram via server, sampleRate:", sttContext.sampleRate);
  }

  function setupScriptProcessor(source, mutedSink) {
    sttNode = sttContext.createScriptProcessor(2048, 1, 1);
    sttNode.onaudioprocess = (e) => {
      if (!isPlatoInputMuted() && sttActive && ws && ws.readyState === 1) {
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]));
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        ws.send(int16.buffer);
      }
    };
    source.connect(sttNode);
    sttNode.connect(mutedSink);
  }

  function stopSpeechRecognition(options = {}) {
    const { flush = true, releaseStream = false } = options;
    if (flush) {
      flushSttBatch();
    } else {
      discardSttBatch();
    }
    if (releaseStream && sttStream) {
      sttStream.getAudioTracks().forEach(track => {
        track.enabled = false;
      });
    }
    if (sttNode) {
      try { sttNode.disconnect(); } catch (e) {}
      sttNode = null;
    }
    if (sttContext) {
      try { sttContext.close(); } catch (e) {}
      sttContext = null;
    }
    // Don't destroy the stream — keep it for reuse to avoid re-prompting mic
    if (sttActive) {
      send({ type: "stt_stop" });
    }
    if (releaseStream && sttStream) {
      sttStream.getTracks().forEach(t => t.stop());
      sttStream = null;
    }
    // Always reset flag so reconnect can re-establish the Deepgram relay
    sttActive = false;
    console.log(`[STT] Stopped (${releaseStream ? "stream released" : "stream kept for reuse"})`);
  }

  function destroySttStream() {
    stopSpeechRecognition();
    if (sttStream) {
      sttStream.getTracks().forEach(t => t.stop());
      sttStream = null;
    }
  }

  // ---- Audio (TTS playback from server) ----
  let playbackContext;

  // Unlock AudioContext on first user gesture (required by Safari)
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

  // ---- Init ----
  loadAuthState();
  const savedState = loadState();
  if (shouldAutoRestore(savedState)) {
    // Show a loading state while we try to rejoin
    navigateTo("lobby", false);
    document.getElementById("session-code").textContent = savedState.currentSessionId;
    document.getElementById("participant-count").textContent = "Reconnecting...";
  } else {
    showScreen("welcome");
  }
  renderAuthState();
  renderClasses();
  renderSessionHistory();
  renderSetupContext();
  loadDemoTeacherConfig();
  refreshWorkspace();
  connect();
  checkDirectJoin();
  renderMaterials();

  // Initialize collapsible sections
  initCollapsibleSections();
  initAnalyticsModal();

  function initCollapsibleSections() {
    // Recent Sessions toggle
    const sessionToggle = document.getElementById('session-history-toggle');
    const sessionCard = document.getElementById('recent-sessions-card');
    if (sessionToggle && sessionCard) {
      if (localStorage.getItem('sessionHistoryCollapsed') === 'true') {
        sessionCard.classList.add('collapsed');
      }
      sessionToggle.addEventListener('click', () => {
        const now = sessionCard.classList.toggle('collapsed');
        localStorage.setItem('sessionHistoryCollapsed', now);
      });
    }

    // Saved Classes toggle (removed — now uses card grid)
  }

  function initAnalyticsModal() {
    const modal = document.getElementById('session-analytics-modal');
    const backdrop = document.getElementById('session-analytics-backdrop');
    const closeBtn = document.getElementById('analytics-close');

    if (backdrop) backdrop.addEventListener('click', hideAnalyticsModal);
    if (closeBtn) closeBtn.addEventListener('click', hideAnalyticsModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.classList.contains('active')) {
        hideAnalyticsModal();
      }
    });
  }

  function showSessionAnalytics(shortCode) {
    if (!accountUser) {
      console.warn('[Analytics] Requires sign-in');
      return;
    }

    const modal = document.getElementById('session-analytics-modal');
    const title = document.getElementById('analytics-title');
    const content = document.getElementById('analytics-content');

    // Show loading state
    title.textContent = `Session ${shortCode} - Analytics`;
    content.innerHTML = `
      <div class="analytics-loading">
        <div class="spinner"></div>
        <p>Loading detailed analytics...</p>
      </div>
    `;

    // Show modal (clear inline display:none, let .active class control visibility)
    modal.style.display = '';
    modal.classList.add('active');

    // Fetch analytics data
    apiGet(`/api/sessions/${shortCode}/analytics`)
      .then(data => {
        renderAnalyticsContent(data);
      })
      .catch(error => {
        console.error('Failed to load analytics:', error);
        content.innerHTML = `
          <div class="analytics-section">
            <p style="color: var(--text-secondary); text-align: center; padding: 40px;">
              Failed to load analytics: ${error.message}
            </p>
          </div>
        `;
      });
  }

  function hideAnalyticsModal() {
    const modal = document.getElementById('session-analytics-modal');
    modal.classList.remove('active');
    modal.style.display = 'none';
  }

  function renderAnalyticsContent(data) {
    const { session, analytics, messages = [] } = data;
    const content = document.getElementById('analytics-content');

    const formatDuration = (seconds) => {
      const mins = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${mins}m ${secs}s`;
    };

    const formatDateTime = (dateString) => {
      return new Date(dateString).toLocaleString();
    };

    const formatTime = (dateString) => {
      if (!dateString) return '';
      return new Date(dateString).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    };

    const transcriptHtml = messages.length
      ? messages.map(msg => {
          const isFacilitator = msg.senderType === 'facilitator';
          const sender = isFacilitator ? 'Plato' : (msg.senderName || 'Unknown');
          const move = msg.moveType ? ` <span class="transcript-move">${escapeHtml(msg.moveType)}</span>` : '';
          const target = msg.targetParticipantName ? ` <span class="transcript-time">to ${escapeHtml(msg.targetParticipantName)}</span>` : '';
          return `
            <div class="transcript-msg ${isFacilitator ? 'transcript-facilitator' : 'transcript-participant'}">
              <div class="transcript-msg-header">
                <span class="transcript-sender">${escapeHtml(sender)}</span>${move}${target}
                <span class="transcript-time">${formatTime(msg.createdAt)}</span>
              </div>
              <div class="transcript-msg-text">${escapeHtml(msg.content || '')}</div>
            </div>
          `;
        }).join('')
      : '<p class="empty-state">No transcript messages were saved for this session.</p>';

    content.innerHTML = `
      <!-- Session Overview -->
      <div class="analytics-section">
        <h3>Session Overview</h3>
        <div class="analytics-grid">
          <div class="analytics-metric">
            <span class="metric-value">${analytics.overview.participantCount}</span>
            <span class="metric-label">Participants</span>
          </div>
          <div class="analytics-metric">
            <span class="metric-value">${analytics.overview.messageCount}</span>
            <span class="metric-label">Messages</span>
          </div>
          <div class="analytics-metric">
            <span class="metric-value">${formatDuration(analytics.overview.durationSeconds)}</span>
            <span class="metric-label">Duration</span>
          </div>
          <div class="analytics-metric">
            <span class="metric-value">${analytics.overview.totalSpeakingTimeSeconds}s</span>
            <span class="metric-label">Total Speaking</span>
          </div>
        </div>
      </div>

      <!-- Discussion Quality -->
      <div class="analytics-section">
        <h3>Discussion Quality</h3>
        <div class="analytics-grid">
          <div class="analytics-metric">
            <span class="metric-value">${analytics.quality.avgSpecificity.toFixed(2)}</span>
            <span class="metric-label">Avg Specificity</span>
          </div>
          <div class="analytics-metric">
            <span class="metric-value">${analytics.quality.avgProfoundness.toFixed(2)}</span>
            <span class="metric-label">Avg Profoundness</span>
          </div>
          <div class="analytics-metric">
            <span class="metric-value">${analytics.quality.avgCoherence.toFixed(2)}</span>
            <span class="metric-label">Avg Coherence</span>
          </div>
          <div class="analytics-metric">
            <span class="metric-value">${analytics.quality.avgDiscussionValue.toFixed(2)}</span>
            <span class="metric-label">Avg Discussion Value</span>
          </div>
        </div>
        <div style="margin-top: 16px; font-size: 0.9rem; color: var(--text-secondary);">
          <strong>Engagement Metrics:</strong> ${analytics.quality.anchorReferences} anchor references,
          ${analytics.quality.peerResponses} peer responses, ${analytics.quality.anchorsCreated} anchors created
        </div>
      </div>

      <!-- Participant Breakdown -->
      <div class="analytics-section">
        <h3>Participant Breakdown</h3>
        <table class="participants-table">
          <thead>
            <tr>
              <th>Participant</th>
              <th>Role</th>
              <th>Messages</th>
              <th>Speaking Time</th>
              <th>Contribution</th>
              <th>Engagement</th>
              <th>Speaking %</th>
            </tr>
          </thead>
          <tbody>
            ${analytics.participants.map(p => `
              <tr>
                <td>
                  <span class="participant-name">${escapeHtml(p.name)}</span>
                  ${p.age ? `<br><small style="color: var(--text-muted);">Age: ${escapeHtml(String(p.age))}</small>` : ''}
                </td>
                <td><span class="participant-role">${escapeHtml(p.role)}</span></td>
                <td>${p.messageCount}</td>
                <td>${formatDuration(p.speakingSeconds)}</td>
                <td>${p.contributionScore.toFixed(2)}</td>
                <td>${p.engagementScore.toFixed(2)}</td>
                <td>
                  ${p.speakingPercentage}%
                  <div class="speaking-bar">
                    <div class="speaking-fill" style="width: ${p.speakingPercentage}%"></div>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Transcript -->
      <div class="analytics-section">
        <h3>Transcript</h3>
        <div class="transcript-feed">
          ${transcriptHtml}
        </div>
      </div>

      <!-- Session Details -->
      <div class="analytics-section">
        <h3>Session Details</h3>
        <div style="background: var(--surface-alt); padding: 16px; border-radius: 10px; font-size: 0.9rem;">
          <strong>Title:</strong> ${escapeHtml(session.title)}<br>
          <strong>Status:</strong> ${escapeHtml(session.status)}<br>
          <strong>Started:</strong> ${formatDateTime(session.createdAt)}<br>
          ${session.endedAt ? `<strong>Ended:</strong> ${formatDateTime(session.endedAt)}` : ''}
        </div>
      </div>
    `;
  }
})();
