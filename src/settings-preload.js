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
  getAllTerminalThemes: () => ipcRenderer.invoke('get-all-terminal-themes'),

  // Notification sounds
  getNotificationSounds: () => ipcRenderer.invoke('get-notification-sounds'),
  previewSound: (soundName) => ipcRenderer.invoke('preview-notification-sound', soundName),

  // Firebase Cloud Sync
  getFirebaseStatus: () => ipcRenderer.invoke('firebase-get-status'),
  firebaseLogin: (email, password) => ipcRenderer.invoke('firebase-login', email, password),
  firebaseLogout: () => ipcRenderer.invoke('firebase-logout'),
  onFirebaseSyncStatus: (callback) => {
    ipcRenderer.on('firebase-sync-status', (event, status) => callback(status));
  }
});
