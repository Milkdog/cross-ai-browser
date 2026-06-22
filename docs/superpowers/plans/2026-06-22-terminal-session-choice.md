# Terminal Resume/New Choice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a non-brand-new Claude Code terminal tab has no running session, show the Resume / New Session / Close Tab overlay instead of auto-starting (restored tabs currently auto-run `claude --continue`).

**Architecture:** Gate the lazy, resize-driven PTY spawn. `ViewManager` gains an `awaitingSessionChoice` set and a `presentSessionChoice()` that asks the renderer to show the existing overlay without spawning a PTY. `main.js`'s `terminal-resize` handler, which already detects restored tabs (cwd recovered from the `tabData` store), calls `presentSessionChoice()` for them instead of auto-continuing. The renderer's exit overlay is refactored into a reusable function triggered by both the existing `terminal-exit` event and a new `terminal-show-session-choice` event, with one generic message.

**Tech Stack:** Electron (main + preload + renderer), node-pty, xterm.js. No build step; plain JS.

## Global Constraints

- **Safe DOM construction only** in the renderer — `createElement`/`textContent`, never `innerHTML` for content.
- **No new dependencies.**
- **Node isn't on PATH by default** — prefix checks with `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"`.
- **No Electron-free unit seam** for these files (view/PTY lifecycle) — the gate per task is `node --check` on each changed file; end-to-end behavior is verified by the manual checklist in Task 4. Do **not** fabricate unit tests.
- **Resume = `claude --continue`** (continue most recent); **New = fresh `claude`**. Both reuse the existing `resume()` / `reload()` IPC — do not change the resume/new mechanics.
- **One generic overlay message** for all situations (no per-case wording variants).

---

### Task 1: ViewManager — awaiting-choice state, presentSessionChoice, spawn gate

**Files:**
- Modify: `src/core/ViewManager.js`

**Interfaces:**
- Consumes: existing `this.terminalPtys`, `this.terminalViews`, `this.terminalPromptState`, `this.terminalReadyState`.
- Produces (used by Task 2 + Task 3):
  - `this.awaitingSessionChoice` — `Set<tabId>` of tabs showing the choice overlay (no PTY).
  - `presentSessionChoice(tabId, cols = 80, rows = 30)` — records size, marks awaiting, sends `terminal-show-session-choice` to the view; no-op if a PTY exists, the view is gone, or already awaiting.
  - `handleTerminalResize` no longer auto-spawns while a tab is awaiting a choice.

- [ ] **Step 1: Add the `awaitingSessionChoice` set**

In `src/core/ViewManager.js`, the constructor's terminal-state block reads:
```js
    // Terminal state
    this.terminalReadyState = new Map();
    this.terminalOutputBuffer = new Map();
    this.terminalPromptState = new Map();
```
Change to:
```js
    // Terminal state
    this.terminalReadyState = new Map();
    this.terminalOutputBuffer = new Map();
    this.terminalPromptState = new Map();
    // Tabs showing the Resume/New/Close choice overlay (no PTY running). While a
    // tab is in here, a resize must NOT lazily auto-spawn a session behind it.
    this.awaitingSessionChoice = new Set();
```

- [ ] **Step 2: Gate the lazy spawn in `handleTerminalResize`**

The method (around line 1064) currently ends:
```js
    const ptyProcess = this.terminalPtys.get(tabId);
    if (ptyProcess) {
      try {
        ptyProcess.resize(cols, rows);
      } catch (e) {
        // Resize may fail if process is dead
      }
    } else if (cwd && this.terminalReadyState.get(tabId)) {
      // PTY not spawned yet - spawn it now
      this.setupTerminalPty(tabId, cwd, cols, rows, mode);
    }
  }
```
Change the `else if` body to:
```js
    } else if (cwd && this.terminalReadyState.get(tabId)) {
      // Don't auto-spawn while the user is being asked to choose Resume/New.
      if (this.awaitingSessionChoice.has(tabId)) return;
      // PTY not spawned yet - spawn it now
      this.setupTerminalPty(tabId, cwd, cols, rows, mode);
    }
  }
```
(The cols/rows are already recorded into `terminalPromptState` at the top of the method, so the size is tracked even when the spawn is gated.)

- [ ] **Step 3: Add `presentSessionChoice`**

Insert this method immediately before `handleTerminalResize` (just after the `handleTerminalResize` doc comment block, or directly above the method — place it as a sibling method in the class):
```js
  /**
   * Offer the Resume / New Session / Close choice for a non-brand-new terminal
   * instead of auto-starting a session. Records the latest size and asks the
   * renderer to show the overlay; does NOT spawn a PTY. Idempotent.
   * @param {string} tabId
   * @param {number} cols
   * @param {number} rows
   */
  presentSessionChoice(tabId, cols = 80, rows = 30) {
    // A session is already running, or there's no view to show the overlay in.
    if (this.terminalPtys.get(tabId)) return;
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;

    const promptState = this.terminalPromptState.get(tabId);
    if (promptState) {
      promptState.cols = cols;
      promptState.rows = rows;
    }

    if (this.awaitingSessionChoice.has(tabId)) return; // overlay already requested
    this.awaitingSessionChoice.add(tabId);
    view.webContents.send('terminal-show-session-choice');
  }
```

- [ ] **Step 4: Mark awaiting on run-time exit and shutdown**

In `handlePtyExit`, the line (≈975):
```js
      view.webContents.send('terminal-exit', { exitCode, signal });
```
becomes:
```js
      view.webContents.send('terminal-exit', { exitCode, signal });
      // The overlay is now up; don't let a stray resize auto-spawn behind it.
      this.awaitingSessionChoice.add(tabId);
```

In `shutdownTerminal`, the line (≈1146):
```js
      view.webContents.send('terminal-exit', { exitCode: 0, signal: null });
```
becomes:
```js
      view.webContents.send('terminal-exit', { exitCode: 0, signal: null });
      this.awaitingSessionChoice.add(tabId);
```

- [ ] **Step 5: Clear awaiting when the user chooses, and on teardown**

In `resumeTerminal`, just after the opening guard `if (!view || view.webContents.isDestroyed()) return;` add:
```js
    this.awaitingSessionChoice.delete(tabId);
```
In `reloadTerminal`, just after its opening guard `if (!view || view.webContents.isDestroyed()) return;` add:
```js
    this.awaitingSessionChoice.delete(tabId);
```
In `destroyView`, alongside the existing per-tab cleanup deletes (next to `this.terminalPromptState.delete(tabId);`) add:
```js
    this.awaitingSessionChoice.delete(tabId);
```

- [ ] **Step 6: Verify syntax**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node --check src/core/ViewManager.js && echo "syntax ok"
```
Expected: `syntax ok`.

- [ ] **Step 7: Commit**

```bash
git add src/core/ViewManager.js
git commit -m "Add terminal session-choice state and spawn gate to ViewManager"
```

---

### Task 2: main.js — restored tabs present the choice instead of auto-continuing

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `viewManager.presentSessionChoice(tabId, cols, rows)` (Task 1); existing `viewManager.handleTerminalResize`.

- [ ] **Step 1: Route restored tabs to the choice overlay**

In `src/main.js`, the `terminal-resize` handler currently contains:
```js
  // Try to get cwd from tab or from tabData store
  let cwd = tab.cwd;
  let mode = tab.mode || 'normal';

  if (!cwd) {
    const tabData = store.get('tabData', {});
    const data = tabData[terminalId];
    if (data && data.cwd) {
      cwd = data.cwd;
      tab.cwd = cwd; // Cache it on the tab object
      // When restoring from store, use continue mode
      if (!tab.mode) {
        mode = 'continue';
      }
    }
  }

  if (cwd) {
    viewManager.handleTerminalResize(terminalId, cols, rows, cwd, mode);
    // Clear mode after first use
    tab.mode = 'normal';
  } else {
    viewManager.handleTerminalResize(terminalId, cols, rows);
  }
```
Replace that block with:
```js
  // Try to get cwd from tab or from tabData store
  let cwd = tab.cwd;
  let mode = tab.mode || 'normal';
  let restoredFromStore = false;

  if (!cwd) {
    const tabData = store.get('tabData', {});
    const data = tabData[terminalId];
    if (data && data.cwd) {
      cwd = data.cwd;
      tab.cwd = cwd; // Cache it on the tab object
      restoredFromStore = true;
    }
  }

  if (cwd) {
    if (restoredFromStore && !tab.mode) {
      // Restored (non-brand-new) tab with no running session: let the user
      // choose Resume / New / Close instead of silently auto-continuing.
      viewManager.presentSessionChoice(terminalId, cols, rows);
    } else {
      viewManager.handleTerminalResize(terminalId, cols, rows, cwd, mode);
      // Clear mode after first use
      tab.mode = 'normal';
    }
  } else {
    viewManager.handleTerminalResize(terminalId, cols, rows);
  }
```
Notes: brand-new tabs created by `createTab` carry a live `tab.cwd` + `tab.mode = 'normal'`, so they skip the `if (!cwd)` branch (`restoredFromStore` stays `false`) and start fresh exactly as today. The previous auto-`mode = 'continue'` for restored tabs is removed — `continue` now only comes from the Resume button (`resumeTerminal`).

- [ ] **Step 2: Verify syntax**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node --check src/main.js && echo "syntax ok"
```
Expected: `syntax ok`.

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "Offer Resume/New choice for restored terminals instead of auto-continue"
```

---

### Task 3: Preload event + renderer overlay (generic, reusable)

**Files:**
- Modify: `src/terminal-preload.js`
- Modify: `src/renderer/terminal.js`

**Interfaces:**
- Consumes: the `terminal-show-session-choice` event sent by `presentSessionChoice` (Task 1); existing `resume()`, `reload()`, `close()` preload methods.
- Produces: `window.electronAPI.onShowSessionChoice(callback)`.

- [ ] **Step 1: Add the preload listener variable**

In `src/terminal-preload.js`, near the other listener refs (after `let streamingStateListener = null;`) add:
```js
let sessionChoiceListener = null;
```

- [ ] **Step 2: Expose `onShowSessionChoice`**

In the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, after the `onStreamingState` method, add:
```js
  // Listen for a request to show the Resume/New/Close session-choice overlay
  onShowSessionChoice: (callback) => {
    if (sessionChoiceListener) {
      ipcRenderer.removeListener('terminal-show-session-choice', sessionChoiceListener);
    }
    sessionChoiceListener = () => callback();
    ipcRenderer.on('terminal-show-session-choice', sessionChoiceListener);
  },
```

- [ ] **Step 3: Clean up the listener**

In the `cleanup()` method, alongside the other `removeListener` calls, add:
```js
    if (sessionChoiceListener) {
      ipcRenderer.removeListener('terminal-show-session-choice', sessionChoiceListener);
      sessionChoiceListener = null;
    }
```
In the `window.addEventListener('beforeunload', ...)` block, add:
```js
  if (sessionChoiceListener) {
    ipcRenderer.removeListener('terminal-show-session-choice', sessionChoiceListener);
  }
```

- [ ] **Step 4: Refactor the overlay into a reusable function with generic wording**

In `src/renderer/terminal.js`, replace the entire `window.electronAPI.onExit(({ exitCode, signal }) => { ... });` block (currently lines ≈306–456, from `// Handle process exit` through its closing `});`) with the following. It extracts the overlay into `showSessionChoiceOverlay()`, makes the wording generic, guards against stacking, and wires both triggers:
```js
// Show the Resume / New Session / Close Tab overlay. Used both when a running
// Claude Code session exits and when a non-brand-new tab is opened with no
// session running (restored after a restart, previously shut down, etc.).
function showSessionChoiceOverlay() {
  // Never stack overlays.
  if (document.getElementById('exit-overlay')) return;

  // Create exit overlay using safe DOM methods
  const overlay = document.createElement('div');
  overlay.id = 'exit-overlay';

  const message = document.createElement('div');
  message.className = 'exit-message';

  const icon = document.createElement('div');
  icon.className = 'exit-icon';
  icon.textContent = '⏹';

  const title = document.createElement('div');
  title.className = 'exit-title';
  title.textContent = 'Claude Code isn’t running in this tab';

  const subtitle = document.createElement('div');
  subtitle.className = 'exit-subtitle';
  subtitle.textContent = 'Resume your previous session, or start a new one.';

  const buttons = document.createElement('div');
  buttons.className = 'exit-buttons';

  // Resume button (primary) - uses claude --continue
  const resumeBtn = document.createElement('button');
  resumeBtn.className = 'exit-btn resume-btn';
  const resumeIcon = document.createElement('span');
  resumeIcon.className = 'btn-icon';
  resumeIcon.textContent = '▶';
  resumeBtn.appendChild(resumeIcon);
  resumeBtn.appendChild(document.createTextNode(' Resume'));

  // New Session button - starts fresh
  const newBtn = document.createElement('button');
  newBtn.className = 'exit-btn new-btn';
  const newIcon = document.createElement('span');
  newIcon.className = 'btn-icon';
  newIcon.textContent = '+';
  newBtn.appendChild(newIcon);
  newBtn.appendChild(document.createTextNode(' New Session'));

  // Close Tab button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'exit-btn close-btn';
  const closeIcon = document.createElement('span');
  closeIcon.className = 'btn-icon';
  closeIcon.textContent = '✕';
  closeBtn.appendChild(closeIcon);
  closeBtn.appendChild(document.createTextNode(' Close Tab'));

  buttons.appendChild(resumeBtn);
  buttons.appendChild(newBtn);
  buttons.appendChild(closeBtn);
  message.appendChild(icon);
  message.appendChild(title);
  message.appendChild(subtitle);
  message.appendChild(buttons);
  overlay.appendChild(message);

  // Style the overlay
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(30, 30, 30, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  `;

  const style = document.createElement('style');
  style.textContent = `
    .exit-message {
      text-align: center;
      color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .exit-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.7;
    }
    .exit-title {
      font-size: 18px;
      font-weight: 500;
      margin-bottom: 8px;
    }
    .exit-subtitle {
      font-size: 14px;
      color: #a0a0a0;
      margin-bottom: 24px;
    }
    .exit-buttons {
      display: flex;
      gap: 12px;
      justify-content: center;
    }
    .exit-btn {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 20px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .exit-btn:hover {
      transform: translateY(-1px);
    }
    .btn-icon {
      font-size: 16px;
    }
    .resume-btn {
      background: #d97757;
      color: white;
    }
    .resume-btn:hover {
      background: #e88868;
    }
    .new-btn {
      background: #3c3c3c;
      color: #d4d4d4;
    }
    .new-btn:hover {
      background: #4c4c4c;
    }
    .close-btn {
      background: #3c3c3c;
      color: #d4d4d4;
    }
    .close-btn:hover {
      background: #4c4c4c;
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);

  // Handle button clicks
  resumeBtn.addEventListener('click', () => {
    overlay.remove();
    terminal.clear();
    window.electronAPI.resume(); // Uses claude --continue
  });

  newBtn.addEventListener('click', () => {
    overlay.remove();
    terminal.clear();
    window.electronAPI.reload(); // Starts fresh claude session
  });

  closeBtn.addEventListener('click', () => {
    window.electronAPI.close();
  });
}

// A running session exited (/exit, crash, or manual shutdown).
window.electronAPI.onExit(() => showSessionChoiceOverlay());

// A non-brand-new tab was opened with no session running (e.g. after restart).
window.electronAPI.onShowSessionChoice(() => showSessionChoiceOverlay());
```

- [ ] **Step 5: Verify syntax**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
node --check src/terminal-preload.js && node --check src/renderer/terminal.js && echo "syntax ok"
```
Expected: `syntax ok`.

- [ ] **Step 6: Commit**

```bash
git add src/terminal-preload.js src/renderer/terminal.js
git commit -m "Show generic session-choice overlay for exit and restored terminals"
```

---

### Task 4: Manual verification + docs

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Manual end-to-end checklist**

Run the app (`npm start`) and confirm:
1. Restart the app, click a restored terminal tab → the Resume/New/Close overlay appears (it does **not** auto-resume).
2. Click **Resume** → previous session continues (`claude --continue`).
3. Reproduce, click **New Session** → a fresh `claude` starts.
4. Create a brand-new tab with `+` → it starts fresh immediately, no overlay.
5. In a running session type `/exit` → overlay appears (unchanged).
6. Manually shut a terminal down → overlay appears (unchanged).
7. With the overlay showing, resize the window / switch to another tab and back → no session is spawned behind the overlay; the choice persists until you click it.

If any step fails, fix the relevant task before continuing.

- [ ] **Step 2: Add a CLAUDE.md note**

In `CLAUDE.md`, under the **Claude Code Terminals** streaming/indicator area (or the nearest terminal-behavior section), add a short subsection:
```markdown
### Terminal Session Start / Resume
- Brand-new terminal tabs (created with `+`) start a fresh `claude` session immediately.
- Any non-brand-new tab with no running session — restored after an app restart, `/exit`ed, crashed, or manually shut down — shows a Resume / New Session / Close Tab overlay instead of auto-starting. Resume runs `claude --continue`; New starts fresh.
- Implemented via `ViewManager.awaitingSessionChoice` + `presentSessionChoice()` (gates the lazy resize-driven PTY spawn) and the renderer's `showSessionChoiceOverlay()` (triggered by `terminal-exit` and `terminal-show-session-choice`).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document terminal session start/resume choice behavior"
```

---

## Self-Review Notes

- **Spec coverage:** detection/trigger → Task 2; awaiting gate + presentSessionChoice + add/clear → Task 1; preload event → Task 3 (steps 1–3); generic overlay refactor + both triggers → Task 3 (step 4); latent resize-spawn fix → Task 1 (steps 2,4); manual tests + docs → Task 4. All spec sections mapped.
- **Type consistency:** `awaitingSessionChoice` (Set), `presentSessionChoice(tabId, cols, rows)`, event name `terminal-show-session-choice`, preload `onShowSessionChoice`, and renderer `showSessionChoiceOverlay()` are used identically across tasks.
- **Brand-new vs restored:** relies on `createTab` setting live `tab.cwd` + `tab.mode = 'normal'` (verified) vs restored tabs recovering cwd from the `tabData` store; `restoredFromStore && !tab.mode` is the discriminator.
- **Note:** memory files (outside the repo) are written by the controller, not part of these commits.
```
