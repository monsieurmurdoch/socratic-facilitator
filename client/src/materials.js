/**
 * Materials Module
 *
 * Handles material upload, priming, and rendering.
 */

import { state, MAX_MATERIALS, getAuthHeaders } from './state.js';

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

// ---- Prime Materials ----

export async function primeMaterials() {
  if (!state.currentSessionId || state.materials.length === 0) return;

  const primingStatus = document.getElementById("priming-status");
  if (primingStatus) primingStatus.style.display = "flex";

  try {
    // Upload each material
    for (const m of state.materials) {
      if (m.type === "file") {
        const formData = new FormData();
        formData.append("file", m.file);
        const response = await fetch(`/api/sessions/${state.currentSessionId}/materials`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: formData
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.error || `Upload failed ${response.status}`);
        }
      } else if (m.type === "url") {
        await apiPost(`/api/sessions/${state.currentSessionId}/materials`, { url: m.url });
      }
    }

    // Prime the session
    const result = await apiPost(`/api/sessions/${state.currentSessionId}/prime`, {});

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

export function showPrimedContext(context) {
  import('./ui.js').then(({ escapeHtml }) => {
    const preview = document.getElementById("primed-preview");
    const themes = document.getElementById("primed-themes");
    if (preview && themes && context.keyThemes && context.keyThemes.length > 0) {
      themes.innerHTML = context.keyThemes.map(t => `<span class="theme-chip">${escapeHtml(t)}</span>`).join("");
      preview.style.display = "block";
    }
  });
}

// ---- Render Materials ----

export function renderMaterials() {
  import('./ui.js').then(({ escapeHtml }) => {
    const container = document.getElementById("materials-list");
    const countEl = document.getElementById("material-count");
    container.innerHTML = "";
    countEl.textContent = `(${state.materials.length}/${MAX_MATERIALS})`;

    state.materials.forEach((m, i) => {
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
    if (state.materials.length >= MAX_MATERIALS) {
      uploadArea.style.opacity = "0.5";
      uploadArea.style.pointerEvents = "none";
    } else {
      uploadArea.style.opacity = "1";
      uploadArea.style.pointerEvents = "auto";
    }
  });
}
