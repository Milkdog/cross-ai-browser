# Tabbed Library Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the library panel's single stacked column (Notes, Reusable, Prompts, Testing, Done, Secrets) with three top tabs (Prompts / Notes / Secrets) plus a Global/Project scope filter, showing one focused view at a time.

**Architecture:** Renderer-only UX change in `prompt-library.js` (a ~3,100-line plain script exporting `window.PromptLibrary`) driven by two new persisted fields, `activeTab` and `scopeFilter`. `renderPrompts()` becomes a router that paints tab/scope chrome and delegates to `renderPromptsTab` / `renderNotesTab` / `renderSecretsTab`, all reusing the existing section builders. Static markup goes in `terminal.html`, styles in `prompt-library.css`, and panel-state persistence is extended in `PromptLibraryManager.js`.

**Tech Stack:** Vanilla JS (no framework, no innerHTML — `createElement`/`textContent` only), Electron IPC via `window.electronAPI`, design-token CSS variables. Plain-Node tests (no framework) for the one piece of pure logic (panel-state persistence); renderer changes verified via `node --check` + a manual checklist.

**Spec:** `docs/superpowers/specs/2026-06-13-library-panel-tabs-design.md`

**Node not on PATH:** prefix node commands with `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"`.

---

## File Structure

- **Modify** `src/core/PromptLibraryManager.js` — persist `activeTab` + `scopeFilter` in panel state (currently whitelists only `visible`/`width`).
- **Create** `test/prompt-panel-state.test.js` — plain-Node test for the persistence change.
- **Modify** `src/renderer/terminal.html` — static tab bar + scope segmented markup.
- **Modify** `src/renderer/prompt-library.css` — tab bar + scope segmented styles.
- **Modify** `src/renderer/prompt-library.js` — constructor fields, panel-state load/save, filtering helpers, render router, three tab methods, event wiring, context-aware add, search match badges.
- **Modify** `CLAUDE.md` — document the tabbed panel.

---

### Task 1: Persist activeTab + scopeFilter in panel state

**Files:**
- Modify: `src/core/PromptLibraryManager.js` (`getPanelState` ~1029, `setPanelState` ~1039)
- Test: `test/prompt-panel-state.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/prompt-panel-state.test.js`:

```js
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
```

- [ ] **Step 2: Run the test, expect failure**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node test/prompt-panel-state.test.js`
Expected: FAIL — `activeTab` is `undefined` (defaults/round-trip not implemented).

- [ ] **Step 3: Implement the persistence change**

In `src/core/PromptLibraryManager.js`, replace `getPanelState`:

```js
  getPanelState(tabId) {
    const panels = this.store.get('promptPanels', {});
    const saved = panels[tabId] || {};
    return {
      visible: saved.visible || false,
      width: saved.width || 300,
      activeTab: saved.activeTab || 'prompts',
      scopeFilter: saved.scopeFilter || 'all'
    };
  }
```

And replace `setPanelState`:

```js
  setPanelState(tabId, state) {
    const panels = this.store.get('promptPanels', {});
    const prev = panels[tabId] || {};
    panels[tabId] = {
      visible: state.visible !== undefined ? state.visible : (prev.visible || false),
      width: state.width !== undefined ? state.width : (prev.width || 300),
      activeTab: state.activeTab !== undefined ? state.activeTab : (prev.activeTab || 'prompts'),
      scopeFilter: state.scopeFilter !== undefined ? state.scopeFilter : (prev.scopeFilter || 'all')
    };
    this.store.set('promptPanels', panels);

    this.emit('panel-state-changed', { tabId, state: panels[tabId] });
  }
```

- [ ] **Step 4: Run the test, expect pass**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node test/prompt-panel-state.test.js`
Expected: `All 3 tests passed`

- [ ] **Step 5: Commit**

```bash
git add src/core/PromptLibraryManager.js test/prompt-panel-state.test.js
git commit -m "Persist activeTab + scopeFilter in library panel state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Tab bar + scope filter markup and styles

**Files:**
- Modify: `src/renderer/terminal.html` (the `#prompt-panel` block, ~lines 21-33)
- Modify: `src/renderer/prompt-library.css` (append)

- [ ] **Step 1: Add static markup**

In `src/renderer/terminal.html`, replace the panel block:

```html
    <div id="prompt-panel" class="collapsed">
      <div id="prompt-panel-header">
        <h3>Library</h3>
        <div class="prompt-panel-actions">
          <button class="prompt-panel-btn add-btn" title="Add to library">+</button>
          <button class="prompt-panel-btn collapse-btn" title="Close panel">×</button>
        </div>
      </div>
      <div id="prompt-search-container">
        <input type="text" id="prompt-search-input" placeholder="Search prompts...">
      </div>
      <div id="prompt-cards-container"></div>
    </div>
```

with:

```html
    <div id="prompt-panel" class="collapsed">
      <div id="prompt-panel-header">
        <h3>Library</h3>
        <div class="prompt-panel-actions">
          <button class="prompt-panel-btn add-btn" title="Add to library">+</button>
          <button class="prompt-panel-btn collapse-btn" title="Close panel">×</button>
        </div>
      </div>
      <div id="prompt-tabs">
        <button class="prompt-tab active" data-tab="prompts">Prompts<span class="prompt-tab-badge" hidden></span></button>
        <button class="prompt-tab" data-tab="notes">Notes<span class="prompt-tab-badge" hidden></span></button>
        <button class="prompt-tab" data-tab="secrets">Secrets<span class="prompt-tab-badge" hidden></span></button>
      </div>
      <div id="prompt-scope-filter">
        <button class="prompt-scope-btn active" data-scope="all">All</button>
        <button class="prompt-scope-btn" data-scope="global">Global</button>
        <button class="prompt-scope-btn" data-scope="project">Project</button>
      </div>
      <div id="prompt-search-container">
        <input type="text" id="prompt-search-input" placeholder="Search...">
      </div>
      <div id="prompt-cards-container"></div>
    </div>
```

- [ ] **Step 2: Add styles**

Append to `src/renderer/prompt-library.css` (design tokens only):

```css
/* === Tab bar === */
#prompt-tabs {
  display: flex;
  gap: 2px;
  padding: 0 8px;
  border-bottom: 1px solid var(--color-border-default, #3c3c42);
  background: var(--color-bg-surface, #1f1f24);
}
.prompt-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 8px 6px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}
.prompt-tab:hover {
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.7));
}
.prompt-tab.active {
  color: var(--color-text-primary, #ffffff);
  border-bottom-color: var(--color-primary-base, #6366f1);
}
.prompt-tab-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--color-primary-base, #6366f1);
  color: var(--color-text-primary, #ffffff);
}

/* === Scope segmented filter === */
#prompt-scope-filter {
  display: flex;
  margin: 8px 10px 0;
  background: var(--color-bg-input, #1a1a1f);
  border: 1px solid var(--color-border-default, #3c3c42);
  border-radius: var(--radius-md, 6px);
  overflow: hidden;
}
.prompt-scope-btn {
  flex: 1;
  padding: 4px 0;
  background: none;
  border: none;
  color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
  font-size: 10px;
  font-weight: 600;
  cursor: pointer;
}
.prompt-scope-btn:hover {
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.7));
}
.prompt-scope-btn.active {
  background: var(--color-primary-base, #6366f1);
  color: var(--color-text-primary, #ffffff);
}
```

- [ ] **Step 3: Verify no hardcoded colors and markup parity**

Run: `grep -nE "#[0-9a-fA-F]{3,6}" src/renderer/prompt-library.css | grep -v "var(" | grep -iE "prompt-tab|prompt-scope"`
Expected: no output (every new color is a `var()` fallback, not a bare hex).

Run: `grep -c "prompt-tab\|prompt-scope-btn\|prompt-tab-badge" src/renderer/terminal.html`
Expected: a non-zero count (markup present).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/terminal.html src/renderer/prompt-library.css
git commit -m "Add tab bar + scope filter markup and styles to library panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Constructor fields + panel-state load/save

**Files:**
- Modify: `src/renderer/prompt-library.js` (constructor ~19-49, `loadPanelState` ~510, `savePanelState` ~527)

- [ ] **Step 1: Add constructor fields**

In the constructor, immediately after `this.searchQuery = '';` (~line 37), add:

```js
    this.activeTab = 'prompts';   // 'prompts' | 'notes' | 'secrets'
    this.scopeFilter = 'all';     // 'all' | 'global' | 'project'
```

- [ ] **Step 2: Load the new fields**

In `loadPanelState`, replace the body's assignment block:

```js
        const state = await window.electronAPI.promptLibrary.getPanelState();
        this.panelVisible = state?.visible || false;
        this.panelWidth = state?.width || 300;

        this.updatePanelVisibility();
```

with:

```js
        const state = await window.electronAPI.promptLibrary.getPanelState();
        this.panelVisible = state?.visible || false;
        this.panelWidth = state?.width || 300;
        this.activeTab = state?.activeTab || 'prompts';
        this.scopeFilter = state?.scopeFilter || 'all';

        this.updatePanelVisibility();
```

- [ ] **Step 3: Save the new fields**

In `savePanelState`, replace the payload:

```js
        window.electronAPI.promptLibrary.setPanelState({
          visible: this.panelVisible,
          width: this.panelWidth
        });
```

with:

```js
        window.electronAPI.promptLibrary.setPanelState({
          visible: this.panelVisible,
          width: this.panelWidth,
          activeTab: this.activeTab,
          scopeFilter: this.scopeFilter
        });
```

- [ ] **Step 4: Syntax check**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node --check src/renderer/prompt-library.js`
Expected: silent (exit 0).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/prompt-library.js
git commit -m "Track and persist activeTab + scopeFilter in panel object

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Filtering helpers, render router, and three tab methods

**Files:**
- Modify: `src/renderer/prompt-library.js` (`filterPrompts` ~682, `renderPrompts` ~722-840, `renderSecretsSection` ~3167)

This task replaces the monolithic `renderPrompts` with a router + per-tab methods, adds scope-aware filtering, and wires the tab/scope click handlers so switching works.

- [ ] **Step 1: Replace `filterPrompts` with scope-aware helpers**

Replace the `filterPrompts` method (~682-693):

```js
  filterPrompts(prompts) {
    if (!this.searchQuery) return prompts;

    return prompts.filter(p => {
      const title = (p.title || '').toLowerCase();
      const content = (p.prompt || p.description || '').toLowerCase();
      const labels = (p.labels || []).map(l => l.toLowerCase());
      return title.includes(this.searchQuery) ||
             content.includes(this.searchQuery) ||
             labels.some(l => l.includes(this.searchQuery));
    });
  }
```

with:

```js
  /** True if the item passes the active Global/Project scope filter. */
  matchesScope(item) {
    if (this.scopeFilter === 'all') return true;
    return (item.scope || 'project') === this.scopeFilter;
  }

  /**
   * True if the item passes the active search query. Secrets pass nameOnly=true
   * so their values never participate in search (security rule).
   */
  matchesSearch(item, nameOnly = false) {
    if (!this.searchQuery) return true;
    if (nameOnly) {
      return (item.name || '').toLowerCase().includes(this.searchQuery);
    }
    const title = (item.title || '').toLowerCase();
    const content = (item.prompt || item.description || '').toLowerCase();
    const labels = (item.labels || []).map(l => l.toLowerCase());
    return title.includes(this.searchQuery) ||
           content.includes(this.searchQuery) ||
           labels.some(l => l.includes(this.searchQuery));
  }

  /** Apply both scope and search filters to a list of items. */
  filterItems(items, nameOnly = false) {
    return items.filter(i => this.matchesScope(i) && this.matchesSearch(i, nameOnly));
  }

  /** Build a standard empty/no-match placeholder for any tab. */
  buildEmptyState(message) {
    const emptyState = document.createElement('div');
    emptyState.className = 'prompt-empty-state';
    const icon = document.createElement('div');
    icon.className = 'prompt-empty-icon';
    icon.textContent = '📋';
    const text = document.createElement('div');
    text.className = 'prompt-empty-text';
    text.textContent = message;
    emptyState.appendChild(icon);
    emptyState.appendChild(text);
    return emptyState;
  }
```

- [ ] **Step 2: Replace `renderPrompts` with the router**

Replace the entire `renderPrompts` method (from `renderPrompts() {` ~722 through its closing brace before `updateTestingTimers` ~840) with:

```js
  /**
   * Router: paint tab/scope chrome, then render the active tab's body.
   */
  renderPrompts() {
    if (!this.promptsContainer) return;

    // Capture any in-progress secret form draft before clearing the container
    this.captureSecretFormDraft();

    // Clear any existing testing timer (the Prompts tab re-creates it if needed)
    if (this.testingTimerInterval) {
      clearInterval(this.testingTimerInterval);
      this.testingTimerInterval = null;
    }

    this.updateTabChrome();

    this.promptsContainer.textContent = '';
    switch (this.activeTab) {
      case 'notes':
        this.renderNotesTab();
        break;
      case 'secrets':
        this.renderSecretsTab();
        break;
      case 'prompts':
      default:
        this.renderPromptsTab();
        break;
    }
  }

  /** Reflect activeTab + scopeFilter in the tab bar and scope segmented control,
   *  and show per-tab search match-count badges while a query is active. */
  updateTabChrome() {
    const tabs = document.querySelectorAll('#prompt-tabs .prompt-tab');
    tabs.forEach(btn => {
      const tab = btn.dataset.tab;
      btn.classList.toggle('active', tab === this.activeTab);
      const badge = btn.querySelector('.prompt-tab-badge');
      if (!badge) return;
      const count = (this.searchQuery && tab !== this.activeTab) ? this.tabMatchCount(tab) : 0;
      if (count > 0) {
        badge.textContent = String(count);
        badge.hidden = false;
      } else {
        badge.textContent = '';
        badge.hidden = true;
      }
    });

    const scopeBtns = document.querySelectorAll('#prompt-scope-filter .prompt-scope-btn');
    scopeBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.scope === this.scopeFilter);
    });
  }

  /** Count items in a tab that match the current search + scope filters. */
  tabMatchCount(tab) {
    if (tab === 'secrets') {
      return this.filterItems(this.secrets, true).length;
    }
    const items = this.prompts.filter(p =>
      tab === 'notes' ? p.type === 'note' : p.type !== 'note');
    return this.filterItems(items).length;
  }

  /** Prompts tab: Reusable + Active sections, with Testing/Done collapsible. */
  renderPromptsTab() {
    const items = this.filterItems(this.prompts.filter(p => p.type !== 'note'));
    const reusablePrompts = items.filter(p => p.reusable);
    const regularPrompts = items.filter(p => !p.reusable && !p.done && !p.testing);
    const testingPrompts = items.filter(p => !p.reusable && p.testing && !p.done);
    const donePrompts = items.filter(p => !p.reusable && p.done);

    reusablePrompts.sort((a, b) => {
      if (a.scope === 'global' && b.scope !== 'global') return -1;
      if (a.scope !== 'global' && b.scope === 'global') return 1;
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (a.order || 0) - (b.order || 0);
    });
    const sortWithFavoritesFirst = (a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (a.order || 0) - (b.order || 0);
    };
    regularPrompts.sort(sortWithFavoritesFirst);
    testingPrompts.sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (b.testingStartedAt || 0) - (a.testingStartedAt || 0);
    });
    donePrompts.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));

    if (items.length === 0) {
      const msg = (this.searchQuery || this.scopeFilter !== 'all')
        ? 'No prompts match.'
        : 'No prompts yet. Click + to add a prompt.';
      this.promptsContainer.appendChild(this.buildEmptyState(msg));
      return;
    }

    if (reusablePrompts.length > 0) {
      this.promptsContainer.appendChild(
        this.createSection('REUSABLE', reusablePrompts, this.reusableCollapsed,
          (collapsed) => { this.reusableCollapsed = collapsed; }, 'reusable'));
    }
    if (regularPrompts.length > 0) {
      this.promptsContainer.appendChild(
        this.createSection('ACTIVE', regularPrompts, this.regularCollapsed,
          (collapsed) => { this.regularCollapsed = collapsed; }, 'regular'));
    }
    if (testingPrompts.length > 0) {
      this.promptsContainer.appendChild(this.createTestingSection(testingPrompts));
    }
    if (donePrompts.length > 0) {
      this.promptsContainer.appendChild(this.createDoneSection(donePrompts));
    }

    this.setupPromptEventListeners();

    if (testingPrompts.length > 0) {
      this.testingTimerInterval = setInterval(() => {
        this.updateTestingTimers();
      }, 60000);
    }
  }

  /** Notes tab: a single NOTES section. */
  renderNotesTab() {
    const notes = this.filterItems(this.prompts.filter(p => p.type === 'note'));
    notes.sort((a, b) => {
      if (a.scope === 'global' && b.scope !== 'global') return -1;
      if (a.scope !== 'global' && b.scope === 'global') return 1;
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;
      return (a.order || 0) - (b.order || 0);
    });

    if (notes.length === 0) {
      const msg = (this.searchQuery || this.scopeFilter !== 'all')
        ? 'No notes match.'
        : 'No notes yet. Click + to add a note.';
      this.promptsContainer.appendChild(this.buildEmptyState(msg));
      return;
    }

    this.promptsContainer.appendChild(
      this.createSection('NOTES', notes, this.notesCollapsed,
        (collapsed) => { this.notesCollapsed = collapsed; }, 'notes'));

    this.setupPromptEventListeners();
  }
```

- [ ] **Step 3: Replace `renderSecretsSection` with `renderSecretsTab`**

Replace the entire `renderSecretsSection` method (~3167-3241) with `renderSecretsTab` — no collapse toggle (the tab is the container) and no in-section add button (the header `+` adds when this tab is active), filtered by scope + name:

```js
  /**
   * Secrets tab: masked rows + inline add/edit form. Secrets are not draggable
   * and never join search by value — only by name (filterItems nameOnly=true).
   */
  renderSecretsTab() {
    if (!this.secretsAvailable) {
      const warn = document.createElement('div');
      warn.className = 'secrets-unavailable';
      warn.textContent = 'Secure storage is unavailable on this system — secrets are disabled.';
      this.promptsContainer.appendChild(warn);
      return;
    }

    if (this.secretsEditing === 'new') {
      this.promptsContainer.appendChild(this.createSecretForm(null));
    }

    const visible = this.filterItems(this.secrets, true);
    visible.forEach(secret => {
      if (this.secretsEditing === secret.id) {
        this.promptsContainer.appendChild(this.createSecretForm(secret));
      } else {
        this.promptsContainer.appendChild(this.createSecretRow(secret));
      }
    });

    if (visible.length === 0 && this.secretsEditing !== 'new') {
      const empty = document.createElement('div');
      empty.className = 'secrets-empty';
      empty.textContent = (this.searchQuery || this.scopeFilter !== 'all')
        ? 'No secrets match.'
        : 'No secrets yet. Click + to add one.';
      this.promptsContainer.appendChild(empty);
    }
  }
```

Also remove the now-unused `this.secretsCollapsed = true;` line from the constructor (its only readers were in the replaced `renderSecretsSection`).

- [ ] **Step 4: Wire tab + scope click handlers**

In `setupEventListeners`, immediately after the search-input block (after the `}` closing the `if (this.searchInput) { ... }` at ~247), add:

```js
    // Tab bar
    document.querySelectorAll('#prompt-tabs .prompt-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (!tab || tab === this.activeTab) return;
        this.activeTab = tab;
        this.savePanelState();
        this.renderPrompts();
      });
    });

    // Scope segmented filter
    document.querySelectorAll('#prompt-scope-filter .prompt-scope-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const scope = btn.dataset.scope;
        if (!scope || scope === this.scopeFilter) return;
        this.scopeFilter = scope;
        this.savePanelState();
        this.renderPrompts();
      });
    });
```

- [ ] **Step 5: Drop the per-card scope badge under a specific scope, and render secrets once loaded**

The per-card scope badge is redundant when the scope filter is Global or Project — show it only under "All". There are exactly two sites.

In `createSecretRow` (~3266), replace:

```js
    info.appendChild(scopeEl);
```

with:

```js
    if (this.scopeFilter === 'all') info.appendChild(scopeEl);
```

In `createPromptElement` (the reusable-card branch, ~1145), replace:

```js
      headerRow.appendChild(scopeIcon);
```

with:

```js
      if (this.scopeFilter === 'all') headerRow.appendChild(scopeIcon);
```

`loadSecrets` (~3151) sets `this.secrets` but never re-renders, so a Secrets-tab-on-open shows empty. Append a render at the end — replace:

```js
  async loadSecrets() {
    try {
      const result = await window.electronAPI.secrets.list();
      this.secrets = result.secrets || [];
      this.secretsAvailable = result.available !== false;
    } catch (err) {
      console.error('Failed to load secrets:', err);
      this.secrets = [];
    }
  }
```

with:

```js
  async loadSecrets() {
    try {
      const result = await window.electronAPI.secrets.list();
      this.secrets = result.secrets || [];
      this.secretsAvailable = result.available !== false;
    } catch (err) {
      console.error('Failed to load secrets:', err);
      this.secrets = [];
    }
    this.renderPrompts();
  }
```

- [ ] **Step 6: Syntax check**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node --check src/renderer/prompt-library.js`
Expected: silent (exit 0).

- [ ] **Step 7: Manual smoke test**

Run `npm start`, open a Claude Code terminal tab, press Cmd+Shift+P. Verify:
- Three tabs render; Prompts is active and shows Reusable/Active + collapsible Testing/Done.
- Clicking Notes shows only notes; Secrets shows secret rows.
- The scope segmented control switches All/Global/Project and the list narrows; under Global/Project the per-card G/P badge disappears.
- Switching tabs keeps the scope selection.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/prompt-library.js
git commit -m "Restructure library panel into Prompts/Notes/Secrets tabs

renderPrompts becomes a router delegating to renderPromptsTab/
renderNotesTab/renderSecretsTab, reusing existing section builders.
Adds scope-aware filtering, tab/scope click wiring, per-scope badge
hiding, and a secrets re-render on load.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Context-aware add button + search match badges

**Files:**
- Modify: `src/renderer/prompt-library.js` (`setupEventListeners` add-btn ~230, new `handleAddButton`, `showCreateModal` ~1508)

Note: the search match-count badges are already computed in `updateTabChrome` (Task 4). This task adds the context-aware `+` and verifies the badges end-to-end.

- [ ] **Step 1: Make the add button tab-aware**

In `setupEventListeners`, replace the add-btn block:

```js
    const addBtn = this.panel.querySelector('.add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => this.showCreateModal());
    }
```

with:

```js
    const addBtn = this.panel.querySelector('.add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', () => this.handleAddButton());
    }
```

- [ ] **Step 2: Add `handleAddButton`**

Immediately above `showCreateModal` (~1508), add:

```js
  /**
   * Context-aware add: creates an item of the active tab's type, defaulting
   * scope from the current scope filter (Global/Project; else Project).
   */
  handleAddButton() {
    if (this.activeTab === 'secrets') {
      if (!this.secretsAvailable) return;
      this.secretsEditing = 'new';
      this.renderPrompts();
      return;
    }
    const type = this.activeTab === 'notes' ? 'note' : 'prompt';
    const defaultScope =
      (this.scopeFilter === 'global' || this.scopeFilter === 'project')
        ? this.scopeFilter
        : 'project';
    this.editingPromptId = null;
    this.showInlineEditor(
      type === 'note' ? 'New Note' : 'New Item',
      '', '', [], [], false, false, defaultScope, type
    );
  }
```

- [ ] **Step 3: Syntax check**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node --check src/renderer/prompt-library.js`
Expected: silent (exit 0).

- [ ] **Step 4: Manual verification**

Run `npm start`, open a terminal tab, Cmd+Shift+P. Verify:
- On Prompts tab, `+` opens the prompt editor; on Notes tab it opens a note; on Secrets tab it opens the secret form.
- With scope set to Project, a new item defaults to Project scope in the editor; same for Global.
- Type a query that matches an item in another tab → that tab shows a count badge; switching lands on the matches. Clearing the query hides the badges.
- Secrets: a query matching a secret name badges the Secrets tab; a query matching no name does not.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/prompt-library.js
git commit -m "Context-aware add button for the active library tab

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Full verification pass + docs

**Files:**
- Modify: `CLAUDE.md` (Library section)

- [ ] **Step 1: Run all tests and syntax checks**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node test/prompt-panel-state.test.js && node test/secrets-manager.test.js && node test/tab-attribution.test.js && node --check src/renderer/prompt-library.js && node --check src/core/PromptLibraryManager.js`
Expected: all test files report all passing; both `--check` silent.

- [ ] **Step 2: Full manual checklist (spec §Verification)**

Run `npm start`, open a terminal tab, Cmd+Shift+P:
1. Tab switch preserves the current search text and scope filter.
2. Scope filter narrows correctly: All shows global+project (cards keep G/P badge); Global/Project narrow the list.
3. With a search active, non-active tabs show correct match-count badges; switching lands on the matches.
4. `+` adds an item of the active tab's type, scope defaulted from the filter.
5. `activeTab` + `scopeFilter` survive panel close/reopen and a terminal restart.
6. Secrets tab: name-only search still works; reveal/copy/edit/delete and the unavailable state still work.
7. Drag a prompt card from the Prompts tab to the terminal — still inserts; drag-reorder within a section still works.
8. Empty/no-match states render per tab.

- [ ] **Step 3: Update CLAUDE.md**

In `CLAUDE.md`, under the Library (Prompts + Notes) section's "### UI" subsection, replace the bullet list intro for the panel layout by adding this bullet near the top of that list:

```markdown
- **Tabbed layout** - Three tabs (Prompts / Notes / Secrets) with a Global/Project/All scope filter. Prompts tab holds Reusable + Active sections plus collapsible Testing/Done. `activeTab` and `scopeFilter` persist per terminal in panel state. `renderPrompts()` is a router delegating to `renderPromptsTab`/`renderNotesTab`/`renderSecretsTab`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "Document tabbed library panel layout in CLAUDE.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
