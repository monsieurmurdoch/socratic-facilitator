const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(
  path.join(__dirname, '../client/src/app.js'),
  'utf8'
);

describe('client class materials rendering', () => {
  test('expanded class card renders the current materials list immediately', () => {
    const expandedListIndex = appSource.indexOf('id="expanded-materials-list"');
    const renderCallIndex = appSource.indexOf('renderMaterials();', expandedListIndex);
    const wiringIndex = appSource.indexOf('// Wire up buttons', expandedListIndex);

    expect(expandedListIndex).toBeGreaterThan(-1);
    expect(renderCallIndex).toBeGreaterThan(expandedListIndex);
    expect(renderCallIndex).toBeLessThan(wiringIndex);
  });
});
