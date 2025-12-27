const { contextBridge, ipcRenderer } = require('electron');

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

  // Completion badges
  getCompletionBadges: () => ipcRenderer.invoke('get-completion-badges'),

  // Event listeners
  onActiveServiceChanged: (callback) => {
    ipcRenderer.on('active-service-changed', (event, tabId) => callback(tabId));
  },

  onTabsUpdated: (callback) => {
    ipcRenderer.on('tabs-updated', (event, tabs) => callback(tabs));
  },

  onDownloadsUpdated: (callback) => {
    ipcRenderer.on('downloads-updated', (event, data) => callback(data));
  },

  onHistoryUpdated: (callback) => {
    ipcRenderer.on('history-updated', (event, data) => callback(data));
  },

  onCompletionBadgesUpdated: (callback) => {
    ipcRenderer.on('completion-badges-updated', (event, tabIds) => callback(tabIds));
  },

  onStreamingStateChanged: (callback) => {
    ipcRenderer.on('streaming-state-changed', (event, data) => callback(data));
  }
});
