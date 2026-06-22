# Resume/New Choice for Non-Brand-New Terminals — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design)
**Feature:** When a Claude Code terminal tab that is not brand-new has no running session, present the existing Resume / New Session / Close Tab overlay instead of silently auto-starting (today, restored tabs auto-run `claude --continue`).

## Problem

A terminal tab's first PTY is spawned lazily by the `terminal-resize` handler (`src/main.js`) the moment the renderer loads and reports its size. That handler already distinguishes two cases:

- **Brand-new tab** (created via `+` → `createTab`): has a live `tab.cwd` / `tab.mode = 'normal'`, so the `if (!cwd)` branch is skipped and it starts a **fresh** `claude` session.
- **Restored tab** (after an app restart): has no live `tab.cwd`, so cwd is recovered from the `tabData` store and the handler sets `mode = 'continue'` → it **auto-resumes** (`claude --continue`) with no prompt.

The user wants restored (and any other non-brand-new, not-running) tabs to **offer a choice** rather than auto-resuming.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| When does the choice appear? | Any **non-brand-new** terminal tab with no running session: restored after restart, `/exit`ed, crashed, or manually shut down. Brand-new `+` tabs still start fresh with no prompt. |
| Wording | **One generic message** for all situations (no per-case variants). |
| Resume semantics | **`claude --continue`** (continue most recent session), unchanged from today's Resume button. |
| New Session | Fresh `claude` (unchanged). |
| Close | Close the tab (unchanged). |

## Approach

Reuse the overlay and IPC that already exist; gate the lazy auto-spawn.

### Detection & trigger
The "restored / not brand-new" signal already exists: in `src/main.js`'s `terminal-resize` handler, a restored tab is the one whose cwd is recovered from the `tabData` store (the `if (!cwd)` branch). In that branch, instead of setting `mode = 'continue'` and calling `handleTerminalResize` (which auto-spawns), call a new `viewManager.presentSessionChoice(tabId, cols, rows)` that records the size and shows the overlay **without** spawning a PTY.

### Reliability gate (and latent-bug fix)
Add an `awaitingSessionChoice` Set to `ViewManager`. While a tab is in it, `handleTerminalResize` must **not** auto-spawn a PTY (its no-PTY branch returns early). This:
- prevents a stray resize from spawning a session behind the overlay for restored tabs, and
- fixes a pre-existing latent bug: after `/exit`/shutdown, the PTY is gone; a window/tab resize currently re-enters the no-PTY branch and silently spawns a **fresh** `claude` behind the exit overlay.

`awaitingSessionChoice` is **added** when an overlay is presented (`presentSessionChoice` for restored; `handlePtyExit` and `shutdownTerminal` for the run-time cases) and **cleared** when the user chooses (`resumeTerminal` / `reloadTerminal`, which spawn the PTY directly, not via resize) and on tab teardown.

### Overlay UI
The overlay is currently built inline in `terminal.js`'s `onExit` handler. Extract it into a reusable `showSessionChoiceOverlay()` and trigger it from:
- the existing `onExit` event (run-time exit/crash/shutdown), and
- a new `onShowSessionChoice` event (restored case).

Wording becomes generic, e.g. title *"Claude Code isn't running in this tab"*, body *"Resume your previous session, or start a new one?"*, buttons **Resume · New Session · Close Tab**. Buttons reuse the existing `resume()` (`claude --continue`), `reload()` (fresh), and `close()` IPC — the resume/new mechanics are unchanged.

## Components & changes

- **`src/main.js`** — `terminal-resize` handler: in the restored branch, call `viewManager.presentSessionChoice(tabId, cols, rows)` (and do not pass `mode = 'continue'`) when no PTY exists and the choice isn't already pending; otherwise behave as today (brand-new → fresh; existing PTY → resize).
- **`src/core/ViewManager.js`**
  - `awaitingSessionChoice` Set (constructor).
  - `presentSessionChoice(tabId, cols, rows)` — record cols/rows in `terminalPromptState`, add to `awaitingSessionChoice`, send `terminal-show-session-choice` to the view (idempotent: no-op if already awaiting or a PTY exists).
  - `handleTerminalResize` — it already records the latest cols/rows into `terminalPromptState` at the top; in the no-PTY branch, return early if `awaitingSessionChoice.has(tabId)` (so the size is still tracked for the eventual spawn, but no PTY is started).
  - `handlePtyExit`, `shutdownTerminal` — add the tab to `awaitingSessionChoice` (overlay shown via existing `terminal-exit`).
  - `resumeTerminal`, `reloadTerminal` — `awaitingSessionChoice.delete(tabId)` (user chose).
  - `destroyView` (tab teardown) — delete from `awaitingSessionChoice`.
- **`src/terminal-preload.js`** — expose `onShowSessionChoice(callback)` for `terminal-show-session-choice`, with the listener-cleanup pattern used by the other terminal listeners (remove old listener before adding; clear in `cleanup()` and `beforeunload`).
- **`src/renderer/terminal.js`** — extract `showSessionChoiceOverlay()` from the `onExit` body; call it from `onExit` and from `onShowSessionChoice`; generic wording.

## Out of scope
- Per-situation wording variants (explicitly one generic message).
- `claude --resume` session picker (Resume stays `--continue`).
- Persisted session-state machine / resumability detection from Claude history.

## Testing
No Electron-free unit seam (view/PTY lifecycle). Verify with `node --check` on each changed file plus a manual checklist:
1. Restart the app, click a restored terminal tab → overlay appears (does **not** auto-resume).
2. Resume → previous session continues (`claude --continue`).
3. New Session → fresh `claude`.
4. Brand-new `+` tab → starts fresh immediately, no prompt.
5. `/exit` a running session → overlay appears (unchanged).
6. Manual shutdown → overlay appears (unchanged).
7. With the overlay up, resize the window / switch away and back → no session is spawned behind the overlay; the choice persists until clicked.
