/**
 * Teacher Dashboard — Real-time monitoring and control of Plato
 */
(function () {
  let ws = null;
  let sessionId = null;
  let paused = false;
  let joinedAt = null;
  let sourceMaterials = [];
  let selectedSourceId = "";
  let sourceSearch = "";
  let sessionActive = false;
  let participantCount = 0;
  let sourceReloadScheduled = false;

  // --- DOM refs ---
  const $ = (id) => document.getElementById(id);

  // --- Auto-detect session from URL ---
  const params = new URLSearchParams(window.location.search);
  const urlSession = params.get("session");
  if (urlSession) {
    $("session-code-input").value = urlSession;
  }

  // --- Join ---
  $("join-btn").addEventListener("click", joinSession);
  $("session-code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinSession();
  });
  $("source-material-select").addEventListener("change", (e) => {
    selectedSourceId = e.target.value;
    renderSourceText();
  });
  $("source-search-input").addEventListener("input", (e) => {
    sourceSearch = e.target.value.trim().toLowerCase();
    renderSourceText();
  });
  $("source-refresh-btn").addEventListener("click", () => {
    loadSourceText(true);
  });

  function joinSession() {
    const code = $("session-code-input").value.trim().toLowerCase();
    if (!code) return;

    sessionId = code;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join_dashboard", sessionId: code }));
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) return;
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    };

    ws.onclose = () => {
      $("session-status").textContent = "Disconnected";
      $("session-status").className = "dash-badge ended";
    };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  // --- Message handling ---
  function handleMessage(msg) {
    switch (msg.type) {
      case "connected":
        break;

      case "dashboard_joined":
        $("join-screen").style.display = "none";
        $("dashboard").style.display = "block";
        $("session-code").textContent = msg.sessionId;
        joinedAt = Date.now();
        if (msg.topic) {
          $("topic-title").textContent = msg.topic.title || "";
        }
        updateStatus(msg.active, msg.paused);
        if (msg.snapshot) renderSnapshot(msg.snapshot);
        if (msg.analyzerState) renderAnalyzer(msg.analyzerState);
        if (msg.recentTurns) renderInitialTranscript(msg.recentTurns);
        startTimer(msg.snapshot?.sessionDurationMin);
        loadSourceText();
        break;

      case "dashboard_update":
        if (msg.snapshot) renderSnapshot(msg.snapshot);
        if (msg.analyzerState) renderAnalyzer(msg.analyzerState);
        updateStatus(msg.active, msg.paused);
        maybeReloadSourceText();
        break;

      case "participant_message":
        addTranscriptEntry(msg.name, msg.text, false);
        break;

      case "facilitator_message":
        addTranscriptEntry("Plato", msg.text, true, msg.move);
        break;

      case "participant_joined":
        addTranscriptEntry(null, `${msg.name} joined`, false, null, true);
        break;

      case "participant_left":
        addTranscriptEntry(null, `${msg.name} left`, false, null, true);
        break;

      case "facilitator_paused":
        paused = true;
        updatePauseUI();
        break;

      case "facilitator_resumed":
        paused = false;
        updatePauseUI();
        break;

      case "discussion_started":
        updateStatus(true, false);
        addTranscriptEntry(null, "Discussion started", false, null, true);
        break;

      case "discussion_ended":
        updateStatus(false, false);
        addTranscriptEntry(null, "Discussion ended", false, null, true);
        break;

      case "error":
        alert(msg.text);
        break;
    }
  }

  // --- Controls ---
  $("pause-btn").addEventListener("click", () => {
    send({ type: "teacher_pause" });
    paused = true;
    updatePauseUI();
  });

  $("resume-btn").addEventListener("click", () => {
    send({ type: "teacher_resume" });
    paused = false;
    updatePauseUI();
  });

  $("force-btn").addEventListener("click", () => {
    send({ type: "teacher_force_speak" });
  });

  $("goal-btn").addEventListener("click", () => {
    const goal = $("goal-input").value.trim();
    if (goal) send({ type: "teacher_set_goal", goal });
  });

  // Slider debounce
  let paramTimer = null;
  function onParamChange() {
    clearTimeout(paramTimer);
    const gap = parseInt($("param-gap").value);
    const ratio = parseInt($("param-ratio").value);
    const silence = parseInt($("param-silence").value);
    $("param-gap-val").textContent = gap + "s";
    $("param-ratio-val").textContent = ratio + "%";
    $("param-silence-val").textContent = silence + "s";
    $("params-status").textContent = "Applying live…";
    paramTimer = setTimeout(() => {
      send({
        type: "teacher_adjust_params",
        params: {
          minInterventionGapSec: gap,
          maxAITalkRatio: ratio / 100,
          silenceTimeoutSec: silence
        }
      });
      const statusEl = $("params-status");
      if (statusEl) {
        statusEl.textContent = "Live settings updated for this session.";
        window.clearTimeout(statusEl._resetTimer);
        statusEl._resetTimer = window.setTimeout(() => {
          statusEl.textContent = "Changes apply live to the current discussion.";
        }, 2200);
      }
    }, 500);
  }

  $("param-gap").addEventListener("input", onParamChange);
  $("param-ratio").addEventListener("input", onParamChange);
  $("param-silence").addEventListener("input", onParamChange);

  // --- Renderers ---

  function updateStatus(active, isPaused) {
    sessionActive = !!active;
    const badge = $("session-status");
    if (isPaused) {
      badge.textContent = "Paused";
      badge.className = "dash-badge paused";
    } else if (active) {
      badge.textContent = "Live";
      badge.className = "dash-badge active";
    } else {
      badge.textContent = "Warmup";
      badge.className = "dash-badge";
    }
    paused = isPaused;
    updatePauseUI();
  }

  function updatePauseUI() {
    $("pause-btn").style.display = paused ? "none" : "";
    $("resume-btn").style.display = paused ? "" : "none";
  }

  function renderSnapshot(snap) {
    participantCount = Array.isArray(snap.participants) ? snap.participants.length : 0;
    syncControlState();

    // Participants
    const list = $("participant-list");
    const participants = snap.participants || [];
    $("participant-count").textContent = participants.length;

    if (participants.length === 0) {
      list.innerHTML = '<p class="empty-hint">No participants yet</p>';
    } else {
      const totalMsgs = Math.max(1, snap.totalMessages || 1);
      list.innerHTML = participants.map(p => {
        const pct = Math.round((p.messageCount / totalMsgs) * 100);
        const silenceStr = p.silenceDurationSec > 60
          ? Math.round(p.silenceDurationSec / 60) + "m ago"
          : p.silenceDurationSec + "s ago";
        return `<div class="participant-row">
          <span class="p-name">${esc(p.name)}</span>
          <div class="p-bar-wrap"><div class="p-bar" style="width:${pct}%"></div></div>
          <span class="p-stats">${p.messageCount} msgs · ${silenceStr}</span>
        </div>`;
      }).join("");
    }

    // AI stats
    $("ai-msg-count").textContent = snap.aiStats?.messageCount || 0;
    $("ai-talk-ratio").textContent = Math.round((snap.aiStats?.talkRatio || 0) * 100) + "%";
    $("total-messages").textContent = snap.totalMessages || 0;
    $("total-turns").textContent = snap.totalTurns || 0;

    const sinceLast = snap.aiStats?.secondsSinceLastIntervention;
    $("ai-since-last").textContent = sinceLast != null
      ? (sinceLast > 60 ? Math.round(sinceLast / 60) + "m" : sinceLast + "s") + " ago"
      : "Never";
  }

  async function loadSourceText(force = false) {
    if (!sessionId) return;
    if (!force) {
      sourceReloadScheduled = false;
    }

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/source-text`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      sourceMaterials = payload.materials || [];
      if (!selectedSourceId || !sourceMaterials.some((m) => materialKey(m) === selectedSourceId)) {
        selectedSourceId = sourceMaterials[0] ? materialKey(sourceMaterials[0]) : "";
      }
      renderSourceSelector();
      renderSourceText();
    } catch (error) {
      $("source-summary").textContent = "Could not load source text";
      $("source-empty").style.display = "block";
      $("source-empty").innerHTML = `<p>${esc(error.message || "Source text unavailable")}</p>`;
      $("source-viewer").style.display = "none";
    }
  }

  function maybeReloadSourceText() {
    if (sourceReloadScheduled || sourceMaterials.length > 0) return;
    sourceReloadScheduled = true;
    window.setTimeout(() => loadSourceText(), 600);
  }

  function syncControlState() {
    const forceBtn = $("force-btn");
    const help = $("controls-help");
    if (!forceBtn || !help) return;

    const isGroupLive = sessionActive && participantCount >= 2;
    forceBtn.disabled = !isGroupLive;
    if (!sessionActive) {
      help.textContent = "These controls only act on a live discussion. Warmup and ended sessions won't trigger a forced intervention.";
    } else if (participantCount < 2) {
      help.textContent = "Force Intervention is mainly for observing a live group discussion. In solo mode, Plato already responds turn by turn.";
    } else {
      help.textContent = "Pause, resume, and live slider changes affect this discussion immediately. Force Intervention prompts an extra Plato move now.";
    }
  }

  function renderSourceSelector() {
    const select = $("source-material-select");
    const current = selectedSourceId;
    select.innerHTML = "";

    if (!sourceMaterials.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No shared source text";
      select.appendChild(option);
      select.disabled = true;
      return;
    }

    select.disabled = false;

    for (const material of sourceMaterials) {
      const option = document.createElement("option");
      option.value = materialKey(material);
      option.textContent = `${material.title} · ${material.lineCount || 0} lines`;
      if (option.value === current) option.selected = true;
      select.appendChild(option);
    }
  }

  function renderSourceText() {
    const viewer = $("source-viewer");
    const empty = $("source-empty");
    const summary = $("source-summary");
    const material = sourceMaterials.find((item) => materialKey(item) === selectedSourceId) || sourceMaterials[0];

    if (!material) {
      summary.textContent = "No source loaded";
      empty.style.display = "block";
      empty.innerHTML = "<p>No shared source text is attached to this live session yet. Add or edit reading from the class room's Source Text & Setup flow, then refresh here.</p>";
      viewer.style.display = "none";
      return;
    }

    const chunks = (material.chunks || []).filter((chunk) => {
      if (!sourceSearch) return true;
      return String(chunk.content || "").toLowerCase().includes(sourceSearch)
        || String(chunk.lineStart).includes(sourceSearch)
        || String(chunk.lineEnd).includes(sourceSearch);
    });

    summary.textContent = `${material.title} · ${material.lineCount || 0} lines`;

    if (!chunks.length) {
      empty.style.display = "block";
      empty.innerHTML = `<p>No lines match “${esc(sourceSearch)}”.</p>`;
      viewer.style.display = "none";
      return;
    }

    empty.style.display = "none";
    viewer.style.display = "flex";
    viewer.innerHTML = chunks.map((chunk) => {
      const lines = String(chunk.content || "")
        .split("\n")
        .map((line, index) => ({
          number: chunk.lineStart + index,
          text: line
        }));

      return `<article class="source-chunk">
        <div class="source-chunk-meta">Lines ${chunk.lineStart}-${chunk.lineEnd}</div>
        <div class="source-lines">
          ${lines.map((line) => `
            <div class="source-line${matchesLine(line.text) ? " source-line-match" : ""}">
              <span class="source-line-number">${line.number}</span>
              <span class="source-line-text">${highlightMatch(esc(line.text))}</span>
            </div>
          `).join("")}
        </div>
      </article>`;
    }).join("");
  }

  function renderAnalyzer(state) {
    if (!state) return;

    // Engagement & coherence from engagement tracker
    const eng = state.engagement;
    if (eng) {
      setSignal("engagement", eng.engagementScore);
      setSignal("coherence", eng.coherenceScore);
    }

    // Neuron state — extract signals from lastDecision.contributions
    const neuron = state.neuron;
    if (neuron) {
      const lastDec = neuron.lastDecision;
      if (lastDec) {
        setSignal("activation", lastDec.activation);
        // contributions has { signalName: { value, weight, contribution } }
        if (lastDec.contributions) {
          const c = lastDec.contributions;
          if (c.anchorDrift) setSignal("drift", c.anchorDrift.value);
          if (c.silenceDepth) setSignal("silence", c.silenceDepth.value);
          if (c.dominanceImbalance) setSignal("dominance", c.dominanceImbalance.value);
        }
      }
    }

    // Phase
    $("sig-phase").textContent = state.phase || "—";

    // Forced intervention tracking
    const forced = state.forcedIntervention;
    if (forced) {
      $("sig-silent-streak").textContent = forced.consecutiveSilentDecisions || 0;
    }

    // Anchors
    const anchors = state.anchors;
    if (anchors && anchors.anchors && anchors.anchors.length > 0) {
      $("anchor-list").innerHTML = anchors.anchors
        .sort((a, b) => (b.weight || 0) - (a.weight || 0))
        .slice(0, 8)
        .map(a => `<div class="anchor-item">
          <div class="anchor-speaker">${esc(a.participantName || "Unknown")}</div>
          <div class="anchor-text">${esc(a.summary || a.text || "")}</div>
          <div class="anchor-meta">weight ${(a.weight || 0).toFixed(2)} · ${a.referenceCount || 0} refs</div>
        </div>`).join("");
    }
  }

  function setSignal(name, value) {
    if (value == null || isNaN(value)) return;
    const v = Math.max(0, Math.min(1, value));
    const bar = $("sig-" + name);
    const val = $("sig-" + name + "-val");
    if (bar) bar.style.width = Math.round(v * 100) + "%";
    if (val) val.textContent = v.toFixed(2);
  }

  function renderInitialTranscript(turnsText) {
    if (!turnsText) return;
    const lines = turnsText.split("\n").filter(l => l.trim());
    const feed = $("transcript-feed");
    for (const line of lines) {
      const match = line.match(/^\[(.+?)\]:\s*(.+)$/);
      if (match) {
        const name = match[1];
        const text = match[2];
        const isFac = name === "Facilitator";
        addTranscriptEntry(isFac ? "Plato" : name, text, isFac, null, false, true);
      }
    }
  }

  function addTranscriptEntry(name, text, isFacilitator, move, isSystem, noScroll) {
    const feed = $("transcript-feed");
    const div = document.createElement("div");

    if (isSystem) {
      div.className = "t-entry";
      div.style.fontStyle = "italic";
      div.style.color = "var(--text-muted)";
      div.style.textAlign = "center";
      div.textContent = text;
    } else if (isFacilitator) {
      div.className = "t-entry t-facilitator";
      div.innerHTML = `<strong>Plato:</strong> ${esc(text)}${move ? `<span class="t-move">${esc(move)}</span>` : ""}`;
    } else {
      div.className = "t-entry";
      div.innerHTML = `<strong>${esc(name)}:</strong> ${esc(text)}`;
    }

    feed.appendChild(div);
    if (!noScroll) feed.scrollTop = feed.scrollHeight;
  }

  // --- Timer ---
  let timerInterval = null;
  function startTimer(durationMin) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!joinedAt) return;
      const elapsed = Math.floor((Date.now() - joinedAt) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      $("session-timer").textContent = m + ":" + String(s).padStart(2, "0");
    }, 1000);
  }

  function esc(text) {
    const d = document.createElement("div");
    d.textContent = text || "";
    return d.innerHTML;
  }

  function materialKey(material) {
    return material.materialId || material.title || "";
  }

  function matchesLine(text) {
    return sourceSearch && String(text || "").toLowerCase().includes(sourceSearch);
  }

  function highlightMatch(escapedText) {
    if (!sourceSearch) return escapedText;
    const safeQuery = sourceSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(${safeQuery})`, "ig");
    return escapedText.replace(regex, "<mark>$1</mark>");
  }
})();
