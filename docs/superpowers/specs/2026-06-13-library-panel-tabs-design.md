# Library Panel — Tabbed Redesign — Design

**Date:** 2026-06-13
**Status:** Approved

## Overview

The library panel stacks six collapsible sections in one column — Notes, Reusable, Prompts, Testing, Done, Secrets — which became crowded once Secrets was added. This redesign replaces the single stacked column with **three top tabs** (Prompts / Notes / Secrets) plus a **scope segmented filter** (All / Global / Project), so the user sees one focused view at a time. Lifecycle states (Testing / Done) become collapsible sub-sections inside the Prompts tab.

Scope is unchanged at the data layer; this is a renderer/UX change to `prompt-library.js`, `terminal.html`, `prompt-library.css`, plus a small panel-state persistence change in `PromptLibraryManager.js`.

## Decisions Made

| Question | Decision |
|---|---|
| Overall layout | Top tabs: Prompts / Notes / Secrets |
| Testing & Done | Collapsible sub-sections at the bottom of the Prompts tab (default collapsed) |
| Global vs Project | Segmented filter (All / Global / Project) under the tabs, applies to the active tab |
| Search | Filters the active tab; non-active tabs show a match-count badge while a query is active |
| `+` add button | Context-aware — adds a prompt / note / secret based on the active tab |
| Persistence | `activeTab` + `scopeFilter` persist in per-terminal panel state |

## Panel Layout

Top to bottom inside `#prompt-panel`:

1. **Header** — title + `+` (add) + `×` (close). Position unchanged.
2. **Tab bar** — `Prompts | Notes | Secrets`. Active tab marked with the indigo underline (`--color-primary-*`).
3. **Scope segmented** — `All | Global | Project`. Filters the active tab.
4. **Search** — existing `#prompt-search-input`, position unchanged. Filters the active tab.
5. **Body** — `#prompt-cards-container`, renders only the active tab's content.

## Per-Tab Body

- **Prompts** — Reusable and Active sections expanded; Testing and Done as collapsible sub-sections at the bottom, default collapsed. Drag-to-terminal and drag-reorder preserved exactly as today. The current regular-prompts section (today labeled "PROMPTS") is relabeled **"Active"** inside this tab to avoid the redundant "Prompts ▸ PROMPTS" heading.
- **Notes** — the current NOTES list. Not sendable to the terminal (unchanged). Can hold images/labels (unchanged).
- **Secrets** — the existing secret rows + inline add/edit form, reveal/copy/edit/delete, and the "secure storage unavailable" disabled state, all carried over unchanged.

## Behavior

**Tab switching.** Clicking a tab re-renders the body for that tab. The search text and scope filter persist across the switch and apply to whichever tab is active.

**`+` add button (context-aware).**
- Prompts tab → new prompt (existing prompt editor).
- Notes tab → new note.
- Secrets tab → opens the inline secret form (same as today's secrets add button).
- New item's default scope = the current scope filter when it is Global or Project; otherwise Project.

**Search.**
- Filters the active tab's items.
- While a query is non-empty, each non-active tab shows a small match-count badge so the user knows results exist elsewhere; clicking the tab switches to them.
- Secrets search remains **name-only** — secret values never participate in search (preserves the secrets security rule).

**Scope filter (All / Global / Project).**
- Applies to the active tab.
- Under **All**, each card keeps a small G/P badge to distinguish scopes.
- Under **Global** or **Project**, the per-card scope badge is dropped (redundant with the filter).

**Empty states** — per tab: "No prompts yet." / "No notes yet." / the existing secrets empty / unavailable messages. When a search or scope filter yields nothing, show a "nothing matches" variant.

## State & Persistence

New instance fields on the panel object:
- `activeTab` — `'prompts' | 'notes' | 'secrets'`, default `'prompts'`.
- `scopeFilter` — `'all' | 'global' | 'project'`, default `'all'`.

Both persist in the existing per-terminal panel state alongside `visible` and `width`.

`PromptLibraryManager.getPanelState` / `setPanelState` currently **whitelist only `visible` and `width`** (extra fields are silently dropped). They must be extended to carry `activeTab` and `scopeFilter`, with defaults (`'prompts'`, `'all'`) in `getPanelState`.

Testing/Done collapsed state stays in-memory and resets per load (this already matches today's behavior — `*Collapsed` flags are not persisted). No change.

## Architecture / Files

**`src/renderer/terminal.html`**
- Add static markup for the tab bar and scope segmented control between `#prompt-panel-header` and `#prompt-search-container`.

**`src/renderer/prompt-library.js`**
- `renderPrompts()` becomes a router: it paints the tab-bar and scope-bar active states, computes per-tab search match-count badges, then delegates to one of:
  - `renderPromptsTab()` — reuses `createSection` (Reusable, Active), `createTestingSection`, `createDoneSection`.
  - `renderNotesTab()` — reuses the existing notes section logic.
  - `renderSecretsTab()` — wraps the existing `renderSecretsSection()`.
- `filterPrompts()` gains scope filtering (by `scopeFilter`) in addition to the existing search filter.
- Wire tab-bar and scope-bar click handlers; call `savePanelState()` on change.
- Make the `+` add handler tab-aware (prompt / note / secret).
- Add `activeTab` / `scopeFilter` to the constructor and to `loadPanelState()` / `savePanelState()`.

**`src/renderer/prompt-library.css`**
- Tab-bar and scope-segmented styles. Design tokens only (every color a `var(--token, fallback)`).

**`src/core/PromptLibraryManager.js`**
- Extend `getPanelState` default and `setPanelState` persistence to include `activeTab` and `scopeFilter`.

## Non-Goals (YAGNI)

- No per-tab independent search or scope state (one shared search + scope, applied to the active tab).
- No keyboard tab-switching shortcuts.
- No tab reordering or user-configurable tabs.
- No new item types or changes to how items are stored.
- No changes to drag-to-terminal mechanics.
- No full module split of `prompt-library.js` (~3,100 lines) — this change reorganizes render code behind three tab methods; a larger split is a separate effort.

## Verification (manual, renderer UI)

1. Tab switch preserves the current search text and scope filter.
2. Scope filter narrows the active tab correctly (All shows both with badges; Global/Project narrow and drop the badge).
3. With a search active, non-active tabs show correct match-count badges; switching lands on the matches.
4. `+` adds an item of the active tab's type, defaulting scope from the filter.
5. `activeTab` + `scopeFilter` survive panel close/reopen and a terminal restart.
6. Secrets tab: name-only search still works; reveal/copy/edit/delete and the unavailable state still work.
7. Drag-to-terminal still works from the Prompts tab; drag-reorder still works within sections.
8. Empty/no-match states render per tab.
