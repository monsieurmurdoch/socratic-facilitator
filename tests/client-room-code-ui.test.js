const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('client room code UI', () => {
  test('guest and student join forms teach the room-code model', () => {
    const html = read('client/public/index.html');

    expect(html).toContain('<label for="join-code-input">Room Code</label>');
    expect(html).toContain('<label for="join-code-input-student">Room Code</label>');
    expect(html).toContain('placeholder="e.g. maple-river"');
    expect(html).toContain('Ask your teacher for the room code');
    expect(html).not.toContain('Room codes start with <strong>RM-</strong>');
  });

  test('share links use the public room code when one is available', () => {
    const app = read('client/src/app.js');

    expect(app).toContain('const publicJoinCode = currentRoomCode || sessionId');
    expect(app).toContain('getShareLink(publicJoinCode)');
    expect(app).toContain('showShareInfo(msg.sessionId, msg.roomCode)');
  });
});
