# Cross AI Browser - Project Context

## Overview
An Electron app that provides a unified tabbed interface for AI chat services (ChatGPT, Claude, Gemini) and Claude Code terminal sessions. Features multi-tab support, drag-drop reordering, shared sessions, and desktop notifications.

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
- `ViewManager.js` - Handles BrowserView lifecycle and switching

### Renderer Process (`src/renderer/`)
- `sidebar.html/js` - Tab list with drag-drop reordering
- `service-picker.html/js/css` - Modal for adding new tabs
- `rename-dialog.html/js` - Modal for renaming tabs
- `terminal.html/js/css` - xterm.js terminal for Claude Code
- `settings.html` - Settings popup window
- `styles.css` - Sidebar styling

### Preload Scripts
- `sidebar-preload.js` - Exposes IPC APIs to sidebar
- `webview-preload.js` - Detects AI streaming state, sends notifications
- `terminal-preload.js` - Terminal IPC for pty communication
- `service-picker-preload.js` - Service picker IPC
- `rename-dialog-preload.js` - Rename dialog IPC

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
├── core/
│   ├── ServiceRegistry.js     # Service type definitions
│   ├── TabManager.js          # Tab state management
│   └── ViewManager.js         # BrowserView management
└── renderer/
    ├── sidebar.html/js        # Sidebar with tab list
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
