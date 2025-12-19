const { contextBridge, ipcRenderer } = require('electron');

// Get terminal ID from URL search params
const urlParams = new URLSearchParams(window.location.search);
const terminalId = urlParams.get('id');

// Store listener references for cleanup
let dataListener = null;

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

  // Cleanup listeners when terminal is closed
  cleanup: () => {
    if (dataListener) {
      ipcRenderer.removeListener('terminal-data', dataListener);
      dataListener = null;
    }
  }
});

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
  if (dataListener) {
    ipcRenderer.removeListener('terminal-data', dataListener);
  }
});
