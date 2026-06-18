# Claude Memories in the Markdown Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Claude's auto-memory `.md` files as a dedicated group in the terminal's Markdown tab (fully editable), and add a last-modified date to every file row.

**Architecture:** Reuse the existing root-agnostic `MarkdownFilesManager` by pointing a second instance at the project's memory directory (`~/.claude/projects/<encoded-cwd>/memory/`). An explicit `root: 'project' | 'memory'` selector is threaded through the IPC surface so the backend dispatches to the correct manager; each root keeps its own security boundary. The renderer shows two collapsible groups (CLAUDE MEMORIES over PROJECT FILES) and a hybrid relative/absolute date on each row.

**Tech Stack:** Electron (main + preload + renderer), Node `fs`/`path`/`os`, plain-Node test scripts. No new dependencies.

## Global Constraints

- **No hardcoded colors in CSS** — every color uses a design-token CSS variable with a fallback, e.g. `var(--color-text-muted, #777)`. Add new tokens to `design-tokens.js` first if needed.
- **No `innerHTML` for content** except the existing single sanitized markdown path (`DOMPurify.sanitize(marked.parse(...))`). Build DOM via `createElement`/`textContent`.
- **Node not on PATH by default.** Prefix test commands with: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"`.
- **Core modules take injectable deps** so they run under plain Node without Electron (e.g. `homedir`, `projectsRoot`, `fs`, `trash`).
- **Path encoding is `cwd.replace(/\//g, '-')`** — preserves case and spaces. Resolution is verified against disk; if the project dir is absent, no memory section is shown.
- **Backward-compatible `root` default is `'project'`** on every IPC handler.

---

### Task 1: `claudeMemoryPath` core module

Pure path computation mapping a terminal cwd to its Claude memory directory. No filesystem access inside the function (callers do existence checks), so it is fully deterministic and unit-testable.

**Files:**
- Create: `src/core/claudeMemoryPath.js`
- Test: `test/claude-memory-path.test.js`

**Interfaces:**
- Produces: `memoryDirForCwd(cwd, { homedir, projectsRoot }) -> { encoded: string, projectDir: string, memoryDir: string }`
  - `encoded` = `cwd.replace(/\//g, '-')`
  - `projectsRoot` defaults to `path.join(homedir, '.claude', 'projects')`
  - `homedir` defaults to `os.homedir()`

- [ ] **Step 1: Write the failing test**

Create `test/claude-memory-path.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node test/claude-memory-path.test.js`
Expected: FAIL — `Cannot find module '../src/core/claudeMemoryPath'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/claudeMemoryPath.js`:

```javascript
/**
 * claudeMemoryPath
 *
 * Maps a terminal working directory to the Claude auto-memory directory that
 * Claude Code keeps at ~/.claude/projects/<encoded-cwd>/memory/.
 *
 * Encoding (verified against real project dirs): replace every '/' with '-',
 * preserving case and spaces. Pure path math only — callers perform existence
 * checks so this stays deterministic and unit-testable. Deps are injectable.
 */
const os = require('os');
const path = require('path');

function memoryDirForCwd(cwd, deps = {}) {
  if (!cwd) throw new Error('memoryDirForCwd requires a cwd');
  const homedir = deps.homedir || os.homedir();
  const projectsRoot = deps.projectsRoot || path.join(homedir, '.claude', 'projects');
  const encoded = cwd.replace(/\//g, '-');
  const projectDir = path.join(projectsRoot, encoded);
  const memoryDir = path.join(projectDir, 'memory');
  return { encoded, projectDir, memoryDir };
}

module.exports = { memoryDirForCwd };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node test/claude-memory-path.test.js`
Expected: PASS — `3 assertions passed`.

- [ ] **Step 5: Commit**

```bash
git add src/core/claudeMemoryPath.js test/claude-memory-path.test.js
git commit -m "Add claudeMemoryPath: cwd -> Claude memory dir resolver"
```

---

### Task 2: Backend — memory manager, `root` dispatch, watcher, preload

Add a second `MarkdownFilesManager` per cwd rooted at the memory dir, route IPC by `root`, return both roots from `markdown-list`, and live-refresh memory changes by watching the parent project dir.

**Files:**
- Modify: `src/main.js` (markdown section ~lines 105-128 and IPC handlers ~1703-1745)
- Modify: `src/terminal-preload.js:196-211` (markdownFiles bridge)
- Test: `test/markdown-files-manager.test.js` (add one assertion)

**Interfaces:**
- Consumes: `memoryDirForCwd` from Task 1; existing `ensureMarkdownManager(cwd)`, `viewManager.broadcastToTerminalsWithCwd(cwd, channel, data)`.
- Produces (renderer-facing IPC, Task 3 consumes these):
  - `markdownFiles.list()` -> `{ project: Row[], memory: Row[], memoryAvailable: boolean }` where `Row = { relPath, name, dir, mtimeMs, size }`
  - `markdownFiles.read(root, relPath)` / `.write(root, relPath, content)` / `.create(root, relPath)` / `.remove(root, relPath)` / `.rename(root, fromRel, toRel)`

- [ ] **Step 1: Add the memory-manager machinery in `main.js`**

At the top of `main.js`, add the require near the other core requires (next to `const MarkdownFilesManager = require('./core/MarkdownFilesManager');` at line 24):

```javascript
const { memoryDirForCwd } = require('./core/claudeMemoryPath');
```

Then, immediately after the existing `releaseMarkdownManagerIfUnused` function (ends ~line 128), add:

```javascript
// Memory files: a second MarkdownFilesManager per cwd, rooted at the project's
// Claude memory dir (~/.claude/projects/<encoded>/memory). The list watcher sits
// on the PARENT project dir so we also catch the first creation of memory/.
const memoryManagers = new Map();  // cwd -> MarkdownFilesManager (rooted at memoryDir)
const memoryWatchers = new Map();  // cwd -> { watcher, timer }

function ensureMemoryManager(cwd) {
  if (!cwd) return null;
  const { projectDir, memoryDir } = memoryDirForCwd(cwd);
  if (!fs.existsSync(projectDir)) return null; // Claude Code never ran here
  let mgr = memoryManagers.get(cwd);
  if (!mgr) {
    mgr = new MarkdownFilesManager(memoryDir, { trash: (p) => shell.trashItem(p) });
    try {
      const watcher = fs.watch(projectDir, { recursive: true }, (_event, filename) => {
        if (filename && !filename.toString().toLowerCase().endsWith('.md')) return;
        const entry = memoryWatchers.get(cwd);
        if (entry) {
          clearTimeout(entry.timer);
          entry.timer = setTimeout(() => {
            viewManager.broadcastToTerminalsWithCwd(cwd, 'markdown-files-changed', {});
          }, 150);
        }
      });
      memoryWatchers.set(cwd, { watcher, timer: null });
    } catch { /* recursive watch unsupported on this platform */ }
    memoryManagers.set(cwd, mgr);
  }
  return mgr;
}

function getMarkdownManager(cwd, root) {
  return root === 'memory' ? ensureMemoryManager(cwd) : ensureMarkdownManager(cwd);
}
```

Then extend `releaseMarkdownManagerIfUnused(cwd)` so its `if (!stillUsed) { ... }` block also tears down the memory manager/watcher. The block currently reads:

```javascript
  if (!stillUsed) {
    const mgr = markdownManagers.get(cwd);
    if (mgr) { mgr.unwatch(); markdownManagers.delete(cwd); }
  }
```

Replace it with:

```javascript
  if (!stillUsed) {
    const mgr = markdownManagers.get(cwd);
    if (mgr) { mgr.unwatch(); markdownManagers.delete(cwd); }
    const memEntry = memoryWatchers.get(cwd);
    if (memEntry) {
      try { memEntry.watcher.close(); } catch {}
      clearTimeout(memEntry.timer);
      memoryWatchers.delete(cwd);
    }
    memoryManagers.delete(cwd);
  }
```

- [ ] **Step 2: Update the markdown IPC handlers in `main.js`**

Replace the whole `// ---- Markdown files tab ----` handler block (the six `ipcMain.handle('markdown-*', ...)` handlers, ~lines 1703-1745) with:

```javascript
// ---- Markdown files tab ----
ipcMain.handle('markdown-list', (event, { terminalId }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { project: [], memory: [], memoryAvailable: false };
  let project = [];
  try { project = ensureMarkdownManager(cwd).list(); }
  catch (err) { console.error('markdown-list (project) failed:', err); }
  const memMgr = ensureMemoryManager(cwd);
  let memory = [];
  if (memMgr) {
    try { memory = memMgr.list(); }
    catch (err) { console.error('markdown-list (memory) failed:', err); }
  }
  return { project, memory, memoryAvailable: !!memMgr };
});

ipcMain.handle('markdown-read', (event, { terminalId, root, relPath }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  const mgr = getMarkdownManager(cwd, root);
  if (!mgr) return { error: 'No memory directory' };
  try { return mgr.read(relPath); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-write', (event, { terminalId, root, relPath, content }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  if (typeof content !== 'string') return { error: 'Invalid content' };
  const mgr = getMarkdownManager(cwd, root);
  if (!mgr) return { error: 'No memory directory' };
  try { return mgr.write(relPath, content); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-create', (event, { terminalId, root, relPath }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  const mgr = getMarkdownManager(cwd, root);
  if (!mgr) return { error: 'No memory directory' };
  try { return mgr.create(relPath); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-delete', async (event, { terminalId, root, relPath }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  const mgr = getMarkdownManager(cwd, root);
  if (!mgr) return { error: 'No memory directory' };
  try { return await mgr.delete(relPath); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-rename', (event, { terminalId, root, fromRel, toRel }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  const mgr = getMarkdownManager(cwd, root);
  if (!mgr) return { error: 'No memory directory' };
  try { return mgr.rename(fromRel, toRel); }
  catch (err) { return { error: err.message }; }
});
```

- [ ] **Step 3: Thread `root` through the preload bridge**

In `src/terminal-preload.js`, replace the `markdownFiles` object's method definitions (lines 197-203) so each write/read method carries `root` (list keeps its no-arg signature):

```javascript
  markdownFiles: {
    list: () => ipcRenderer.invoke('markdown-list', { terminalId }),
    read: (root, relPath) => ipcRenderer.invoke('markdown-read', { terminalId, root, relPath }),
    write: (root, relPath, content) => ipcRenderer.invoke('markdown-write', { terminalId, root, relPath, content }),
    create: (root, relPath) => ipcRenderer.invoke('markdown-create', { terminalId, root, relPath }),
    remove: (root, relPath) => ipcRenderer.invoke('markdown-delete', { terminalId, root, relPath }),
    rename: (root, fromRel, toRel) => ipcRenderer.invoke('markdown-rename', { terminalId, root, fromRel, toRel }),
    openExternal: (url) => ipcRenderer.invoke('open-external', { url }),
    onFilesChanged: (callback) => {
```

(Leave `onFilesChanged` and the rest of the object unchanged.)

- [ ] **Step 4: Add a guard assertion to the manager test**

The date feature depends on `list()` rows carrying a numeric `mtimeMs`. In `test/markdown-files-manager.test.js`, add this test right after the existing `'list rows carry name and dir'` test (after line 53):

```javascript
  test('list rows carry a numeric mtimeMs (date column depends on it)', () => {
    const row = mgr.list().find(f => f.relPath === 'CLAUDE.md');
    assert.strictEqual(typeof row.mtimeMs, 'number');
    assert.ok(row.mtimeMs > 0);
  });
```

- [ ] **Step 5: Run the manager test and syntax-check the changed files**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node test/markdown-files-manager.test.js && \
node test/claude-memory-path.test.js && \
node --check src/main.js && \
node --check src/terminal-preload.js
```
Expected: both test scripts print their `N assertions passed` lines with no `✗`, and both `node --check` commands print nothing (exit 0).

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/terminal-preload.js test/markdown-files-manager.test.js
git commit -m "Wire memory-rooted markdown manager and root-aware IPC"
```

---

### Task 3: Renderer — grouped memories list + root-aware file ops

Render two collapsible groups in the Markdown tab, store both roots, and thread `root` through every open/save/rename/delete/create path plus panel-state persistence.

**Files:**
- Modify: `src/renderer/prompt-library.js` (constructor state ~40-51; panel state 552-588; `loadMarkdownFiles`/`renderMarkdownList`/`buildMarkdownRow` 3616-3693; `handleMarkdownFilesChanged` 3713-3749; open/save/rename/delete/create 3761-3994)
- Modify: `src/renderer/prompt-library.css` (markdown list section, after line 1772)

**Interfaces:**
- Consumes: `markdownFiles.list()` -> `{ project, memory, memoryAvailable }` and the `root`-carrying read/write/create/remove/rename from Task 2.
- Produces (Task 4 consumes): `buildMarkdownRow(file, root)` — the single insertion point for the date element.

- [ ] **Step 1: Extend constructor state**

In `src/renderer/prompt-library.js`, in the "Markdown tab state" block (after line 41 `this.mdFiles = [];`), add:

```javascript
    this.mdMemoryFiles = [];        // memory-root rows
    this.mdMemoryAvailable = false; // project dir exists under ~/.claude/projects
    this.mdOpenRoot = 'project';    // 'project' | 'memory' for the open file
    this.mdMemoryCollapsed = false; // CLAUDE MEMORIES group collapsed
    this.mdProjectCollapsed = false;// PROJECT FILES group collapsed
```

- [ ] **Step 2: Persist the new state in panel state**

In `loadPanelState` (after line 561 `this.mdMode = state?.mdMode || 'view';`), add:

```javascript
        this.mdOpenRoot = state?.mdOpenRoot || 'project';
        this.mdMemoryCollapsed = state?.mdMemoryCollapsed || false;
        this.mdProjectCollapsed = state?.mdProjectCollapsed || false;
```

In `savePanelState` (inside the `setPanelState({ ... })` object, after `mdMode: this.mdMode`), add a trailing comma to that line and append:

```javascript
          mdOpenRoot: this.mdOpenRoot,
          mdMemoryCollapsed: this.mdMemoryCollapsed,
          mdProjectCollapsed: this.mdProjectCollapsed
```

- [ ] **Step 3: Store both roots in `loadMarkdownFiles`**

Replace the body of `loadMarkdownFiles` (lines 3616-3628) with:

```javascript
  async loadMarkdownFiles() {
    try {
      const res = await window.electronAPI.markdownFiles.list();
      if (Array.isArray(res)) {
        this.mdFiles = res; this.mdMemoryFiles = []; this.mdMemoryAvailable = false;
      } else {
        this.mdFiles = res?.project || [];
        this.mdMemoryFiles = res?.memory || [];
        this.mdMemoryAvailable = !!res?.memoryAvailable;
      }
    } catch (err) {
      console.error('Failed to list markdown files:', err);
      this.mdFiles = []; this.mdMemoryFiles = []; this.mdMemoryAvailable = false;
    }
    this._mdLoaded = true;
    if (this.activeTab === 'markdown' && !this.mdOpenFile) {
      this.renderMarkdownList();
    }
    this.updateTabChrome();
  }
```

- [ ] **Step 4: Replace `renderMarkdownList` with a grouped renderer + add `buildMarkdownSection`**

Replace `renderMarkdownList` (lines 3630-3655) with the following two methods:

```javascript
  renderMarkdownList() {
    this.setMarkdownChromeHidden(false);
    const container = this.promptsContainer;
    container.textContent = '';

    const q = this.searchQuery;
    const match = (f) => !q || f.relPath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q);
    const projectFiles = this.mdFiles.filter(match);
    const memoryFiles = this.sortMemoryFiles(this.mdMemoryFiles.filter(match));

    if (this.mdFiles.length === 0 && !this.mdMemoryAvailable) {
      container.appendChild(this.buildEmptyState('No markdown files found. Click + to create one.'));
      return;
    }
    if (q && projectFiles.length === 0 && memoryFiles.length === 0) {
      container.appendChild(this.buildEmptyState('No files match.'));
      return;
    }

    if (this.mdMemoryAvailable) {
      container.appendChild(this.buildMarkdownSection(
        'CLAUDE MEMORIES', memoryFiles, 'memory',
        this.mdMemoryCollapsed,
        (c) => { this.mdMemoryCollapsed = c; this.savePanelState(); },
        () => this.createNewMarkdownFile('memory'),
        memoryFiles.length === 0 ? 'No memories yet. Click + to add one.' : null
      ));
    }
    container.appendChild(this.buildMarkdownSection(
      'PROJECT FILES', projectFiles, 'project',
      this.mdProjectCollapsed,
      (c) => { this.mdProjectCollapsed = c; this.savePanelState(); },
      null, null
    ));
  }

  // MEMORY.md pinned first, everything else alphabetical by relPath.
  sortMemoryFiles(files) {
    return [...files].sort((a, b) => {
      if (a.name === 'MEMORY.md' && b.name !== 'MEMORY.md') return -1;
      if (b.name === 'MEMORY.md' && a.name !== 'MEMORY.md') return 1;
      return a.relPath.localeCompare(b.relPath);
    });
  }

  // A collapsible group header + a .md-list of rows. onAdd (optional) renders a
  // "+" button on the header; emptyMsg (optional) shows when the group has no rows.
  buildMarkdownSection(title, files, root, collapsed, onToggle, onAdd, emptyMsg) {
    const section = document.createElement('div');
    section.className = 'prompt-section md-section';

    const header = document.createElement('div');
    header.className = 'prompt-section-header';

    const toggle = document.createElement('button');
    toggle.className = 'prompt-section-toggle';
    toggle.textContent = collapsed ? '▶' : '▼';

    const titleEl = document.createElement('span');
    titleEl.className = 'prompt-section-title';
    titleEl.textContent = `${title} (${files.length})`;

    header.appendChild(toggle);
    header.appendChild(titleEl);

    if (onAdd) {
      const addBtn = document.createElement('button');
      addBtn.className = 'md-section-add';
      addBtn.title = 'New memory file';
      addBtn.appendChild(this.createIcon('plus', 14));
      addBtn.addEventListener('click', (e) => { e.stopPropagation(); onAdd(); });
      header.appendChild(addBtn);
    }

    const listEl = document.createElement('div');
    listEl.className = 'md-list';
    if (collapsed) listEl.style.display = 'none';
    if (files.length === 0 && emptyMsg) {
      const hint = document.createElement('div');
      hint.className = 'md-section-empty';
      hint.textContent = emptyMsg;
      listEl.appendChild(hint);
    } else {
      for (const file of files) listEl.appendChild(this.buildMarkdownRow(file, root));
    }

    header.addEventListener('click', () => {
      collapsed = !collapsed;
      toggle.textContent = collapsed ? '▶' : '▼';
      listEl.style.display = collapsed ? 'none' : 'flex';
      onToggle(collapsed);
    });

    section.appendChild(header);
    section.appendChild(listEl);
    return section;
  }
```

- [ ] **Step 5: Make `buildMarkdownRow` root-aware**

Replace `buildMarkdownRow` (lines 3657-3693) so it accepts `root` and passes it into open/rename/delete:

```javascript
  buildMarkdownRow(file, root = 'project') {
    const row = document.createElement('div');
    row.className = 'md-row';

    const main = document.createElement('div');
    main.className = 'md-row-main';
    const nm = document.createElement('div');
    nm.className = 'md-row-name';
    nm.textContent = file.name;
    const dir = document.createElement('div');
    dir.className = 'md-row-dir';
    dir.textContent = file.dir;
    main.appendChild(nm);
    main.appendChild(dir);
    main.addEventListener('click', () => this.openMarkdownFile(file.relPath, root));
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'md-row-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'md-row-btn';
    renameBtn.title = 'Rename';
    renameBtn.appendChild(this.createIcon('edit', 14));
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this.promptRenameMarkdown(file, root); });

    const delBtn = document.createElement('button');
    delBtn.className = 'md-row-btn';
    delBtn.title = 'Delete';
    delBtn.appendChild(this.createIcon('trash', 14));
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteMarkdownFile(file, root); });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    row.appendChild(actions);
    return row;
  }
```

- [ ] **Step 6: Thread `root` through `handleMarkdownFilesChanged`**

Replace the body of `handleMarkdownFilesChanged` (lines 3713-3749) so existence checks and reload use the open file's root:

```javascript
  async handleMarkdownFilesChanged() {
    await this.loadMarkdownFiles();
    if (!this.mdOpenFile) return;
    const onMarkdownTab = this.activeTab === 'markdown';
    const list = this.mdOpenRoot === 'memory' ? this.mdMemoryFiles : this.mdFiles;
    const exists = list.some(f => f.relPath === this.mdOpenFile);
    if (!exists) {
      if (this.mdDirty) {
        this.mdStaleNotice = true;
        if (onMarkdownTab) this.renderMarkdownDetail();
      } else if (onMarkdownTab) {
        this.closeMarkdownFileImmediate();
      } else {
        this.mdOpenFile = null;
        this._mdContentPath = null;
        this.savePanelState();
      }
      return;
    }
    if (this.mdDirty) {
      this.mdStaleNotice = true;
      if (onMarkdownTab) this.renderMarkdownDetail();
      return;
    }
    try {
      const res = await window.electronAPI.markdownFiles.read(this.mdOpenRoot, this.mdOpenFile);
      if (!res?.error && res.content !== this.mdContent) {
        this.mdContent = res.content;
        this.mdDraft = res.content;
        this.mdLoadedMtimeMs = res.mtimeMs;
        if (onMarkdownTab) this.renderMarkdownDetail();
      }
    } catch (err) {
      console.error('Failed to reload markdown file:', err);
    }
  }
```

- [ ] **Step 7: Thread `root` through open/restore/save/rename/delete/create**

Apply these edits in `src/renderer/prompt-library.js`:

`openMarkdownFile` — change the signature and read call, and record the root (lines 3907-3926). Replace the method header line and the read line and add the assignment:

```javascript
  async openMarkdownFile(relPath, root = 'project') {
    let res;
    try { res = await window.electronAPI.markdownFiles.read(root, relPath); }
    catch (err) { res = { error: err.message }; }
    if (res?.error) {
      await this.showChoiceDialog('Could not open file: ' + res.error,
        [{ value: 'ok', label: 'OK', primary: true }]);
      return;
    }
    this.mdOpenRoot = root;
    this.mdOpenFile = relPath;
    this.mdContent = res.content;
    this.mdDraft = res.content;
    this.mdLoadedMtimeMs = res.mtimeMs;
    this._mdContentPath = relPath;
    this.mdDirty = false;
    this.mdStaleNotice = false;
    this.mdMode = 'view';
    this.savePanelState();
    this.renderPrompts();
  }
```

`openMarkdownFileInEdit` — pass root through (lines 3928-3935):

```javascript
  async openMarkdownFileInEdit(relPath, root = 'project') {
    await this.openMarkdownFile(relPath, root);
    if (this.mdOpenFile === relPath) {
      this.mdMode = 'edit';
      this.savePanelState();
      this.renderMarkdownDetail();
    }
  }
```

`restoreOpenMarkdownFile` — read with `this.mdOpenRoot` (line 3941):

```javascript
    try { res = await window.electronAPI.markdownFiles.read(this.mdOpenRoot, relPath); }
```

`saveMarkdownFile` — write with `this.mdOpenRoot` (line 3981):

```javascript
    try { res = await window.electronAPI.markdownFiles.write(this.mdOpenRoot, this.mdOpenFile, this.mdDraft); }
```

`createNewMarkdownFile` — accept a root and use it for create + auto-open (lines 3761-3778):

```javascript
  async createNewMarkdownFile(root = 'project') {
    const name = await this.showInputDialog({
      title: root === 'memory' ? 'New memory file' : 'New markdown file',
      message: 'File name (relative path allowed):',
      placeholder: root === 'memory' ? 'note.md' : 'notes.md',
      confirmLabel: 'Create'
    });
    if (!name || !name.trim()) return;
    const res = await window.electronAPI.markdownFiles.create(root, name.trim());
    if (res?.error) {
      await this.showChoiceDialog('Could not create file: ' + res.error,
        [{ value: 'ok', label: 'OK', primary: true }]);
      return;
    }
    await this.loadMarkdownFiles();
    if (this.openMarkdownFileInEdit) this.openMarkdownFileInEdit(res.relPath, root);
  }
```

`promptRenameMarkdown` — accept root and pass to rename, restoring the open-file root (lines 3780-3797):

```javascript
  async promptRenameMarkdown(file, root = 'project') {
    const next = await this.showInputDialog({
      title: 'Rename file',
      message: 'New name (relative path allowed):',
      value: file.relPath,
      confirmLabel: 'Rename'
    });
    if (!next || !next.trim() || next.trim() === file.relPath) return;
    const res = await window.electronAPI.markdownFiles.rename(root, file.relPath, next.trim());
    if (res?.error) {
      await this.showChoiceDialog('Rename failed: ' + res.error,
        [{ value: 'ok', label: 'OK', primary: true }]);
      return;
    }
    if (this.mdOpenFile === file.relPath && this.mdOpenRoot === root) {
      this.mdOpenFile = res.relPath; this._mdContentPath = res.relPath;
    }
    await this.loadMarkdownFiles();
    this.renderPrompts();
  }
```

`deleteMarkdownFile` — accept root and pass to remove (lines 3799-3814):

```javascript
  async deleteMarkdownFile(file, root = 'project') {
    const choice = await this.showChoiceDialog(
      `Move "${file.relPath}" to the Trash?`,
      [{ value: 'delete', label: 'Move to Trash', primary: true, danger: true },
       { value: 'cancel', label: 'Cancel' }]
    );
    if (choice !== 'delete') return;
    const res = await window.electronAPI.markdownFiles.remove(root, file.relPath);
    if (res?.error) {
      await this.showChoiceDialog('Delete failed: ' + res.error,
        [{ value: 'ok', label: 'OK', primary: true }]);
      return;
    }
    if (this.mdOpenFile === file.relPath && this.mdOpenRoot === root) this.closeMarkdownFileImmediate();
    else { await this.loadMarkdownFiles(); this.renderPrompts(); }
  }
```

- [ ] **Step 8: Verify `plus` icon exists; add it if missing**

Run: `grep -n "plus:" src/renderer/prompt-library.js`
If it prints a match, do nothing. If it prints nothing, add a `plus` entry inside the `icons` map in `createIcon` (alongside `edit`/`copy`, after line ~110):

```javascript
      plus: () => {
        const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        l1.setAttribute('x1', '12'); l1.setAttribute('y1', '5');
        l1.setAttribute('x2', '12'); l1.setAttribute('y2', '19');
        const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        l2.setAttribute('x1', '5'); l2.setAttribute('y1', '12');
        l2.setAttribute('x2', '19'); l2.setAttribute('y2', '12');
        return [l1, l2];
      },
```

- [ ] **Step 9: Add CSS for the section add button, empty hint, and group spacing**

In `src/renderer/prompt-library.css`, after line 1772 (`.md-row-btn:hover { ... }`), add:

```css
.md-section { margin-bottom: 4px; }
.md-section .prompt-section-header { display: flex; align-items: center; gap: 6px; }
.md-section-add {
  margin-left: auto;
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0;
  background: transparent; border: none; border-radius: var(--radius-sm, 4px);
  color: var(--color-text-secondary, #aaa); cursor: pointer;
}
.md-section-add:hover { background: var(--color-bg-elevated, #33333a); color: var(--color-text-primary, #fff); }
.md-section-empty {
  padding: 8px; font-size: 12px; color: var(--color-text-muted, #777);
}
```

- [ ] **Step 10: Syntax-check and run all tests**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node --check src/renderer/prompt-library.js && \
node test/claude-memory-path.test.js && \
node test/markdown-files-manager.test.js
```
Expected: `node --check` prints nothing (exit 0); both tests pass.

- [ ] **Step 11: Manual in-app check**

Run `npm start`. In a Claude Code terminal opened in this repo, open the Markdown tab. Verify:
- A **CLAUDE MEMORIES** group appears above **PROJECT FILES**, with `MEMORY.md` first.
- Clicking a memory file opens it; Edit → change → Save writes to `~/.claude/projects/.../memory/` (confirm with `cat`).
- The memory group's `+` creates a new memory file (opens in edit mode); rename and delete work (delete → Trash).
- Collapsing each group and reopening the panel preserves the collapse state and any open memory file.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/prompt-library.js src/renderer/prompt-library.css
git commit -m "Show Claude memories as a group in the Markdown tab, fully editable"
```

---

### Task 4: Last-modified date on every row

Add a hybrid relative/absolute date to each row (both groups), driven by `mtimeMs` already returned by `list()`.

**Files:**
- Modify: `src/renderer/prompt-library.js` (`buildMarkdownRow` from Task 3; add `formatMtime` helper)
- Modify: `src/renderer/prompt-library.css` (after the `.md-row-*` block)

**Interfaces:**
- Consumes: `file.mtimeMs` (number, epoch ms) from `list()` rows; `buildMarkdownRow(file, root)` from Task 3.

- [ ] **Step 1: Add the `formatMtime` helper**

In `src/renderer/prompt-library.js`, add this method directly above `buildMarkdownRow`:

```javascript
  // Hybrid last-modified label: today / yesterday / N days ago through 6 days,
  // then an absolute date (MMM D, plus year when it differs from now).
  formatMtime(mtimeMs) {
    if (!mtimeMs) return '';
    const then = new Date(mtimeMs);
    const now = new Date();
    const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);
    if (dayDiff <= 0) return 'today';
    if (dayDiff === 1) return 'yesterday';
    if (dayDiff < 7) return `${dayDiff} days ago`;
    const sameYear = then.getFullYear() === now.getFullYear();
    return then.toLocaleDateString(undefined, sameYear
      ? { month: 'short', day: 'numeric' }
      : { month: 'short', day: 'numeric', year: 'numeric' });
  }
```

- [ ] **Step 2: Render the date in `buildMarkdownRow`**

In `buildMarkdownRow` (from Task 3), insert a date element between the `main` block append and the `actions` block. After the line `row.appendChild(main);` add:

```javascript
    const date = document.createElement('div');
    date.className = 'md-row-date';
    date.textContent = this.formatMtime(file.mtimeMs);
    if (file.mtimeMs) date.title = new Date(file.mtimeMs).toLocaleString();
    row.appendChild(date);
```

- [ ] **Step 3: Add CSS for the date column**

In `src/renderer/prompt-library.css`, immediately after the `.md-row-dir { ... }` rule (line 1763), add:

```css
.md-row-date {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--color-text-muted, #777);
  white-space: nowrap;
  margin-left: 4px;
}
```

- [ ] **Step 4: Syntax-check**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node --check src/renderer/prompt-library.js`
Expected: prints nothing (exit 0).

- [ ] **Step 5: Manual check**

Run `npm start`, open the Markdown tab. Verify every row (both groups) shows a sensible label: recently edited files show `today`/`yesterday`/`N days ago`; older files show a date like `Jun 3` (or `Jun 3, 2025` for a prior year). Hovering a date shows the full timestamp.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/prompt-library.js src/renderer/prompt-library.css
git commit -m "Add hybrid last-modified date to Markdown tab rows"
```

---

## Self-Review Notes

**Spec coverage:**
- Auto-memory-only scope → Task 1 (resolver) + Task 2 (`ensureMemoryManager`).
- Grouped sections (CLAUDE MEMORIES over PROJECT FILES, MEMORY.md pinned) → Task 3 Steps 4.
- Fully editable incl. create → Task 3 Steps 5,7 (root threading) + memory `+` (Step 4).
- Empty-memory-dir hint → Task 3 Step 4 (`emptyMsg`).
- Hybrid last-modified on all rows + hover → Task 4.
- Path encoding + disk existence safety net → Task 1 + Task 2 (`fs.existsSync(projectDir)`).
- Parent-dir watcher for first `memory/` creation → Task 2 Step 1.
- Tests: `claude-memory-path.test.js` (Task 1), manager `mtimeMs` guard (Task 2), `node --check` + manual (Task 3/4).

**Type consistency:** `markdownFiles.{read,write,create,remove,rename}` take `root` as their first arg in both the preload (Task 2 Step 3) and every renderer caller (Task 3 Step 7). `list()` returns `{ project, memory, memoryAvailable }` in main (Task 2 Step 2), preload (unchanged signature), and renderer (`loadMarkdownFiles`, Task 3 Step 3). `buildMarkdownRow(file, root)` defined in Task 3 Step 5 and extended in Task 4 Step 2. `mdOpenRoot` defined in Task 3 Step 1 and used consistently in Steps 6-7.

**Known non-goals (documented in spec):** `MEMORY.md` index is not auto-maintained on edit/delete; CLAUDE.md and `~/.claude/CLAUDE.md` are out of scope.
