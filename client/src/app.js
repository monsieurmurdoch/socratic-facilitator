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
  const MAX_MATERIALS = 5;

  // ---- State Persistence ----
  const STORAGE_KEY = "socratic_state";

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        myName,
        myId,
        currentSessionId,
        isHost,
        participants,
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
  }

  // ---- DOM Elements ----
  const screens = {
    welcome: document.getElementById("welcome-screen"),
    setup: document.getElementById("setup-screen"),
    lobby: document.getElementById("lobby-screen"),
    video: document.getElementById("video-screen")
  };

  function showScreen(name) {
    Object.values(screens).forEach(s => s && s.classList.remove("active"));
    if (screens[name]) screens[name].classList.add("active");
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
      if (saved && saved.currentSessionId && saved.myId) {
        console.log("[WS] Restoring session:", saved.currentSessionId, "as", saved.myName);
        myName = saved.myName;
        myId = saved.myId;
        currentSessionId = saved.currentSessionId;
        isHost = saved.isHost;
        send({
          type: "rejoin_session",
          sessionId: saved.currentSessionId,
          oldClientId: saved.myId
        });
        return;
      }

      // If we have a pending join from URL, auto-join once connected
      const params = new URLSearchParams(window.location.search);
      const joinCode = params.get("join");
      if (joinCode && myName) {
        send({ type: "join_session", sessionId: joinCode, name: myName, age: getAge() });
      }
    };
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        playAudioBuffer(event.data);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `Server error ${res.status}`);
    }
    return json;
  }

  async function apiGet(endpoint) {
    const res = await fetch(endpoint);
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `Server error ${res.status}`);
    }
    return json;
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
        send({ type: "join_session", sessionId: msg.sessionId, name: myName, age: getAge() });
        isHost = true;
        break;

      case "session_joined":
        currentSessionId = msg.sessionId;
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
        showScreen("video");
        launchJitsi(currentSessionId, myName);
        startSpeechRecognition();
        document.getElementById("start-discussion-btn").style.display = "";
        saveState();
        break;

      case "discussion_started":
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
        addTranscriptEntry(msg.name, msg.text, msg.name === myName);
        break;

      case "participant_partial":
        updatePartialTranscript(msg.name, msg.text);
        break;

      case "facilitator_message":
        addFacilitatorMessage(msg.text, msg.move);
        setFacilitatorStatus("speaking");
        setPlatoTileSpeaking(msg.text);
        // Use browser TTS as fallback when server TTS isn't available
        speakWithBrowserTTS(msg.text);
        break;

      case "stt_transcript":
        if (msg.isFinal) {
          if (msg.text && msg.text.trim().length > 2) {
            addTranscriptEntry(myName, msg.text, true, false);
            send({ type: "message", text: msg.text });
            console.log("[STT] Final:", msg.text);
          }
        } else {
          if (msg.text && msg.text.trim()) {
            addTranscriptEntry(myName, msg.text + " ...", true, true);
          }
        }
        break;

      case "stt_error":
        console.warn("[STT] Server error:", msg.text);
        break;

      case "discussion_ended":
        addFacilitatorMessage("The discussion has ended. Thank you for participating.", "closing");
        stopSpeechRecognition();
        destroyJitsi();
        clearState();
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
    container.scrollTop = container.scrollHeight;
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
      container.scrollTop = container.scrollHeight;
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
    container.scrollTop = container.scrollHeight;
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
    container.scrollTop = container.scrollHeight;
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

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function getAge() {
    return 25; // Default age — age input removed from UI
  }

  // ---- Event Listeners ----

  // Show/hide join section
  document.getElementById("join-toggle-btn").addEventListener("click", () => {
    const section = document.getElementById("join-section");
    section.style.display = section.style.display === "none" ? "flex" : "none";
  });

  // Create button → setup screen
  document.getElementById("create-btn").addEventListener("click", () => {
    myName = document.getElementById("name-input").value.trim();
    if (!myName) { alert("Enter your name"); return; }
    showScreen("setup");
  });

  // Back from setup
  document.getElementById("back-to-welcome-btn")?.addEventListener("click", () => {
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
    uploadArea.classList.remove("dragover");
    handleFiles(e.dataTransfer.files);
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

    if (!title && materials.length === 0) {
      alert("Enter a discussion title or upload some materials");
      return;
    }

    const sessionTitle = title || "Open Discussion";
    const btn = document.getElementById("start-session-btn");
    btn.disabled = true;
    btn.textContent = "Creating...";

    console.log("[Session] Creating:", { title: sessionTitle, question });

    apiPost("/api/sessions", {
      title: sessionTitle,
      openingQuestion: question || null,
      conversationGoal: null
    }).then(session => {
      console.log("[Session] Created:", session);
      if (!session.shortCode) {
        throw new Error("Server returned session without shortCode");
      }
      currentSessionId = session.shortCode;
      isHost = true;
      send({
        type: "join_session",
        sessionId: session.shortCode,
        name: myName,
        age: getAge()
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
    send({ type: "join_session", sessionId: code, name: myName, age: getAge() });
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
    send({ type: "message", text });
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
      sttStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
      });
      console.log("[STT] Mic access granted");
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
    if (sttNode) {
      try { sttNode.disconnect(); } catch (e) {}
      sttNode = null;
    }
    if (sttContext) {
      try { sttContext.close(); } catch (e) {}
      sttContext = null;
    }
    if (sttStream) {
      sttStream.getTracks().forEach(t => t.stop());
      sttStream = null;
    }
    if (sttActive) {
      send({ type: "stt_stop" });
      sttActive = false;
    }
    console.log("[STT] Stopped");
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
  const savedState = loadState();
  if (savedState && savedState.currentSessionId) {
    // Show a loading state while we try to rejoin
    showScreen("lobby");
    document.getElementById("session-code").textContent = savedState.currentSessionId;
    document.getElementById("participant-count").textContent = "Reconnecting...";
  } else {
    showScreen("welcome");
  }
  connect();
  checkDirectJoin();
  renderMaterials();
})();
