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
  let demoTeacherConfig = { enabled: false, name: "", email: "" };
  const MAX_MATERIALS = 5;
  let sttBatchBuffer = '';
  let sttBatchTimer = null;
  let lastInterimTranscript = '';
  let discussionActive = false;
  let currentScreen = "welcome";
  const STT_FLUSH_MS_WARMUP = 4000;
  const STT_FLUSH_MS_DISCUSSION = 3000;

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
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
  }

  // ---- DOM Elements ----
  const screens = {
    welcome: document.getElementById("welcome-screen"),
    setup: document.getElementById("setup-screen"),
    lobby: document.getElementById("lobby-screen"),
    video: document.getElementById("video-screen")
  };

  function showScreen(name) {
    currentScreen = name;
    Object.values(screens).forEach(s => s && s.classList.remove("active"));
    if (screens[name]) screens[name].classList.add("active");
  }

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
      console.log("[WS] Disconnected. Code:", event.code, "Reason:", event.reason, "— reconnecting in 2s...");
      setTimeout(connect, 2000);
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

  function renderAuthState() {
    const signedOut = document.getElementById("auth-signed-out");
    const signedIn = document.getElementById("auth-signed-in");
    const classCreation = document.getElementById("class-creation");
    const classesLocked = document.getElementById("classes-locked");
    const accountName = document.getElementById("account-name");
    const accountEmail = document.getElementById("account-email");
    const classHelp = document.getElementById("session-class-help");
    const demoLoginSection = document.getElementById("demo-login-section");
    const demoLoginCopy = document.getElementById("demo-login-copy");

    if (demoLoginSection) {
      demoLoginSection.style.display = !accountUser && demoTeacherConfig.enabled ? "block" : "none";
    }
    if (demoLoginCopy && demoTeacherConfig.enabled) {
      demoLoginCopy.textContent = `Use ${demoTeacherConfig.name} (${demoTeacherConfig.email}) for quick teacher access.`;
    }

    if (accountUser) {
      signedOut.style.display = "none";
      signedIn.style.display = "block";
      classCreation.style.display = canManageClasses() ? "block" : "none";
      classesLocked.style.display = canManageClasses() ? "none" : "block";
      accountName.textContent = accountUser.name;
      accountEmail.textContent = `${accountUser.email}${accountUser.role ? ` · ${accountUser.role}` : ""}`;
      if (!document.getElementById("name-input").value.trim()) {
        document.getElementById("name-input").value = getDisplayNameFromAccount();
      }
      if (classHelp) {
        classHelp.textContent = canManageClasses()
          ? "Choose a class to keep this session in your saved workspace."
          : "Your account can join sessions and keep history, but class management is limited.";
      }
    } else {
      signedOut.style.display = "block";
      signedIn.style.display = "none";
      classCreation.style.display = "none";
      classesLocked.style.display = "block";
      if (classHelp) {
        classHelp.textContent = "Sign in to organize sessions by class and keep a history.";
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

    if (savedClasses.length === 0) {
      list.innerHTML = '<p class="empty-state">No classes yet. Create your first one here.</p>';
    } else {
      list.innerHTML = savedClasses.map(cls => `
        <div class="workspace-item">
          <strong>${escapeHtml(cls.name)}</strong>
          <div class="workspace-item-meta">${escapeHtml(cls.description || "No notes yet.")}</div>
          <span class="workspace-item-tag">${cls.sessionCount} saved session${cls.sessionCount === 1 ? "" : "s"}${cls.ageRange ? ` · Ages ${escapeHtml(cls.ageRange)}` : ""}</span>
        </div>
      `).join("");
    }

    savedClasses.forEach(cls => {
      const option = document.createElement("option");
      option.value = cls.id;
      option.textContent = cls.name;
      select.appendChild(option);
    });

    if (savedClasses.some(cls => cls.id === previousValue)) {
      select.value = previousValue;
    }
  }

  function renderSessionHistory() {
    const list = document.getElementById("session-history-list");

    if (!accountUser) {
      list.innerHTML = '<p class="empty-state">Sign in to see session history.</p>';
      return;
    }

    if (sessionHistory.length === 0) {
      list.innerHTML = '<p class="empty-state">No saved sessions yet. Your newly created rooms will show up here.</p>';
      return;
    }

    list.innerHTML = sessionHistory.map(session => `
      <div class="workspace-item">
        <strong>${escapeHtml(session.title)}</strong>
        <div class="workspace-item-meta">
          ${escapeHtml(session.className || "Unassigned")} · ${escapeHtml(session.status)} · ${escapeHtml(session.viewerRole || "Member")}<br>
          ${session.participantCount} participants · ${session.messageCount} messages · ${formatDateTime(session.createdAt)}<br>
          You spoke about ${Math.round(Number(session.viewerSpeakingSeconds || 0))}s · contribution ${Number(session.viewerContributionScore || 0).toFixed(2)}
        </div>
        <span class="workspace-item-tag">Code ${escapeHtml(session.shortCode)}</span>
      </div>
    `).join("");
  }

  async function refreshWorkspace() {
    renderAuthState();

    if (!authToken) {
      savedClasses = [];
      sessionHistory = [];
      renderClasses();
      renderSessionHistory();
      return;
    }

    try {
      const [me, classes, history] = await Promise.all([
        apiGet("/api/auth/me"),
        apiGet("/api/classes"),
        apiGet("/api/sessions/history")
      ]);
      accountUser = me.user;
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(accountUser));
      savedClasses = classes;
      sessionHistory = history;
      renderAuthState();
      renderClasses();
      renderSessionHistory();
    } catch (error) {
      console.warn("[Auth] Workspace refresh failed:", error.message);
      clearAuthState();
      renderAuthState();
      renderClasses();
      renderSessionHistory();
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

    // Show dashboard link for host
    const dashLink = document.getElementById("dashboard-link");
    if (dashLink && isHost) {
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

  // ---- Message Handlers ----
  function handleServerMessage(msg) {
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

      case "session_joined":
        currentSessionId = msg.sessionId;
        discussionActive = false;
        resetConversationFeed();
        myId = msg.yourId;
        participants = msg.participants;
        updateParticipantList();
        showShareInfo(msg.sessionId);
        if (msg.topicTitle) {
          document.getElementById("lobby-topic").textContent = msg.topicTitle;
          document.getElementById("lobby-topic-section").style.display = "block";
        }
        showScreen("lobby");
        saveState();

        // Pre-fill name input in case we need it
        document.getElementById("name-input").value = myName;

        // If host, prime materials now that session exists
        if (isHost && materials.length > 0) {
          primeMaterials();
        }
        break;

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
        showScreen("video");
        launchJitsi(currentSessionId, myName);
        startSpeechRecognition();
        // Only the host sees the Start Discussion button
        document.getElementById("start-discussion-btn").style.display = isHost ? "" : "none";
        saveState();
        break;

      case "discussion_started":
        discussionActive = true;
        // If already in video room (warmup → active), just hide the start button
        if (!document.getElementById("video-screen").classList.contains("active")) {
          showScreen("video");
          launchJitsi(currentSessionId, myName);
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

      case "discussion_ended":
        discussionActive = false;
        addFacilitatorMessage("The discussion has ended. Thank you for participating.", "closing");
        destroySttStream();
        destroyJitsi();
        clearState();
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
        if (m.type === "file") {
          const formData = new FormData();
          formData.append("file", m.file);
          await fetch(`/api/sessions/${currentSessionId}/materials`, {
            method: "POST",
            headers: getAuthHeaders(),
            body: formData
          });
        } else if (m.type === "url") {
          await apiPost(`/api/sessions/${currentSessionId}/materials`, { url: m.url });
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
      const icon = m.type === "url" ? "&#128279;" : "&#128196;";
      div.innerHTML = `
        <span class="material-icon">${icon}</span>
        <span class="material-name">${escapeHtml(m.name)}</span>
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

    const div = document.createElement("div");
    if (name === "system") {
      div.className = "transcript-system";
      div.textContent = text;
    } else {
      div.className = `transcript-entry ${isSelf ? "self" : ""}`;
      div.innerHTML = `<strong>${escapeHtml(name)}:</strong> ${escapeHtml(text)}`;
    }
    container.appendChild(div);
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

  async function handleRegister() {
    const name = document.getElementById("auth-name-input").value.trim();
    const email = document.getElementById("auth-email-input").value.trim();
    const password = document.getElementById("auth-password-input").value;
    const role = document.getElementById("auth-role-select").value;

    if (!name || !email || !password) {
      alert("Enter your name, email, and password to create an account.");
      return;
    }

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
      document.getElementById("new-class-name").value = "";
      document.getElementById("new-class-age-range").value = "";
      document.getElementById("new-class-description").value = "";
      renderClasses();
    } catch (error) {
      alert(error.message);
    }
  }

  function handleLogout() {
    clearAuthState();
    renderAuthState();
    renderClasses();
    renderSessionHistory();
    document.getElementById("session-class-select").value = "";
  }

  // ---- Event Listeners ----

  document.getElementById("register-btn").addEventListener("click", handleRegister);
  document.getElementById("login-btn").addEventListener("click", handleLogin);
  document.getElementById("demo-login-btn")?.addEventListener("click", handleDemoTeacherLogin);
  document.getElementById("create-class-btn").addEventListener("click", handleCreateClass);
  document.getElementById("logout-btn").addEventListener("click", handleLogout);

  // Show/hide join section
  document.getElementById("join-toggle-btn").addEventListener("click", () => {
    const section = document.getElementById("join-section");
    section.style.display = section.style.display === "none" ? "flex" : "none";
  });

  // Create button → setup screen
  document.getElementById("create-btn").addEventListener("click", () => {
    myName = document.getElementById("name-input").value.trim();
    if (!myName) { alert("Enter your name"); return; }
    if (accountUser && !canManageClasses()) {
      alert("Only teachers and admins can create sessions right now.");
      return;
    }
    abandonDraftSession();
    showScreen("setup");
  });

  // Back from setup
  document.getElementById("back-to-welcome-btn")?.addEventListener("click", () => {
    abandonDraftSession();
    showScreen("welcome");
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
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (e.target !== uploadArea && !uploadArea.contains(e.target)) {
      e.preventDefault();
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

  // Join existing session
  document.getElementById("join-btn").addEventListener("click", () => {
    myName = document.getElementById("name-input").value.trim();
    const code = document.getElementById("join-code-input").value.trim().toLowerCase();
    if (!myName) { alert("Enter your name"); return; }
    if (!code) { alert("Enter a session code"); return; }
    send({ type: "join_session", sessionId: code, name: myName, age: getAge(), authToken });
  });

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
  let sttStream = null;  // MediaStream
  let sttNode = null;    // AudioWorklet or ScriptProcessor
  let sttContext = null;  // AudioContext
  let sttActive = false;

  async function startSpeechRecognition() {
    if (sttActive) {
      console.log("[STT] Already active, skipping");
      return;
    }
    // Set flag IMMEDIATELY to prevent race condition with Jitsi's audioMuteStatusChanged event
    sttActive = true;

    try {
      // Reuse existing stream to avoid re-prompting mic permissions
      if (!sttStream || sttStream.getTracks().every(t => t.readyState === 'ended')) {
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
      sttActive = false;
    }
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
    showScreen("lobby");
    document.getElementById("session-code").textContent = savedState.currentSessionId;
    document.getElementById("participant-count").textContent = "Reconnecting...";
  } else {
    showScreen("welcome");
  }
  renderAuthState();
  renderClasses();
  renderSessionHistory();
  loadDemoTeacherConfig();
  refreshWorkspace();
  connect();
  checkDirectJoin();
  renderMaterials();
})();
