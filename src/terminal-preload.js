const { contextBridge, ipcRenderer } = require('electron');

// Get terminal ID from URL search params
const urlParams = new URLSearchParams(window.location.search);
const terminalId = urlParams.get('id');

// Store listener references for cleanup
let dataListener = null;
let exitListener = null;
let usageListener = null;
let themeChangeListener = null;

contextBridge.exposeInMainWorld('electronAPI', {
  // Send terminal input to main process
  sendInput: (data) => {
    ipcRenderer.send('terminal-input', { terminalId, data });
  },

  // Send resize event to main process
  sendResize: (cols, rows) => {
    ipcRenderer.send('terminal-resize', { terminalId, cols, rows });
  },

  // Notify main process that terminal is ready
  ready: () => {
    ipcRenderer.send('terminal-ready', { terminalId });
  },

  // Receive terminal output from main process
  onData: (callback) => {
    // Remove previous listener if exists to prevent memory leaks
    if (dataListener) {
      ipcRenderer.removeListener('terminal-data', dataListener);
    }
    dataListener = (event, data) => callback(data);
    ipcRenderer.on('terminal-data', dataListener);
  },

  // Listen for process exit event
  onExit: (callback) => {
    if (exitListener) {
      ipcRenderer.removeListener('terminal-exit', exitListener);
    }
    exitListener = (event, data) => callback(data);
    ipcRenderer.on('terminal-exit', exitListener);
  },

  // Request to reload/restart Claude in this terminal (fresh session)
  reload: () => {
    ipcRenderer.send('terminal-reload', { terminalId });
  },

  // Request to resume the previous Claude session (claude --continue)
  resume: () => {
    ipcRenderer.send('terminal-resume', { terminalId });
  },

  // Request to close this terminal tab
  close: () => {
    ipcRenderer.send('terminal-close', { terminalId });
  },

  // Save clipboard image to temp file and return the path
  saveClipboardImage: (imageBuffer) => {
    return ipcRenderer.invoke('terminal-save-clipboard-image', { terminalId, imageBuffer });
  },

  // Request usage data update
  requestUsageUpdate: () => {
    ipcRenderer.send('terminal-request-usage', { terminalId });
  },

  // Listen for usage updates
  onUsageUpdate: (callback) => {
    if (usageListener) {
      ipcRenderer.removeListener('usage-update', usageListener);
    }
    usageListener = (event, data) => callback(data);
    ipcRenderer.on('usage-update', usageListener);
  },

  // Get current terminal theme
  getTerminalTheme: () => {
    return ipcRenderer.invoke('get-terminal-theme');
  },

  // Listen for theme changes
  onThemeChanged: (callback) => {
    if (themeChangeListener) {
      ipcRenderer.removeListener('terminal-theme-changed', themeChangeListener);
    }
    themeChangeListener = (event, themeId) => callback(themeId);
    ipcRenderer.on('terminal-theme-changed', themeChangeListener);
  },

  // Cleanup listeners when terminal is closed
  cleanup: () => {
    if (dataListener) {
      ipcRenderer.removeListener('terminal-data', dataListener);
      dataListener = null;
    }
    if (exitListener) {
      ipcRenderer.removeListener('terminal-exit', exitListener);
      exitListener = null;
    }
    if (usageListener) {
      ipcRenderer.removeListener('usage-update', usageListener);
      usageListener = null;
    }
    if (themeChangeListener) {
      ipcRenderer.removeListener('terminal-theme-changed', themeChangeListener);
      themeChangeListener = null;
    }
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (dataListener) {
    ipcRenderer.removeListener('terminal-data', dataListener);
  }
  if (exitListener) {
    ipcRenderer.removeListener('terminal-exit', exitListener);
  }
  if (usageListener) {
    ipcRenderer.removeListener('usage-update', usageListener);
  }
  if (themeChangeListener) {
    ipcRenderer.removeListener('terminal-theme-changed', themeChangeListener);
  }
});
