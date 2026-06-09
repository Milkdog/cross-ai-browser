// Tests for Claude Code hook event -> tab attribution in ViewManager.
// Plain Node script (no test framework): node test/tab-attribution.test.js
//
// ViewManager requires 'electron', which under plain Node resolves to the
// binary-path string export — destructuring it yields undefined, which is fine
// because these tests never touch BrowserWindow/WebContentsView.

const assert = require('assert');
const ViewManager = require('../src/core/ViewManager');

function makeViewManager(tabs, activeTabId) {
  // tabs: { tabId: cwd }
  const storeData = {};
  for (const [tabId, cwd] of Object.entries(tabs)) {
    storeData[`tabData.${tabId}.cwd`] = cwd;
  }
  const vm = new ViewManager({
    mainWindow: null,
    store: { get: (key) => storeData[key] },
    getSidebarWidth: () => 160,
    onTabsChanged: () => {},
    onTerminalComplete: () => {}
  });
  for (const tabId of Object.keys(tabs)) {
    vm.terminalViews.set(tabId, {});
  }
  vm.activeTabId = activeTabId || null;
  return vm;
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

// --- The reported bug: new session in a new tab must not bind to the first
// --- (older, idle, unbound) tab when the event carries the tab's identity.
test('event tabId (from CROSSAI_TAB_ID) wins over cwd heuristic', () => {
  const vm = makeViewManager({ tabA: '/proj', tabB: '/proj' }, 'tabB');
  const chosen = vm._getTabIdForHookEvent('session-B1', '/proj', 'tabB');
  assert.strictEqual(chosen, 'tabB');
  // and the binding must stick for follow-up events without re-guessing
  assert.strictEqual(vm.hookSessionToTab.get('session-B1'), 'tabB');
});

test('event tabId for a closed tab falls back to heuristic', () => {
  const vm = makeViewManager({ tabA: '/proj' }, 'tabA');
  const chosen = vm._getTabIdForHookEvent('s1', '/proj', 'tab-gone');
  assert.strictEqual(chosen, 'tabA');
});

// --- Heuristic fallback (sessions outside the app, no header): prefer the
// --- active tab over creation order when both tabs are unbound.
test('heuristic prefers active tab among equally-matched unbound tabs', () => {
  const vm = makeViewManager({ tabA: '/proj', tabB: '/proj' }, 'tabB');
  const chosen = vm._getTabIdForHookEvent('session-X', '/proj', undefined);
  assert.strictEqual(chosen, 'tabB');
});

// --- Subdirectory matches must be sorted by specificity, not creation order.
test('deeper tab cwd wins for subdirectory event cwd', () => {
  const vm = makeViewManager({ tabA: '/ws', tabB: '/ws/proj' }, null);
  const ids = vm._findTabIdsForCwd('/ws/proj/sub');
  assert.deepStrictEqual(ids, ['tabB', 'tabA']);
});

test('exact match still beats deeper subdirectory parent', () => {
  const vm = makeViewManager({ tabA: '/ws/proj/sub', tabB: '/ws/proj' }, null);
  const ids = vm._findTabIdsForCwd('/ws/proj');
  assert.strictEqual(ids[0], 'tabB');
});

// --- Stale bindings: restarting Claude in a tab must free the tab so its
// --- next session does not get pushed onto another tab.
test('clearing a tab binding frees both maps', () => {
  const vm = makeViewManager({ tabA: '/proj', tabB: '/proj' }, 'tabB');
  vm._getTabIdForHookEvent('dead-session', '/proj', 'tabB');
  vm._clearHookSessionBinding('tabB');
  assert.strictEqual(vm.hookSessionToTab.has('dead-session'), false);
  assert.strictEqual(vm.hookTabToSession.has('tabB'), false);
  // a new headerless session in tabB's cwd can now claim the active tab again
  const chosen = vm._getTabIdForHookEvent('new-session', '/proj', undefined);
  assert.strictEqual(chosen, 'tabB');
});

test('stale binding does not push a tab\'s new session onto another tab', () => {
  const vm = makeViewManager({ tabA: '/proj', tabB: '/proj' }, 'tabB');
  // tabA's session is live and bound; tabB had a session that died (stale binding)
  vm._getTabIdForHookEvent('session-A', '/proj', 'tabA');
  vm._getTabIdForHookEvent('session-B-old', '/proj', 'tabB');
  vm._clearHookSessionBinding('tabB'); // restart path must do this
  const chosen = vm._getTabIdForHookEvent('session-B-new', '/proj', undefined);
  assert.strictEqual(chosen, 'tabB');
  // tabA's binding must be untouched
  assert.strictEqual(vm.hookSessionToTab.get('session-A'), 'tabA');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err.message}`);
  }
}
console.log(failed ? `\n${failed}/${tests.length} tests failed` : `\nAll ${tests.length} tests passed`);
process.exit(failed ? 1 : 0);
