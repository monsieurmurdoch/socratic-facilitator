/**
 * Analytics Module
 *
 * Handles session analytics modal and display.
 */

import { state, getAuthHeaders } from './state.js';

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

// ---- Analytics Modal ----

export function initAnalyticsModal() {
  const modal = document.getElementById('session-analytics-modal');
  const backdrop = document.getElementById('session-analytics-backdrop');
  const closeBtn = document.getElementById('analytics-close');

  // Close modal when clicking backdrop or close button
  backdrop.addEventListener('click', hideAnalyticsModal);
  closeBtn.addEventListener('click', hideAnalyticsModal);

  // Close on escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) {
      hideAnalyticsModal();
    }
  });
}

export function showSessionAnalytics(shortCode) {
  if (!state.accountUser) {
    console.warn('[Analytics] Requires sign-in');
    return;
  }

  const modal = document.getElementById('session-analytics-modal');
  const title = document.getElementById('analytics-title');
  const content = document.getElementById('analytics-content');

  // Show loading state
  title.textContent = `Session ${shortCode} - Analytics`;
  content.innerHTML = `
    <div class="analytics-loading">
      <div class="spinner"></div>
      <p>Loading detailed analytics...</p>
    </div>
  `;

  // Show modal (clear inline display:none, let .active class control visibility)
  modal.style.display = '';
  modal.classList.add('active');

  // Fetch analytics data
  apiGet(`/api/sessions/${shortCode}/analytics`)
    .then(data => {
      renderAnalyticsContent(data);
    })
    .catch(error => {
      console.error('Failed to load analytics:', error);
      content.innerHTML = `
        <div class="analytics-section">
          <p style="color: var(--text-secondary); text-align: center; padding: 40px;">
            Failed to load analytics: ${error.message}
          </p>
        </div>
      `;
    });
}

export function hideAnalyticsModal() {
  const modal = document.getElementById('session-analytics-modal');
  modal.classList.remove('active');
  modal.style.display = 'none';
}

function renderAnalyticsContent(data) {
  const { escapeHtml } = require('./ui.js');
  const { session, analytics } = data;
  const content = document.getElementById('analytics-content');

  const formatDuration = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  };

  const formatDateTime = (dateString) => {
    return new Date(dateString).toLocaleString();
  };

  content.innerHTML = `
    <!-- Session Overview -->
    <div class="analytics-section">
      <h3>Session Overview</h3>
      <div class="analytics-grid">
        <div class="analytics-metric">
          <span class="metric-value">${analytics.overview.participantCount}</span>
          <span class="metric-label">Participants</span>
        </div>
        <div class="analytics-metric">
          <span class="metric-value">${analytics.overview.messageCount}</span>
          <span class="metric-label">Messages</span>
        </div>
        <div class="analytics-metric">
          <span class="metric-value">${formatDuration(analytics.overview.durationSeconds)}</span>
          <span class="metric-label">Duration</span>
        </div>
        <div class="analytics-metric">
          <span class="metric-value">${analytics.overview.totalSpeakingTimeSeconds}s</span>
          <span class="metric-label">Total Speaking</span>
        </div>
      </div>
    </div>

    <!-- Discussion Quality -->
    <div class="analytics-section">
      <h3>Discussion Quality</h3>
      <div class="analytics-grid">
        <div class="analytics-metric">
          <span class="metric-value">${analytics.quality.avgSpecificity.toFixed(2)}</span>
          <span class="metric-label">Avg Specificity</span>
        </div>
        <div class="analytics-metric">
          <span class="metric-value">${analytics.quality.avgProfoundness.toFixed(2)}</span>
          <span class="metric-label">Avg Profoundness</span>
        </div>
        <div class="analytics-metric">
          <span class="metric-value">${analytics.quality.avgCoherence.toFixed(2)}</span>
          <span class="metric-label">Avg Coherence</span>
        </div>
        <div class="analytics-metric">
          <span class="metric-value">${analytics.quality.avgDiscussionValue.toFixed(2)}</span>
          <span class="metric-label">Avg Discussion Value</span>
        </div>
      </div>
      <div style="margin-top: 16px; font-size: 0.9rem; color: var(--text-secondary);">
        <strong>Engagement Metrics:</strong> ${analytics.quality.anchorReferences} anchor references,
        ${analytics.quality.peerResponses} peer responses, ${analytics.quality.anchorsCreated} anchors created
      </div>
    </div>

    <!-- Participant Breakdown -->
    <div class="analytics-section">
      <h3>Participant Breakdown</h3>
      <table class="participants-table">
        <thead>
          <tr>
            <th>Participant</th>
            <th>Role</th>
            <th>Messages</th>
            <th>Speaking Time</th>
            <th>Contribution</th>
            <th>Engagement</th>
            <th>Speaking %</th>
          </tr>
        </thead>
        <tbody>
          ${analytics.participants.map(p => `
            <tr>
              <td>
                <span class="participant-name">${escapeHtml(p.name)}</span>
                ${p.age ? `<br><small style="color: var(--text-muted);">Age: ${p.age}</small>` : ''}
              </td>
              <td><span class="participant-role">${p.role}</span></td>
              <td>${p.messageCount}</td>
              <td>${formatDuration(p.speakingSeconds)}</td>
              <td>${p.contributionScore.toFixed(2)}</td>
              <td>${p.engagementScore.toFixed(2)}</td>
              <td>
                ${p.speakingPercentage}%
                <div class="speaking-bar">
                  <div class="speaking-fill" style="width: ${p.speakingPercentage}%"></div>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- Session Details -->
    <div class="analytics-section">
      <h3>Session Details</h3>
      <div style="background: var(--surface-alt); padding: 16px; border-radius: 10px; font-size: 0.9rem;">
        <strong>Title:</strong> ${escapeHtml(session.title)}<br>
        <strong>Status:</strong> ${session.status}<br>
        <strong>Started:</strong> ${formatDateTime(session.createdAt)}<br>
        ${session.endedAt ? `<strong>Ended:</strong> ${formatDateTime(session.endedAt)}` : ''}
      </div>
    </div>
  `;
}

// ---- Transcript Viewer ----

export function initTranscriptModal() {
  const modal = document.getElementById('transcript-modal');
  const backdrop = document.getElementById('transcript-backdrop');
  const closeBtn = document.getElementById('transcript-close');

  backdrop.addEventListener('click', hideTranscriptModal);
  closeBtn.addEventListener('click', hideTranscriptModal);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) {
      hideTranscriptModal();
    }
  });
}

export function showTranscript(shortCode) {
  if (!state.accountUser) {
    console.warn('[Transcript] Requires sign-in');
    return;
  }

  const modal = document.getElementById('transcript-modal');
  const title = document.getElementById('transcript-title');
  const body = document.getElementById('transcript-body');

  title.textContent = `Session ${shortCode} — Transcript`;
  body.innerHTML = `
    <div class="analytics-loading">
      <div class="spinner"></div>
      <p>Loading transcript...</p>
    </div>
  `;

  modal.style.display = '';
  modal.classList.add('active');

  // Fetch session info and messages in parallel
  Promise.all([
    apiGet(`/api/sessions/${shortCode}`),
    apiGet(`/api/sessions/${shortCode}/messages?limit=1000`)
  ]).then(([sessionData, messages]) => {
    renderTranscriptContent(sessionData, messages);
  }).catch(error => {
    console.error('Failed to load transcript:', error);
    body.innerHTML = `
      <div class="analytics-section">
        <p style="color: var(--text-secondary); text-align: center; padding: 40px;">
          Failed to load transcript: ${error.message}
        </p>
      </div>
    `;
  });
}

export function hideTranscriptModal() {
  const modal = document.getElementById('transcript-modal');
  modal.classList.remove('active');
  modal.style.display = 'none';
}

function renderTranscriptContent(sessionData, messages) {
  const { escapeHtml } = require('./ui.js');
  const body = document.getElementById('transcript-body');

  const formatTime = (dateStr) => {
    if (!dateStr) return '';
    return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  // Group messages by type for the header summary
  const participantMessages = messages.filter(m => m.senderType === 'participant');
  const facilitatorMessages = messages.filter(m => m.senderType === 'facilitator');

  let html = `
    <div class="analytics-section">
      <div style="background: var(--surface-alt); padding: 12px 16px; border-radius: 10px; font-size: 0.85rem; margin-bottom: 16px;">
        <strong>${escapeHtml(sessionData.title)}</strong><br>
        ${sessionData.participants.map(p => escapeHtml(p.name)).join(', ')} ·
        ${participantMessages.length} participant messages ·
        ${facilitatorMessages.length} facilitator messages
      </div>
    </div>
    <div class="transcript-feed">
  `;

  for (const msg of messages) {
    const time = formatTime(msg.createdAt);
    if (msg.senderType === 'facilitator') {
      html += `
        <div class="transcript-msg transcript-facilitator">
          <div class="transcript-msg-header">
            <span class="plato-avatar-tiny">P</span> Plato
            ${msg.moveType ? `<span class="transcript-move">${escapeHtml(msg.moveType)}</span>` : ''}
            <span class="transcript-time">${time}</span>
          </div>
          <div class="transcript-msg-text">${escapeHtml(msg.content)}</div>
        </div>
      `;
    } else {
      const senderName = escapeHtml(msg.senderName || 'Unknown');
      const targetInfo = msg.targetParticipantName ? ` (to ${escapeHtml(msg.targetParticipantName)})` : '';
      html += `
        <div class="transcript-msg transcript-participant">
          <div class="transcript-msg-header">
            <span class="transcript-sender">${senderName}</span>${targetInfo}
            <span class="transcript-time">${time}</span>
          </div>
          <div class="transcript-msg-text">${escapeHtml(msg.content)}</div>
        </div>
      `;
    }
  }

  html += '</div>';
  body.innerHTML = html;

  // Scroll to top
  body.scrollTop = 0;
}
