# Cross AI Browser - Project Context

## Overview
An Electron app that provides a unified interface for switching between AI chat services (ChatGPT, Claude, Gemini) with persistent sessions and desktop notifications.

## Architecture

### Main Process (`src/main.js`)
- Creates the main window with a sidebar for navigation
- Manages BrowserViews for each AI service (one per service, persistent)
- Handles IPC communication between sidebar and webviews
- Manages settings via electron-store
- Shows desktop notifications when AI responses complete

### Renderer Process
- `src/renderer/sidebar.html` - Main window content (60px sidebar)
- `src/renderer/sidebar.js` - Service switching, UI interactions
- `src/renderer/settings.html` - Settings popup window
- `src/renderer/styles.css` - Sidebar styling

### Preload Scripts
- `src/sidebar-preload.js` - Exposes IPC APIs to sidebar
- `src/webview-preload.js` - Detects AI streaming state, sends notifications

## Key Technical Decisions
- **BrowserViews over webviews**: Better isolation, each AI gets its own session partition
- **electron-store v8**: Using v8 (not v11+) for CommonJS compatibility
- **Custom user agent**: Strips "Electron" to avoid detection by AI services

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
- Builds the Electron app on macOS
- Uploads DMG and ZIP as artifacts (retained 30 days)
- Access artifacts via Actions tab → workflow run → Artifacts section

## Repository
https://github.com/Milkdog/cross-ai-browser

## File Structure
```
src/
├── main.js              # Electron main process
├── sidebar-preload.js   # Preload for sidebar window
├── webview-preload.js   # Preload for AI webviews
└── renderer/
    ├── sidebar.html     # Sidebar UI
    ├── sidebar.js       # Sidebar logic
    ├── settings.html    # Settings popup
    └── styles.css       # Styles
assets/
├── icon.svg             # Source icon (3 overlapping circles)
└── icon.icns            # macOS app icon
```

## Known Security Issues
The following issues were identified during security review and should be addressed:

### Critical
1. **IPC allows arbitrary setting keys** (`src/main.js:244-246`) - Add allowlist validation for `set-setting` handler
2. **Missing navigation security** - Add `will-navigate` handlers to BrowserViews to prevent navigation attacks
3. **Unsafe window open handler** - Replace substring matching with strict origin-based allowlist

### High
4. **Missing sandbox** - Add `sandbox: true` to BrowserView webPreferences
5. **IPC listener memory leak** - `onActiveServiceChanged` doesn't clean up listeners
6. **Missing IPC input validation** - Validate `serviceId` against known services

### Medium
7. Add CSP to `settings.html`
8. Sanitize notification preview text from webviews

## Future Plans
- [ ] **Code signing & notarization** - Sign with Developer ID certificate for distribution without Gatekeeper warnings
- [ ] **Additional AI services** - Perplexity, Copilot, etc.
- [ ] **Notification thumbnails** - Include image preview in notifications when AI generates images
- [ ] **Keyboard shortcuts customization** - Let users configure their own shortcuts
- [ ] **Window state persistence** - Remember window size/position
