const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Create a new tab
  createTab: (serviceType) => ipcRenderer.invoke('create-tab', serviceType),

  // Select folder and create terminal tab
  selectFolderAndCreateTab: (serviceType) => ipcRenderer.invoke('select-folder-and-create-tab', serviceType),

  // Close the picker
  closeServicePicker: () => ipcRenderer.send('close-service-picker')
});
