const { contextBridge, ipcRenderer } = require('electron');

// Get terminal ID from URL search params
const urlParams = new URLSearchParams(window.location.search);
const terminalId = urlParams.get('id');

// Store listener references for cleanup
let dataListener = null;
let exitListener = null;
let usageListener = null;
let themeChangeListener = null;
let promptLibraryListener = null;
let streamingStateListener = null;

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

  // Listen for streaming state changes (for ready indicator)
  onStreamingState: (callback) => {
    if (streamingStateListener) {
      ipcRenderer.removeListener('terminal-streaming-state', streamingStateListener);
    }
    streamingStateListener = (event, streaming) => callback(streaming);
    ipcRenderer.on('terminal-streaming-state', streamingStateListener);
  },

  // Prompt Library APIs
  promptLibrary: {
    // Get all prompts for this terminal's cwd
    getPrompts: () => ipcRenderer.invoke('prompt-library-get', { terminalId }),

    // Get the working directory
    getCwd: () => ipcRenderer.invoke('prompt-library-get-cwd', { terminalId }),

    // Create a new prompt
    createPrompt: (prompt) => ipcRenderer.invoke('prompt-library-create', { terminalId, prompt }),

    // Update a prompt
    updatePrompt: (promptId, updates) => ipcRenderer.invoke('prompt-library-update', { terminalId, promptId, updates }),

    // Delete a prompt
    deletePrompt: (promptId) => ipcRenderer.invoke('prompt-library-delete', { terminalId, promptId }),

    // Duplicate a prompt
    duplicatePrompt: (promptId) => ipcRenderer.invoke('prompt-library-duplicate', { terminalId, promptId }),

    // Reorder prompts
    reorderPrompts: (promptIds, scope) => ipcRenderer.invoke('prompt-library-reorder', { terminalId, promptIds, scope }),

    // Toggle reusable flag on a prompt
    toggleReusable: (promptId) => ipcRenderer.invoke('prompt-library-toggle-reusable', { terminalId, promptId }),

    // Toggle favorite flag on a prompt
    toggleFavorite: (promptId) => ipcRenderer.invoke('prompt-library-toggle-favorite', { terminalId, promptId }),

    // Mark a prompt as testing
    markAsTesting: (promptId) => ipcRenderer.invoke('prompt-library-mark-testing', { terminalId, promptId }),

    // Mark a prompt as done
    markAsDone: (promptId) => ipcRenderer.invoke('prompt-library-mark-done', { terminalId, promptId }),

    // Restore a prompt from done or testing
    restorePrompt: (promptId) => ipcRenderer.invoke('prompt-library-restore', { terminalId, promptId }),

    // Clear all done prompts
    clearDonePrompts: () => ipcRenderer.invoke('prompt-library-clear-done', { terminalId }),

    // Label management
    getLabels: () => ipcRenderer.invoke('prompt-library-get-labels'),
    addLabel: (name) => ipcRenderer.invoke('prompt-library-add-label', { name }),
    deleteLabel: (name) => ipcRenderer.invoke('prompt-library-delete-label', { name }),

    // Legacy category API (redirects to labels)
    getCategories: () => ipcRenderer.invoke('prompt-library-get-labels'),
    addCategory: (name) => ipcRenderer.invoke('prompt-library-add-label', { name }),
    deleteCategory: (name) => ipcRenderer.invoke('prompt-library-delete-label', { name }),

    // Get panel state
    getPanelState: () => ipcRenderer.invoke('prompt-panel-get-state', { terminalId }),

    // Set panel state
    setPanelState: (state) => ipcRenderer.send('prompt-panel-set-state', { terminalId, state }),

    // Image management
    addImage: (filePath) => ipcRenderer.invoke('prompt-image-add', { filePath }),
    addImageFromDataUrl: (dataUrl) => ipcRenderer.invoke('prompt-image-add-from-data-url', { dataUrl }),
    removeImage: (imageId) => ipcRenderer.invoke('prompt-image-remove', { imageId }),
    getImageThumbnail: (imageId) => ipcRenderer.invoke('prompt-image-get-thumbnail', { imageId }),
    getImagePath: (imageId) => ipcRenderer.invoke('prompt-image-get-path', { imageId }),
    copyImageToTemp: (imageId) => ipcRenderer.invoke('prompt-image-copy-to-temp', { imageId }),
    copyImageToClipboard: (imageId) => ipcRenderer.invoke('prompt-image-copy-to-clipboard', { imageId }),
    pickImageFiles: () => ipcRenderer.invoke('prompt-image-pick-files'),

    // Listen for prompt updates (from other terminals with same cwd)
    onPromptsUpdated: (callback) => {
      if (promptLibraryListener) {
        ipcRenderer.removeListener('prompt-library-updated', promptLibraryListener);
      }
      promptLibraryListener = (event, data) => callback(data);
      ipcRenderer.on('prompt-library-updated', promptLibraryListener);
    }
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
    if (promptLibraryListener) {
      ipcRenderer.removeListener('prompt-library-updated', promptLibraryListener);
      promptLibraryListener = null;
    }
    if (streamingStateListener) {
      ipcRenderer.removeListener('terminal-streaming-state', streamingStateListener);
      streamingStateListener = null;
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
  if (promptLibraryListener) {
    ipcRenderer.removeListener('prompt-library-updated', promptLibraryListener);
  }
  if (streamingStateListener) {
    ipcRenderer.removeListener('terminal-streaming-state', streamingStateListener);
  }
});
