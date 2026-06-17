// Tests for panel-state persistence of activeTab + scopeFilter.
// Plain Node: node test/prompt-panel-state.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PromptLibraryManager = require('../src/core/PromptLibraryManager');

// Minimal electron-store stand-in backed by a Map.
function makeStore() {
  const data = new Map();
  return {
    get: (k, d) => (data.has(k) ? data.get(k) : d),
    set: (k, v) => { data.set(k, v); },
    has: (k) => data.has(k)
  };
}

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelstate-'));
  return new PromptLibraryManager({ store: makeStore(), userDataPath: dir });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('defaults include activeTab=prompts and scopeFilter=all', () => {
  const mgr = makeManager();
  const state = mgr.getPanelState('tab1');
  assert.strictEqual(state.activeTab, 'prompts');
  assert.strictEqual(state.scopeFilter, 'all');
  assert.strictEqual(state.visible, false);
  assert.strictEqual(state.width, 300);
});

test('round-trips activeTab and scopeFilter', () => {
  const mgr = makeManager();
  mgr.setPanelState('tab1', { visible: true, width: 360, activeTab: 'secrets', scopeFilter: 'project' });
  const state = mgr.getPanelState('tab1');
  assert.strictEqual(state.activeTab, 'secrets');
  assert.strictEqual(state.scopeFilter, 'project');
  assert.strictEqual(state.visible, true);
  assert.strictEqual(state.width, 360);
});

test('panel state round-trips mdOpenFile and mdMode', () => {
  const mgr = makeManager();
  mgr.setPanelState('tab1', { mdOpenFile: 'docs/x.md', mdMode: 'edit' });
  const state = mgr.getPanelState('tab1');
  assert.strictEqual(state.mdOpenFile, 'docs/x.md');
  assert.strictEqual(state.mdMode, 'edit');
});

test('partial update preserves existing activeTab/scopeFilter', () => {
  const mgr = makeManager();
  mgr.setPanelState('tab1', { activeTab: 'notes', scopeFilter: 'global' });
  mgr.setPanelState('tab1', { width: 420 }); // unrelated update
  const state = mgr.getPanelState('tab1');
  assert.strictEqual(state.activeTab, 'notes');
  assert.strictEqual(state.scopeFilter, 'global');
  assert.strictEqual(state.width, 420);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`  ok    ${name}`); }
  catch (e) { failed++; console.error(`  FAIL  ${name}\n        ${e.message}`); }
}
console.log(failed ? `\n${failed}/${tests.length} failed` : `\nAll ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
