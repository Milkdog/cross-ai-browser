const assert = require('assert');
const path = require('path');
const { memoryDirForCwd } = require('../src/core/claudeMemoryPath');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (err) { console.error(`✗ ${name}\n   ${err.message}`); process.exitCode = 1; }
}

const HOME = '/Users/chris';
const opts = { homedir: HOME };

test('encodes a simple cwd by replacing slashes with dashes', () => {
  const r = memoryDirForCwd('/Users/chris/workspace/cross-ai-browser', opts);
  assert.strictEqual(r.encoded, '-Users-chris-workspace-cross-ai-browser');
  assert.strictEqual(r.projectDir,
    path.join(HOME, '.claude', 'projects', '-Users-chris-workspace-cross-ai-browser'));
  assert.strictEqual(r.memoryDir,
    path.join(HOME, '.claude', 'projects', '-Users-chris-workspace-cross-ai-browser', 'memory'));
});

test('preserves spaces and case in the path', () => {
  const r = memoryDirForCwd('/Users/chris/workspace/Time Since', opts);
  assert.strictEqual(r.encoded, '-Users-chris-workspace-Time Since');
});

test('honors an injected projectsRoot', () => {
  const r = memoryDirForCwd('/a/b', { homedir: HOME, projectsRoot: '/custom/root' });
  assert.strictEqual(r.projectDir, path.join('/custom/root', '-a-b'));
  assert.strictEqual(r.memoryDir, path.join('/custom/root', '-a-b', 'memory'));
});

console.log(`\n${passed} assertions passed`);
