# Markdown Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Markdown" tab to the Claude Code terminal library panel that lists all `.md` files under the working directory and lets the user view rendered markdown or edit/save the raw text, with create/rename/delete and live refresh.

**Architecture:** A new `MarkdownFilesManager` core module owns filesystem access (list/read/write/create/delete/rename + a recursive watcher) and is the security boundary (path validation). `main.js` exposes it over IPC, one manager per cwd, broadcasting change events to terminals via the existing `broadcastToTerminalsWithCwd`. The renderer (`prompt-library.js`) gains a 4th tab with a master-detail UI: a flat file list and a viewer/editor that renders markdown with `marked` + `DOMPurify`.

**Tech Stack:** Electron, Node `fs`, `marked`, `dompurify`, vanilla DOM (no framework), electron-store v8.

## Global Constraints

- **No hardcoded colors in CSS** — use design-token CSS variables with fallbacks, e.g. `var(--color-bg-surface, #1f1f24)`. Add new tokens to `design-tokens.js` first if needed.
- **Safe DOM construction only** — use `createElement`/`textContent`. The ONLY permitted `innerHTML` for content is the sanitized markdown render: `el.innerHTML = DOMPurify.sanitize(marked.parse(text))`.
- **Path validation is mandatory** — every renderer-supplied relative path must be resolved and confirmed to stay inside the terminal's cwd before any fs operation.
- **Tests are plain Node scripts** in `test/`, run directly, exit non-zero on failure. Core modules take injectable dependencies so they run without Electron.
- **Node isn't on PATH by default** — prefix test commands with `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"`.
- **electron-store v8** (CommonJS) — do not upgrade.
- Renderer files have no automated tests — verify with `node --check` + the manual checklist.

---

### Task 1: MarkdownFilesManager core module (TDD)

**Files:**
- Create: `src/core/MarkdownFilesManager.js`
- Test: `test/markdown-files-manager.test.js`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `new MarkdownFilesManager(cwd, { fs?, trash? })`
  - `list()` → `Array<{ relPath, name, dir, mtimeMs, size }>` (sorted by relPath)
  - `read(relPath)` → `{ content: string, mtimeMs: number }`
  - `write(relPath, content)` → `{ mtimeMs: number }`
  - `create(relPath)` → `{ relPath: string }` (appends `.md` if missing; errors if exists)
  - `delete(relPath)` → `Promise<{ ok: true }>` (uses injected `trash`)
  - `rename(fromRel, toRel)` → `{ relPath: string }` (appends `.md` to target if missing)
  - `watch(onChange)` / `unwatch()` — debounced recursive watcher
  - All path-taking methods throw `Error` on a path that escapes cwd.

- [ ] **Step 1: Write the failing test**

Create `test/markdown-files-manager.test.js`:

```js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MarkdownFilesManager = require('../src/core/MarkdownFilesManager');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (err) { console.error(`✗ ${name}\n   ${err.message}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed++; }
  catch (err) { console.error(`✗ ${name}\n   ${err.message}`); process.exitCode = 1; }
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdfm-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# claude');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not markdown');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.md'), '# hidden ok');
  fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'sub', 'guide.md'), '# guide');
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'README.md'), '# noise');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD.md'), '# noise');
  return root;
}

(async () => {
  const root = makeRoot();
  const mgr = new MarkdownFilesManager(root);

  test('list finds .md recursively, includes hidden dirs, skips noise dirs', () => {
    const rels = mgr.list().map(f => f.relPath).sort();
    assert.deepStrictEqual(rels, [
      'CLAUDE.md',
      path.join('.claude', 'settings.md'),
      path.join('docs', 'sub', 'guide.md')
    ].sort());
  });

  test('list excludes non-.md files', () => {
    assert.ok(!mgr.list().some(f => f.name === 'notes.txt'));
  });

  test('list rows carry name and dir', () => {
    const row = mgr.list().find(f => f.relPath === 'CLAUDE.md');
    assert.strictEqual(row.name, 'CLAUDE.md');
    assert.strictEqual(row.dir, './');
  });

  test('read returns file content', () => {
    assert.strictEqual(mgr.read('CLAUDE.md').content, '# claude');
  });

  test('write persists content', () => {
    mgr.write('CLAUDE.md', '# changed');
    assert.strictEqual(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '# changed');
  });

  test('create makes an empty file and appends .md', () => {
    const res = mgr.create('newdir/fresh');
    assert.strictEqual(res.relPath, path.join('newdir', 'fresh.md'));
    assert.strictEqual(fs.readFileSync(path.join(root, 'newdir', 'fresh.md'), 'utf8'), '');
  });

  test('create rejects an existing file', () => {
    assert.throws(() => mgr.create('CLAUDE.md'));
  });

  test('rename moves the file', () => {
    mgr.create('torename.md');
    const res = mgr.rename('torename.md', 'renamed.md');
    assert.strictEqual(res.relPath, 'renamed.md');
    assert.ok(fs.existsSync(path.join(root, 'renamed.md')));
    assert.ok(!fs.existsSync(path.join(root, 'torename.md')));
  });

  await testAsync('delete uses the injected trash with an absolute path', async () => {
    const calls = [];
    const m2 = new MarkdownFilesManager(root, { trash: async (p) => { calls.push(p); } });
    m2.create('todelete.md');
    await m2.delete('todelete.md');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], path.join(root, 'todelete.md'));
  });

  test('read rejects path traversal', () => {
    assert.throws(() => mgr.read('../escape.md'));
  });

  test('write rejects path traversal', () => {
    assert.throws(() => mgr.write('../../etc/evil.md', 'x'));
  });

  test('create rejects absolute path escape', () => {
    assert.throws(() => mgr.create('/tmp/evil.md'));
  });

  test('rename rejects traversal on either side', () => {
    assert.throws(() => mgr.rename('CLAUDE.md', '../evil.md'));
  });

  console.log(`\n${passed} assertions passed`);
})();
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node test/markdown-files-manager.test.js
```
Expected: FAIL — `Cannot find module '../src/core/MarkdownFilesManager'`.

- [ ] **Step 3: Implement the module**

Create `src/core/MarkdownFilesManager.js`:

```js
/**
 * MarkdownFilesManager
 *
 * Filesystem access for the terminal's Markdown library tab. Owns the security
 * boundary: every relative path is resolved against the working directory and
 * verified to stay inside it before any read/write/create/delete/rename.
 *
 * Dependencies are injectable so the module is unit-testable under plain Node:
 *   - fs:    defaults to node:fs
 *   - trash: async (absPath) => void; defaults to fs.promises.unlink
 *            (main.js injects electron shell.trashItem so deletes go to the OS Trash)
 */
const nodeFs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  '.next', '.cache', 'coverage', '.superpowers'
]);

class MarkdownFilesManager {
  constructor(cwd, deps = {}) {
    if (!cwd) throw new Error('MarkdownFilesManager requires a cwd');
    this.cwd = path.resolve(cwd);
    this.fs = deps.fs || nodeFs;
    this.trash = deps.trash || (async (p) => { await this.fs.promises.unlink(p); });
    this._watcher = null;
    this._watchTimer = null;
  }

  /** Resolve relPath against cwd; throw if it escapes the working directory. */
  _resolveInside(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new Error('Invalid path');
    }
    const abs = path.resolve(this.cwd, relPath);
    const rel = path.relative(this.cwd, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes working directory: ${relPath}`);
    }
    return abs;
  }

  list() {
    const results = [];
    const walk = (absDir) => {
      let entries;
      try { entries = this.fs.readdirSync(absDir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(path.join(absDir, entry.name));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const abs = path.join(absDir, entry.name);
          let stat;
          try { stat = this.fs.statSync(abs); } catch { continue; }
          const relPath = path.relative(this.cwd, abs);
          const dirName = path.dirname(relPath);
          results.push({
            relPath,
            name: entry.name,
            dir: dirName === '.' ? './' : dirName + path.sep,
            mtimeMs: stat.mtimeMs,
            size: stat.size
          });
        }
      }
    };
    walk(this.cwd);
    results.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return results;
  }

  read(relPath) {
    const abs = this._resolveInside(relPath);
    const content = this.fs.readFileSync(abs, 'utf8');
    const stat = this.fs.statSync(abs);
    return { content, mtimeMs: stat.mtimeMs };
  }

  write(relPath, content) {
    const abs = this._resolveInside(relPath);
    this.fs.writeFileSync(abs, content, 'utf8');
    const stat = this.fs.statSync(abs);
    return { mtimeMs: stat.mtimeMs };
  }

  create(relPath) {
    let rel = relPath;
    if (!rel.toLowerCase().endsWith('.md')) rel += '.md';
    const abs = this._resolveInside(rel);
    if (this.fs.existsSync(abs)) throw new Error('File already exists');
    this.fs.mkdirSync(path.dirname(abs), { recursive: true });
    this.fs.writeFileSync(abs, '', 'utf8');
    return { relPath: path.relative(this.cwd, abs) };
  }

  async delete(relPath) {
    const abs = this._resolveInside(relPath);
    await this.trash(abs);
    return { ok: true };
  }

  rename(fromRel, toRel) {
    const fromAbs = this._resolveInside(fromRel);
    let to = toRel;
    if (!to.toLowerCase().endsWith('.md')) to += '.md';
    const toAbs = this._resolveInside(to);
    if (this.fs.existsSync(toAbs)) throw new Error('Target already exists');
    this.fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    this.fs.renameSync(fromAbs, toAbs);
    return { relPath: path.relative(this.cwd, toAbs) };
  }

  watch(onChange) {
    if (this._watcher) return;
    try {
      this._watcher = this.fs.watch(this.cwd, { recursive: true }, (_event, filename) => {
        if (filename) {
          const name = filename.toString();
          if (!name.toLowerCase().endsWith('.md')) return;
          if (name.split(path.sep).some(p => SKIP_DIRS.has(p))) return;
        }
        clearTimeout(this._watchTimer);
        this._watchTimer = setTimeout(() => onChange(), 150);
      });
    } catch {
      this._watcher = null; // recursive watch unsupported on this platform
    }
  }

  unwatch() {
    if (this._watcher) {
      try { this._watcher.close(); } catch {}
      this._watcher = null;
    }
    clearTimeout(this._watchTimer);
  }
}

module.exports = MarkdownFilesManager;
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node test/markdown-files-manager.test.js
```
Expected: PASS — every line prefixed `✓`, ends `15 assertions passed`, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/core/MarkdownFilesManager.js test/markdown-files-manager.test.js
git commit -m "Add MarkdownFilesManager core module with tests"
```

---

### Task 2: Add marked + DOMPurify and load them in the terminal

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/renderer/terminal.html` (script tags)

**Interfaces:**
- Produces: `window.marked` and `window.DOMPurify` globals available in the terminal renderer.

- [ ] **Step 1: Install the libraries**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
npm install marked dompurify
```
Expected: `package.json` gains `marked` and `dompurify` under dependencies; exit 0.

- [ ] **Step 2: Confirm the bundled file paths**

Run:
```bash
ls node_modules/marked/marked.min.js node_modules/dompurify/dist/purify.min.js
```
Expected: both paths print with no error. If a path differs (version layout change), use the actual UMD build path in the next step (e.g. `ls node_modules/marked/lib/` or `node_modules/dompurify/dist/`).

- [ ] **Step 3: Add the script tags**

In `src/renderer/terminal.html`, the scripts at the bottom currently read:
```html
  <script src="../../node_modules/xterm/lib/xterm.js"></script>
  <script src="../../node_modules/xterm-addon-fit/lib/xterm-addon-fit.js"></script>
  <script src="prompt-library.js"></script>
  <script src="terminal.js"></script>
```
Change to (add the two new scripts BEFORE `prompt-library.js`):
```html
  <script src="../../node_modules/xterm/lib/xterm.js"></script>
  <script src="../../node_modules/xterm-addon-fit/lib/xterm-addon-fit.js"></script>
  <script src="../../node_modules/marked/marked.min.js"></script>
  <script src="../../node_modules/dompurify/dist/purify.min.js"></script>
  <script src="prompt-library.js"></script>
  <script src="terminal.js"></script>
```

- [ ] **Step 4: Verify the app still loads and globals exist**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node --check src/renderer/terminal.js && echo "syntax ok"
```
Expected: `syntax ok`.

Manual: `npm start`, open a Claude Code terminal, open DevTools for the terminal view, confirm `typeof marked` and `typeof DOMPurify` are both `"object"`/`"function"` (not `undefined`). The CSP (`script-src 'self'`) allows these because they load from the local `node_modules` path.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/renderer/terminal.html
git commit -m "Add marked + DOMPurify for markdown rendering"
```

---

### Task 3: IPC handlers, per-cwd watcher, and preload bridge

**Files:**
- Modify: `src/main.js` (require + `shell`, manager registry, IPC handlers, terminal-close teardown, quit cleanup)
- Modify: `src/terminal-preload.js` (`markdownFiles` namespace + listener + cleanup)

**Interfaces:**
- Consumes: `MarkdownFilesManager` (Task 1); existing `viewManager.broadcastToTerminalsWithCwd(cwd, channel, data)`; `store.get(\`tabData.${terminalId}.cwd\`)`.
- Produces (renderer-facing, via `window.electronAPI.markdownFiles`):
  - `list()` → `Promise<Array<row>>`
  - `read(relPath)` → `Promise<{content,mtimeMs} | {error}>`
  - `write(relPath, content)` → `Promise<{mtimeMs} | {error}>`
  - `create(relPath)` → `Promise<{relPath} | {error}>`
  - `remove(relPath)` → `Promise<{ok} | {error}>`
  - `rename(fromRel, toRel)` → `Promise<{relPath} | {error}>`
  - `openExternal(url)` → `Promise<{ok}>`
  - `onFilesChanged(cb)` — subscribe to pushed `markdown-files-changed`

- [ ] **Step 1: Add `shell` to the electron import**

In `src/main.js` line 1, change:
```js
const { app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, Notification, Menu, dialog, session } = require('electron');
```
to:
```js
const { app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, Notification, Menu, dialog, session, shell } = require('electron');
```

- [ ] **Step 2: Require the manager**

In `src/main.js`, after the other core requires (the `SecretsManager` line ~23), add:
```js
const MarkdownFilesManager = require('./core/MarkdownFilesManager');
```

- [ ] **Step 3: Add the per-cwd manager registry**

In `src/main.js`, near the other top-level singletons (after the core requires, before the IPC handlers), add:
```js
// Markdown files: one manager (+ recursive watcher) per cwd, created lazily when
// a terminal first lists files. The watcher broadcasts change events to every
// terminal sharing that cwd.
const markdownManagers = new Map(); // cwd -> MarkdownFilesManager

function ensureMarkdownManager(cwd) {
  if (!cwd) return null;
  let mgr = markdownManagers.get(cwd);
  if (!mgr) {
    mgr = new MarkdownFilesManager(cwd, { trash: (p) => shell.trashItem(p) });
    mgr.watch(() => {
      viewManager.broadcastToTerminalsWithCwd(cwd, 'markdown-files-changed', {});
    });
    markdownManagers.set(cwd, mgr);
  }
  return mgr;
}

function releaseMarkdownManagerIfUnused(cwd) {
  if (!cwd) return;
  const tabData = store.get('tabData', {});
  const stillUsed = Object.values(tabData).some(d => d && d.cwd === cwd);
  if (!stillUsed) {
    const mgr = markdownManagers.get(cwd);
    if (mgr) { mgr.unwatch(); markdownManagers.delete(cwd); }
  }
}

function releaseAllMarkdownManagers() {
  for (const mgr of markdownManagers.values()) mgr.unwatch();
  markdownManagers.clear();
}
```

- [ ] **Step 4: Add the IPC handlers**

In `src/main.js`, immediately after the `prompt-library-get-cwd` handler (ends ~line 1665), add:
```js
// ---- Markdown files tab ----
ipcMain.handle('markdown-list', (event, { terminalId }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return [];
  try { return ensureMarkdownManager(cwd).list(); }
  catch (err) { console.error('markdown-list failed:', err); return []; }
});

ipcMain.handle('markdown-read', (event, { terminalId, relPath }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  try { return ensureMarkdownManager(cwd).read(relPath); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-write', (event, { terminalId, relPath, content }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  if (typeof content !== 'string') return { error: 'Invalid content' };
  try { return ensureMarkdownManager(cwd).write(relPath, content); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-create', (event, { terminalId, relPath }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  try { return ensureMarkdownManager(cwd).create(relPath); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-delete', async (event, { terminalId, relPath }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  try { return await ensureMarkdownManager(cwd).delete(relPath); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-rename', (event, { terminalId, fromRel, toRel }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  try { return ensureMarkdownManager(cwd).rename(fromRel, toRel); }
  catch (err) { return { error: err.message }; }
});

// Open an http/https link from rendered markdown in the user's default browser.
ipcMain.handle('open-external', (event, { url }) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(url);
      return { ok: true };
    }
  } catch {}
  return { ok: false };
});
```

- [ ] **Step 5: Tear down the watcher on terminal close**

In `src/main.js`, the handler at ~line 1458:
```js
ipcMain.on('terminal-close', (event, { terminalId }) => {
  closeTab(terminalId, true);
});
```
Change to:
```js
ipcMain.on('terminal-close', (event, { terminalId }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  closeTab(terminalId, true);
  releaseMarkdownManagerIfUnused(cwd);
});
```

- [ ] **Step 6: Tear down all watchers on quit**

In `src/main.js`, find the `app.on('window-all-closed', ...)` handler (search `window-all-closed`). Add `releaseAllMarkdownManagers();` as the first line of its callback. If no such handler exists, add:
```js
app.on('will-quit', () => { releaseAllMarkdownManagers(); });
```

- [ ] **Step 7: Add the preload bridge**

In `src/terminal-preload.js`, add a listener variable near the others (after `let streamingStateListener = null;` ~line 13):
```js
let markdownFilesListener = null;
```

Inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, after the `secrets: { ... }` block, add:
```js
  // Markdown files tab APIs
  markdownFiles: {
    list: () => ipcRenderer.invoke('markdown-list', { terminalId }),
    read: (relPath) => ipcRenderer.invoke('markdown-read', { terminalId, relPath }),
    write: (relPath, content) => ipcRenderer.invoke('markdown-write', { terminalId, relPath, content }),
    create: (relPath) => ipcRenderer.invoke('markdown-create', { terminalId, relPath }),
    remove: (relPath) => ipcRenderer.invoke('markdown-delete', { terminalId, relPath }),
    rename: (fromRel, toRel) => ipcRenderer.invoke('markdown-rename', { terminalId, fromRel, toRel }),
    openExternal: (url) => ipcRenderer.invoke('open-external', { url }),
    onFilesChanged: (callback) => {
      if (markdownFilesListener) {
        ipcRenderer.removeListener('markdown-files-changed', markdownFilesListener);
      }
      markdownFilesListener = () => callback();
      ipcRenderer.on('markdown-files-changed', markdownFilesListener);
    }
  },
```

In the `cleanup()` method, add before its closing brace:
```js
    if (markdownFilesListener) {
      ipcRenderer.removeListener('markdown-files-changed', markdownFilesListener);
      markdownFilesListener = null;
    }
```

In the `window.addEventListener('beforeunload', ...)` block, add:
```js
  if (markdownFilesListener) {
    ipcRenderer.removeListener('markdown-files-changed', markdownFilesListener);
  }
```

- [ ] **Step 8: Verify syntax**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node --check src/main.js && node --check src/terminal-preload.js && echo "syntax ok"
```
Expected: `syntax ok`.

- [ ] **Step 9: Commit**

```bash
git add src/main.js src/terminal-preload.js
git commit -m "Wire markdown files IPC, per-cwd watcher, and preload bridge"
```

---

### Task 4: Renderer — Markdown tab, file list, dialogs, file operations, live refresh

**Files:**
- Modify: `src/renderer/terminal.html` (tab button)
- Modify: `src/renderer/prompt-library.js` (state, routing, list view, dialogs, create/rename/delete, live refresh)
- Modify: `src/renderer/prompt-library.css` (list + dialog styles)

**Interfaces:**
- Consumes: `window.electronAPI.markdownFiles.*` (Task 3); existing `this.buildEmptyState(msg)`, `this.createIcon(name, size)`, `this.promptsContainer`, `this.renderPrompts()`, `this.savePanelState()`, `this.updateTabChrome()`.
- Produces (used by Task 5):
  - state fields `mdFiles, mdOpenFile, mdMode, mdContent, mdDraft, mdDirty, mdLoadedMtimeMs, mdStaleNotice, _mdContentPath, _mdLoaded, _mdChangeSubscribed`
  - `loadMarkdownFiles()`, `renderMarkdownList()`, `buildMarkdownRow(file)`, `setMarkdownChromeHidden(bool)`, `ensureMarkdownSubscription()`, `handleMarkdownFilesChanged()`
  - `showChoiceDialog(message, buttons)` → `Promise<value|null>`
  - `showInputDialog({title,message,value,placeholder,confirmLabel})` → `Promise<string|null>`

- [ ] **Step 1: Add the tab button**

In `src/renderer/terminal.html`, the `#prompt-tabs` block currently has three buttons. Add a fourth after the Secrets button:
```html
        <button class="prompt-tab" data-tab="markdown">Markdown<span class="prompt-tab-badge" hidden></span></button>
```

- [ ] **Step 2: Add state fields**

In `src/renderer/prompt-library.js`, in the constructor after `this.scopeFilter = 'all';` (~line 38), add:
```js
    // Markdown tab state
    this.mdFiles = [];
    this.mdOpenFile = null;       // relPath of the open file, or null (list view)
    this.mdMode = 'view';         // 'view' | 'edit'
    this.mdContent = '';          // last content loaded from / saved to disk
    this.mdDraft = '';            // current editor text
    this.mdDirty = false;
    this.mdLoadedMtimeMs = 0;
    this.mdStaleNotice = false;   // disk changed under unsaved edits
    this._mdContentPath = null;   // relPath whose content is in mdContent/mdDraft
    this._mdLoaded = false;       // file list fetched at least once
    this._mdChangeSubscribed = false;
```

- [ ] **Step 3: Route the markdown tab and hide the scope filter**

In `renderPrompts()` (~line 797), the `switch (this.activeTab)` adds a case. Change:
```js
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
```
to:
```js
    // The Markdown tab is filesystem-based, not scope-based — hide the scope filter.
    const scopeFilterEl = document.getElementById('prompt-scope-filter');
    if (scopeFilterEl && !this.isInlineEditing) {
      scopeFilterEl.style.display = (this.activeTab === 'markdown') ? 'none' : '';
    }

    this.promptsContainer.textContent = '';
    switch (this.activeTab) {
      case 'notes':
        this.renderNotesTab();
        break;
      case 'secrets':
        this.renderSecretsTab();
        break;
      case 'markdown':
        this.renderMarkdownTab();
        break;
      case 'prompts':
      default:
        this.renderPromptsTab();
        break;
    }
```

- [ ] **Step 4: Handle the markdown match-count badge**

In `tabMatchCount(tab)` (~line 837), add a markdown branch at the top of the method body:
```js
  tabMatchCount(tab) {
    if (tab === 'markdown') {
      const q = this.searchQuery;
      if (!q) return 0;
      return this.mdFiles.filter(f =>
        f.relPath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)).length;
    }
    if (tab === 'secrets') {
      return this.filterItems(this.secrets, true).length;
    }
    // ...existing prompts/notes logic unchanged...
```

- [ ] **Step 5: Add the markdown render methods (list view)**

In `src/renderer/prompt-library.js`, add these methods to the class (e.g. after `renderSecretsTab` near the end of the rendering methods):
```js
  // ---------- Markdown tab ----------

  renderMarkdownTab() {
    this.ensureMarkdownSubscription();
    if (this.mdOpenFile) {
      // Detail view lives in Task 5; until then, fall through to a reload.
      if (this._mdContentPath !== this.mdOpenFile) {
        this.setMarkdownChromeHidden(true);
        this.promptsContainer.textContent = '';
        this.promptsContainer.appendChild(this.buildEmptyState('Loading…'));
        this.restoreOpenMarkdownFile();
        return;
      }
      this.renderMarkdownDetail();
      return;
    }
    if (!this._mdLoaded) {
      this.promptsContainer.textContent = '';
      this.promptsContainer.appendChild(this.buildEmptyState('Loading…'));
      this.loadMarkdownFiles();
      return;
    }
    this.renderMarkdownList();
  }

  ensureMarkdownSubscription() {
    if (this._mdChangeSubscribed) return;
    if (window.electronAPI?.markdownFiles?.onFilesChanged) {
      window.electronAPI.markdownFiles.onFilesChanged(() => this.handleMarkdownFilesChanged());
      this._mdChangeSubscribed = true;
    }
  }

  async loadMarkdownFiles() {
    try {
      this.mdFiles = (await window.electronAPI.markdownFiles.list()) || [];
    } catch (err) {
      console.error('Failed to list markdown files:', err);
      this.mdFiles = [];
    }
    this._mdLoaded = true;
    if (this.activeTab === 'markdown' && !this.mdOpenFile) {
      this.renderMarkdownList();
    }
    this.updateTabChrome();
  }

  renderMarkdownList() {
    this.setMarkdownChromeHidden(false);
    const container = this.promptsContainer;
    container.textContent = '';

    if (this.mdFiles.length === 0) {
      container.appendChild(this.buildEmptyState('No markdown files found. Click + to create one.'));
      return;
    }

    const q = this.searchQuery;
    const files = q
      ? this.mdFiles.filter(f =>
          f.relPath.toLowerCase().includes(q) || f.name.toLowerCase().includes(q))
      : this.mdFiles;

    if (files.length === 0) {
      container.appendChild(this.buildEmptyState('No files match.'));
      return;
    }

    const listEl = document.createElement('div');
    listEl.className = 'md-list';
    for (const file of files) listEl.appendChild(this.buildMarkdownRow(file));
    container.appendChild(listEl);
  }

  buildMarkdownRow(file) {
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
    // Open handler is added in Task 5.
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'md-row-actions';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'md-row-btn';
    renameBtn.title = 'Rename';
    renameBtn.appendChild(this.createIcon('edit', 14));
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); this.promptRenameMarkdown(file); });

    const delBtn = document.createElement('button');
    delBtn.className = 'md-row-btn';
    delBtn.title = 'Delete';
    delBtn.appendChild(this.createIcon('trash', 14));
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); this.deleteMarkdownFile(file); });

    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    row.appendChild(actions);
    return row;
  }

  setMarkdownChromeHidden(hidden) {
    const searchContainer = document.getElementById('prompt-search-container');
    const panelHeader = document.getElementById('prompt-panel-header');
    const promptTabs = document.getElementById('prompt-tabs');
    const scopeFilter = document.getElementById('prompt-scope-filter');
    if (hidden) {
      if (searchContainer) searchContainer.style.display = 'none';
      if (panelHeader) panelHeader.style.display = 'none';
      if (promptTabs) promptTabs.style.display = 'none';
      if (scopeFilter) scopeFilter.style.display = 'none';
    } else {
      if (searchContainer) searchContainer.style.display = '';
      if (panelHeader) panelHeader.style.display = '';
      if (promptTabs) promptTabs.style.display = '';
      if (scopeFilter) scopeFilter.style.display = (this.activeTab === 'markdown') ? 'none' : '';
    }
  }

  async handleMarkdownFilesChanged() {
    await this.loadMarkdownFiles();
    if (!this.mdOpenFile) return;
    const exists = this.mdFiles.some(f => f.relPath === this.mdOpenFile);
    if (!exists) {
      if (this.mdDirty) { this.mdStaleNotice = true; this.renderMarkdownDetail(); }
      else { this.closeMarkdownFileImmediate(); }
      return;
    }
    if (this.mdDirty) {
      this.mdStaleNotice = true;
      this.renderMarkdownDetail();
      return;
    }
    try {
      const res = await window.electronAPI.markdownFiles.read(this.mdOpenFile);
      if (!res?.error && res.content !== this.mdContent) {
        this.mdContent = res.content;
        this.mdDraft = res.content;
        this.mdLoadedMtimeMs = res.mtimeMs;
        this.renderMarkdownDetail();
      }
    } catch (err) {
      console.error('Failed to reload markdown file:', err);
    }
  }

  closeMarkdownFileImmediate() {
    this.mdOpenFile = null;
    this.mdDirty = false;
    this.mdStaleNotice = false;
    this._mdContentPath = null;
    this.setMarkdownChromeHidden(false);
    this.savePanelState();
    this.renderPrompts();
  }

  async createNewMarkdownFile() {
    const name = await this.showInputDialog({
      title: 'New markdown file',
      message: 'File name (relative path allowed):',
      placeholder: 'notes.md',
      confirmLabel: 'Create'
    });
    if (!name || !name.trim()) return;
    const res = await window.electronAPI.markdownFiles.create(name.trim());
    if (res?.error) {
      await this.showChoiceDialog('Could not create file: ' + res.error,
        [{ value: 'ok', label: 'OK', primary: true }]);
      return;
    }
    await this.loadMarkdownFiles();
    // Auto-open in edit mode is added in Task 5; for now refresh the list.
    if (this.openMarkdownFileInEdit) this.openMarkdownFileInEdit(res.relPath);
  }

  async promptRenameMarkdown(file) {
    const next = await this.showInputDialog({
      title: 'Rename file',
      message: 'New name (relative path allowed):',
      value: file.relPath,
      confirmLabel: 'Rename'
    });
    if (!next || !next.trim() || next.trim() === file.relPath) return;
    const res = await window.electronAPI.markdownFiles.rename(file.relPath, next.trim());
    if (res?.error) {
      await this.showChoiceDialog('Rename failed: ' + res.error,
        [{ value: 'ok', label: 'OK', primary: true }]);
      return;
    }
    if (this.mdOpenFile === file.relPath) { this.mdOpenFile = res.relPath; this._mdContentPath = res.relPath; }
    await this.loadMarkdownFiles();
    this.renderPrompts();
  }

  async deleteMarkdownFile(file) {
    const choice = await this.showChoiceDialog(
      `Move "${file.relPath}" to the Trash?`,
      [{ value: 'delete', label: 'Move to Trash', primary: true, danger: true },
       { value: 'cancel', label: 'Cancel' }]
    );
    if (choice !== 'delete') return;
    const res = await window.electronAPI.markdownFiles.remove(file.relPath);
    if (res?.error) {
      await this.showChoiceDialog('Delete failed: ' + res.error,
        [{ value: 'ok', label: 'OK', primary: true }]);
      return;
    }
    if (this.mdOpenFile === file.relPath) this.closeMarkdownFileImmediate();
    else { await this.loadMarkdownFiles(); this.renderPrompts(); }
  }
```

- [ ] **Step 6: Add the dialog helpers**

Add to the class (these are reused by Task 5):
```js
  /** Modal with N buttons; resolves to the chosen button value, or null if dismissed. */
  showChoiceDialog(message, buttons) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'prompt-modal-overlay md-dialog-overlay';
      const box = document.createElement('div');
      box.className = 'prompt-modal md-dialog';

      const msg = document.createElement('div');
      msg.className = 'md-dialog-message';
      msg.textContent = message;
      box.appendChild(msg);

      const actions = document.createElement('div');
      actions.className = 'md-dialog-actions';
      const close = (value) => { overlay.remove(); resolve(value); };
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.className = 'md-dialog-btn'
          + (b.primary ? ' primary' : '')
          + (b.danger ? ' danger' : '');
        btn.textContent = b.label;
        btn.addEventListener('click', () => close(b.value));
        actions.appendChild(btn);
      }
      box.appendChild(actions);

      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(null); }
      });

      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  /** Modal with a single text input; resolves to the trimmed value, or null if cancelled. */
  showInputDialog({ title, message, value = '', placeholder = '', confirmLabel = 'OK' }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'prompt-modal-overlay md-dialog-overlay';
      const box = document.createElement('div');
      box.className = 'prompt-modal md-dialog';

      if (title) {
        const h = document.createElement('div');
        h.className = 'md-dialog-title';
        h.textContent = title;
        box.appendChild(h);
      }
      if (message) {
        const m = document.createElement('div');
        m.className = 'md-dialog-message';
        m.textContent = message;
        box.appendChild(m);
      }

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'md-dialog-input';
      input.value = value;
      input.placeholder = placeholder;
      box.appendChild(input);

      const actions = document.createElement('div');
      actions.className = 'md-dialog-actions';
      const close = (v) => { overlay.remove(); resolve(v); };
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'md-dialog-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => close(null));
      const okBtn = document.createElement('button');
      okBtn.className = 'md-dialog-btn primary';
      okBtn.textContent = confirmLabel;
      okBtn.addEventListener('click', () => close(input.value));
      actions.appendChild(cancelBtn);
      actions.appendChild(okBtn);
      box.appendChild(actions);

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); close(null); }
      });
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      setTimeout(() => { input.focus(); input.select(); }, 0);
    });
  }
```

- [ ] **Step 7: Wire the + button for the markdown tab**

In `handleAddButton()` (~line 1579), add a markdown branch at the top:
```js
  handleAddButton() {
    if (this.activeTab === 'markdown') {
      this.createNewMarkdownFile();
      return;
    }
    if (this.activeTab === 'secrets') {
      // ...unchanged...
```

- [ ] **Step 8: Load the file list when the tab is selected**

In the tab-bar click listener (~line 251), it currently calls `this.renderPrompts()`. The router already triggers a lazy load via `renderMarkdownTab`, so no change is required here — verify the listener still reads:
```js
        this.activeTab = tab;
        this.savePanelState();
        this.renderPrompts();
```
(No edit; this step is a confirmation that selecting "markdown" routes through `renderMarkdownTab` → `loadMarkdownFiles`.)

- [ ] **Step 9: Add a temporary detail stub so list view runs standalone**

`renderMarkdownTab` references `renderMarkdownDetail` and `restoreOpenMarkdownFile` (built in Task 5). Add minimal stubs now so this task is runnable; Task 5 replaces them:
```js
  renderMarkdownDetail() { /* replaced in Task 5 */ this.renderMarkdownList(); }
  restoreOpenMarkdownFile() { /* replaced in Task 5 */ this.mdOpenFile = null; this.setMarkdownChromeHidden(false); this.renderMarkdownList(); }
```

- [ ] **Step 10: Add list + dialog CSS**

Append to `src/renderer/prompt-library.css`:
```css
/* ---------- Markdown tab: file list ---------- */
.md-list { display: flex; flex-direction: column; }
.md-row {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 8px; border-radius: var(--radius-md, 6px);
  cursor: pointer;
}
.md-row:hover { background: var(--color-bg-cardHover, #32323c); }
.md-row-main { flex: 1; min-width: 0; }
.md-row-name {
  font-size: 13px; color: var(--color-text-primary, #e8e8ea);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.md-row-dir {
  font-size: 11px; color: var(--color-text-muted, #777);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.md-row-actions { display: flex; gap: 2px; opacity: 0; transition: opacity var(--transition-fast, 150ms); }
.md-row:hover .md-row-actions { opacity: 1; }
.md-row-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0;
  background: transparent; border: none; border-radius: var(--radius-sm, 4px);
  color: var(--color-text-secondary, #aaa); cursor: pointer;
}
.md-row-btn:hover { background: var(--color-bg-elevated, #33333a); color: var(--color-text-primary, #fff); }

/* ---------- Markdown tab: dialogs ---------- */
.md-dialog { min-width: 260px; max-width: 360px; padding: 16px; }
.md-dialog-title { font-size: 14px; font-weight: 600; color: var(--color-text-primary, #fff); margin-bottom: 8px; }
.md-dialog-message { font-size: 13px; color: var(--color-text-secondary, #ccc); margin-bottom: 12px; word-break: break-word; }
.md-dialog-input {
  width: 100%; box-sizing: border-box; padding: 8px;
  background: var(--color-bg-input, #15151a);
  border: 1px solid var(--color-border-default, #333);
  border-radius: var(--radius-md, 6px);
  color: var(--color-text-primary, #fff); font-size: 13px; margin-bottom: 12px;
}
.md-dialog-input:focus { outline: none; border-color: var(--color-border-focus, #4f46e5); }
.md-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }
.md-dialog-btn {
  padding: 6px 12px; font-size: 13px; cursor: pointer;
  background: var(--color-bg-elevated, #33333a);
  border: 1px solid var(--color-border-default, #333);
  border-radius: var(--radius-md, 6px);
  color: var(--color-text-primary, #fff);
}
.md-dialog-btn:hover { background: var(--color-bg-cardHover, #32323c); }
.md-dialog-btn.primary { background: var(--color-primary-base, #4f46e5); border-color: var(--color-primary-base, #4f46e5); }
.md-dialog-btn.primary:hover { background: var(--color-primary-hover, #4338ca); }
.md-dialog-btn.danger { background: var(--color-status-error, #b91c1c); border-color: var(--color-status-error, #b91c1c); }
```
NOTE: Verify each color references a real token in `design-tokens.js`; if a token name differs, use the correct one (keep the literal fallback).

- [ ] **Step 11: Verify syntax**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node --check src/renderer/prompt-library.js && echo "syntax ok"
```
Expected: `syntax ok`.

- [ ] **Step 12: Manual verification**

`npm start`, open a Claude Code terminal, open the library panel (Prompts button / Cmd+Shift+P), click the **Markdown** tab. Verify:
- The list populates with `.md` files (recursive; `.claude`/`.github` present, `node_modules` absent), scope filter hidden, search filters the list.
- **+** prompts for a name and creates the file (it appears in the list).
- Row **rename** changes the filename; **delete** asks to confirm then moves it to the macOS Trash.
- Editing a `.md` externally (e.g. `echo x >> CLAUDE.md` in the terminal) updates the list within ~½s (live refresh).

- [ ] **Step 13: Commit**

```bash
git add src/renderer/terminal.html src/renderer/prompt-library.js src/renderer/prompt-library.css
git commit -m "Add Markdown tab list view, file operations, and live refresh"
```

---

### Task 5: Renderer — detail view (viewer/editor), save, unsaved guard, persistence

**Files:**
- Modify: `src/renderer/prompt-library.js` (replace stubs with real detail view; open/save/guard; panel-state persistence; init restore)
- Modify: `src/renderer/prompt-library.css` (detail + rendered-markdown styles)
- Modify: `src/core/PromptLibraryManager.js` (persist `mdOpenFile` + `mdMode`)
- Modify: `test/prompt-panel-state.test.js` (cover the new fields)

**Interfaces:**
- Consumes: everything Produced by Task 4; `window.electronAPI.markdownFiles.{read,write,openExternal}`; `window.marked`, `window.DOMPurify`.
- Produces: `openMarkdownFile`, `openMarkdownFileInEdit`, `setMarkdownMode`, `saveMarkdownFile`, `closeMarkdownFile`, `confirmDiscardMarkdownIfDirty`, `handleMarkdownLinkClick`, real `renderMarkdownDetail`/`restoreOpenMarkdownFile`.

- [ ] **Step 1: Persist the new panel-state fields (manager)**

In `src/core/PromptLibraryManager.js`, `getPanelState` returns an object — add two fields:
```js
    return {
      visible: saved.visible || false,
      width: saved.width || 300,
      activeTab: saved.activeTab || 'prompts',
      scopeFilter: saved.scopeFilter || 'all',
      mdOpenFile: saved.mdOpenFile || null,
      mdMode: saved.mdMode || 'view'
    };
```
In `setPanelState`, extend the persisted object:
```js
    panels[tabId] = {
      visible: state.visible !== undefined ? state.visible : (prev.visible || false),
      width: state.width !== undefined ? state.width : (prev.width || 300),
      activeTab: state.activeTab !== undefined ? state.activeTab : (prev.activeTab || 'prompts'),
      scopeFilter: state.scopeFilter !== undefined ? state.scopeFilter : (prev.scopeFilter || 'all'),
      mdOpenFile: state.mdOpenFile !== undefined ? state.mdOpenFile : (prev.mdOpenFile || null),
      mdMode: state.mdMode !== undefined ? state.mdMode : (prev.mdMode || 'view')
    };
```

- [ ] **Step 2: Add the failing test for persistence**

In `test/prompt-panel-state.test.js`, add a test that sets and reads back `mdOpenFile`/`mdMode`. Find the existing pattern (it constructs a manager with a fake store) and add:
```js
test('panel state round-trips mdOpenFile and mdMode', () => {
  const mgr = makeManager(); // use the existing helper in this file
  mgr.setPanelState('tab1', { mdOpenFile: 'docs/x.md', mdMode: 'edit' });
  const state = mgr.getPanelState('tab1');
  assert.strictEqual(state.mdOpenFile, 'docs/x.md');
  assert.strictEqual(state.mdMode, 'edit');
});
```
(If the file's helper to build a manager is named differently, match it. If it has no helper, mirror the construction used by the existing tests in that file.)

- [ ] **Step 3: Run the test to confirm it passes after Step 1**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node test/prompt-panel-state.test.js
```
Expected: PASS, including the new assertions (Step 1 already implemented the support). If it fails, fix `PromptLibraryManager.js` until green.

- [ ] **Step 4: Save/load the fields in the renderer**

In `loadPanelState()` (~line 539) after `this.scopeFilter = ...`:
```js
        this.mdOpenFile = state?.mdOpenFile || null;
        this.mdMode = state?.mdMode || 'view';
```
In `savePanelState()` (~line 555) extend the object:
```js
        window.electronAPI.promptLibrary.setPanelState({
          visible: this.panelVisible,
          width: this.panelWidth,
          activeTab: this.activeTab,
          scopeFilter: this.scopeFilter,
          mdOpenFile: this.mdOpenFile,
          mdMode: this.mdMode
        });
```

- [ ] **Step 5: Replace the stubs with the real detail view**

In `src/renderer/prompt-library.js`, delete the two stub methods from Task 4 Step 9 and add:
```js
  async openMarkdownFile(relPath) {
    let res;
    try { res = await window.electronAPI.markdownFiles.read(relPath); }
    catch (err) { res = { error: err.message }; }
    if (res?.error) {
      await this.showChoiceDialog('Could not open file: ' + res.error,
        [{ value: 'ok', label: 'OK', primary: true }]);
      return;
    }
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

  async openMarkdownFileInEdit(relPath) {
    await this.openMarkdownFile(relPath);
    if (this.mdOpenFile === relPath) {
      this.mdMode = 'edit';
      this.savePanelState();
      this.renderMarkdownDetail();
    }
  }

  async restoreOpenMarkdownFile() {
    const relPath = this.mdOpenFile;
    const desiredMode = this.mdMode;
    let res;
    try { res = await window.electronAPI.markdownFiles.read(relPath); }
    catch (err) { res = { error: err.message }; }
    if (res?.error) { this.closeMarkdownFileImmediate(); return; }
    this.mdContent = res.content;
    this.mdDraft = res.content;
    this.mdLoadedMtimeMs = res.mtimeMs;
    this._mdContentPath = relPath;
    this.mdDirty = false;
    this.mdMode = desiredMode || 'view';
    this.renderMarkdownDetail();
  }

  setMarkdownMode(mode) {
    if (mode === this.mdMode) return;
    this.mdMode = mode;
    this.savePanelState();
    this.renderMarkdownDetail();
  }

  async closeMarkdownFile() {
    if (!(await this.confirmDiscardMarkdownIfDirty())) return;
    this.closeMarkdownFileImmediate();
  }

  async confirmDiscardMarkdownIfDirty() {
    if (!this.mdOpenFile || !this.mdDirty) return true;
    const choice = await this.showChoiceDialog(
      `"${this.mdOpenFile}" has unsaved changes.`,
      [{ value: 'save', label: 'Save', primary: true },
       { value: 'discard', label: 'Discard', danger: true },
       { value: 'cancel', label: 'Cancel' }]
    );
    if (choice === 'save') return await this.saveMarkdownFile();
    if (choice === 'discard') return true;
    return false;
  }

  async saveMarkdownFile() {
    if (!this.mdOpenFile) return false;
    let res;
    try { res = await window.electronAPI.markdownFiles.write(this.mdOpenFile, this.mdDraft); }
    catch (err) { res = { error: err.message }; }
    if (res?.error) {
      await this.showChoiceDialog('Save failed: ' + res.error,
        [{ value: 'ok', label: 'OK', primary: true }]);
      return false;
    }
    this.mdContent = this.mdDraft;
    this.mdDirty = false;
    this.mdLoadedMtimeMs = res.mtimeMs;
    this.mdStaleNotice = false;
    this.renderMarkdownDetail();
    return true;
  }

  handleMarkdownLinkClick(e) {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href && /^https?:\/\//i.test(href)) {
      window.electronAPI.markdownFiles.openExternal(href);
    }
  }

  renderMarkdownDetail() {
    this.setMarkdownChromeHidden(true);
    const container = this.promptsContainer;
    container.textContent = '';

    const wrap = document.createElement('div');
    wrap.className = 'md-detail';

    // Header: back · filename(+dirty) · View/Edit toggle · Save
    const header = document.createElement('div');
    header.className = 'md-detail-header';

    const back = document.createElement('button');
    back.className = 'md-back';
    back.textContent = '←';
    back.title = 'Back to list';
    back.addEventListener('click', () => this.closeMarkdownFile());

    const name = document.createElement('span');
    name.className = 'md-filename';
    name.textContent = this.mdOpenFile;
    const dirtyDot = document.createElement('span');
    dirtyDot.className = 'md-dirty-dot';
    dirtyDot.textContent = '●';
    dirtyDot.style.visibility = this.mdDirty ? 'visible' : 'hidden';
    name.appendChild(document.createTextNode(' '));
    name.appendChild(dirtyDot);

    const toggle = document.createElement('div');
    toggle.className = 'md-toggle';
    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View';
    viewBtn.className = this.mdMode === 'view' ? 'active' : '';
    viewBtn.addEventListener('click', () => this.setMarkdownMode('view'));
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.className = this.mdMode === 'edit' ? 'active' : '';
    editBtn.addEventListener('click', () => this.setMarkdownMode('edit'));
    toggle.appendChild(viewBtn);
    toggle.appendChild(editBtn);

    header.appendChild(back);
    header.appendChild(name);
    header.appendChild(toggle);

    let saveBtn = null;
    if (this.mdMode === 'edit') {
      saveBtn = document.createElement('button');
      saveBtn.className = 'md-save';
      saveBtn.textContent = 'Save';
      saveBtn.disabled = !this.mdDirty;
      saveBtn.addEventListener('click', () => this.saveMarkdownFile());
      header.appendChild(saveBtn);
    }
    wrap.appendChild(header);

    if (this.mdStaleNotice) {
      const notice = document.createElement('div');
      notice.className = 'md-stale-notice';
      notice.textContent = 'This file changed on disk. Saving overwrites the disk version.';
      wrap.appendChild(notice);
    }

    const body = document.createElement('div');
    body.className = 'md-body';
    if (this.mdMode === 'view') {
      const rendered = document.createElement('div');
      rendered.className = 'md-rendered';
      // The ONLY sanctioned innerHTML-for-content path: sanitized markdown.
      rendered.innerHTML = window.DOMPurify.sanitize(window.marked.parse(this.mdDraft || ''));
      rendered.addEventListener('click', (e) => this.handleMarkdownLinkClick(e));
      body.appendChild(rendered);
    } else {
      const ta = document.createElement('textarea');
      ta.className = 'md-editor';
      ta.value = this.mdDraft;
      ta.spellcheck = false;
      ta.addEventListener('input', () => {
        this.mdDraft = ta.value;
        this.mdDirty = this.mdDraft !== this.mdContent;
        dirtyDot.style.visibility = this.mdDirty ? 'visible' : 'hidden';
        if (saveBtn) saveBtn.disabled = !this.mdDirty;
      });
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); this.saveMarkdownFile(); }
      });
      body.appendChild(ta);
    }
    wrap.appendChild(body);
    container.appendChild(wrap);

    if (this.mdMode === 'edit') {
      const ta = wrap.querySelector('.md-editor');
      if (ta) ta.focus();
    }
  }
```

- [ ] **Step 6: Wire row click → open**

In `buildMarkdownRow(file)` (Task 4), add the open handler to `main` (after the `dir` append, before `row.appendChild(main)`):
```js
    main.addEventListener('click', () => this.openMarkdownFile(file.relPath));
```

- [ ] **Step 7: Guard the unsaved-edit case on panel toggle**

In `togglePanel()` (~line 590), it currently guards `isInlineEditing`. Add a markdown guard:
```js
  togglePanel() {
    if (this.isInlineEditing) { this.closeInlineEditor(); return; }
    if (this.panelVisible && this.mdOpenFile && this.mdDirty) {
      this.confirmDiscardMarkdownIfDirty().then((ok) => {
        if (!ok) return;
        this.mdDirty = false;
        this.panelVisible = false;
        this.updatePanelVisibility();
        this.savePanelState();
      });
      return;
    }
    this.panelVisible = !this.panelVisible;
    this.updatePanelVisibility();
    this.savePanelState();
  }
```

- [ ] **Step 8: Let Escape exit the detail view**

In the keydown handler (~line 283), add a markdown branch before the `closeModal()` fallback:
```js
        if (this.activeTab === 'markdown' && this.mdOpenFile) {
          this.closeMarkdownFile();
          e.stopPropagation();
          return;
        }
```

- [ ] **Step 9: Add detail + rendered-markdown CSS**

Append to `src/renderer/prompt-library.css`:
```css
/* ---------- Markdown tab: detail view ---------- */
.md-detail { display: flex; flex-direction: column; height: 100%; }
.md-detail-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-bottom: 1px solid var(--color-border-subtle, #2a2a32);
}
.md-back {
  background: transparent; border: none; cursor: pointer;
  color: var(--color-text-secondary, #aaa); font-size: 16px; line-height: 1;
  padding: 2px 6px; border-radius: var(--radius-sm, 4px);
}
.md-back:hover { background: var(--color-bg-elevated, #33333a); color: var(--color-text-primary, #fff); }
.md-filename {
  flex: 1; min-width: 0; font-size: 12px; font-family: var(--font-mono, monospace);
  color: var(--color-text-primary, #e8e8ea);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.md-dirty-dot { color: var(--color-status-warning, #e0a000); }
.md-toggle { display: inline-flex; border: 1px solid var(--color-border-default, #444); border-radius: var(--radius-sm, 4px); overflow: hidden; }
.md-toggle button {
  background: transparent; border: none; cursor: pointer;
  color: var(--color-text-secondary, #9aa); font-size: 12px; padding: 2px 8px;
}
.md-toggle button.active { background: var(--color-primary-base, #4f46e5); color: #fff; }
.md-save {
  background: var(--color-status-success, #16794a); color: #fff;
  border: none; border-radius: var(--radius-sm, 4px); cursor: pointer;
  font-size: 12px; padding: 3px 10px;
}
.md-save:disabled { opacity: 0.5; cursor: default; }
.md-stale-notice {
  font-size: 11px; padding: 6px 8px;
  color: var(--color-status-warning, #fbbf24);
  background: var(--color-status-warningMuted, rgba(251,191,36,0.15));
}
.md-body { flex: 1; min-height: 0; overflow: auto; }
.md-editor {
  width: 100%; height: 100%; box-sizing: border-box; resize: none;
  border: none; outline: none; padding: 10px;
  background: var(--color-bg-base, #15151a);
  color: var(--color-text-primary, #ccd);
  font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.5;
}

/* Rendered markdown */
.md-rendered { padding: 12px; font-size: 13px; line-height: 1.6; color: var(--color-text-secondary, #ccc); }
.md-rendered h1, .md-rendered h2, .md-rendered h3,
.md-rendered h4, .md-rendered h5, .md-rendered h6 {
  color: var(--color-text-primary, #fff); margin: 16px 0 8px; line-height: 1.3;
}
.md-rendered h1 { font-size: 20px; } .md-rendered h2 { font-size: 17px; } .md-rendered h3 { font-size: 15px; }
.md-rendered p { margin: 0 0 10px; }
.md-rendered a { color: var(--color-primary-base, #6366f1); text-decoration: none; }
.md-rendered a:hover { text-decoration: underline; }
.md-rendered ul, .md-rendered ol { margin: 0 0 10px; padding-left: 20px; }
.md-rendered li { margin: 2px 0; }
.md-rendered code {
  font-family: var(--font-mono, monospace); font-size: 12px;
  background: var(--color-bg-elevated, #2a2a32); padding: 1px 4px; border-radius: var(--radius-sm, 4px);
}
.md-rendered pre {
  background: var(--color-bg-base, #1a1a20); padding: 10px; border-radius: var(--radius-md, 6px);
  overflow: auto; margin: 0 0 10px;
}
.md-rendered pre code { background: transparent; padding: 0; }
.md-rendered blockquote {
  border-left: 3px solid var(--color-border-default, #444); margin: 0 0 10px;
  padding-left: 10px; color: var(--color-text-muted, #999);
}
.md-rendered hr { border: none; border-top: 1px solid var(--color-border-subtle, #2a2a32); margin: 16px 0; }
.md-rendered table { border-collapse: collapse; margin: 0 0 10px; font-size: 12px; }
.md-rendered th, .md-rendered td { border: 1px solid var(--color-border-default, #444); padding: 4px 8px; }
.md-rendered img { max-width: 100%; }
```
Verify each token exists in `design-tokens.js`; if a name differs, use the real token and keep the literal fallback.

- [ ] **Step 10: Verify syntax and tests**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node --check src/renderer/prompt-library.js \
  && node test/prompt-panel-state.test.js \
  && node test/markdown-files-manager.test.js \
  && echo "all ok"
```
Expected: `syntax ok` implied (no error) + both test files pass + `all ok`.

- [ ] **Step 11: Manual verification**

`npm start`, open a terminal, Markdown tab:
- Click a file → opens in **View**, markdown renders (headings, lists, code, a table if present).
- Toggle **Edit** → raw text in a textarea; type → amber ● shows, Save enables.
- **Save** (button or Cmd/Ctrl+S) → writes to disk (confirm with the file on disk); ● clears.
- Toggle back to **View** → reflects saved content.
- Edit again, hit **←** / Escape / Cmd+Shift+P → **Save/Discard/Cancel** dialog appears and behaves.
- A rendered http link opens in the default browser (not in-panel).
- Edit a file externally while viewing it (no unsaved edits) → it reloads; while dirty → the amber stale notice appears instead of clobbering.
- Reopen the panel (or restart) with a file open → it restores to that file and mode.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/prompt-library.js src/renderer/prompt-library.css src/core/PromptLibraryManager.js test/prompt-panel-state.test.js
git commit -m "Add Markdown detail view: viewer/editor, save, unsaved guard, persistence"
```

---

### Task 6: Documentation and memory

**Files:**
- Modify: `CLAUDE.md`
- Modify: `/Users/chris/.claude/projects/-Users-chris-workspace-cross-ai-browser/memory/MEMORY.md` (+ a new memory file)

- [ ] **Step 1: Update CLAUDE.md**

- In **Core Modules**, add: `MarkdownFilesManager.js - Lists/reads/writes/creates/renames/deletes .md files under a terminal's cwd (recursive, skips noise dirs), with a recursive fs watcher; path-validates against cwd.`
- In the **Library (Prompts + Notes)** section, update the tab description from three tabs to four: Prompts / Notes / Secrets / **Markdown**. Add a short **Markdown tab** subsection: lists `.md` files recursively (skips `node_modules`, `.git`, etc.); master-detail view/edit with `marked` + `DOMPurify`; create/rename/delete (delete → OS Trash); live fs-watch refresh; scope filter hidden on this tab.
- In **Key Technical Decisions** or a new note, record: `marked` + `DOMPurify` are the only place `innerHTML` is used for content (sanitized).
- In **Testing**, add `test/markdown-files-manager.test.js`.
- In **File Structure**, add `MarkdownFilesManager.js` under `core/`.

- [ ] **Step 2: Update memory**

Create `/Users/chris/.claude/projects/-Users-chris-workspace-cross-ai-browser/memory/markdown-tab.md`:
```markdown
---
name: markdown-tab
description: Markdown library tab — file listing, viewer/editor, IPC, watcher
metadata:
  type: project
---

The library panel has a 4th tab, **Markdown** (after Prompts/Notes/Secrets).
- Core: `src/core/MarkdownFilesManager.js` — recursive `.md` list (skips node_modules/.git/dist/build/etc.), read/write/create/rename/delete, recursive fs watcher. Injectable `fs`/`trash` (main injects `shell.trashItem`). Path-validates every relPath against cwd. Tested: `test/markdown-files-manager.test.js`.
- IPC: `markdown-list/read/write/create/delete/rename` + pushed `markdown-files-changed` + `open-external`. One manager per cwd in main.js; change events via `broadcastToTerminalsWithCwd`.
- Renderer (`prompt-library.js`): `activeTab='markdown'`, master-detail. View renders `DOMPurify.sanitize(marked.parse(text))` — the only sanctioned content innerHTML. Scope filter hidden on this tab. Open file + mode persisted in panel state (`mdOpenFile`/`mdMode`, added to `PromptLibraryManager` get/setPanelState).
- Deps: `marked`, `dompurify`, loaded in `terminal.html` before `prompt-library.js`.
```
Add a line to `MEMORY.md` under an appropriate heading:
```markdown
- [Markdown tab](markdown-tab.md) — 4th library tab: .md viewer/editor, MarkdownFilesManager, fs watcher
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document Markdown library tab"
```
(Memory files live outside the repo and are not committed.)

---

## Self-Review Notes

- **Spec coverage:** file scope/skip-dirs → Task 1 `SKIP_DIRS` + test; flat list → Task 4 `renderMarkdownList`; detail view/toggle/save → Task 5; unsaved confirm → Task 5 `confirmDiscardMarkdownIfDirty`; create/delete/rename → Task 4 (delete via `shell.trashItem`, Task 3); live watch → Tasks 1+3+4; marked+DOMPurify → Tasks 2+5; links external → Tasks 3+5; path validation → Task 1 `_resolveInside` + tests; persistence → Task 5; docs/tests → Tasks 1/5/6. All spec sections map to a task.
- **Type consistency:** preload exposes `remove` (not `delete`) for the delete channel — renderer calls `markdownFiles.remove(...)` consistently (Task 4 `deleteMarkdownFile`). `list()` row shape `{relPath,name,dir,mtimeMs,size}` is identical in Task 1 and consumed unchanged in Task 4. `read/write` return `{content,mtimeMs}` / `{mtimeMs}` consistently across Tasks 1/3/5.
- **Known follow-ups (out of scope):** images in markdown won't load (CSP `img-src 'self' data:`); no syntax highlighting in code blocks.
```
