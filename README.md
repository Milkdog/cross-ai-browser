# Cross AI Browser

A macOS desktop app for quickly switching between AI chat services with persistent sessions and desktop notifications.

## Features

- **Unified interface** - Access ChatGPT, Claude, and Gemini from one app
- **Persistent sessions** - Each AI maintains its own session, stay logged in
- **Keyboard shortcuts** - Cmd+1/2/3 to switch, Cmd+[/] to cycle
- **Desktop notifications** - Get notified when an AI finishes responding
- **Configurable notifications** - Always, when unfocused, or inactive tab only

## Installation

```bash
npm install
```

## Usage

### Development
```bash
npm start
```

### Build
```bash
npm run build
```

The built app will be in `dist/` as both `.app` and `.dmg`.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+1 | Switch to ChatGPT |
| Cmd+2 | Switch to Claude |
| Cmd+3 | Switch to Gemini |
| Cmd+] | Next service |
| Cmd+[ | Previous service |
| Cmd+R | Reload current service |
| Cmd+Option+I | Open DevTools for current service |

## Settings

Click the gear icon in the sidebar to configure notifications:
- **Enable notifications** - Toggle on/off
- **Notify when** - Always, window unfocused, or inactive tab only

## Distribution

The built DMG is unsigned. Recipients on macOS will need to:
1. Right-click the app → Open → Open anyway
2. Or run: `xattr -cr /path/to/Cross\ AI\ Browser.app`

## Tech Stack

- Electron
- BrowserViews for isolated AI sessions
- electron-store for settings persistence
- electron-builder for packaging
