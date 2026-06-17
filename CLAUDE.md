# Cross AI Browser - Project Context

## Overview
An Electron app that provides a unified tabbed interface for AI chat services (ChatGPT, Claude, Gemini) and Claude Code terminal sessions. Features multi-tab support, drag-drop reordering, shared sessions, desktop notifications, real-time streaming indicators, and a prompt library with image attachments.

## Architecture

### Main Process (`src/main.js`)
- Creates the main window with a 160px sidebar for tab navigation
- Manages WebContentsViews for each tab (web services and terminals)
- Handles IPC communication between sidebar and content views
- Manages settings via electron-store
- Shows desktop notifications when AI responses complete
- Dynamic window title shows active tab name

### Core Modules (`src/core/`)
- `ServiceRegistry.js` - Defines available service types (ChatGPT, Claude, Gemini, Claude Code)
- `TabManager.js` - Manages tab state, persistence, ordering, and naming
- `ViewManager.js` - Handles WebContentsView lifecycle, switching, and terminal streaming detection
- `UsageMonitor.js` - Polls the Anthropic OAuth usage API for the terminal usage bars (token reading, backoff, parsing)
- `DownloadManager.js` - Manages file downloads with thumbnails and history
- `HistoryManager.js` - Coordinates terminal session history capture and retention
- `TerminalThemes.js` - Terminal color theme definitions
- `PromptLibraryManager.js` - Manages prompt CRUD, ordering, favorites, labels, and scopes
- `PromptImageManager.js` - Handles image storage, thumbnails, and clipboard operations
- `PromptStorageEngine.js` - File I/O for prompt library with atomic writes
- `FirebaseSyncAdapter.js` - Bidirectional Firebase sync for cross-device prompt access
- `MarkdownFilesManager.js` - Lists/reads/writes/creates/renames/deletes `.md` files under a terminal's cwd (recursive, skips noise dirs), with a recursive fs watcher; path-validates against cwd

### History Modules (`src/core/history/`)
- `StorageEngine.js` - File I/O abstraction, atomic writes, path hashing by cwd
- `SessionRecorder.js` - In-memory buffer for PTY output, gzip compression
- `RetentionPolicy.js` - Time-based (30 days) and size-based (500MB) cleanup logic

### Renderer Process (`src/renderer/`)
- `sidebar.html/js` - Tab list with drag-drop reordering
- `service-picker.html/js/css` - Modal for adding new tabs
- `rename-dialog.html/js` - Modal for renaming tabs
- `terminal.html/js/css` - xterm.js terminal for Claude Code
- `prompt-library.js/css` - Prompt library panel UI for terminals
- `settings.html` - Settings popup window
- `styles.css` - Sidebar styling

### Preload Scripts
- `sidebar-preload.js` - Exposes IPC APIs to sidebar (tabs, downloads, history, streaming state)
- `webview-preload.js` - Detects AI streaming state, sends notifications
- `terminal-preload.js` - Terminal IPC for pty communication
- `service-picker-preload.js` - Service picker IPC
- `rename-dialog-preload.js` - Rename dialog IPC
- `settings-preload.js` - Settings panel IPC

## Key Technical Decisions
- **Shared session partition** - All web services share `persist:shared` for unified login (Google OAuth works across services)
- **WebContentsViews over webviews** - Better isolation and performance
- **Multi-tab architecture** - Multiple instances of same service supported
- **Modular core** - ServiceRegistry, TabManager, ViewManager separation
- **node-pty + xterm.js** - Native terminal for Claude Code
- **electron-store v8** - Using v8 (not v11+) for CommonJS compatibility
- **Custom user agent** - Strips "Electron" to avoid detection by AI services
- **Shared design tokens** - Single source of truth for colors, spacing, typography across Electron and PWA
- **marked + DOMPurify** - The only place `innerHTML` is used for content (Markdown tab renderer); output is always sanitized via `DOMPurify.sanitize(marked.parse(text))` before insertion

## Design System

### Architecture
The app uses a unified design system shared between the Electron app and PWA companion.

**Source of Truth:** `design-tokens.js` (root directory)
- Defines all colors, spacing, border radii, typography, shadows, and transitions
- Exports `generateCSSVariables()` for Electron runtime injection
- Exports `generateTailwindTheme()` for PWA Tailwind config

**Electron Integration:** `src/renderer/design-system.js`
- Imports tokens and injects CSS variables into `:root` at runtime
- Loaded via `<script type="module">` in each HTML file

**PWA Integration:** `pwa/tailwind.config.js`
- Imports tokens and generates Tailwind theme at build time

### CSS Rules
**IMPORTANT: Never use hardcoded colors in CSS files.**
- All colors MUST use CSS variables from design tokens (e.g., `var(--color-bg-surface, #1f1f24)`)
- Always include a fallback value for the variable
- If a new color is needed, add it to `design-tokens.js` first, then reference via CSS variable
- This ensures consistency across the app and makes theming changes easy

### Token Categories
```
colors:
  bg: base, surface, elevated, card, cardHover, input
  border: subtle, default, hover, focus
  text: primary, secondary, muted, disabled
  primary: base, hover, active, muted, border (indigo accent)
  status: success, warning, error, info (+ muted variants)
  service: chatgpt, claude, gemini, claudeCode (brand colors)
  semantic: reusable, favorite, testing, done, project
  ready: border, borderDim, glow, glowFar, glowDim, glowDimFar (terminal ready indicator)
spacing: 0-12 scale (4px base unit)
radius: sm (4px), md (6px), lg (8px), xl (12px), full
typography: fontFamily, fontSize, fontWeight, lineHeight, letterSpacing
shadows: sm, md, lg, glow, glowReady
transitions: fast (150ms), normal (200ms), slow (300ms)
```

### Ready Indicator
Terminal displays a pulsing green border when awaiting user input:
- 8px green border (`--color-ready-border`) pulses between 100% and 50% opacity
- Strong inner glow effect for visibility from across the room
- Activates when terminal is not streaming and user hasn't interacted
- Dismisses on mouse movement, click, or keypress
- Returns after 3 seconds of inactivity post-streaming

## AI Detection Logic (`webview-preload.js`)
Each AI service has specific selectors for detecting streaming state:
- **ChatGPT**: Looks for stop button, streaming dots, result-streaming class
- **Claude**: Looks for stop button with specific SVG path
- **Gemini**: Looks for stop button, loading indicators

## Streaming Indicators
Tabs display real-time activity indicators when AI services are generating responses.

### Web AI Services
- Detected via DOM observation in `webview-preload.js`
- Shows animated pulsing dots next to tab name
- Tab background highlights during streaming
- Task description extracted from user's prompt (first 50 chars)

### Claude Code Terminals
- Detected via PTY output pattern matching in `ViewManager.js`
- Patterns: "Esc to interrupt", spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
- Uses 800-character sliding window for pattern detection
- Debounced state transitions to avoid rapid oscillation
- Sends streaming state to sidebar via IPC

### Terminal Auto-Scroll
The terminal (`terminal.js`) implements smart auto-scrolling:
- Auto-scrolls to bottom when new output arrives (if user is at bottom)
- Preserves user scroll position when scrolled up
- Distinguishes between user scrolls and programmatic scrolls
- Resets to auto-scroll when user scrolls back to bottom

## Terminal Session History
Claude Code terminal sessions are automatically captured and persisted for later review.

### How It Works
1. **Capture**: PTY output is buffered in memory (max 100MB per session)
2. **Compression**: On session end, output is gzip compressed (level 6)
3. **Storage**: Saved to `~/Library/Application Support/Cross AI Browser/history/`
4. **Organization**: Sessions grouped by working directory hash
5. **Retention**: Automatic cleanup of sessions older than 30 days or when total exceeds 500MB

### UI
- **History panel** in sidebar (collapsible, below Downloads)
- Sessions grouped by date (Today, Yesterday, etc.)
- Actions: View (modal), Export (plain text), Delete

### Storage Format
```
history/
├── <cwd-hash-1>/
│   ├── 1703001234567.gz    # Compressed session (timestamp.gz)
│   └── 1703002345678.gz
└── <cwd-hash-2>/
    └── 1703003456789.gz
```
Session metadata stored in electron-store under `history.sessions`.

## Library (Prompts + Notes)
A collapsible panel in Claude Code terminals for managing reusable prompts and notes with image attachments.

### Item Types
Every item has a `type` field (default `'prompt'`):
- **Prompt** — can be sent to the terminal, participates in Reusable / Regular / Testing / Done lifecycle.
- **Note** — sketchpad / saved-command entries. Cannot be sent to the terminal, cannot be reusable, no lifecycle states. Can be global and can hold images and labels.

Users can convert between types at any time; converting to a note strips incompatible flags (reusable/done/testing).

### Features
- **CRUD operations** - Create, edit, duplicate, delete prompts and notes
- **Image attachments** - Add images via file picker, drag-drop, or clipboard paste
- **Favorites** - Pin important items to the top of their section
- **Labels** - Tag items with multiple labels for organization
- **Reusable flag** (prompts only) - Mark prompts that shouldn't move to Done after use
- **Done / Testing sections** (prompts only) - Lifecycle states for non-reusable prompts
- **Notes section** - Collapsible, separate from prompt sections
- **Drag-drop reordering** - Reorder prompts within the panel (notes are not draggable)
- **Scopes** - Global (shared across projects) vs Project (per working directory)
- **Search/filter** - Filter by title, content, or labels across prompts and notes

### Image Attachment Flow
1. Images are stored in `~/Library/Application Support/Cross AI Browser/prompt-images/`
2. Thumbnails generated at 120px for display in the UI
3. When dragging a prompt to terminal:
   - Each image is copied to system clipboard
   - Paste is triggered programmatically
   - Claude Code detects the image and shows `[Image #N]`
4. Prompt text is sent after all images are attached

### Storage
- Prompts stored in `~/Library/Application Support/Cross AI Browser/prompts/`
- Global prompts: `global-prompts.json`
- Project prompts: `<cwd-hash>.json`
- Images: `prompt-images/<image-id>.png` with `<image-id>_thumb.png` thumbnails

### UI
- **Tabbed layout** - Four tabs (Prompts / Notes / Secrets / Markdown) with a Global/Project/All scope filter (hidden on the Markdown tab). Prompts tab holds Reusable + Active sections plus collapsible Testing/Done. `activeTab` and `scopeFilter` persist per terminal in panel state. `renderPrompts()` is a router delegating to `renderPromptsTab`/`renderNotesTab`/`renderSecretsTab`/`renderMarkdownTab`.
- Toggle button in terminal view ("Prompts")
- Resizable panel (200-500px width)
- Keyboard shortcut: Cmd+Shift+P to toggle
- Drag prompt card to terminal to insert

### Markdown Tab
Provides a master-detail `.md` file browser rooted at the terminal's cwd.

- **File list** - Recursively lists all `.md` files under cwd, skipping `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.cache`, `coverage`, `.superpowers` (but descends hidden dirs like `.claude`)
- **View / Edit** - Toggle between rendered view (HTML via `marked` + `DOMPurify`) and raw edit mode; save writes back to disk
- **File operations** - Create new `.md` file, rename, delete (delete moves to OS Trash via `shell.trashItem`)
- **Live refresh** - `MarkdownFilesManager` runs a recursive fs watcher; changes on disk update the list automatically via pushed `markdown-files-changed` IPC event
- **Persistence** - Open file path and view/edit mode saved in panel state (`mdOpenFile`/`mdMode`) via `PromptLibraryManager` get/setPanelState
- **Scope filter** - Hidden on this tab (not applicable to filesystem files)
- **Dependencies** - `marked` and `dompurify` loaded in `terminal.html` before `prompt-library.js`

### PWA Companion App
A Progressive Web App for managing prompts from iPhone or any device, synced via Firebase.

**Location:** `pwa/` directory

**Tech Stack:**
- React 18 + Vite
- Tailwind CSS (matching desktop app theme)
- Firebase (Auth, Firestore, Storage)
- PWA with offline support

**Setup:**
1. Create Firebase project with Auth (Email/Password), Firestore, and Storage
2. Copy config to `pwa/src/services/firebase.js`
3. Deploy Firestore rules from `pwa/firestore.rules`
4. Deploy Storage rules from `pwa/storage.rules`
5. Run `cd pwa && npm install && npm run build`
6. Deploy to Firebase Hosting or any static host

**Sync Architecture:**
- `FirebaseSyncAdapter.js` in Electron app handles bidirectional sync
- Real-time sync via Firestore listeners
- Auto-merge conflict resolution (union for arrays, newer wins for content)
- Images stored in Firebase Storage per user

## Secrets Store
Encrypted secrets/API keys at global and project scope, injected as environment
variables into Claude Code terminal PTYs at spawn (project overrides global).

- `src/core/SecretsManager.js` — storage, CRUD, validation, merged-env
- Files: `~/Library/Application Support/Cross AI Browser/secrets/global.enc` and
  `<cwd-hash>.enc`, encrypted via Electron `safeStorage` (Keychain-backed)
- Local-only: never synced to Firebase
- UI: SECRETS section in the library panel (masked values; reveal/copy on demand)
- IPC list responses never contain values — only `secrets-reveal` returns one
- No plaintext fallback: writes refused if `safeStorage` is unavailable
- Tests: `test/secrets-manager.test.js` (plain Node, injected fake encryptor)

## Testing
No test framework — tests are plain Node scripts in `test/`, run directly (e.g.
`node test/secrets-manager.test.js`), each exiting non-zero on failure.
- `test/secrets-manager.test.js`, `test/tab-attribution.test.js`, `test/prompt-panel-state.test.js`, `test/markdown-files-manager.test.js`
- **Convention:** core modules take an injectable dependency so they're testable under plain Node without Electron — e.g. SecretsManager takes a fake `encryptor`, PromptLibraryManager a fake `store`. `require('electron')` under plain Node returns a path string, so modules whose constructors touch no Electron APIs (ViewManager) can still be instantiated in tests.
- Renderer code (`prompt-library.js`, etc.) has no automated tests — verify with `node --check` for syntax plus a manual in-app checklist.
- Node isn't on PATH by default; prefix with `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"`.

## Commands
- `npm start` - Run in development
- `npm run build` - Build distributable .app/.dmg

## CI/CD
GitHub Actions workflow (`.github/workflows/build.yml`) runs on every push to `main`:
- Builds the Electron app on macOS (with Python 3.11 for node-gyp)
- Uploads DMG and ZIP as artifacts (retained 30 days)
- Access artifacts via Actions tab -> workflow run -> Artifacts section

## Repository
https://github.com/Milkdog/cross-ai-browser

## File Structure
```
design-tokens.js               # Design system source of truth (colors, spacing, etc.)
src/
├── main.js                    # Electron main process
├── sidebar-preload.js         # Preload for sidebar window
├── webview-preload.js         # Preload for AI webviews
├── terminal-preload.js        # Preload for terminal
├── service-picker-preload.js  # Preload for service picker
├── rename-dialog-preload.js   # Preload for rename dialog
├── settings-preload.js        # Preload for settings panel
├── core/
│   ├── ServiceRegistry.js     # Service type definitions
│   ├── TabManager.js          # Tab state management
│   ├── ViewManager.js         # WebContentsView management, streaming detection
│   ├── UsageMonitor.js        # OAuth usage API polling for terminal usage bars
│   ├── DownloadManager.js     # Download management
│   ├── HistoryManager.js      # Terminal session history coordinator
│   ├── TerminalThemes.js      # Terminal color themes
│   ├── PromptLibraryManager.js # Prompt CRUD and organization
│   ├── PromptImageManager.js  # Image storage and clipboard
│   ├── PromptStorageEngine.js # Prompt file I/O
│   ├── SecretsManager.js      # Encrypted secrets store (global + project env vars)
│   ├── FirebaseSyncAdapter.js # Firebase bidirectional sync
│   ├── MarkdownFilesManager.js # .md file listing, CRUD, and fs watcher per cwd
│   └── history/
│       ├── StorageEngine.js   # File I/O for history
│       ├── SessionRecorder.js # PTY output buffering
│       └── RetentionPolicy.js # Cleanup logic
└── renderer/
    ├── design-system.js       # Runtime CSS variable injection
    ├── sidebar.html/js        # Sidebar with tab list, downloads, history
    ├── service-picker.*       # Add tab modal
    ├── rename-dialog.*        # Rename tab modal
    ├── terminal.*             # Claude Code terminal
    ├── prompt-library.*       # Prompt library panel
    ├── settings.html          # Settings popup
    └── styles.css             # Sidebar styles
assets/
├── icon.svg                   # Source icon (3 overlapping circles)
└── icon.icns                  # macOS app icon
pwa/                           # Companion PWA for mobile access
├── src/
│   ├── components/            # React components
│   ├── hooks/                 # useAuth, usePrompts hooks
│   ├── pages/                 # LoginPage, HomePage, SetupPage
│   └── services/              # Firebase, auth, prompts, images
├── firestore.rules            # Firestore security rules
└── storage.rules              # Firebase Storage rules
firebase.json                  # Firebase project configuration
firestore.rules                # Root-level Firestore security rules
firestore.indexes.json         # Firestore index definitions
storage.rules                  # Root-level Storage security rules
.firebaserc                    # Firebase project aliases
```

## Security
The following security measures are implemented:

### Navigation & Window Security
- **Navigation allowlist** - `will-navigate` handlers restrict WebContentsView navigation to allowed AI service origins
- **Strict window.open validation** - Uses hostname-based allowlist instead of substring matching
- **Sandbox mode** - All WebContentsViews have `sandbox: true` enabled

### IPC Security
- **Setting key allowlist** - `set-setting` handler only accepts whitelisted keys
- **Listener cleanup** - All IPC listeners in sidebar-preload.js properly remove old listeners before adding new ones
- **Strict hostname validation** - webview-preload.js uses exact hostname matching instead of `.includes()`

### Content Security
- **CSP headers** - All HTML files have Content Security Policy meta tags
- **Notification sanitization** - Preview text is sanitized before display (HTML/control chars removed)

## Future Plans
- [ ] **Code signing & notarization** - Sign with Developer ID for Gatekeeper
- [ ] **Additional AI services** - Perplexity, Copilot, etc.
- [ ] **Notification thumbnails** - Image preview in notifications
- [ ] **Keyboard shortcuts customization** - User-configurable shortcuts
- [ ] **Window state persistence** - Remember window size/position
