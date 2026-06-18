# Keep Tab Bar Live While a Markdown Doc Is Open — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the panel header and tab bar visible while a markdown doc is open so the user can switch library tabs and return to the same markdown state.

**Architecture:** Replace the imperative `setMarkdownChromeHidden(hidden)` (which hid header/tabs/search/scope in the markdown detail view) with one declarative `updateChromeVisibility()` derived from `(activeTab, mdOpenFile, isInlineEditing)`, recomputed on every render and tab switch. Header and tab bar stay visible always; the list search box hides only while a markdown doc is open; the scope filter hides on the Markdown tab. Markdown state already persists on the instance across tab switches, so no state-retention code is needed.

**Tech Stack:** Electron renderer (`src/renderer/prompt-library.js`), plain DOM. No new dependencies.

## Global Constraints

- **Renderer-only change.** No backend, IPC, or CSS. The one file touched is `src/renderer/prompt-library.js`.
- **No `innerHTML` for content** except the existing sanitized-markdown path; build/toggle DOM via existing patterns (here: `element.style.display`).
- **Renderer has no automated tests** (project convention) — verification is `node --check` plus the manual in-app checklist.
- **Node is not on PATH by default.** Prefix node commands with: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"`.
- **The inline prompt/note editor must be unchanged.** `updateChromeVisibility()` no-ops while `this.isInlineEditing` so it never fights the inline editor's focused chrome.

---

### Task 1: Declarative panel-chrome visibility

Add `updateChromeVisibility()`, route `renderPrompts` and every markdown render path through it, and remove `setMarkdownChromeHidden`.

**Files:**
- Modify: `src/renderer/prompt-library.js`
  - `renderPrompts` scope-filter block (~837-841)
  - `renderMarkdownTab` loading branch (~3601)
  - `renderMarkdownList` (~3649)
  - `closeMarkdownFileImmediate` (~3869)
  - `renderMarkdownDetail` (~4122)
  - `setMarkdownChromeHidden` definition (~3809-3825)

**Interfaces:**
- Produces: `updateChromeVisibility()` — sets `display` on `#prompt-panel-header`, `#prompt-tabs`, `#prompt-scope-filter`, `#prompt-search-container` from `(this.activeTab, this.mdOpenFile, this.isInlineEditing)`; no return value.
- Removes: `setMarkdownChromeHidden(hidden)`.

- [ ] **Step 1: Add the `updateChromeVisibility()` method**

Insert this method immediately **above** the existing `setMarkdownChromeHidden(hidden) {` definition (currently line ~3809):

```javascript
  /**
   * Recompute panel chrome visibility from current state. The panel header and
   * tab bar are ALWAYS visible — including while a markdown doc is open — so the
   * user can switch tabs at any time. The list search box hides only while a
   * markdown doc is open (it filters the file list, not the doc); the scope
   * filter hides on the Markdown tab. No-ops while the inline editor is active,
   * which manages its own focused chrome.
   */
  updateChromeVisibility() {
    if (this.isInlineEditing) return;
    const header = document.getElementById('prompt-panel-header');
    const tabs = document.getElementById('prompt-tabs');
    const scopeFilter = document.getElementById('prompt-scope-filter');
    const searchContainer = document.getElementById('prompt-search-container');
    const onMarkdown = this.activeTab === 'markdown';
    if (header) header.style.display = '';
    if (tabs) tabs.style.display = '';
    if (scopeFilter) scopeFilter.style.display = onMarkdown ? 'none' : '';
    if (searchContainer) searchContainer.style.display = (onMarkdown && this.mdOpenFile) ? 'none' : '';
  }

```

- [ ] **Step 2: Route `renderPrompts` through it**

In `renderPrompts`, replace this block (currently ~837-841):

```javascript
    // The Markdown tab is filesystem-based, not scope-based — hide the scope filter.
    const scopeFilterEl = document.getElementById('prompt-scope-filter');
    if (scopeFilterEl && !this.isInlineEditing) {
      scopeFilterEl.style.display = (this.activeTab === 'markdown') ? 'none' : '';
    }
```

with:

```javascript
    // Panel chrome (header / tabs / scope filter / search) visibility is a pure
    // function of state — recompute it on every render and tab switch.
    this.updateChromeVisibility();
```

- [ ] **Step 3: Replace the four `setMarkdownChromeHidden` call sites**

Each markdown render path now recomputes chrome via `updateChromeVisibility()`. Make these four replacements:

In `renderMarkdownTab` (the loading branch, ~3601):
```javascript
        this.setMarkdownChromeHidden(true);
```
→
```javascript
        this.updateChromeVisibility();
```

In `renderMarkdownList` (~3649):
```javascript
    this.setMarkdownChromeHidden(false);
```
→
```javascript
    this.updateChromeVisibility();
```

In `closeMarkdownFileImmediate` (~3869):
```javascript
    this.setMarkdownChromeHidden(false);
```
→
```javascript
    this.updateChromeVisibility();
```

In `renderMarkdownDetail` (~4122):
```javascript
    this.setMarkdownChromeHidden(true);
```
→
```javascript
    this.updateChromeVisibility();
```

(There are two `this.setMarkdownChromeHidden(false);` occurrences — in `renderMarkdownList` and `closeMarkdownFileImmediate` — and two `this.setMarkdownChromeHidden(true);` occurrences — in `renderMarkdownTab` and `renderMarkdownDetail`. Replace by surrounding-method context, not blindly, since the strings repeat. After this step, `grep -n "setMarkdownChromeHidden(" src/renderer/prompt-library.js` must show only the definition line.)

- [ ] **Step 4: Remove the old `setMarkdownChromeHidden` method**

Delete the entire method definition (currently ~3809-3825):

```javascript
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
```

- [ ] **Step 5: Verify there are no remaining references and the file parses**

Run:
```bash
export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"
grep -n "setMarkdownChromeHidden" src/renderer/prompt-library.js
node --check src/renderer/prompt-library.js
```
Expected: the `grep` prints **nothing** (zero references remain — definition removed and all call sites replaced); `node --check` prints nothing and exits 0.

- [ ] **Step 6: Manual in-app check**

Run `npm start`. In a Claude Code terminal, open the Library panel → Markdown tab. Verify:
1. Open a markdown doc → the panel header and tab bar stay visible above it; the search box is hidden.
2. Click Prompts / Notes / Secrets → switches normally; the search box and scope filter reappear where applicable.
3. Return to Markdown → the same doc in the same view/edit mode is shown.
4. In edit mode, type unsaved text, switch to another tab and back → the unsaved text and the dirty dot are still present, and **no** discard prompt appeared on the switch.
5. On the markdown **list** (no doc open), the search box is visible and filters files; the scope filter stays hidden.
6. ← back / Esc with unsaved edits still prompts to discard; closing the panel (× or Cmd+Shift+P) with unsaved edits still prompts.
7. On the Prompts tab, open the inline editor (edit a prompt) → it still hides the chrome as before and restores it on close.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/prompt-library.js
git commit -m "Keep tab bar visible while a markdown doc is open"
```

---

## Self-Review Notes

**Spec coverage:**
- Header + tabs stay; search hides in doc view; scope hidden on markdown → Step 1 (`updateChromeVisibility` rules) + Steps 2-4 (routing).
- Switching away restores search/scope correctly → Step 2 (recompute in `renderPrompts`, which runs on every tab switch).
- No discard prompt on tab switch; state preserved in memory → no code added to the tab-switch path; covered by manual checks 3-4.
- Inline editor unchanged → `if (this.isInlineEditing) return;` guard (Step 1) + manual check 7.
- Discard still prompts on close/panel-close → untouched (`closeMarkdownFile`/`confirmDiscardMarkdownIfDirty`/`togglePanel`); manual check 6.

**Placeholder scan:** none — every step has exact code and exact commands.

**Type consistency:** `updateChromeVisibility()` is defined in Step 1 and called in Steps 2-4 with the same name and zero arguments. `setMarkdownChromeHidden` is fully removed (Step 4) after all call sites are replaced (Step 3), verified by the Step 5 grep.
