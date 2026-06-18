# Claude Memories in the Markdown Tab — Design Spec

**Date:** 2026-06-18
**Status:** Approved (design)
**Feature:** Surface Claude's auto-memory `.md` files in the terminal's Markdown
tab, and add a last-modified date to every file row.

## Summary

The Markdown tab currently lists `.md` files found recursively under the
terminal's working directory (`cwd`). Claude's auto-memory lives **outside** that
directory, at `~/.claude/projects/<encoded-cwd>/memory/` (e.g.
`~/.claude/projects/-Users-chris-workspace-cross-ai-browser/memory/`, holding
`MEMORY.md` plus the individual memory files).

This feature teaches the Markdown tab about a **second root** — the project's
memory directory — and presents its files in a dedicated **CLAUDE MEMORIES**
group above the existing **PROJECT FILES**. Memory files are fully editable
(view/edit/save/rename/delete/create), reusing the existing file machinery
against the second root. Separately, **every** file row (both groups) gains a
last-modified date rendered in a hybrid relative/absolute format.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| What counts as "Claude memories" | **Auto-memory directory only** — `.md` files under `~/.claude/projects/<encoded-cwd>/memory/` (`MEMORY.md` + individual memory files). Not CLAUDE.md, not @-imports. |
| Presentation | **Grouped sections** in one scrolling list: collapsible **CLAUDE MEMORIES** on top, **PROJECT FILES** below. One search box covers both. |
| Editability | **Fully editable**, including creating new memory files from the app. |
| Last-modified format | **Hybrid**: `today` / `yesterday` / `N days ago` through 6 days, then absolute `MMM D` (or `MMM D, YYYY` if a different year). Full timestamp on hover. Shown on **all** rows, both groups. |
| Empty memory dir | Show the **CLAUDE MEMORIES** section with an empty hint + `+` to create the first memory file, **when** the `~/.claude/projects/<encoded>` project dir exists. If even that dir is absent, omit the section. |
| `MEMORY.md` index | **Not auto-maintained.** Editing/deleting a memory file directly does not rewrite `MEMORY.md`'s pointer lines — same as editing on disk. |

## Path encoding (load-bearing)

cwd → Claude project dir replaces `/` with `-`, **preserving** case and spaces
(verified against the user's `Time Since` vs `Time-Since` projects). The memory
dir is then `<projectsRoot>/<encoded>/memory`.

`memoryDirForCwd('/Users/chris/workspace/cross-ai-browser')`
→ `~/.claude/projects/-Users-chris-workspace-cross-ai-browser/memory`

Resolution is **verified against disk**: if the computed project dir does not
exist, no memory section is shown. The existence check is the safety net for any
encoding edge case — the feature degrades gracefully to "no memories" rather than
guessing.

## Architecture

### Approach

`MarkdownFilesManager` is already generic over its root and enforces a hard
"stay inside the root" boundary (`_resolveInside`). The chosen approach reuses it
verbatim: instantiate a **second** instance pointed at the memory dir, and add an
explicit **`root: 'project' | 'memory'`** selector to the IPC surface so the
backend dispatches to the correct manager. Each root keeps its own independent
security boundary.

*Rejected:* (a) one combined manager with prefixed/namespaced paths — fragile
path-sniffing that weakens the per-root boundary; (b) a separate read-only memory
mechanism — duplicates read/write/watch machinery and contradicts the
fully-editable decision.

### New core module: `src/core/claudeMemoryPath.js` (pure, testable)

```
memoryDirForCwd(cwd, { homedir, projectsRoot }) → {
  encoded,          // '-Users-chris-workspace-cross-ai-browser'
  projectDir,       // <projectsRoot>/<encoded>
  memoryDir,        // <projectsRoot>/<encoded>/memory
}
```

- Encoding: `cwd.replace(/\//g, '-')`.
- `homedir` / `projectsRoot` injectable (default `os.homedir()` /
  `~/.claude/projects`) so it runs under plain Node in tests.
- Pure path computation — **no** existence check here; callers do `fs.existsSync`
  on `projectDir` / `memoryDir` (keeps the function deterministic and testable).

### `src/main.js`

- `memoryManagers` Map (cwd → `MarkdownFilesManager` rooted at the memory dir),
  mirroring the existing `markdownManagers`.
- `ensureMemoryManager(cwd)`:
  - Resolve `memoryDirForCwd`. If the **project dir** does not exist, return null
    (no memories for this cwd).
  - Create/reuse a `MarkdownFilesManager` rooted at `memoryDir`
    (`mkdirSync(memoryDir, { recursive: true })` is acceptable on first create;
    the project dir already exists for a Claude Code terminal).
  - Watcher: a **standalone `fs.watch` on the parent project dir** (recursive),
    set up in main.js — **not** the manager's own `watch()` (which would only
    cover the memory dir, missing the `memory/` creation event). This lets the
    list live-refresh even when `memory/` is created after the terminal opens. On
    change (debounced), broadcast the existing `markdown-files-changed` event to
    terminals with this cwd (same mechanism as the project watcher).
- `getManager(cwd, root)` dispatcher → project or memory manager.
- IPC handler updates:
  - `markdown-list` → returns `{ project: [...], memory: [...], memoryAvailable }`
    in one round-trip (`memoryAvailable` = project dir exists).
  - `markdown-read` / `markdown-write` / `markdown-create` / `markdown-delete` /
    `markdown-rename` → accept `root` (default `'project'`) and dispatch.
- `releaseMarkdownManagerIfUnused(cwd)` also unwatches/drops the memory manager.

### `src/terminal-preload.js`

Thread `root` through the `markdownFiles` bridge:
`read(root, relPath)`, `write(root, relPath, content)`, `create(root, relPath)`,
`remove(root, relPath)`, `rename(root, fromRel, toRel)`. `list()` keeps its
signature (no args) but now returns the combined `{ project, memory, memoryAvailable }`
object. `onFilesChanged` unchanged.

### `src/renderer/prompt-library.js`

**State**
- `mdMemoryFiles = []`, `mdMemoryAvailable = false` (alongside `mdFiles`).
- `mdOpenRoot = 'project'` — which root the open file belongs to; persisted in
  panel state next to `mdOpenFile` / `mdMode`.
- `mdMemoryCollapsed` / `mdProjectCollapsed` — persisted group collapse flags
  (default expanded).

**List rendering (`renderMarkdownList`)**
- Two collapsible groups via the existing `createSection` pattern: **CLAUDE
  MEMORIES** (only when `mdMemoryAvailable`) on top, **PROJECT FILES** below.
- Within the memory group, **`MEMORY.md` pinned first**, rest alphabetical.
- One search box filters both groups by `relPath` / `name`; a group with zero
  matches hides its header; both empty → "No files match."
- Memory group header carries its own `+` (creates a memory file). The existing
  panel-header `+` stays project-scoped.
- Empty memory dir (available but no files): show the section with an empty hint
  + the create affordance.

**Row rendering (`buildMarkdownRow(file, root)`)**
- Threads `root` into click-to-open, rename, and delete.
- Adds a `.md-row-date` element on **every** row showing `formatMtime(file.mtimeMs)`,
  with the full timestamp in `title`.

**Date helper (`formatMtime(mtimeMs)`, pure)**
- Same calendar day → `today`; previous day → `yesterday`; 2–6 days → `N days ago`;
  else absolute `MMM D` (same year) or `MMM D, YYYY` (different year).

**Detail view / file ops**
- `mdOpenRoot` threaded through open / restore / save / rename / delete so each
  operation targets the correct manager.
- Create-new is root-aware: memory `+` → `create('memory', name)`; panel `+` →
  `create('project', name)`. New file auto-opens in edit mode (existing behavior).

### CSS

- `.md-row-date` and the section-header `+` button styled with design tokens
  (CSS variables + fallbacks per project convention — no hardcoded colors).

## Editing semantics

Memory files: view / edit / save / rename / delete (→ OS Trash via
`shell.trashItem`, like project files) / create. The per-root boundary keeps all
writes inside the memory dir (`../escape` rejected). `MEMORY.md`'s index is not
auto-rewritten on edit/delete — documented as known behavior.

## Live refresh

The memory watcher sits on the parent project dir (recursive) and fires the same
`markdown-files-changed` broadcast the project watcher uses. The renderer reloads
**both** roots on that event (one combined `list()` call), so memory changes
written by Claude appear without manual refresh, including the first creation of
`memory/`.

## Testing

- **`test/claude-memory-path.test.js`** (new, plain Node): `memoryDirForCwd`
  encoding for simple paths, paths with spaces, and trailing slashes, using
  injected `homedir` / `projectsRoot`.
- **`test/markdown-files-manager.test.js`** (extend): exercise a
  `MarkdownFilesManager` rooted at a temp "memory" dir — list/read/write/create/
  delete/rename and boundary rejection — proving the second-root reuse is sound.
- `formatMtime` and renderer wiring: `node --check` + manual in-app checklist
  (renderer code has no automated tests, per project convention).

## Manual verification checklist

1. Open a Claude Code terminal in this repo → Markdown tab shows **CLAUDE
   MEMORIES** (MEMORY.md first) above **PROJECT FILES**.
2. Every row shows a sensible last-modified label; hover shows the full timestamp.
3. Open a memory file → renders; Edit → change → Save persists to
   `~/.claude/projects/.../memory/`.
4. Create a memory file via the memory `+`; rename it; delete it (lands in Trash).
5. Have Claude write a memory (or `touch` one on disk) → list live-refreshes.
6. Open a terminal in a cwd with no memory dir → section absent (or empty hint if
   the project dir exists); project files still listed.
7. Search filters across both groups; group headers hide when they have no match.
8. Collapse states and the open memory file persist across panel reopen.

## Out of scope

- CLAUDE.md files and @-imports (project CLAUDE.md already appears under
  PROJECT FILES as a normal in-cwd file).
- Auto-maintaining the `MEMORY.md` index.
- Global `~/.claude/CLAUDE.md`.
