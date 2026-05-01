const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

describe('Expanse landing page routing', () => {
  test('marketing hosts serve landing while talk host remains the app', () => {
    const serverSource = read('server/index.js');

    expect(serverSource).toContain('"expanseonline.co"');
    expect(serverSource).toContain('"www.expanseonline.co"');
    expect(serverSource).toContain('CANONICAL_MARKETING_HOST');
    expect(serverSource).toContain('res.redirect(308');
    expect(serverSource).toContain('client/public/landing.html');
    expect(serverSource).toContain('return next()');
  });

  test('landing page uses Expanse assets and points the app CTA at talk subdomain', () => {
    const landing = read('client/public/landing.html');
    const css = read('client/src/landing.css');

    expect(landing).toContain('/images/expanse-logo.png');
    expect(landing).toContain('Human-led seminars, amplified by Plato');
    expect(landing).toContain('Socratic extracurriculars');
    expect(landing).toContain('https://talk.expanseonline.co');
    expect(css).toContain('.seminar-scene');
    expect(css).toContain('.proof-section');
  });
});
