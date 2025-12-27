const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.send('set-setting', key, value),
  closeSettings: () => ipcRenderer.send('close-settings'),

  // Downloads
  getDownloadSaveMode: () => ipcRenderer.invoke('get-download-save-mode'),
  setDownloadSaveMode: (mode) => ipcRenderer.invoke('set-download-save-mode', mode),
  clearDownloadHistory: () => ipcRenderer.invoke('clear-download-history'),

  // Terminal themes
  getTerminalTheme: () => ipcRenderer.invoke('get-terminal-theme'),
  getAllTerminalThemes: () => ipcRenderer.invoke('get-all-terminal-themes')
});
