const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  submitRename: (tabId, newName) => ipcRenderer.send('rename-dialog-submit', tabId, newName),
  cancelRename: () => ipcRenderer.send('rename-dialog-cancel')
});
