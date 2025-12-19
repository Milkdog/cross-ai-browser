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

  // Event listeners
  onActiveServiceChanged: (callback) => {
    ipcRenderer.on('active-service-changed', (event, tabId) => callback(tabId));
  },

  onTabsUpdated: (callback) => {
    ipcRenderer.on('tabs-updated', (event, tabs) => callback(tabs));
  }
});
