# Cross AI Browser

A macOS desktop app for managing multiple AI chat services and Claude Code terminals in a unified tabbed interface.

## Features

- **Multi-tab interface** - Open multiple tabs of any service
- **AI Services** - ChatGPT, Claude, and Gemini in one app
- **Claude Code terminal** - Integrated terminal for Claude Code sessions
- **Shared sessions** - Log into Google once, works across all services
- **Drag-drop reordering** - Organize tabs by dragging
- **Right-click to rename** - Customize tab names
- **Desktop notifications** - Get notified when an AI finishes responding
- **Keyboard shortcuts** - Quick navigation between tabs
- **Persistent state** - Tabs and sessions survive restarts

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
| Cmd+T | Add new tab |
| Cmd+W | Close current tab |
| Cmd+1-9 | Switch to tab by position |
| Cmd+] | Next tab |
| Cmd+[ | Previous tab |
| Cmd+R | Reload current tab |
| Cmd+Option+I | Open DevTools for current tab |

## Adding Tabs

Click the **+** button in the sidebar to open the service picker:
- **ChatGPT** - OpenAI's ChatGPT
- **Claude** - Anthropic's Claude
- **Gemini** - Google's Gemini
- **Claude Code** - Terminal for Claude Code CLI

## Tab Management

- **Drag tabs** to reorder them
- **Right-click a tab** to rename it
- **Cmd+W** or close from menu to remove a tab

## Settings

Click the gear icon in the sidebar to configure notifications:
- **Enable notifications** - Toggle on/off
- **Notify when** - Always, window unfocused, or inactive tab only

## Distribution

The built DMG is unsigned. Recipients on macOS will need to:
1. Right-click the app -> Open -> Open anyway
2. Or run: `xattr -cr /path/to/Cross\ AI\ Browser.app`

## Tech Stack

- Electron with BrowserViews
- node-pty + xterm.js for terminal
- electron-store for persistence
- electron-builder for packaging
