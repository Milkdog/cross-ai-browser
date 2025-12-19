const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Service management
  getServices: () => ipcRenderer.invoke('get-services'),
  getActiveService: () => ipcRenderer.invoke('get-active-service'),
  switchService: (serviceId) => ipcRenderer.send('switch-service', serviceId),

  // Tab management (includes terminals)
  getAllTabs: () => ipcRenderer.invoke('get-all-tabs'),
  addTerminal: () => ipcRenderer.invoke('add-terminal'),
  closeTerminal: (terminalId) => ipcRenderer.send('close-terminal', terminalId),

  // Navigation controls
  reloadService: (serviceId) => ipcRenderer.send('reload-service', serviceId),
  goBack: (serviceId) => ipcRenderer.send('go-back', serviceId),
  goForward: (serviceId) => ipcRenderer.send('go-forward', serviceId),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.send('set-setting', key, value),
  openSettings: () => ipcRenderer.send('open-settings'),

  // Event listeners
  onActiveServiceChanged: (callback) => {
    ipcRenderer.on('active-service-changed', (event, serviceId) => callback(serviceId));
  },

  onTabsUpdated: (callback) => {
    ipcRenderer.on('tabs-updated', (event, tabs) => callback(tabs));
  }
});
