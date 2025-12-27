# Cross AI Browser - Project Context

## Overview
An Electron app that provides a unified tabbed interface for AI chat services (ChatGPT, Claude, Gemini) and Claude Code terminal sessions. Features multi-tab support, drag-drop reordering, shared sessions, desktop notifications, and real-time streaming indicators.

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

### History Modules (`src/core/history/`)
- `StorageEngine.js` - File I/O abstraction, atomic writes, path hashing by cwd
- `SessionRecorder.js` - In-memory buffer for PTY output, gzip compression
- `RetentionPolicy.js` - Time-based (30 days) and size-based (500MB) cleanup logic

### Renderer Process (`src/renderer/`)
- `sidebar.html/js` - Tab list with drag-drop reordering
- `service-picker.html/js/css` - Modal for adding new tabs
- `rename-dialog.html/js` - Modal for renaming tabs
- `terminal.html/js/css` - xterm.js terminal for Claude Code
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
│   └── history/
│       ├── StorageEngine.js   # File I/O for history
│       ├── SessionRecorder.js # PTY output buffering
│       └── RetentionPolicy.js # Cleanup logic
└── renderer/
    ├── sidebar.html/js        # Sidebar with tab list, downloads, history
    ├── service-picker.*       # Add tab modal
    ├── rename-dialog.*        # Rename tab modal
    ├── terminal.*             # Claude Code terminal
    ├── settings.html          # Settings popup
    └── styles.css             # Sidebar styles
assets/
├── icon.svg                   # Source icon (3 overlapping circles)
└── icon.icns                  # macOS app icon
```

## Known Security Issues
The following issues were identified during security review and should be addressed:

### Critical
1. **IPC allows arbitrary setting keys** - Add allowlist validation for `set-setting` handler
2. **Missing navigation security** - Add `will-navigate` handlers to BrowserViews
3. **Unsafe window open handler** - Replace substring matching with strict origin-based allowlist

### High
4. **Missing sandbox** - Add `sandbox: true` to BrowserView webPreferences
5. **IPC listener memory leak** - `onActiveServiceChanged` doesn't clean up listeners
6. **Missing IPC input validation** - Validate `serviceId` against known services

### Medium
7. Add CSP to `settings.html`
8. Sanitize notification preview text from webviews

## Future Plans
- [ ] **Code signing & notarization** - Sign with Developer ID for Gatekeeper
- [ ] **Additional AI services** - Perplexity, Copilot, etc.
- [ ] **Notification thumbnails** - Image preview in notifications
- [ ] **Keyboard shortcuts customization** - User-configurable shortcuts
- [ ] **Window state persistence** - Remember window size/position
