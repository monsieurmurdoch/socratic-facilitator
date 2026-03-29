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
  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      console.log("Connected to server");
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
    ws.onclose = () => {
      console.log("Disconnected. Reconnecting in 2s...");
      setTimeout(connect, 2000);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
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
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json;
  }

  async function apiGet(endpoint) {
    const res = await fetch(endpoint);
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || `HTTP ${res.status}`);
    }
    return json;
  }

  // ---- Jitsi Integration ----
  let jitsiScriptLoaded = false;

  function loadJitsiScript() {
    return new Promise((resolve, reject) => {
      if (jitsiScriptLoaded || window.JitsiMeetExternalAPI) {
        jitsiScriptLoaded = true;
        resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = "https://meet.jit.si/external_api.js";
      script.onload = () => {
        jitsiScriptLoaded = true;
        resolve();
      };
      script.onerror = () => reject(new Error("Failed to load Jitsi API"));
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
    const domain = "meet.jit.si";

    jitsiApi = new JitsiMeetExternalAPI(domain, {
      roomName: `socratic-${roomName}`,
      parentNode: container,
      userInfo: {
        displayName: displayName
      },
      configOverwrite: {
        startWithAudioMuted: false,
        startWithVideoMuted: false,
        prejoinPageEnabled: false,
        disableDeepLinking: true,
        toolbarButtons: [
          'microphone', 'camera', 'desktop', 'fullscreen',
          'raisehand', 'tileview', 'participants-pane',
          'toggle-camera'
        ],
        disableInviteFunctions: true,
        hideConferenceSubject: true,
        disableThirdPartyRequests: true
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
    });

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
    switch (msg.type) {
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

      case "discussion_started":
        showScreen("video");
        launchJitsi(currentSessionId, myName);
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
        setTimeout(() => setFacilitatorStatus("listening"), 3000);
        break;

      case "discussion_ended":
        addFacilitatorMessage("The discussion has ended. Thank you for participating.", "closing");
        destroyJitsi();
        break;

      case "error":
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
    const container = document.getElementById("facilitator-messages");
    if (!container) return;
    const div = document.createElement("div");
    div.className = "facilitator-bubble";
    div.innerHTML = `
      <span class="facilitator-move">${move || ''}</span>
      <span class="facilitator-text">${escapeHtml(text)}</span>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  function addTranscriptEntry(name, text, isSelf) {
    const container = document.getElementById("transcript-messages");
    if (!container) return;
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
    const container = document.getElementById("transcript-messages");
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

  function setFacilitatorStatus(status) {
    const badge = document.getElementById("facilitator-status");
    if (!badge) return;
    badge.className = `status-badge ${status}`;
    badge.textContent = status === "speaking" ? "Speaking" : "Listening";
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

    apiPost("/api/sessions", {
      title: sessionTitle,
      openingQuestion: question || null,
      conversationGoal: null
    }).then(session => {
      if (!session || !session.shortCode) {
        throw new Error("Invalid response from server");
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
      console.error("Session creation error:", error);
      alert("Failed to create session: " + error.message);
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

  // Start discussion
  document.getElementById("start-btn").addEventListener("click", () => {
    send({ type: "start_discussion" });
  });

  // End discussion
  document.getElementById("video-end-btn").addEventListener("click", () => {
    if (confirm("End the discussion for everyone?")) {
      send({ type: "end_discussion" });
    }
  });

  // ---- Audio (TTS playback from server) ----
  let playbackContext;

  function playAudioBuffer(arrayBuffer) {
    if (!playbackContext) {
      playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    playbackContext.decodeAudioData(arrayBuffer.slice(0), (buffer) => {
      const source = playbackContext.createBufferSource();
      source.buffer = buffer;
      source.connect(playbackContext.destination);
      source.start(0);
    }, (err) => {
      console.warn('[Audio] Failed to decode audio:', err);
    });
  }

  // ---- Init ----
  showScreen("welcome");
  connect();
  checkDirectJoin();
  renderMaterials();
})();
