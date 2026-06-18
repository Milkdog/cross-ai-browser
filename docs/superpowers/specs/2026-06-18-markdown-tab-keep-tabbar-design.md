# Keep Tab Bar Live While a Markdown Doc Is Open — Design Spec

**Date:** 2026-06-18
**Status:** Approved (design)
**Feature:** Let the user switch library tabs while a markdown doc is open, and
return to the same markdown state.

## Summary

Today, opening a markdown file (the detail view) calls
`setMarkdownChromeHidden(true)`, which hides the panel header, the tab bar, the
search box, and the scope filter — leaving only the doc. Because the tab bar is
hidden, the user cannot switch to Prompts/Notes/Secrets without first closing the
doc.

This change keeps the **panel header and tab bar visible while a doc is open**, so
the doc renders *under* the Markdown tab and the user can switch tabs at will. The
markdown state (`mdOpenFile`, `mdMode`, `mdDraft`, `mdDirty`, `_mdContentPath`)
already lives on the panel instance and survives a tab switch, so returning to the
Markdown tab re-renders the doc exactly as it was left — same file, same view/edit
mode, same unsaved text and dirty indicator.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Doc-view chrome | **Header + tab bar stay visible.** The list search box hides while a doc is open. Scope filter stays hidden on the Markdown tab (unchanged). |
| Tab switch with unsaved edits | **No discard prompt.** The draft/dirty state persist in memory; the doc returns as left. |
| Discard confirmation | Stays only for genuinely closing the doc (← back / Esc) or closing the whole panel (`togglePanel`). |
| Inline prompt/note editor | **Unchanged.** Its focused full-panel chrome (hides header/tabs/search) is left as-is; only the markdown detail view changes. |
| Cross-restart drafts | Out of scope. `mdOpenFile`/`mdMode` already persist; unsaved drafts are not written to disk across a full app restart (existing behavior). |

## Problem detail

Two flows currently hide all panel chrome via the same pattern:
- **Inline prompt/note editor** (`prompt-library.js` ~2167 show, ~2463 restore) —
  must remain unchanged.
- **Markdown detail view** (`setMarkdownChromeHidden`, called at ~3601 and ~4122
  to hide, ~3649 and ~3869 to show) — this is what changes.

`renderPrompts()` (the tab router) currently only manages the **scope filter**
visibility; it does nothing to restore the **search box** or header/tabs. That's
fine today because the tab bar is hidden in detail view so no tab switch can
happen. Once the tab bar stays visible, switching away from a markdown doc to
another tab would leave the search box hidden (the markdown detail hid it and
nothing re-shows it). So chrome visibility must become a deterministic function of
state, recomputed on every render — not an imperative toggle.

## Architecture

### Declarative chrome visibility

Replace the imperative `setMarkdownChromeHidden(hidden)` with a single method
`updateChromeVisibility()` that derives the display of the four chrome elements
from current state and is called on every render:

```
updateChromeVisibility():
  if (this.isInlineEditing) return;          // inline editor owns its own chrome
  header (#prompt-panel-header).display = '' // always visible
  tabs   (#prompt-tabs).display        = '' // always visible
  const onMarkdown = activeTab === 'markdown'
  scope  (#prompt-scope-filter).display = onMarkdown ? 'none' : ''
  search (#prompt-search-container).display = (onMarkdown && mdOpenFile) ? 'none' : ''
```

- Called from `renderPrompts()` (replacing the current scope-only block at
  ~838-841), so every tab switch and re-render recomputes chrome correctly.
- Called from the markdown render paths that re-render the detail/list without
  going through `renderPrompts()` (`renderMarkdownDetail`, `renderMarkdownList`),
  replacing their `setMarkdownChromeHidden(...)` calls.
- `setMarkdownChromeHidden` is removed; all call sites switch to
  `updateChromeVisibility()`.

The `isInlineEditing` guard preserves the inline editor's focused chrome: while it
is active it manages header/tabs/search itself and the recompute no-ops, exactly
as the existing scope-filter block already guards on `isInlineEditing`.

### Tab switching preserves markdown state (already true)

The tab click handler (~270-278) sets `activeTab`, saves panel state, and calls
`renderPrompts()`. It does **not** touch markdown state, so `mdOpenFile`,
`mdMode`, `mdDraft`, `mdDirty`, and `_mdContentPath` are retained across the
switch. On return, `renderMarkdownTab()` sees `mdOpenFile` set with
`_mdContentPath === mdOpenFile` and calls `renderMarkdownDetail()`, which renders
the body from `mdDraft` in `mdMode` — i.e. the same state, including unsaved edits
and the dirty dot. No code change is required for state retention; only the
chrome change unblocks reaching it.

No discard prompt is added to the tab-switch path. The textarea DOM is recreated
on return, but its contents come from `mdDraft` (kept current by the editor's
`input` handler), so no text is lost. Cursor/scroll position within the doc is not
preserved (DOM is recreated) — acceptable.

## Out of scope

- Changing the inline prompt/note editor's chrome behavior.
- Persisting unsaved markdown drafts to disk across app restart.
- Preserving editor cursor/scroll position across a tab switch.

## Testing

- Renderer-only change; no automated tests (project convention).
- `node --check src/renderer/prompt-library.js`.
- Manual in-app checklist:
  1. Open a markdown doc → header + tab bar remain visible above it; search box
     hidden.
  2. Click Prompts/Notes/Secrets → switches normally; search box + scope filter
     reappear where applicable.
  3. Return to Markdown → same doc, same view/edit mode is shown.
  4. In edit mode, type unsaved text, switch away and back → the unsaved text and
     dirty dot are still there; no discard prompt appeared on the switch.
  5. On the markdown **list** (no doc open), the search box is visible and filters
     files; scope filter stays hidden.
  6. ← back / Esc with unsaved edits still prompts to discard; closing the panel
     with unsaved edits still prompts.
  7. Inline prompt editor (Prompts tab) still hides chrome as before and restores
     it on close.
