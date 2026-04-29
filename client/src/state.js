/**
 * State Management Module
 *
 * Central state object and persistence functions for the Socratic Facilitator client.
 */

// ---- Constants ----
export const MAX_MATERIALS = 5;
export const STT_FLUSH_MS_WARMUP = 1200;
export const STT_FLUSH_MS_DISCUSSION = 800;
export const STORAGE_KEY = "socratic_state";
export const AUTH_TOKEN_KEY = "socratic_auth_token";
export const AUTH_USER_KEY = "socratic_auth_user";
export const SESSION_ACCESS_TOKEN_KEY = "socratic_session_access_tokens";
export const JAAS_APP_ID = "vpaas-magic-cookie-44bf27b66fab458bae6a8c271ea52a82";

// ---- State ----
export const state = {
  ws: null,
  myName: "",
  myId: "",
  currentSessionId: null,
  participants: [],
  isHost: false,
  jitsiApi: null,
  materials: [],
  sessionAccessTokens: loadSessionAccessTokens(),
  authToken: null,
  accountUser: null,
  savedClasses: [],
  sessionHistory: [],
  demoTeacherConfig: null,
  linkedChildren: [],
  parentChildrenSessions: [],
  authPanelManuallyOpened: false,
  sttBatchBuffer: '',
  sttBatchTimer: null,
  lastInterimTranscript: '',
  discussionActive: false,
  currentScreen: "welcome",
  wsConnectedToServer: false,
  jitsiScriptLoaded: false,
  jitsiMicMuted: false,
  platoMicMuted: false,
  jitsiMutePoller: null,
  sttStream: null,
  sttNode: null,
  sttContext: null,
  sttActive: false,
  playbackContext: null,
  serverTTSReceived: false,
  platoSpeakingTimer: null
};

// ---- State Persistence ----

export function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      myName: state.myName,
      myId: state.myId,
      currentSessionId: state.currentSessionId,
      isHost: state.isHost,
      participants: state.participants,
      currentScreen: state.currentScreen,
      savedAt: Date.now()
    }));
  } catch (e) { /* storage full or unavailable */ }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const savedState = JSON.parse(raw);
    // Expire after 4 hours
    if (Date.now() - savedState.savedAt > 4 * 60 * 60 * 1000) {
      clearState();
      return null;
    }
    return savedState;
  } catch (e) { return null; }
}

export function clearState() {
  localStorage.removeItem(STORAGE_KEY);
  state.currentSessionId = null;
  state.myId = "";
  state.participants = [];
  state.isHost = false;
  state.discussionActive = false;
  state.currentScreen = "welcome";
  state.sttBatchBuffer = "";
  state.lastInterimTranscript = "";
  clearTimeout(state.sttBatchTimer);
  state.sttBatchTimer = null;
}

export function shouldAutoRestore(saved) {
  return !!(saved && saved.currentSessionId && saved.myId && ["lobby", "video"].includes(saved.currentScreen));
}

export function loadAuthState() {
  try {
    state.authToken = localStorage.getItem(AUTH_TOKEN_KEY);
    const rawUser = localStorage.getItem(AUTH_USER_KEY);
    state.accountUser = rawUser ? JSON.parse(rawUser) : null;
  } catch (e) {
    state.authToken = null;
    state.accountUser = null;
  }
}

export function saveAuthState(user, token) {
  state.authToken = token;
  state.accountUser = user;
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
}

export function clearAuthState() {
  state.authToken = null;
  state.accountUser = null;
  state.savedClasses = [];
  state.sessionHistory = [];
  state.linkedChildren = [];
  state.parentChildrenSessions = [];
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
}

// ---- Utility Functions ----

export function loadSessionAccessTokens() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_ACCESS_TOKEN_KEY) || "{}");
  } catch (_error) {
    return {};
  }
}

export function saveSessionAccessTokens() {
  try {
    localStorage.setItem(SESSION_ACCESS_TOKEN_KEY, JSON.stringify(state.sessionAccessTokens));
  } catch (_error) { /* storage unavailable */ }
}

export function setSessionAccessToken(sessionId, token) {
  if (!sessionId || !token) return;
  state.sessionAccessTokens[sessionId] = token;
  saveSessionAccessTokens();
}

export function getSessionAccessToken(sessionId = state.currentSessionId) {
  return sessionId ? state.sessionAccessTokens[sessionId] || null : null;
}

export function getAge() {
  return 25; // Default age — age input removed from UI
}

export function getAuthHeaders(extra = {}) {
  const headers = { ...extra };
  if (state.authToken) {
    headers.Authorization = `Bearer ${state.authToken}`;
  }
  const sessionAccessToken = getSessionAccessToken();
  if (sessionAccessToken) {
    headers["X-Session-Access"] = sessionAccessToken;
  }
  return headers;
}

export function getDisplayNameFromAccount() {
  if (!state.accountUser?.name) return "";
  return state.accountUser.name;
}

export function canManageClasses() {
  return ["Teacher", "Admin", "SuperAdmin"].includes(state.accountUser?.role);
}

export function formatDateTime(value) {
  if (!value) return "Not started";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

export function clearSessionUrlState() {
  const url = new URL(window.location.href);
  url.searchParams.delete("join");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

export function abandonDraftSession(resetConversationFeedFn) {
  clearState();
  // Call the passed-in function to avoid circular dependency
  if (resetConversationFeedFn) {
    resetConversationFeedFn();
  }
  clearSessionUrlState();
}
