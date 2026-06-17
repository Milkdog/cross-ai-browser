# Markdown Tab — Design Spec

**Date:** 2026-06-17
**Status:** Approved (design)
**Feature:** A markdown viewer/editor as a 4th tab in the Claude Code terminal library panel.

## Summary

Add a **Markdown** tab alongside Prompts / Notes / Secrets. It lists every `.md`
file found recursively under the terminal's working directory, lets the user view
a file as rendered markdown or edit the raw text and save it, and supports
creating, renaming, and deleting files. The file list and any open file refresh
live as files change on disk (Claude Code frequently edits these very files).

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| File scope | Recursive walk from cwd, **including hidden folders** (`.claude`, `.github`), **skipping** noise dirs (`node_modules`, `.git`, `dist`, `build`, etc.) |
| List presentation | Flat, sorted list; each row shows filename with its folder path dimmed underneath |
| Detail view | Master-detail: clicking a file replaces the list with a focused view; header = `←` back · filename (+ amber ● when dirty) · **View/Edit** segmented toggle · **Save** |
| Unsaved edits | **Confirm before discarding** (Save / Discard / Cancel) on any navigation away while dirty |
| File operations | **Create, delete, and rename** (full file management) |
| External changes | **Live watch & auto-refresh**: list updates as files appear/disappear; open file with no unsaved edits reloads automatically; if dirty, show a non-destructive notice |
| Renderer | **marked + DOMPurify**: `innerHTML = DOMPurify.sanitize(marked.parse(text))` (a single, contained, sanitized exception to the no-innerHTML convention) |
| Tab name | **Markdown** |

## Architecture

### New core module: `src/core/MarkdownFilesManager.js`
Given a working directory, provides:
- `list()` → array of `{ relPath, name, dir, mtimeMs, size }` for every `.md`
  file under cwd, recursive, skipping the noise-dir list. Sorted (by path).
- `read(relPath)` → `{ content, mtimeMs }`
- `write(relPath, content)` → `{ mtimeMs }`
- `create(relPath)` → creates an empty file (parent dirs as needed), returns `{ relPath }`
- `delete(relPath)` → moves file to OS Trash via injected `trash` fn
- `rename(fromRel, toRel)` → `fs.rename`
- `watch(onChange)` / `unwatch()` → debounced filesystem watcher; invokes
  `onChange` when a relevant `.md` file (outside skip-dirs) is added/removed/changed.

**Testability:** constructor takes injectable `fs` (defaults to `node:fs`) and
`trash` (defaults to `electron.shell.trashItem`) so the module is unit-testable
under plain Node, per the project convention.

**Skip-dir list:** `node_modules`, `.git`, `dist`, `build`, `out`, `.next`,
`.cache`, `coverage`, `.superpowers` (defined as a single constant in the module; easy to extend).

### Security: path validation (mandatory)
Every `relPath` from the renderer is resolved against the terminal's cwd and
verified to remain inside it (reject `..` traversal and absolute escapes) before
**any** read/write/create/delete/rename. This is the critical security boundary —
the renderer can otherwise request arbitrary filesystem paths.

### IPC

New preload namespace `markdownFiles` in `src/terminal-preload.js`, with handlers
in `src/main.js` (resolving the terminal's cwd the same way the prompt library does):

| Channel | Direction | Payload |
|---------|-----------|---------|
| `markdown-list` | invoke | `{ terminalId }` → file list |
| `markdown-read` | invoke | `{ terminalId, relPath }` → `{ content, mtimeMs }` |
| `markdown-write` | invoke | `{ terminalId, relPath, content }` → `{ mtimeMs }` |
| `markdown-create` | invoke | `{ terminalId, relPath }` → `{ relPath }` |
| `markdown-delete` | invoke | `{ terminalId, relPath }` → `{ ok }` |
| `markdown-rename` | invoke | `{ terminalId, fromRel, toRel }` → `{ relPath }` |
| `markdown-files-changed` | event → renderer | (push, debounced) |
| `open-external` | invoke/send | `{ url }` → `shell.openExternal` (http/https only) |

`shell` must be added to the `require('electron')` destructure in `main.js`
(currently absent) for `openExternal` and `trashItem`.

Watcher lifecycle: started lazily when a terminal first opens the Markdown tab,
torn down on PTY exit / terminal close (mirror existing per-terminal cleanup).

### Renderer: `src/renderer/prompt-library.js`
- `activeTab` gains `'markdown'`; `renderPrompts()` router adds a
  `renderMarkdownTab()` branch.
- New state: `mdFiles`, `mdOpenFile` (relPath | null), `mdMode` (`'view'|'edit'`),
  `mdContent` (last-loaded disk content), `mdDraft` (edited text), `mdDirty`,
  `mdLoadedMtimeMs`.
- `renderMarkdownTab()`:
  - **No open file** → render the flat file list (search filters it).
  - **Open file** → render the detail view (header + view/edit body). Reuse the
    inline-editor chrome pattern: hide `#prompt-tabs`, `#prompt-scope-filter`,
    `#prompt-search-container`, `#prompt-panel-header`; widen the panel; restore on back.
- **Scope filter hidden** whenever the Markdown tab is active (filesystem-based, not scoped).
- **Context-aware + button:** extend `handleAddButton()` with a `markdown` branch →
  new-file flow (prompt for name/relative path, append `.md` if missing, create,
  open in Edit mode).
- **Per-row actions:** rename, delete (trash). Detail header carries back/toggle/save.
- **Live refresh:** subscribe to `markdown-files-changed`; re-list; if a file is
  open and not dirty, reload it; if dirty, show a notice.
- **Unsaved-edit guard:** confirm (Save/Discard/Cancel) before back, file switch,
  tab switch, or panel close while `mdDirty`.
- **Panel state:** persist `activeTab` (existing) plus `mdOpenFile` and `mdMode`
  so reopening the panel returns to the file.

### Markdown rendering & link/image handling
- Add `marked` and `dompurify` to `package.json`; load both in `terminal.html`
  via relative `node_modules` paths (origin `'self'`, allowed by CSP).
- View mode: `container.innerHTML = DOMPurify.sanitize(marked.parse(content))`.
  This is the one sanctioned innerHTML-for-content use, justified by DOMPurify.
- **Links:** intercept clicks on rendered `<a href>`; http/https open in the
  default browser via `open-external`; in-panel navigation is prevented.
- **Images:** terminal CSP is `img-src 'self' data:`, so remote/relative images
  won't load — accepted v1 limitation (later enhancement: resolve local images to
  data URLs via IPC).
- All rendered-markdown styles (`h1`–`h6`, `p`, lists, `code`/`pre`, `blockquote`,
  `table`, `a`, `hr`) use design-token CSS variables with fallbacks — no hardcoded colors.

### Out of scope (v1)
- Firebase sync (these are on-disk files, never synced).
- Non-`.md` files.
- Rendering local/remote images (CSP-blocked; future enhancement).
- Markdown editing aids (preview-as-you-type split, toolbar).

## Testing
- `test/markdown-files-manager.test.js` (plain Node, temp dir, injected `fs`/`trash`):
  recursive list + skip-list correctness, read/write round-trip, create (incl. nested
  dirs), delete-via-trash, rename, and **path-traversal rejection**.
- Renderer changes: `node --check` for syntax + manual in-app checklist
  (open tab, list populates, view renders, edit+save persists, dirty guard,
  create/rename/delete, live refresh on external edit, link opens externally).

## Documentation
- Update `CLAUDE.md`: 4-tab library layout, `MarkdownFilesManager` module, new IPC,
  new dependencies, test file.
- Update project memory (`MEMORY.md` + a markdown-tab note) as needed.

## UI flow (recap)

```
[ Prompts | Notes | Secrets | Markdown ]
   (scope filter hidden on Markdown tab)
   [ Search… ]
   ┌──────────────────────────────┐
   │ 📄 CLAUDE.md        ./        │  ← flat list, folder dimmed
   │ 📄 README.md        ./        │     row actions: rename, trash
   │ 📄 design.md  docs/specs/     │
   └──────────────────────────────┘
        │ click row
        ▼
   ┌──────────────────────────────┐
   │ ← CLAUDE.md ●   [View|Edit] Save │  ← detail header (chrome hidden)
   │ ──────────────────────────────── │
   │ (rendered markdown | raw textarea)│
   └──────────────────────────────┘
```
