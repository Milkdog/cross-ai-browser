# Cross AI Browser - Project Context

## Overview
An Electron app that provides a unified tabbed interface for AI chat services (ChatGPT, Claude, Gemini) and Claude Code terminal sessions. Features multi-tab support, drag-drop reordering, shared sessions, desktop notifications, real-time streaming indicators, and a prompt library with image attachments.

## Architecture

### Main Process (`src/main.js`)
- Creates the main window with a 160px sidebar for tab navigation
- Manages BrowserViews for each tab (web services and terminals)
- Handles IPC communication between sidebar and content views
- Manages settings via electron-store
- Shows desktop notifications when AI responses complete
- Dynamic window title shows active tab name

### Core Modules (`src/core/`)
- `ServiceRegistry.js` - Defines available service types (ChatGPT, Claude, Gemini, Claude Code)
- `TabManager.js` - Manages tab state, persistence, ordering, and naming
- `ViewManager.js` - Handles BrowserView lifecycle, switching, and terminal streaming detection
- `DownloadManager.js` - Manages file downloads with thumbnails and history
- `HistoryManager.js` - Coordinates terminal session history capture and retention
- `TerminalThemes.js` - Terminal color theme definitions
- `PromptLibraryManager.js` - Manages prompt CRUD, ordering, favorites, labels, and scopes
- `PromptImageManager.js` - Handles image storage, thumbnails, and clipboard operations
- `PromptStorageEngine.js` - File I/O for prompt library with atomic writes

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
- **BrowserViews over webviews** - Better isolation and performance
- **Multi-tab architecture** - Multiple instances of same service supported
- **Modular core** - ServiceRegistry, TabManager, ViewManager separation
- **node-pty + xterm.js** - Native terminal for Claude Code
- **electron-store v8** - Using v8 (not v11+) for CommonJS compatibility
- **Custom user agent** - Strips "Electron" to avoid detection by AI services

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

## Prompt Library
A collapsible panel in Claude Code terminals for managing reusable prompts with image attachments.

### Features
- **CRUD operations** - Create, edit, duplicate, delete prompts
- **Image attachments** - Add images via file picker, drag-drop, or clipboard paste
- **Favorites** - Pin important prompts to a dedicated section
- **Labels** - Tag prompts with multiple labels for organization
- **Reusable flag** - Mark prompts that shouldn't move to Done after use
- **Done section** - Completed prompts move here (unless reusable)
- **Drag-drop reordering** - Reorder prompts within the panel
- **Scopes** - Global prompts (shared across projects) vs Project prompts (per working directory)
- **Search/filter** - Filter prompts by title, content, or labels

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
- Toggle button in terminal view ("Prompts")
- Resizable panel (200-500px width)
- Keyboard shortcut: Cmd+Shift+P to toggle
- Drag prompt card to terminal to insert

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
│   ├── ViewManager.js         # BrowserView management, streaming detection
│   ├── DownloadManager.js     # Download management
│   ├── HistoryManager.js      # Terminal session history coordinator
│   ├── TerminalThemes.js      # Terminal color themes
│   ├── PromptLibraryManager.js # Prompt CRUD and organization
│   ├── PromptImageManager.js  # Image storage and clipboard
│   ├── PromptStorageEngine.js # Prompt file I/O
│   └── history/
│       ├── StorageEngine.js   # File I/O for history
│       ├── SessionRecorder.js # PTY output buffering
│       └── RetentionPolicy.js # Cleanup logic
└── renderer/
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
```

## Security
The following security measures are implemented:

### Navigation & Window Security
- **Navigation allowlist** - `will-navigate` handlers restrict BrowserView navigation to allowed AI service origins
- **Strict window.open validation** - Uses hostname-based allowlist instead of substring matching
- **Sandbox mode** - All BrowserViews have `sandbox: true` enabled

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
