/**
 * Authentication Module
 *
 * Handles user authentication, class management, and session history.
 */

import { state, getAuthHeaders, saveAuthState, clearAuthState } from './state.js';
import { send } from './websocket.js';
import { AUTH_USER_KEY } from './state.js';

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

// Export API functions for use in other modules
export { apiPost, apiGet };

// ---- Auth State Rendering ----

export function renderAuthState() {
  const unsignedHeader = document.getElementById("unsigned-header");
  const signedInHeader = document.getElementById("signed-in-header");
  const authCard = document.getElementById("auth-card");
  const guestPanel = document.getElementById("guest-panel");
  const dashboardTeacher = document.getElementById("dashboard-teacher");
  const dashboardStudent = document.getElementById("dashboard-student");
  const dashboardParent = document.getElementById("dashboard-parent");
  const accountName = document.getElementById("account-name");
  const accountRoleBadge = document.getElementById("account-role-badge");
  const userAvatarInitial = document.getElementById("user-avatar-initial");
  const demoLoginSection = document.getElementById("demo-login-section");
  const demoLoginCopy = document.getElementById("demo-login-copy");

  // Show demo button unless: user is signed in, or server explicitly said disabled
  if (demoLoginSection) {
    const demoDisabled = state.demoTeacherConfig && !state.demoTeacherConfig.enabled;
    demoLoginSection.style.display = !state.accountUser && !demoDisabled ? "block" : "none";
  }
  if (demoLoginCopy && state.demoTeacherConfig && state.demoTeacherConfig.enabled) {
    demoLoginCopy.textContent = `Use ${state.demoTeacherConfig.name} (${state.demoTeacherConfig.email}) for quick teacher access.`;
  }

  // Toggle the side-by-side columns wrapper
  const welcomeColumns = document.querySelector(".welcome-columns");

  if (!state.accountUser) {
    // NOT signed in — show auth card + guest panel side by side
    if (unsignedHeader) unsignedHeader.style.display = "";
    if (signedInHeader) signedInHeader.style.display = "none";
    if (welcomeColumns) welcomeColumns.style.display = "";
    if (authCard) authCard.style.display = "";
    if (guestPanel) guestPanel.style.display = "";
    if (dashboardTeacher) dashboardTeacher.style.display = "none";
    if (dashboardStudent) dashboardStudent.style.display = "none";
    if (dashboardParent) dashboardParent.style.display = "none";
  } else {
    // Signed in — hide columns, show dashboard
    if (unsignedHeader) unsignedHeader.style.display = "none";
    if (signedInHeader) signedInHeader.style.display = "";
    if (welcomeColumns) welcomeColumns.style.display = "none";

    // Set header content
    if (accountName) accountName.textContent = state.accountUser.name;
    if (accountRoleBadge) {
      accountRoleBadge.textContent = state.accountUser.role || "Student";
      // Style badge based on role
      accountRoleBadge.className = "role-badge";
      if (state.accountUser.role === "Teacher") {
        accountRoleBadge.classList.add("role-badge-teacher");
      } else if (state.accountUser.role === "Parent") {
        accountRoleBadge.classList.add("role-badge-parent");
      } else if (state.accountUser.role === "Admin" || state.accountUser.role === "SuperAdmin") {
        accountRoleBadge.classList.add("role-badge-admin");
      } else {
        accountRoleBadge.classList.add("role-badge-student");
      }
    }
    if (userAvatarInitial) {
      userAvatarInitial.textContent = state.accountUser.name.charAt(0).toUpperCase();
    }

    // Auto-fill name input from account
    const nameInput = document.getElementById("name-input")
      || document.getElementById("name-input-teacher");
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = state.accountUser.name;
    }

    // Show role-specific dashboard
    if (dashboardTeacher) dashboardTeacher.style.display = "none";
    if (dashboardStudent) dashboardStudent.style.display = "none";
    if (dashboardParent) dashboardParent.style.display = "none";

    const role = state.accountUser.role;
    if (role === "Admin" || role === "SuperAdmin") {
      // Redirect admins to admin panel
      window.location.href = "/admin";
      return;
    } else if (role === "Teacher") {
      if (dashboardTeacher) dashboardTeacher.style.display = "";
    } else if (role === "Parent") {
      if (dashboardParent) dashboardParent.style.display = "";
    } else {
      // Student or default
      if (dashboardStudent) dashboardStudent.style.display = "";
    }
  }
}

// Helper functions imported from state
function canManageClasses() {
  return ["Teacher", "Admin", "SuperAdmin"].includes(state.accountUser?.role);
}

function getDisplayNameFromAccount() {
  if (!state.accountUser?.name) return "";
  return state.accountUser.name;
}

// ---- Classes Rendering ----

export function renderClasses() {
  const list = document.getElementById("classes-list");
  const select = document.getElementById("session-class-select");
  const previousValue = select.value;

  select.innerHTML = '<option value="">Not linked to a class</option>';

  if (!state.accountUser) {
    list.innerHTML = '<p class="empty-state">Sign in to create and reuse classes.</p>';
    return;
  }

  if (!canManageClasses() && state.savedClasses.length === 0) {
    list.innerHTML = '<p class="empty-state">No class memberships yet.</p>';
    return;
  }

  if (state.savedClasses.length === 0) {
    list.innerHTML = '<p class="empty-state">No classes yet. Create your first one here.</p>';
  } else {
    list.innerHTML = state.savedClasses.map(cls => `
      <div class="workspace-item class-item" data-class-id="${escapeHtml(cls.id)}">
        <strong>${escapeHtml(cls.name)}</strong>
        <div class="workspace-item-meta">${escapeHtml(cls.description || "No notes yet.")}</div>
        <span class="workspace-item-tag">${cls.sessionCount} saved session${cls.sessionCount === 1 ? "" : "s"}${cls.ageRange ? ` · Ages ${escapeHtml(cls.ageRange)}` : ""}</span>
      </div>
    `).join("");
  }

  state.savedClasses.forEach(cls => {
    const option = document.createElement("option");
    option.value = cls.id;
    option.textContent = cls.name;
    select.appendChild(option);
  });

  if (state.savedClasses.some(cls => cls.id === previousValue)) {
    select.value = previousValue;
  }
}

// ---- Session History Rendering ----

export function renderSessionHistory() {
  // Parents use renderParentSessionHistory instead
  if (state.accountUser && state.accountUser.role === "Parent") {
    return;
  }

  // Determine which list to render into based on user role
  let listId = "session-history-list";
  if (state.accountUser) {
    const role = state.accountUser.role;
    if (role === "Student") {
      listId = "student-session-history-list";
    }
  }

  const list = document.getElementById(listId);

  if (!list) return; // Element doesn't exist in current view

  if (!state.accountUser) {
    list.innerHTML = '<p class="empty-state">Sign in to see session history.</p>';
    return;
  }

  if (state.sessionHistory.length === 0) {
    const emptyMessage = state.accountUser.role === "Teacher"
      ? "No saved sessions yet. Your newly created rooms will show up here."
      : "No saved sessions yet. Join a room to see your history here.";
    list.innerHTML = `<p class="empty-state">${emptyMessage}</p>`;
    return;
  }

  list.innerHTML = state.sessionHistory.map(session => `
    <div class="workspace-item session-item" data-shortcode="${escapeHtml(session.shortCode)}">
      <strong>${escapeHtml(session.title)}</strong>
      <div class="workspace-item-meta">
        ${escapeHtml(session.className || "Unassigned")} · ${escapeHtml(session.status)} · ${escapeHtml(session.viewerRole || "Member")}<br>
        ${session.participantCount} participants · ${session.messageCount} messages · ${formatDateTime(session.createdAt)}<br>
        You spoke about ${Math.round(Number(session.viewerSpeakingSeconds || 0))}s · contribution ${Number(session.viewerContributionScore || 0).toFixed(2)}
      </div>
      <div class="session-item-actions">
        <span class="workspace-item-tag">Code ${escapeHtml(session.shortCode)}</span>
        <button class="btn btn-small btn-secondary transcript-btn" data-shortcode="${escapeHtml(session.shortCode)}">View Transcript</button>
      </div>
    </div>
  `).join("");

  // Add click handlers for session analytics
  import('./analytics.js').then(({ showSessionAnalytics, showTranscript }) => {
    document.querySelectorAll('.session-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Don't trigger analytics when clicking transcript button
        if (e.target.classList.contains('transcript-btn')) return;
        const shortCode = item.dataset.shortcode;
        showSessionAnalytics(shortCode);
      });
      item.style.cursor = 'pointer';
    });

    document.querySelectorAll('.transcript-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        showTranscript(btn.dataset.shortcode);
      });
    });
  });
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

// ---- Workspace Refresh ----

export async function refreshWorkspace() {
  renderAuthState();

  if (!state.authToken) {
    state.savedClasses = [];
    state.sessionHistory = [];
    state.linkedChildren = [];
    state.parentChildrenSessions = [];
    renderClasses();
    renderSessionHistory();
    renderLinkedChildren();
    return;
  }

  try {
    const [me, classes, history] = await Promise.all([
      apiGet("/api/auth/me"),
      apiGet("/api/classes"),
      apiGet("/api/sessions/history")
    ]);
    state.accountUser = me.user;
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(state.accountUser));
    state.savedClasses = classes;
    state.sessionHistory = history;
    renderAuthState();
    renderClasses();
    renderSessionHistory();

    // Fetch parent-specific data
    if (state.accountUser.role === 'Parent') {
      await refreshLinkedChildren();
    }
  } catch (error) {
    console.warn("[Auth] Workspace refresh failed:", error.message);
    clearAuthState();
    renderAuthState();
    renderClasses();
    renderSessionHistory();
  }
}

// ---- Linked Children (Parent Dashboard) ----

export async function refreshLinkedChildren() {
  try {
    const children = await apiGet("/api/parents/children");
    state.linkedChildren = children;
    renderLinkedChildren();

    // Also fetch each child's sessions for the parent session history
    const allSessions = [];
    for (const child of children) {
      try {
        const sessions = await apiGet(`/api/parents/children/${child.id}/sessions`);
        sessions.forEach(s => { s._childName = child.name; });
        allSessions.push(...sessions);
      } catch (_e) { /* skip children with fetch errors */ }
    }
    state.parentChildrenSessions = allSessions;
    renderParentSessionHistory();
  } catch (error) {
    console.warn("[Auth] Failed to load linked children:", error.message);
    state.linkedChildren = [];
    state.parentChildrenSessions = [];
    renderLinkedChildren();
    renderParentSessionHistory();
  }
}

export function renderLinkedChildren() {
  const list = document.getElementById("linked-children-list");
  if (!list) return;

  if (!state.linkedChildren || state.linkedChildren.length === 0) {
    list.innerHTML = '<p class="empty-state">No linked students yet. Use the form above to link your child\'s account.</p>';
    return;
  }

  list.innerHTML = state.linkedChildren.map(child => `
    <div class="workspace-item">
      <strong>${escapeHtml(child.name)}</strong>
      <div class="workspace-item-meta">${escapeHtml(child.email)}</div>
    </div>
  `).join("");
}

function renderParentSessionHistory() {
  const list = document.getElementById("parent-session-history-list");
  if (!list) return;

  if (!state.parentChildrenSessions || state.parentChildrenSessions.length === 0) {
    list.innerHTML = '<p class="empty-state">No sessions yet. Link a student to see their discussion history.</p>';
    return;
  }

  list.innerHTML = state.parentChildrenSessions.map(session => `
    <div class="workspace-item">
      <strong>${escapeHtml(session.title || 'Untitled')}</strong>
      <div class="workspace-item-meta">
        ${escapeHtml(session._childName)} · ${formatDateTime(session.created_at)} · ${escapeHtml(session.status)}<br>
        ${session.message_count || 0} messages · ${Math.round(Number(session.estimated_speaking_seconds || 0))}s speaking · contribution ${Number(session.contribution_score || 0).toFixed(2)}
      </div>
    </div>
  `).join("");
}

// ---- Event Handlers ----

export async function handleRegister() {
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

export async function handleLogin() {
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

export async function loadDemoTeacherConfig() {
  try {
    state.demoTeacherConfig = await apiGet("/api/auth/demo-teacher");
  } catch (_error) {
    state.demoTeacherConfig = { enabled: false, name: "", email: "" };
  }
  renderAuthState();
}

export async function handleDemoTeacherLogin() {
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

export async function handleCreateClass() {
  if (!state.accountUser || !canManageClasses()) {
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
    state.savedClasses.unshift(created);
    document.getElementById("new-class-name").value = "";
    document.getElementById("new-class-age-range").value = "";
    document.getElementById("new-class-description").value = "";
    renderClasses();
  } catch (error) {
    alert(error.message);
  }
}

export function handleLogout() {
  clearAuthState();
  state.authPanelManuallyOpened = false;
  renderAuthState();
  renderClasses();
  renderSessionHistory();
  document.getElementById("session-class-select").value = "";
}

// ---- Auth Card Display ----

export function showAuthCard(tab = 'signin') {
  // Auth card is always visible now — just switch the tab
  const targetBtn = document.querySelector(`.auth-tab[data-tab="${tab}"]`);
  if (targetBtn) {
    targetBtn.click();
  }
}

// Security: Escape HTML to prevent XSS
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
