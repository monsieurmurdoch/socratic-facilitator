const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(
  path.join(__dirname, '../client/src/app.js'),
  'utf8'
);

describe('client Jitsi smoke guards', () => {
  test('Jitsi launch is idempotent for the active room and clears stale iframes', () => {
    expect(appSource).toContain('let jitsiLaunchingRoom = null;');
    expect(appSource).toContain('let activeJitsiRoom = null;');
    expect(appSource).toContain('jitsiLaunchingRoom === fullRoomName');
    expect(appSource).toContain('container.replaceChildren()');
    expect(appSource).toContain('document.getElementById("jitsi-container")?.replaceChildren()');
  });

  test('Jitsi mute releases the separate STT mic stream without flushing partial speech', () => {
    expect(appSource).toContain('stopSpeechRecognition({ flush: false, releaseStream: true })');
    expect(appSource).toContain('function discardSttBatch()');
    expect(appSource).toContain('sttStream.getTracks().forEach(t => t.stop())');
  });

  test('Plato mic is the app-owned STT gate rather than the Jitsi mirror flag', () => {
    expect(appSource).toContain('let platoMicMuted = false;');
    expect(appSource).toContain('function isPlatoInputMuted()');
    expect(appSource).toContain('document.getElementById("plato-mic-toggle")');
    expect(appSource).toContain('jitsiApi.executeCommand("toggleAudio")');
    expect(appSource).toContain('if (!isPlatoInputMuted() && sttActive && ws && ws.readyState === 1)');
    expect(appSource).not.toContain('if (!jitsiMicMuted && sttActive && ws && ws.readyState === 1)');
  });
});
