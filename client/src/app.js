/**
 * Socratic Facilitator — Client (Video Mode)
 *
 * Handles: WebSocket connection, session creation/joining,
 * file uploads, Jitsi Meet embedding, and facilitator display.
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

  // ---- WebSocket ----
  function connect() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}`);
    ws.binaryType = "arraybuffer";

    ws.onopen = () => console.log("Connected to server");
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
    return res.json();
  }

  async function apiGet(endpoint) {
    const res = await fetch(endpoint);
    return res.json();
  }

  // ---- Jitsi Integration ----
  function launchJitsi(roomName, displayName) {
    if (jitsiApi) {
      jitsiApi.dispose();
    }

    const container = document.getElementById("jitsi-container");
    const domain = "meet.jit.si"; // or self-hosted domain from config

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

    // Track participants joining/leaving
    jitsiApi.addEventListener('participantJoined', (event) => {
      console.log('[Jitsi] Participant joined:', event);
    });

    jitsiApi.addEventListener('participantLeft', (event) => {
      console.log('[Jitsi] Participant left:', event);
    });

    // Track when video conference ends
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

  // ---- Message Handlers ----
  function handleServerMessage(msg) {
    switch (msg.type) {
      case "session_created":
        currentSessionId = msg.sessionId;
        document.getElementById("session-code").textContent = msg.sessionId;
        document.getElementById("lobby-topic").textContent = msg.topicTitle;
        document.getElementById("lobby-passage").textContent = msg.passage;
        send({ type: "join_session", sessionId: msg.sessionId, name: myName, age: getAge() });
        isHost = true;
        break;

      case "session_joined":
        currentSessionId = msg.sessionId;
        myId = msg.yourId;
        participants = msg.participants;
        updateParticipantList();
        if (!isHost) {
          document.getElementById("session-code").textContent = msg.sessionId;
          document.getElementById("lobby-topic").textContent = msg.topicTitle;
          document.getElementById("lobby-passage").textContent = msg.passage;
        }
        showScreen("lobby");
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
        // Launch Jitsi and show video screen
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
        // Reset to listening after a delay
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

  // Plato configuration
  const PLATO = {
    name: 'Plato',
    avatar: {
      src: '/images/plato-statue.jpg',
      fallbackSrc: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/Plato_Silanion_Musei_Capitolini_MC1377.jpg/440px-Plato_Silanion_Musei_Capitolini_MC1377.jpg'
    }
  };

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

    // Update or create partial entry
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
    const val = document.getElementById("age-input").value;
    return parseInt(val) || 12;
  }

  // ---- Materials Management ----
  let materials = [];

  function renderMaterials() {
    const container = document.getElementById("materials-list");
    container.innerHTML = "";

    materials.forEach((m, i) => {
      const div = document.createElement("div");
      div.className = "material-item";
      div.innerHTML = `
        <span class="material-name">${escapeHtml(m.name)}</span>
        <button class="material-remove" data-index="${i}">&times;</button>
      `;
      container.appendChild(div);
    });

    const primeBtn = document.getElementById("prime-btn");
    primeBtn.disabled = materials.length === 0;
  }

  // File upload
  const uploadArea = document.getElementById("upload-area");
  const fileInput = document.getElementById("file-input");

  uploadArea.addEventListener("click", () => fileInput.click());
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

  async function handleFiles(files) {
    for (const file of files) {
      materials.push({ type: "file", name: file.name, file: file });
    }
    renderMaterials();
  }

  // URL input
  document.getElementById("add-url-btn").addEventListener("click", () => {
    const input = document.getElementById("url-input");
    const url = input.value.trim();
    if (url) {
      materials.push({ type: "url", name: url, url: url });
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

  // ---- Session Creation Flow ----

  // Show/hide join section
  document.getElementById("join-toggle-btn").addEventListener("click", () => {
    const section = document.getElementById("join-section");
    section.style.display = section.style.display === "none" ? "flex" : "none";
  });

  // Create button - go to setup screen
  document.getElementById("create-btn").addEventListener("click", () => {
    myName = document.getElementById("name-input").value.trim();
    if (!myName) { alert("Enter your name"); return; }

    const topicSelect = document.getElementById("topic-select");
    const selectedTopic = topicSelect.options[topicSelect.selectedIndex];
    document.getElementById("session-title").value = selectedTopic?.text || "";
    showScreen("setup");
  });

  // Back button from setup
  document.getElementById("back-to-welcome-btn")?.addEventListener("click", () => {
    showScreen("welcome");
  });

  // Prime materials button
  document.getElementById("prime-btn").addEventListener("click", async () => {
    if (!currentSessionId || materials.length === 0) return;

    const btn = document.getElementById("prime-btn");
    const btnText = document.getElementById("prime-btn-text");
    const spinner = document.getElementById("prime-spinner");

    btn.disabled = true;
    btnText.textContent = "Processing...";
    spinner.style.display = "inline-block";

    try {
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

      const result = await apiPost(`/api/sessions/${currentSessionId}/prime`, {});
      if (result.status === "complete" && result.context) {
        btnText.textContent = "Ready!";
        showPrimedContext(result.context);
      } else {
        btnText.textContent = "Prime Materials";
      }
    } catch (error) {
      console.error("Priming error:", error);
      btnText.textContent = "Error - Retry";
    } finally {
      spinner.style.display = "none";
      btn.disabled = false;
    }
  });

  function showPrimedContext(context) {
    const preview = document.getElementById("primed-preview");
    const themes = document.getElementById("primed-themes");
    if (context.keyThemes && context.keyThemes.length > 0) {
      themes.innerHTML = context.keyThemes.map(t => `<span class="theme-chip">${escapeHtml(t)}</span>`).join("");
      preview.style.display = "block";
    }
  }

  // Create session and proceed to lobby
  document.getElementById("start-session-btn").addEventListener("click", () => {
    const title = document.getElementById("session-title").value.trim();
    const question = document.getElementById("opening-question").value.trim();
    const goal = document.getElementById("conversation-goal").value.trim();

    if (!title) { alert("Enter a title"); return; }

    apiPost("/api/sessions", {
      title,
      openingQuestion: question || null,
      conversationGoal: goal || null
    }).then(session => {
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
      alert("Failed to create session");
    });
  });

  // ---- Join Existing Session ----
  document.getElementById("join-btn").addEventListener("click", () => {
    myName = document.getElementById("name-input").value.trim();
    const code = document.getElementById("join-code-input").value.trim().toLowerCase();
    if (!myName) { alert("Enter your name"); return; }
    if (!code) { alert("Enter a session code"); return; }

    send({ type: "join_session", sessionId: code, name: myName, age: getAge() });
  });

  // ---- Start Discussion ----
  document.getElementById("start-btn").addEventListener("click", () => {
    send({ type: "start_discussion" });
  });

  // ---- End Discussion ----
  document.getElementById("video-end-btn").addEventListener("click", () => {
    if (confirm("End the discussion for everyone?")) {
      send({ type: "end_discussion" });
    }
  });

  // ---- Audio (for TTS playback from server) ----
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

  // ---- Load Topics ----
  async function loadTopics() {
    try {
      const topics = await apiGet("/api/topics");
      const select = document.getElementById("topic-select");
      select.innerHTML = "";
      topics.forEach(t => {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.title;
        select.appendChild(opt);
      });
    } catch (e) {
      console.error("Failed to load topics:", e);
    }
  }

  // ---- Init ----
  showScreen("welcome");
  connect();
  loadTopics();
})();
