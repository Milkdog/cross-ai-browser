const { contextBridge, ipcRenderer } = require('electron');

// Store listener references for cleanup (prevents memory leaks)
let activeServiceListener = null;
let tabsUpdatedListener = null;
let downloadsUpdatedListener = null;
let historyUpdatedListener = null;
let completionBadgesListener = null;
let streamingStateListener = null;
let terminalRunningStateListener = null;
let settingsActiveListener = null;
let archivedTabsListener = null;

contextBridge.exposeInMainWorld('electronAPI', {
  // Service/Tab management
  getServices: () => ipcRenderer.invoke('get-services'),
  getActiveService: () => ipcRenderer.invoke('get-active-service'),
  switchService: (tabId) => ipcRenderer.send('switch-service', tabId),

  // Tab management
  getAllTabs: () => ipcRenderer.invoke('get-all-tabs'),
  closeTab: (tabId) => ipcRenderer.send('close-tab', tabId),
  renameTab: (tabId, newName) => ipcRenderer.invoke('rename-tab', tabId, newName),
  reorderTabs: (draggedTabId, targetTabId, position) => ipcRenderer.send('reorder-tabs', draggedTabId, targetTabId, position),
  showServicePicker: () => ipcRenderer.send('show-service-picker'),
  showTabContextMenu: (tabId) => ipcRenderer.invoke('show-tab-context-menu', tabId),
  showRenameDialog: (tabId) => ipcRenderer.invoke('show-rename-dialog', tabId),

  // Legacy terminal support
  addTerminal: () => ipcRenderer.invoke('add-terminal'),
  closeTerminal: (terminalId) => ipcRenderer.send('close-terminal', terminalId),
  restartTerminal: (terminalId) => ipcRenderer.send('terminal-reload', { terminalId }),
  shutdownTerminal: (terminalId) => ipcRenderer.send('terminal-shutdown', { terminalId }),

  // Navigation controls
  reloadService: (tabId) => ipcRenderer.send('reload-service', tabId),
  goBack: (tabId) => ipcRenderer.send('go-back', tabId),
  goForward: (tabId) => ipcRenderer.send('go-forward', tabId),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.send('set-setting', key, value),
  openSettings: () => ipcRenderer.send('open-settings'),
  closeSettings: () => ipcRenderer.send('close-settings'),

  // Downloads
  getDownloads: () => ipcRenderer.invoke('get-downloads'),
  pauseDownload: (downloadId) => ipcRenderer.invoke('pause-download', downloadId),
  resumeDownload: (downloadId) => ipcRenderer.invoke('resume-download', downloadId),
  cancelDownload: (downloadId) => ipcRenderer.invoke('cancel-download', downloadId),
  removeDownload: (downloadId) => ipcRenderer.invoke('remove-download', downloadId),
  clearDownloadHistory: () => ipcRenderer.invoke('clear-download-history'),
  openDownload: (downloadId) => ipcRenderer.invoke('open-download', downloadId),
  showDownloadInFolder: (downloadId) => ipcRenderer.invoke('show-download-in-folder', downloadId),
  getDownloadSaveMode: () => ipcRenderer.invoke('get-download-save-mode'),
  setDownloadSaveMode: (mode) => ipcRenderer.invoke('set-download-save-mode', mode),

  // History
  getHistorySessions: (options) => ipcRenderer.invoke('get-history-sessions', options),
  getHistorySessionsForCwd: (cwd, limit) => ipcRenderer.invoke('get-history-sessions-for-cwd', cwd, limit),
  getHistorySession: (sessionId) => ipcRenderer.invoke('get-history-session', sessionId),
  readHistorySession: (sessionId) => ipcRenderer.invoke('read-history-session', sessionId),
  deleteHistorySession: (sessionId) => ipcRenderer.invoke('delete-history-session', sessionId),
  exportHistorySession: (sessionId) => ipcRenderer.invoke('export-history-session', sessionId),
  getHistorySettings: () => ipcRenderer.invoke('get-history-settings'),
  updateHistorySettings: (settings) => ipcRenderer.invoke('update-history-settings', settings),
  getHistoryStats: () => ipcRenderer.invoke('get-history-stats'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  isHistoryEnabled: () => ipcRenderer.invoke('is-history-enabled'),

  // Archive management
  archiveTab: (tabId) => ipcRenderer.invoke('archive-tab', tabId),
  unarchiveTab: (tabId) => ipcRenderer.invoke('unarchive-tab', tabId),
  getArchivedTabs: () => ipcRenderer.invoke('get-archived-tabs'),

  // Completion badges
  getCompletionBadges: () => ipcRenderer.invoke('get-completion-badges'),

  // Terminal running state
  getRunningTerminals: () => ipcRenderer.invoke('get-running-terminals'),

  // Event listeners - with proper cleanup to prevent memory leaks
  onActiveServiceChanged: (callback) => {
    if (activeServiceListener) {
      ipcRenderer.removeListener('active-service-changed', activeServiceListener);
    }
    activeServiceListener = (event, tabId) => callback(tabId);
    ipcRenderer.on('active-service-changed', activeServiceListener);
  },

  onTabsUpdated: (callback) => {
    if (tabsUpdatedListener) {
      ipcRenderer.removeListener('tabs-updated', tabsUpdatedListener);
    }
    tabsUpdatedListener = (event, tabs) => callback(tabs);
    ipcRenderer.on('tabs-updated', tabsUpdatedListener);
  },

  onDownloadsUpdated: (callback) => {
    if (downloadsUpdatedListener) {
      ipcRenderer.removeListener('downloads-updated', downloadsUpdatedListener);
    }
    downloadsUpdatedListener = (event, data) => callback(data);
    ipcRenderer.on('downloads-updated', downloadsUpdatedListener);
  },

  onHistoryUpdated: (callback) => {
    if (historyUpdatedListener) {
      ipcRenderer.removeListener('history-updated', historyUpdatedListener);
    }
    historyUpdatedListener = (event, data) => callback(data);
    ipcRenderer.on('history-updated', historyUpdatedListener);
  },

  onCompletionBadgesUpdated: (callback) => {
    if (completionBadgesListener) {
      ipcRenderer.removeListener('completion-badges-updated', completionBadgesListener);
    }
    completionBadgesListener = (event, tabIds) => callback(tabIds);
    ipcRenderer.on('completion-badges-updated', completionBadgesListener);
  },

  onStreamingStateChanged: (callback) => {
    if (streamingStateListener) {
      ipcRenderer.removeListener('streaming-state-changed', streamingStateListener);
    }
    streamingStateListener = (event, data) => callback(data);
    ipcRenderer.on('streaming-state-changed', streamingStateListener);
  },

  onTerminalRunningStateChanged: (callback) => {
    if (terminalRunningStateListener) {
      ipcRenderer.removeListener('terminal-running-state-changed', terminalRunningStateListener);
    }
    terminalRunningStateListener = (event, data) => callback(data);
    ipcRenderer.on('terminal-running-state-changed', terminalRunningStateListener);
  },

  onArchivedTabsUpdated: (callback) => {
    if (archivedTabsListener) {
      ipcRenderer.removeListener('archived-tabs-updated', archivedTabsListener);
    }
    archivedTabsListener = (event, tabs) => callback(tabs);
    ipcRenderer.on('archived-tabs-updated', archivedTabsListener);
  },

  onSettingsActiveChanged: (callback) => {
    if (settingsActiveListener) {
      ipcRenderer.removeListener('settings-active-changed', settingsActiveListener);
    }
    settingsActiveListener = (event, isActive) => callback(isActive);
    ipcRenderer.on('settings-active-changed', settingsActiveListener);
  },

  // Cleanup method for manual cleanup if needed
  cleanup: () => {
    if (activeServiceListener) {
      ipcRenderer.removeListener('active-service-changed', activeServiceListener);
      activeServiceListener = null;
    }
    if (tabsUpdatedListener) {
      ipcRenderer.removeListener('tabs-updated', tabsUpdatedListener);
      tabsUpdatedListener = null;
    }
    if (downloadsUpdatedListener) {
      ipcRenderer.removeListener('downloads-updated', downloadsUpdatedListener);
      downloadsUpdatedListener = null;
    }
    if (historyUpdatedListener) {
      ipcRenderer.removeListener('history-updated', historyUpdatedListener);
      historyUpdatedListener = null;
    }
    if (completionBadgesListener) {
      ipcRenderer.removeListener('completion-badges-updated', completionBadgesListener);
      completionBadgesListener = null;
    }
    if (streamingStateListener) {
      ipcRenderer.removeListener('streaming-state-changed', streamingStateListener);
      streamingStateListener = null;
    }
    if (terminalRunningStateListener) {
      ipcRenderer.removeListener('terminal-running-state-changed', terminalRunningStateListener);
      terminalRunningStateListener = null;
    }
    if (archivedTabsListener) {
      ipcRenderer.removeListener('archived-tabs-updated', archivedTabsListener);
      archivedTabsListener = null;
    }
    if (settingsActiveListener) {
      ipcRenderer.removeListener('settings-active-changed', settingsActiveListener);
      settingsActiveListener = null;
    }
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (activeServiceListener) {
    ipcRenderer.removeListener('active-service-changed', activeServiceListener);
  }
  if (tabsUpdatedListener) {
    ipcRenderer.removeListener('tabs-updated', tabsUpdatedListener);
  }
  if (downloadsUpdatedListener) {
    ipcRenderer.removeListener('downloads-updated', downloadsUpdatedListener);
  }
  if (historyUpdatedListener) {
    ipcRenderer.removeListener('history-updated', historyUpdatedListener);
  }
  if (completionBadgesListener) {
    ipcRenderer.removeListener('completion-badges-updated', completionBadgesListener);
  }
  if (streamingStateListener) {
    ipcRenderer.removeListener('streaming-state-changed', streamingStateListener);
  }
  if (terminalRunningStateListener) {
    ipcRenderer.removeListener('terminal-running-state-changed', terminalRunningStateListener);
  }
  if (archivedTabsListener) {
    ipcRenderer.removeListener('archived-tabs-updated', archivedTabsListener);
  }
  if (settingsActiveListener) {
    ipcRenderer.removeListener('settings-active-changed', settingsActiveListener);
  }
});
