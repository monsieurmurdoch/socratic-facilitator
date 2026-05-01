const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(
  path.join(__dirname, '../client/src/app.js'),
  'utf8'
);
const styleSource = fs.readFileSync(
  path.join(__dirname, '../client/src/style.css'),
  'utf8'
);
const sessionsRouteSource = fs.readFileSync(
  path.join(__dirname, '../server/routes/sessions.js'),
  'utf8'
);

describe('analytics post-mortem UI guards', () => {
  test('analytics metric cards open explanatory submodals', () => {
    expect(appSource).toContain('metric-detail-backdrop');
    expect(appSource).toContain('data-metric-key');
    expect(appSource).toContain('How it is calculated');
    expect(styleSource).toContain('.metric-detail-modal');
  });

  test('analytics transcript can collapse inside the post-mortem modal', () => {
    expect(appSource).toContain('analytics-transcript-toggle');
    expect(appSource).toContain('analytics-transcript-body');
    expect(appSource).toContain("transcriptBody.toggleAttribute('hidden')");
  });

  test('analytics post-mortem surfaces transcript health and estimated speaking time', () => {
    expect(appSource).toContain('transcriptHealth');
    expect(appSource).toContain('transcript-health-section');
    expect(appSource).toContain('STT issue:');
    expect(appSource).toContain('Est. Speaking');
    expect(styleSource).toContain('.transcript-health-grid');
  });

  test('analytics post-mortem includes Plato replay/debug decisions for teachers', () => {
    expect(appSource).toContain('platoReplay');
    expect(appSource).toContain('plato-replay-section');
    expect(appSource).toContain('Recent Transcript Context');
    expect(appSource).toContain('Suppression Constraints');
    expect(styleSource).toContain('.plato-replay-item');
  });

  test('teacher notes are persisted through a managed session route', () => {
    expect(appSource).toContain('teacher-notes-input');
    expect(appSource).toContain('/teacher-notes');
    expect(sessionsRouteSource).toContain("router.post('/:shortCode/teacher-notes', async");
    expect(sessionsRouteSource).toContain("reportType: 'teacher_notes'");
  });

  test('analytics timeline modal renders zoomable speaker and metric lanes', () => {
    expect(appSource).toContain('conversation-timeline-modal');
    expect(appSource).toContain('open-conversation-timeline');
    expect(appSource).toContain('timeline-graph-btn');
    expect(appSource).toContain('function showSessionTimeline');
    expect(appSource).toContain('window.socraticOpenTimeline = showSessionTimeline');
    expect(appSource).toContain('timeline-zoom-in');
    expect(appSource).toContain('timelineZoom');
    expect(appSource).toContain('Who spoke');
    expect(appSource).toContain('timeline-inspector');
    expect(appSource).toContain('timelineFavorites');
    expect(appSource).toContain('timeline-summary-strip');
    expect(appSource).toContain('hiddenAfterEndCount');
    expect(appSource).toContain('allDatedMessages.filter(msg => msg._time <= endedAtTime)');
    expect(styleSource).toContain('.analytics-tool-strip');
    expect(styleSource).toContain('.timeline-modal-content');
    expect(styleSource).toContain('.conversation-timeline-svg');
  });
});
