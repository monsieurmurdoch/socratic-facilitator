/**
 * Socratic Facilitator — Client
 *
 * Handles: WebSocket connection, session creation/joining,
 * file uploads, URL materials, and real-time chat.
 */

(function () {
  // ---- State ----
  let ws = null;
  let myName = "";
  let myId = "";
  let currentSessionId = null;
  let participants = [];
  let isHost = false;
  let sessionMode = "text"; // "text" or "video"

  // ---- DOM Elements ----
  const screens = {
    welcome: document.getElementById("welcome-screen"),
    setup: document.getElementById("setup-screen"),
    lobby: document.getElementById("lobby-screen"),
    chat: document.getElementById("chat-screen"),
    video: document.getElementById("video-screen")
  };

  function showScreen(name) {
    Object.values(screens).forEach(s => s && s.classList.remove("active"));
    if (screens[name]) screens[name].classList.add("active");
  }

  // ---- Mode Selection ----
  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      sessionMode = btn.dataset.mode;

      document.getElementById("text-mode-options").style.display = sessionMode === "text" ? "block" : "none";
      document.getElementById("video-mode-options").style.display = sessionMode === "video" ? "block" : "none";
    });
  });

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
        document.getElementById("chat-topic").textContent = msg.topicTitle;
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
        addSystemMessage(`${msg.name} left the discussion`);
        break;

      case "discussion_started":
        showScreen("chat");
        document.getElementById("message-input").focus();
        break;

      case "participant_message":
        addParticipantMessage(msg.name, msg.text, msg.name === myName);
        break;

      case "facilitator_message":
        addFacilitatorMessage(msg.text, msg.move);
        break;

      case "discussion_ended":
        addSystemMessage("The discussion has ended. Thank you for participating.");
        document.getElementById("message-input").disabled = true;
        document.getElementById("send-btn").disabled = true;
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

  function addParticipantMessage(name, text, isSelf) {
    const container = document.getElementById("chat-messages");
    const div = document.createElement("div");
    div.className = `message ${isSelf ? "message-self" : "message-participant"}`;
    div.innerHTML = `<span class="sender">${escapeHtml(name)}</span><span class="message-text">${escapeHtml(text)}</span>`;
    container.appendChild(div);
    scrollToBottom();
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
    const container = document.getElementById("chat-messages");
    const div = document.createElement("div");
    div.className = "message message-facilitator";
    div.innerHTML = `
      <img class="avatar plato-avatar" src="${PLATO.avatar.src}"
           onerror="this.src='${PLATO.avatar.fallbackSrc}'"
           alt="${PLATO.name}">
      <div class="message-content">
        <span class="sender">${PLATO.name}</span>
        <span class="message-text">${escapeHtml(text)}</span>
      </div>
    `;
    container.appendChild(div);
    scrollToBottom();
  }

  function addSystemMessage(text) {
    const container = document.getElementById("chat-messages");
    const div = document.createElement("div");
    div.className = "message message-system";
    div.textContent = text;
    container.appendChild(div);
    scrollToBottom();
  }

  function scrollToBottom() {
    const container = document.getElementById("chat-messages");
    container.scrollTop = container.scrollHeight;
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
        <span class="material-icon">${m.type === "url" ? "🔗" : "📄"}</span>
        <span class="material-name">${escapeHtml(m.name)}</span>
        <button class="material-remove" data-index="${i}">×</button>
      `;
      container.appendChild(div);
    });

    // Enable prime button if materials exist
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
      materials.push({
        type: "file",
        name: file.name,
        file: file
      });
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
      // Upload materials first
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

    // Create session via REST API only — do NOT also send create_session over WS
    apiPost("/api/sessions", {
      title,
      openingQuestion: question || null,
      conversationGoal: goal || null
    }).then(session => {
      currentSessionId = session.shortCode;
      isHost = true;

      // Join via WebSocket using the session code from the REST response
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

  // ---- Send Message ----
  function sendMessage() {
    const input = document.getElementById("message-input");
    const text = input.value.trim();
    if (!text) return;
    send({ type: "message", text });
    input.value = "";
    input.focus();
  }

  document.getElementById("send-btn").addEventListener("click", sendMessage);
  document.getElementById("message-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ---- End Discussion ----
  document.getElementById("end-btn").addEventListener("click", () => {
    if (confirm("End the discussion for everyone?")) {
      send({ type: "end_discussion" });
    }
  });

  // ---- Audio ----
  let playbackContext;

  function playAudioBuffer(arrayBuffer) {
    if (!playbackContext) {
      playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    playbackContext.decodeAudioData(arrayBuffer, (buffer) => {
      const source = playbackContext.createBufferSource();
      source.buffer = buffer;
      source.connect(playbackContext.destination);
      source.start(0);
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
