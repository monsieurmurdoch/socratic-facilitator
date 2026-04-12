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
  let authToken = null;
  let accountUser = null;
  let savedClasses = [];
  let sessionHistory = [];
  let classTimeline = [];
  let selectedClassSummary = null;
  let selectedClassLiveSession = null;
  let pendingRoomJoin = null;
  let sessionHistoryQuery = "";
  let sessionSearchTimer = null;
  let selectedClassId = null;
  let editingClassId = null;
  let demoTeacherConfig = null; // null until server responds
  const MAX_MATERIALS = 5;
  let sttBatchBuffer = '';
  let sttBatchTimer = null;
  let lastInterimTranscript = '';
  let discussionActive = false;
  let currentScreen = "welcome";
  const STT_FLUSH_MS_WARMUP = 1200;
  const STT_FLUSH_MS_DISCUSSION = 800;
  let wsReconnectDelay = 1000; // exponential backoff starting at 1s
  const WS_RECONNECT_MAX = 30000; // cap at 30s

  // ---- State Persistence ----
  const STORAGE_KEY = "socratic_state";
  const AUTH_TOKEN_KEY = "socratic_auth_token";
  const AUTH_USER_KEY = "socratic_auth_user";

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
    sttBatchBuffer = "";
    lastInterimTranscript = "";
    clearTimeout(sttBatchTimer);
    sttBatchTimer = null;
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
  }

  // Navigate to a screen and push browser history so the back button works
  function navigateTo(name, pushHistory = true) {
    const prev = currentScreen;
    showScreen(name);
    if (pushHistory && prev !== name) {
      window.history.pushState({ screen: name }, '');
    }
  }

  // Handle browser back/forward buttons
  window.addEventListener('popstate', (e) => {
    if (e.state?.screen) {
      showScreen(e.state.screen);
    } else {
      showScreen('welcome');
    }
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
          authToken
        });
        return;
      }

      // If we have a pending join from URL, auto-join once connected
      const params = new URLSearchParams(window.location.search);
      const joinCode = params.get("join");
      if (joinCode && myName) {
        send({ type: "join_session", sessionId: joinCode, name: myName, age: getAge(), authToken });
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
    renderMaterials();
  }

  function getSelectedClass() {
    return savedClasses.find(cls => cls.id === selectedClassId) || null;
  }

  function escapeAttribute(value) {
    return escapeHtml(String(value || "")).replace(/"/g, "&quot;");
  }

  function renderClasses() {
    const list = document.getElementById("classes-list");
    const select = document.getElementById("session-class-select");
    const previousValue = select.value;

    select.innerHTML = '<option value="">Not linked to a class</option>';

    if (!accountUser) {
      list.innerHTML = '<p class="empty-state">Sign in to create and reuse classes.</p>';
      return;
    }

    if (!canManageClasses() && savedClasses.length === 0) {
      list.innerHTML = '<p class="empty-state">No class memberships yet.</p>';
      return;
    }

    if (!selectedClassId && savedClasses.length > 0) {
      selectedClassId = savedClasses[0].id;
    }

    const orderedClasses = savedClasses;

    if (orderedClasses.length === 0) {
      list.innerHTML = '<p class="empty-state">No classes yet. Create your first class room here.</p>';
    } else {
      list.innerHTML = orderedClasses.map(cls => {
        const isSelected = cls.id === selectedClassId;
        const isEditing = cls.id === editingClassId;
        if (isEditing) {
          return `
            <div class="workspace-item class-item class-item-selected class-item-editing" data-class-id="${escapeHtml(cls.id)}">
              <input type="text" class="class-edit-name" value="${escapeHtml(cls.name)}" placeholder="Class name">
              <input type="text" class="class-edit-age" value="${escapeHtml(cls.ageRange || '')}" placeholder="Age range (e.g. 14-15)">
              <textarea class="class-edit-desc" placeholder="Notes">${escapeHtml(cls.description || '')}</textarea>
              <div class="class-edit-actions">
                <button class="btn btn-small btn-primary class-save-btn">Save</button>
                <button class="btn btn-small btn-secondary class-cancel-btn">Cancel</button>
              </div>
            </div>`;
        }
        return `
          <div class="workspace-item class-item${isSelected ? ' class-item-selected' : ''}" data-class-id="${escapeHtml(cls.id)}" draggable="true">
            <span class="class-drag-handle" title="Drag to reorder">&#9776;</span>
            <div class="class-item-main">
              <strong>${escapeHtml(cls.name)}</strong>
              <div class="workspace-item-meta">${escapeHtml(cls.description || "No notes yet.")}</div>
              <div class="class-item-tags">
                <span class="workspace-item-tag code-badge code-badge-room">${escapeHtml(cls.roomCode || "pending")}</span>
                <span class="workspace-item-tag">${cls.sessionCount} session${cls.sessionCount === 1 ? "" : "s"}${cls.ageRange ? ` · Ages ${escapeHtml(cls.ageRange)}` : ""}</span>
              </div>
            </div>
            <button class="class-edit-btn" title="Edit class">&#9998;</button>
          </div>`;
      }).join("");

      // Bind click, edit, drag handlers
      list.querySelectorAll('.class-item').forEach(item => {
        const classId = item.dataset.classId;

        // Select on click (main area only)
        const main = item.querySelector('.class-item-main');
        if (main) {
          main.addEventListener('click', () => {
            selectedClassId = classId;
            renderClasses();
            loadSelectedClassTimeline();
          });
          main.style.cursor = 'pointer';
        }

        // Edit button
        const editBtn = item.querySelector('.class-edit-btn');
        if (editBtn) {
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingClassId = classId;
            renderClasses();
          });
        }

        // Save button (in edit mode)
        const saveBtn = item.querySelector('.class-save-btn');
        if (saveBtn) {
          saveBtn.addEventListener('click', async () => {
            const name = item.querySelector('.class-edit-name').value.trim();
            const ageRange = item.querySelector('.class-edit-age').value.trim() || null;
            const description = item.querySelector('.class-edit-desc').value.trim() || null;
            if (!name) { alert("Class name cannot be empty"); return; }
            saveBtn.disabled = true;
            saveBtn.textContent = "Saving...";
            try {
              const updated = await apiPatch(`/api/classes/${classId}`, { name, ageRange, description });
              const idx = savedClasses.findIndex(c => c.id === classId);
              if (idx !== -1) savedClasses[idx] = { ...savedClasses[idx], ...updated };
              editingClassId = null;
              renderClasses();
            } catch (err) {
              alert("Failed to save: " + err.message);
              saveBtn.disabled = false;
              saveBtn.textContent = "Save";
            }
          });
        }

        // Cancel button (in edit mode)
        const cancelBtn = item.querySelector('.class-cancel-btn');
        if (cancelBtn) {
          cancelBtn.addEventListener('click', () => {
            editingClassId = null;
            renderClasses();
          });
        }

        // Drag and drop
        item.addEventListener('dragstart', (e) => {
          item.classList.add('class-item-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', classId);
        });
        item.addEventListener('dragend', () => {
          item.classList.remove('class-item-dragging');
          list.querySelectorAll('.class-item').forEach(el => el.classList.remove('class-item-drop-above', 'class-item-drop-below'));
        });
        item.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const rect = item.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          list.querySelectorAll('.class-item').forEach(el => el.classList.remove('class-item-drop-above', 'class-item-drop-below'));
          item.classList.add(e.clientY < midY ? 'class-item-drop-above' : 'class-item-drop-below');
        });
        item.addEventListener('dragleave', () => {
          item.classList.remove('class-item-drop-above', 'class-item-drop-below');
        });
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          const draggedId = e.dataTransfer.getData('text/plain');
          if (draggedId === classId) return;
          const ids = orderedClasses.map(c => c.id);
          const fromIdx = ids.indexOf(draggedId);
          if (fromIdx === -1) return;
          ids.splice(fromIdx, 1);
          const rect = item.getBoundingClientRect();
          const toIdx = ids.indexOf(classId);
          const insertIdx = e.clientY < rect.top + rect.height / 2 ? toIdx : toIdx + 1;
          ids.splice(insertIdx, 0, draggedId);
          // Reorder locally for instant feedback, then persist to server
          const draggedCls = savedClasses.find(c => c.id === draggedId);
          savedClasses.splice(savedClasses.indexOf(draggedCls), 1);
          savedClasses.splice(insertIdx, 0, draggedCls);
          renderClasses();
          apiPatch('/api/classes/reorder', { order: ids }).catch(err => {
            console.warn('[Classes] Reorder failed:', err.message);
            refreshWorkspace(); // revert on failure
          });
        });
      });
    }

    // Populate dropdown in display order
    orderedClasses.forEach(cls => {
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

    renderClassRoomSummary();
    renderSetupContext();
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
          <div class="timeline-header">
            <div>
              <strong>${selectedClass ? `Session ${String(session.ordinal || source.length - index).padStart(2, '0')}` : escapeHtml(session.title)}</strong>
              <div class="workspace-item-meta timeline-subtitle">
                ${selectedClass ? escapeHtml(session.title) : escapeHtml(session.className || "Quick Session")} · ${formatDateTime(session.createdAt)}
              </div>
            </div>
            <span class="workspace-item-tag timeline-status-tag">${escapeHtml(session.status)}</span>
          </div>
          <div class="workspace-item-meta timeline-stats">
            ${session.participantCount} participants · ${session.messageCount} messages · You spoke about ${Math.round(Number(session.viewerSpeakingSeconds || 0))}s · contribution ${Number(session.viewerContributionScore || 0).toFixed(2)}
          </div>
          <p class="timeline-summary">${escapeHtml(buildSessionSummary(session))}</p>
          ${(session.matchedParticipant || session.searchExcerpt) ? `
            <div class="timeline-search-hit">
              ${session.matchedParticipant ? `<span class="search-hit-pill">Matched student: ${escapeHtml(session.matchedParticipant)}</span>` : ""}
              ${session.searchExcerpt ? `<p>“${escapeHtml(session.searchExcerpt)}${session.searchExcerpt.length >= 220 ? "…" : ""}”</p>` : ""}
            </div>
          ` : ""}
          <div class="timeline-actions">
            <button class="btn btn-secondary btn-small timeline-open-btn" data-shortcode="${escapeAttribute(session.shortCode)}">Open Analytics</button>
            <span class="workspace-item-tag code-badge code-badge-session">${escapeHtml(session.shortCode)}</span>
          </div>
        </div>
      </div>
    `).join("");

    document.querySelectorAll('.timeline-open-btn').forEach(btn => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        showSessionAnalytics(btn.dataset.shortcode);
      });
    });
  }

  function renderClassRoomSummary() {
    const summary = document.getElementById("class-room-summary");
    if (!summary) return;

    const cls = selectedClassSummary || getSelectedClass();
    if (!cls) {
      summary.className = "room-summary empty-state";
      summary.innerHTML = 'Choose a class to see its room code, live session status, and timeline.';
      return;
    }

    const liveSession = selectedClassLiveSession;
    summary.className = "room-summary";
    summary.innerHTML = `
      <div class="room-summary-hero">
        <div>
          <span class="room-summary-label">Class Room</span>
          <h4>${escapeHtml(cls.name)}</h4>
          <p>${escapeHtml(cls.description || "A persistent room for this class. Students can keep using the same code across meetings.")}</p>
        </div>
        <div class="room-code-card">
          <span class="room-code-label">Stable room code</span>
          <strong id="selected-room-code">${escapeHtml(cls.roomCode || "pending")}</strong>
          <button id="copy-room-code-btn" class="btn btn-secondary btn-small">Copy Code</button>
        </div>
      </div>
      <div class="room-summary-metrics">
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
      <div class="room-summary-actions">
        <button id="start-class-session-btn" class="btn btn-primary">Start Session In This Room</button>
        ${liveSession ? `<button id="join-live-session-btn" class="btn btn-secondary">Join Live Session</button>` : ""}
      </div>
      <p class="room-code-note">Room codes stay the same for the class. Live session codes change each time you start a new session.</p>
    `;

    document.getElementById("copy-room-code-btn")?.addEventListener("click", () => {
      navigator.clipboard.writeText(cls.roomCode || "").then(() => {
        const btn = document.getElementById("copy-room-code-btn");
        if (!btn) return;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = "Copy Code"; }, 1200);
      });
    });

    document.getElementById("start-class-session-btn")?.addEventListener("click", () => {
      myName = accountUser?.name || "";
      if (!myName) {
        alert("Sign in first.");
        return;
      }
      openSetupForClass(cls.id, { suggestedTitle: `${cls.name} Discussion` });
    });

    document.getElementById("join-live-session-btn")?.addEventListener("click", () => {
      if (!liveSession?.shortCode) return;
      myName = accountUser?.name || "";
      send({ type: "join_session", sessionId: liveSession.shortCode, name: myName, age: getAge(), authToken });
    });
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

  async function refreshWorkspace() {
    renderAuthState();

    if (!authToken) {
      savedClasses = [];
      sessionHistory = [];
      classTimeline = [];
      selectedClassSummary = null;
      selectedClassLiveSession = null;
      renderClasses();
      renderSessionHistory();
      renderClassRoomSummary();
      return;
    }

    try {
      const historyPath = `/api/sessions/history${sessionHistoryQuery ? `?q=${encodeURIComponent(sessionHistoryQuery)}` : ''}`;
      const [me, classes, history] = await Promise.all([
        apiGet("/api/auth/me"),
        apiGet("/api/classes"),
        apiGet(historyPath)
      ]);
      accountUser = me.user;
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(accountUser));
      savedClasses = classes;
      sessionHistory = history;
      if (selectedClassId && !savedClasses.some(cls => cls.id === selectedClassId)) {
        selectedClassId = null;
      }
      if (!selectedClassId && savedClasses.length > 0) {
        selectedClassId = savedClasses[0].id;
      }
      renderAuthState();
      renderClasses();
      renderSessionHistory();
      loadSelectedClassTimeline();
      renderSetupContext();
    } catch (error) {
      console.warn("[Auth] Workspace refresh failed:", error.message);
      clearAuthState();
      renderAuthState();
      renderClasses();
      renderSessionHistory();
      renderClassRoomSummary();
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
    try {
      await loadJitsiScript();
    } catch (e) {
      console.error("[Jitsi] Failed to load script:", e);
      alert("Failed to load video call. Check your connection and try again.");
      return;
    }

    if (jitsiApi) {
      jitsiApi.dispose();
    }

    const container = document.getElementById("jitsi-container");

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
      roomName: `${JAAS_APP_ID}/socratic-${roomName}`,
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
          'microphone', 'camera', 'desktop', 'fullscreen',
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
      send({ type: "end_discussion" });
    });

    jitsiApi.addEventListener('videoConferenceLeft', () => {
      console.log('[Jitsi] Left conference');
    });

    jitsiApi.addEventListener('audioMuteStatusChanged', (event) => {
      console.log('[Jitsi] Audio mute:', event.muted);
      if (event.muted) {
        stopSpeechRecognition();
      } else {
        startSpeechRecognition();
      }
    });

    jitsiApi.addEventListener('errorOccurred', (event) => {
      console.error('[Jitsi] Error:', event);
    });

    console.log('[Jitsi] Launched room:', roomName);
  }

  function destroyJitsi() {
    if (jitsiApi) {
      jitsiApi.dispose();
      jitsiApi = null;
    }
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
        send({ type: "join_session", sessionId: msg.sessionId, name: myName, age: getAge(), authToken });
        isHost = true;
        break;

      case "session_ended_readonly": {
        // Tried to join an ended session — show read-only transcript
        const overlay = document.getElementById("readonly-overlay");
        const feed = document.getElementById("readonly-feed");
        const titleEl = document.getElementById("readonly-title");
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

      case "session_joined": {
        const isRejoin = currentSessionId === msg.sessionId && myId === msg.yourId;
        currentSessionId = msg.sessionId;
        discussionActive = false;
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

      case "participant_joined":
        participants.push({ name: msg.name });
        updateParticipantList();
        document.getElementById("participant-count").textContent = `${msg.participantCount} participants`;
        break;

      case "participant_left":
        participants = participants.filter(p => p.name !== msg.name);
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
          await fetch(`/api/sessions/${currentSessionId}/materials`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: formData
          });
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
    const container = document.getElementById("materials-list");
    const countEl = document.getElementById("material-count");
    container.innerHTML = "";
    countEl.textContent = `(${materials.length}/${MAX_MATERIALS})`;

    materials.forEach((m, i) => {
      const div = document.createElement("div");
      div.className = "material-item";
      const icon = m.type === "url" ? "&#128279;" : m.type === "text" ? "&#182;" : "&#128196;";
      const badge = m.fromClass ? ' <span class="material-badge">from class</span>' : '';
      div.innerHTML = `
        <span class="material-icon">${icon}</span>
        <span class="material-name">${escapeHtml(m.name)}${badge}</span>
        <button class="material-remove" data-index="${i}">&times;</button>
      `;
      container.appendChild(div);
    });

    // Disable upload if at limit
    const uploadArea = document.getElementById("upload-area");
    if (materials.length >= MAX_MATERIALS) {
      uploadArea.style.opacity = "0.5";
      uploadArea.style.pointerEvents = "none";
    } else {
      uploadArea.style.opacity = "1";
      uploadArea.style.pointerEvents = "auto";
    }
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
        send({ type: "join_session", sessionId: resolved.sessionShortCode, name: myName, age: getAge(), authToken });
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
        renderMaterials();
      }
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
    return discussionActive ? STT_FLUSH_MS_DISCUSSION : STT_FLUSH_MS_WARMUP;
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

  function scheduleSttFlush() {
    clearTimeout(sttBatchTimer);
    sttBatchTimer = setTimeout(() => {
      flushSttBatch();
    }, getSttFlushDelay());
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
    badge.className = `status-badge ${status}`;
    badge.textContent = status === "speaking" ? "Speaking" : "Listening";
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
      if (tileStatus) tileStatus.textContent = "Listening";
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
      document.getElementById("new-class-name").value = "";
      document.getElementById("new-class-age-range").value = "";
      document.getElementById("new-class-description").value = "";
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

  ["join-code-input", "join-code-input-teacher", "join-code-input-student"].forEach((id) => {
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
    if (materials.length >= MAX_MATERIALS) return;
    const input = document.getElementById("url-input");
    const url = input.value.trim();
    if (url) {
      // Truncate display name
      const displayName = url.length > 50 ? url.substring(0, 47) + "..." : url;
      materials.push({ type: "url", name: displayName, url: url });
      input.value = "";
      renderMaterials();
    }
  });

  document.getElementById("add-text-btn")?.addEventListener("click", () => {
    if (materials.length >= MAX_MATERIALS) return;
    const input = document.getElementById("paste-text-input");
    const text = input?.value?.trim() || "";
    if (!text) return;
    const firstLine = text.split(/\r?\n/).find(Boolean) || "Pasted text";
    const name = firstLine.length > 42 ? `${firstLine.slice(0, 39)}...` : firstLine;
    materials.push({
      type: "text",
      name: name || "Pasted source text",
      text,
      extractedText: text
    });
    input.value = "";
    renderMaterials();
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
      refreshWorkspace();
      currentSessionId = session.shortCode;
      isHost = true;
      send({
        type: "join_session",
        sessionId: session.shortCode,
        name: myName,
        age: getAge(),
        authToken
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
      send({ type: "join_session", sessionId: joinCode, name: myName, age: getAge(), authToken });
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

  document.getElementById("video-end-btn").addEventListener("click", () => {
    if (confirm("End the discussion for everyone?")) {
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
    // Set flag IMMEDIATELY to prevent race condition with Jitsi's audioMuteStatusChanged event
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

    sttContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = sttContext.createMediaStreamSource(sttStream);

    // Tell server to open Deepgram connection
    send({ type: "stt_start" });

    // Try AudioWorklet, fall back to ScriptProcessor
    if (window.AudioWorkletNode) {
      try {
        await sttContext.audioWorklet.addModule('/src/audio-processor.js');
        sttNode = new AudioWorkletNode(sttContext, 'pcm-processor');
        sttNode.port.onmessage = (e) => {
          if (ws && ws.readyState === 1) {
            ws.send(e.data); // send raw Int16 PCM buffer
          }
        };
        source.connect(sttNode);
        sttNode.connect(sttContext.destination); // required to keep processing alive
      } catch (e) {
        console.warn("[STT] AudioWorklet failed, using ScriptProcessor:", e.message);
        setupScriptProcessor(source);
      }
    } else {
      setupScriptProcessor(source);
    }

    console.log("[STT] Streaming to Deepgram via server, sampleRate:", sttContext.sampleRate);
  }

  function setupScriptProcessor(source) {
    sttNode = sttContext.createScriptProcessor(2048, 1, 1);
    sttNode.onaudioprocess = (e) => {
      if (ws && ws.readyState === 1) {
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
    sttNode.connect(sttContext.destination);
  }

  function stopSpeechRecognition() {
    flushSttBatch();
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
    // Always reset flag so reconnect can re-establish the Deepgram relay
    sttActive = false;
    console.log("[STT] Stopped (stream kept for reuse)");
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

    // Saved Classes toggle
    const classesToggle = document.getElementById('classes-toggle');
    const classesCard = document.getElementById('saved-classes-card');
    if (classesToggle && classesCard) {
      if (localStorage.getItem('classesCollapsed') === 'true') {
        classesCard.classList.add('collapsed');
      }
      classesToggle.addEventListener('click', () => {
        const now = classesCard.classList.toggle('collapsed');
        localStorage.setItem('classesCollapsed', now);
      });
    }
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
    const { session, analytics } = data;
    const content = document.getElementById('analytics-content');

    const formatDuration = (seconds) => {
      const mins = Math.floor(seconds / 60);
      const secs = Math.round(seconds % 60);
      return `${mins}m ${secs}s`;
    };

    const formatDateTime = (dateString) => {
      return new Date(dateString).toLocaleString();
    };

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
