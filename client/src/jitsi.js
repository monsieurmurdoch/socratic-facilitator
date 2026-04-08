/**
 * Jitsi Integration Module
 *
 * Handles Jitsi Meet video conferencing integration.
 */

import { state, JAAS_APP_ID, getAuthHeaders } from './state.js';
import { send } from './websocket.js';

// ---- API Helpers ----

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

// ---- Jitsi Script Loading ----

export function loadJitsiScript() {
  return new Promise((resolve, reject) => {
    if (state.jitsiScriptLoaded || window.JitsiMeetExternalAPI) {
      state.jitsiScriptLoaded = true;
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = `https://8x8.vc/${JAAS_APP_ID}/external_api.js`;
    script.onload = () => {
      state.jitsiScriptLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error("Failed to load JaaS API"));
    document.head.appendChild(script);
  });
}

// ---- Launch Jitsi ----

export async function launchJitsi(roomName, displayName) {
  try {
    await loadJitsiScript();
  } catch (e) {
    console.error("[Jitsi] Failed to load script:", e);
    alert("Failed to load video call. Check your connection and try again.");
    return;
  }

  if (state.jitsiApi) {
    state.jitsiApi.dispose();
  }

  const container = document.getElementById("jitsi-container");

  // Fetch JWT from server for authenticated access
  let jwt = null;
  try {
    const tokenData = await apiGet(`/api/jitsi-token?room=socratic-${roomName}&name=${encodeURIComponent(displayName)}&moderator=${state.isHost}`);
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

  state.jitsiApi = new JitsiMeetExternalAPI("8x8.vc", options);

  // Ensure iframe has audio/video permissions (Safari requires this)
  const iframe = state.jitsiApi.getIFrame();
  if (iframe) {
    iframe.setAttribute('allow', 'camera *; microphone *; autoplay *; display-capture *; clipboard-write *');
    console.log('[Jitsi] iframe permissions set');
  }

  // Import speech functions for event handlers
  import('./speech.js').then(({ startSpeechRecognition, stopSpeechRecognition }) => {
    state.jitsiApi.addEventListener('audioMuteStatusChanged', (event) => {
      console.log('[Jitsi] Audio mute:', event.muted);
      if (event.muted) {
        stopSpeechRecognition();
      } else {
        startSpeechRecognition();
      }
    });
  });

  state.jitsiApi.addEventListener('participantJoined', (event) => {
    console.log('[Jitsi] Participant joined:', event);
  });

  state.jitsiApi.addEventListener('participantLeft', (event) => {
    console.log('[Jitsi] Participant left:', event);
  });

  state.jitsiApi.addEventListener('readyToClose', () => {
    console.log('[Jitsi] Conference ended');
    send({ type: "end_discussion" });
  });

  state.jitsiApi.addEventListener('videoConferenceLeft', () => {
    console.log('[Jitsi] Left conference');
  });

  state.jitsiApi.addEventListener('errorOccurred', (event) => {
    console.error('[Jitsi] Error:', event);
  });

  console.log('[Jitsi] Launched room:', roomName);
}

// ---- Destroy Jitsi ----

export function destroyJitsi() {
  if (state.jitsiApi) {
    state.jitsiApi.dispose();
    state.jitsiApi = null;
  }
}
