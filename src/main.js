const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, Notification, Menu, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('electron-store');

// Import core modules
const { SERVICE_TYPES, getServiceType, isValidServiceType, isTerminalAvailable } = require('./core/ServiceRegistry');
const TabManager = require('./core/TabManager');
const ViewManager = require('./core/ViewManager');
const DownloadManager = require('./core/DownloadManager');
const HistoryManager = require('./core/HistoryManager');
const TerminalThemes = require('./core/TerminalThemes');

// Set app name (shown in menu bar)
app.setName('Cross AI Browser');

// Initialize settings store
const store = new Store({
  defaults: {
    notifications: {
      enabled: true,
      mode: 'always' // 'always', 'unfocused', 'inactive-tab'
    },
    tabs: [], // Persisted tabs (new format)
    tabData: {}, // Additional tab data (cwd for terminals)
    downloads: {
      items: [],
      settings: { saveMode: 'ask' } // 'ask' or 'auto'
    },
    ui: {
      sidebarExpanded: false
    },
    terminal: {
      theme: 'vscode-dark'
    }
  }
});

const SIDEBAR_WIDTH = 280; // Always expanded

let mainWindow = null;
let tabManager = null;
let viewManager = null;
let downloadManager = null;
let historyManager = null;
let servicePickerWindow = null;

// Track tabs with unread completions (for badge display)
const tabsWithCompletions = new Set();

// Notify sidebar of completion badge changes
function sendCompletionBadges() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('completion-badges-updated', Array.from(tabsWithCompletions));
  }
}

// Mark a tab as having an unread completion
function markTabCompleted(tabId) {
  const activeTabId = viewManager?.getActiveTabId();
  const isWindowFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();

  // Show badge if:
  // 1. Tab is not the active tab, OR
  // 2. Window is not focused (user is in another app)
  if (tabId !== activeTabId || !isWindowFocused) {
    tabsWithCompletions.add(tabId);
    sendCompletionBadges();
  }
}

// Clear completion badge for a tab
function clearTabCompletion(tabId) {
  if (tabsWithCompletions.has(tabId)) {
    tabsWithCompletions.delete(tabId);
    sendCompletionBadges();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'sidebar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Load sidebar UI
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'sidebar.html'));

  // Initialize TabManager
  tabManager = new TabManager(store);

  // Initialize HistoryManager
  historyManager = new HistoryManager({
    store,
    userDataPath: app.getPath('userData')
  });

  // Forward history events to renderer
  historyManager.on('history-updated', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('history-updated', data);
    }
  });

  // Initialize ViewManager
  viewManager = new ViewManager({
    mainWindow,
    store,
    getSidebarWidth: () => SIDEBAR_WIDTH,
    onTabsChanged: () => {
      mainWindow.webContents.send('tabs-updated', getTabsForRenderer());
      updateShortcuts();
    },
    historyManager,
    onTerminalCompleted: (tabId) => {
      markTabCompleted(tabId);
    }
  });

  // Initialize DownloadManager with shared session
  const sharedSession = session.fromPartition('persist:shared');
  downloadManager = new DownloadManager({
    store,
    session: sharedSession,
    getMainWindow: () => mainWindow
  });
  downloadManager.initialize();

  // Forward download events to renderer
  downloadManager.on('downloads-updated', (data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('downloads-updated', data);
    }
  });

  // Create views for existing tabs
  const existingTabs = tabManager.getOrderedTabs();
  existingTabs.forEach(tab => {
    createViewForTab(tab);
  });

  // Handle window resize
  mainWindow.on('resize', () => {
    viewManager.updateViewBounds();
  });

  // Auto-focus the active view when window gains focus
  mainWindow.on('focus', () => {
    viewManager.focusActiveView();
  });

  mainWindow.on('closed', () => {
    viewManager.destroy();
    if (downloadManager) {
      downloadManager.destroy();
      downloadManager = null;
    }
    if (historyManager) {
      historyManager.destroy();
      historyManager = null;
    }
    mainWindow = null;
  });

  // Show service picker if no tabs exist (first-time experience)
  if (!tabManager.hasTabs()) {
    // Delay to allow window to fully load
    setTimeout(() => {
      showServicePicker(true);
    }, 300);
  } else {
    // Switch to first tab
    const firstTab = tabManager.getTabAtIndex(0);
    if (firstTab) {
      switchToTab(firstTab.id);
    }
  }
}

/**
 * Create a view for a tab and handle terminal-specific setup
 */
function createViewForTab(tab) {
  const serviceType = getServiceType(tab.serviceType);
  if (!serviceType) return;

  viewManager.createViewForTab(tab);

  // For terminal tabs, we need to store and restore cwd
  if (serviceType.type === 'terminal') {
    const tabData = store.get('tabData', {});
    const data = tabData[tab.id];

    if (data && data.cwd) {
      // Verify directory still exists
      try {
        if (fs.existsSync(data.cwd) && fs.statSync(data.cwd).isDirectory()) {
          // Store cwd in tab for later use when PTY is spawned
          tab.cwd = data.cwd;
          tab.mode = 'continue'; // Auto-resume on app restart
        }
      } catch {
        // Directory doesn't exist, will need to be set up again
      }
    }
  }
}

/**
 * Get tabs formatted for renderer
 */
function getTabsForRenderer() {
  const tabs = tabManager.getOrderedTabs();
  return tabs.map((tab, index) => {
    const serviceType = getServiceType(tab.serviceType);
    return {
      id: tab.id,
      serviceType: tab.serviceType,
      name: tab.name,
      type: serviceType ? serviceType.type : 'web',
      shortcut: index < 9 ? `⌘${index + 1}` : null,
      closeable: true,
      order: tab.order
    };
  });
}

/**
 * Switch to a specific tab
 */
function switchToTab(tabId) {
  const tab = tabManager.getTab(tabId);
  if (!tab) return;

  // Ensure view exists
  if (!viewManager.hasView(tabId)) {
    createViewForTab(tab);
  }

  viewManager.switchToTab(tabId);

  // Clear completion badge for this tab
  clearTabCompletion(tabId);

  // Update window title
  mainWindow.setTitle(`${tab.name} - Cross AI Browser`);

  // Notify sidebar
  mainWindow.webContents.send('active-service-changed', tabId);
}

/**
 * Show the service picker modal
 */
function showServicePicker(isFirstTime = false) {
  if (servicePickerWindow) {
    servicePickerWindow.focus();
    return;
  }

  // Create service picker as a BrowserView that fills the content area
  const pickerView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'service-picker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  servicePickerWindow = pickerView; // Store reference (reusing variable name)
  mainWindow.addBrowserView(pickerView);

  // Position to fill content area (right of sidebar)
  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  pickerView.setBounds({
    x: SIDEBAR_WIDTH,
    y: 0,
    width: windowWidth - SIDEBAR_WIDTH,
    height: windowHeight
  });

  const query = {
    terminalAvailable: isTerminalAvailable() ? 'true' : 'false'
  };
  if (isFirstTime) {
    query.firstTime = 'true';
  }
  pickerView.webContents.loadFile(
    path.join(__dirname, 'renderer', 'service-picker.html'),
    { query }
  );
}

/**
 * Close the service picker
 */
function closeServicePicker() {
  if (servicePickerWindow && mainWindow) {
    mainWindow.removeBrowserView(servicePickerWindow);
    servicePickerWindow = null;
  }
}

/**
 * Create a new tab
 */
async function createTab(serviceType, cwd = null) {
  if (!isValidServiceType(serviceType)) {
    return { success: false, error: 'Invalid service type' };
  }

  const service = getServiceType(serviceType);

  // For terminal tabs (Claude Code), use folder name as the tab name
  let customName = null;
  if (service.type === 'terminal' && cwd) {
    const folderName = path.basename(cwd);
    customName = folderName;
  }

  const tab = tabManager.createTab(serviceType, customName);

  // Store additional data for terminals
  if (service.type === 'terminal' && cwd) {
    const tabData = store.get('tabData', {});
    tabData[tab.id] = { cwd };
    store.set('tabData', tabData);
    tab.cwd = cwd;
    tab.mode = 'normal';
  }

  // Create view
  createViewForTab(tab);

  // Switch to new tab
  switchToTab(tab.id);

  // Notify sidebar
  mainWindow.webContents.send('tabs-updated', getTabsForRenderer());
  updateShortcuts();

  // Close service picker if open
  closeServicePicker();

  return { success: true, tabId: tab.id };
}

/**
 * Close a tab
 */
async function closeTab(tabId, skipConfirm = false) {
  const tab = tabManager.getTab(tabId);
  if (!tab) return;

  const serviceType = getServiceType(tab.serviceType);

  // Show confirmation for terminal tabs
  if (serviceType && serviceType.type === 'terminal' && !skipConfirm) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Close Tab', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Close Tab',
      message: `Close "${tab.name}"?`,
      detail: 'The session will be terminated. You can resume previous sessions when creating a new tab.'
    });

    if (response !== 0) return;
  }

  // Destroy view
  viewManager.destroyView(tabId);

  // Remove tab data
  const tabData = store.get('tabData', {});
  delete tabData[tabId];
  store.set('tabData', tabData);

  // Delete tab
  tabManager.deleteTab(tabId);

  // Switch to another tab or show picker
  if (!tabManager.hasTabs()) {
    showServicePicker(true);
  } else {
    const firstTab = tabManager.getTabAtIndex(0);
    if (firstTab) {
      switchToTab(firstTab.id);
    }
  }

  // Notify sidebar
  mainWindow.webContents.send('tabs-updated', getTabsForRenderer());
  updateShortcuts();
}

/**
 * Rename a tab
 */
function renameTab(tabId, newName) {
  const success = tabManager.renameTab(tabId, newName);
  if (success) {
    mainWindow.webContents.send('tabs-updated', getTabsForRenderer());
    // Update title if this is the active tab
    if (viewManager.getActiveTabId() === tabId) {
      mainWindow.setTitle(`${newName} - Cross AI Browser`);
    }
  }
  return success;
}

/**
 * Reorder tabs (drag and drop)
 */
function reorderTab(draggedTabId, targetTabId, position) {
  const success = tabManager.moveTabRelative(draggedTabId, targetTabId, position);
  if (success) {
    mainWindow.webContents.send('tabs-updated', getTabsForRenderer());
    updateShortcuts();
  }
  return success;
}

function registerShortcuts() {
  updateShortcuts();

  // Cycle through tabs with Cmd+] / Cmd+[
  globalShortcut.register('CommandOrControl+]', () => {
    const tabs = tabManager.getOrderedTabs();
    if (tabs.length === 0) return;

    const activeId = viewManager.getActiveTabId();
    const currentIndex = tabs.findIndex(t => t.id === activeId);
    const nextIndex = (currentIndex + 1) % tabs.length;
    switchToTab(tabs[nextIndex].id);
  });

  globalShortcut.register('CommandOrControl+[', () => {
    const tabs = tabManager.getOrderedTabs();
    if (tabs.length === 0) return;

    const activeId = viewManager.getActiveTabId();
    const currentIndex = tabs.findIndex(t => t.id === activeId);
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    switchToTab(tabs[prevIndex].id);
  });

  // Cmd+T to open service picker
  globalShortcut.register('CommandOrControl+T', () => {
    showServicePicker(false);
  });
}

function updateShortcuts() {
  // Unregister all numbered shortcuts
  for (let i = 1; i <= 9; i++) {
    globalShortcut.unregister(`CommandOrControl+${i}`);
  }

  // Re-register for current tabs
  const tabs = tabManager.getOrderedTabs();
  tabs.forEach((tab, index) => {
    if (index < 9) {
      globalShortcut.register(`CommandOrControl+${index + 1}`, () => {
        switchToTab(tab.id);
      });
    }
  });
}

// IPC handlers
ipcMain.on('switch-service', (event, tabId) => {
  switchToTab(tabId);
});

ipcMain.handle('get-services', () => {
  return Object.values(SERVICE_TYPES);
});

ipcMain.handle('get-active-service', () => {
  return viewManager ? viewManager.getActiveTabId() : null;
});

ipcMain.handle('get-all-tabs', () => {
  return getTabsForRenderer();
});

ipcMain.handle('get-completion-badges', () => {
  return Array.from(tabsWithCompletions);
});

ipcMain.on('reload-service', (event, tabId) => {
  const tab = tabManager.getTab(tabId);
  if (!tab) return;

  const serviceType = getServiceType(tab.serviceType);
  if (serviceType && serviceType.type === 'web') {
    viewManager.reloadWebView(tabId);
  }
});

ipcMain.on('go-back', (event, tabId) => {
  viewManager.goBack(tabId);
});

ipcMain.on('go-forward', (event, tabId) => {
  viewManager.goForward(tabId);
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return store.store;
});

ipcMain.on('set-setting', (event, key, value) => {
  // Validate setting keys
  const allowedKeys = ['notifications', 'notifications.enabled', 'notifications.mode', 'terminal.theme'];
  if (allowedKeys.includes(key)) {
    // Validate terminal theme
    if (key === 'terminal.theme' && !TerminalThemes.isValidTheme(value)) {
      return;
    }
    store.set(key, value);

    // Broadcast theme change to all terminal windows
    if (key === 'terminal.theme' && viewManager) {
      viewManager.broadcastToTerminals('terminal-theme-changed', value);
    }
  }
});

// Terminal theme handlers
ipcMain.handle('get-terminal-theme', () => {
  const themeId = store.get('terminal.theme', TerminalThemes.DEFAULT_THEME);
  return {
    id: themeId,
    theme: TerminalThemes.getTheme(themeId)
  };
});

ipcMain.handle('get-all-terminal-themes', () => {
  return TerminalThemes.getAllThemes();
});

let settingsView = null;
ipcMain.on('open-settings', () => {
  if (settingsView) {
    closeSettings();
    return;
  }

  settingsView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.addBrowserView(settingsView);

  // Position to fill content area (right of sidebar)
  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  settingsView.setBounds({
    x: SIDEBAR_WIDTH,
    y: 0,
    width: windowWidth - SIDEBAR_WIDTH,
    height: windowHeight
  });

  settingsView.webContents.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
});

function closeSettings() {
  if (settingsView && mainWindow) {
    mainWindow.removeBrowserView(settingsView);
    settingsView = null;
  }
}

ipcMain.on('close-settings', () => {
  closeSettings();
});

// Tab management handlers
ipcMain.handle('create-tab', async (event, serviceType) => {
  return createTab(serviceType);
});

ipcMain.handle('select-folder-and-create-tab', async (event, serviceType) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select folder for Claude Code'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0];
    return createTab(serviceType, folderPath);
  }

  return { success: false, cancelled: true };
});

ipcMain.on('close-service-picker', () => {
  closeServicePicker();
});

ipcMain.on('close-terminal', async (event, tabId) => {
  await closeTab(tabId);
});

ipcMain.on('close-tab', async (event, tabId) => {
  await closeTab(tabId);
});

ipcMain.handle('rename-tab', (event, tabId, newName) => {
  return renameTab(tabId, newName);
});

// Show rename dialog as a BrowserView overlay (like service picker)
let renameDialogView = null;
let renameDialogTabId = null;

ipcMain.handle('show-rename-dialog', async (event, tabId) => {
  const tab = tabManager.getTab(tabId);
  if (!tab) return null;

  if (renameDialogView) {
    return null;
  }

  renameDialogTabId = tabId;

  // Create as BrowserView (proven to work with IPC)
  renameDialogView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'rename-dialog-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.addBrowserView(renameDialogView);

  // Position to fill content area (right of sidebar)
  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  renameDialogView.setBounds({
    x: SIDEBAR_WIDTH,
    y: 0,
    width: windowWidth - SIDEBAR_WIDTH,
    height: windowHeight
  });

  // Load with tab data as query params
  const encodedName = encodeURIComponent(tab.name);
  renameDialogView.webContents.loadFile(
    path.join(__dirname, 'renderer', 'rename-dialog.html'),
    { query: { tabId, currentName: encodedName } }
  );

  return { success: true };
});

function closeRenameDialog() {
  if (renameDialogView && mainWindow) {
    mainWindow.removeBrowserView(renameDialogView);
    renameDialogView = null;
    renameDialogTabId = null;
  }
}

ipcMain.on('rename-dialog-submit', (event, tabId, newName) => {
  if (tabId && newName) {
    renameTab(tabId, newName);
  }
  closeRenameDialog();
});

ipcMain.on('rename-dialog-cancel', () => {
  closeRenameDialog();
});

ipcMain.on('reorder-tabs', (event, draggedTabId, targetTabId, position) => {
  reorderTab(draggedTabId, targetTabId, position);
});

// Native context menu for tabs
ipcMain.handle('show-tab-context-menu', async (event, tabId) => {
  const tab = tabManager.getTab(tabId);
  if (!tab) return null;

  return new Promise((resolve) => {
    const template = [
      {
        label: 'Rename',
        click: () => resolve('rename')
      },
      { type: 'separator' },
      {
        label: 'Close Tab',
        click: () => resolve('close')
      }
    ];

    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: mainWindow,
      callback: () => resolve(null)
    });
  });
});

// Show service picker (for add button)
ipcMain.on('show-service-picker', () => {
  showServicePicker(false);
});

// Legacy add-terminal handler (redirects to service picker)
ipcMain.handle('add-terminal', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select folder for Claude Code'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0];
    return createTab('claude-code', folderPath);
  }

  return { success: false };
});

// Terminal PTY communication
ipcMain.on('terminal-ready', (event, { terminalId }) => {
  viewManager.markTerminalReady(terminalId);
});

ipcMain.on('terminal-input', (event, { terminalId, data }) => {
  viewManager.handleTerminalInput(terminalId, data);
});

ipcMain.on('terminal-resize', (event, { terminalId, cols, rows }) => {
  const tab = tabManager.getTab(terminalId);
  if (!tab) {
    console.error(`terminal-resize: Tab ${terminalId} not found`);
    return;
  }

  // Try to get cwd from tab or from tabData store
  let cwd = tab.cwd;
  let mode = tab.mode || 'normal';

  if (!cwd) {
    const tabData = store.get('tabData', {});
    const data = tabData[terminalId];
    if (data && data.cwd) {
      cwd = data.cwd;
      tab.cwd = cwd; // Cache it on the tab object
      // When restoring from store, use continue mode
      if (!tab.mode) {
        mode = 'continue';
      }
    }
  }

  if (cwd) {
    viewManager.handleTerminalResize(terminalId, cols, rows, cwd, mode);
    // Clear mode after first use
    tab.mode = 'normal';
  } else {
    viewManager.handleTerminalResize(terminalId, cols, rows);
  }
});

ipcMain.on('terminal-reload', (event, { terminalId }) => {
  const tab = tabManager.getTab(terminalId);
  if (!tab) {
    console.error(`terminal-reload: Tab ${terminalId} not found`);
    return;
  }

  // Try to get cwd from tab or from tabData store
  let cwd = tab.cwd;
  if (!cwd) {
    const tabData = store.get('tabData', {});
    const data = tabData[terminalId];
    if (data && data.cwd) {
      cwd = data.cwd;
      tab.cwd = cwd; // Cache it on the tab object
    }
  }

  if (cwd) {
    viewManager.reloadTerminal(terminalId, cwd);
  } else {
    console.error(`terminal-reload: No cwd for tab ${terminalId}`);
    // Send error to terminal UI
    viewManager.sendTerminalMessage(terminalId, '\x1b[31mError: No working directory configured. Please close this tab and create a new one.\x1b[0m\r\n');
  }
});

ipcMain.on('terminal-resume', (event, { terminalId }) => {
  const tab = tabManager.getTab(terminalId);
  if (!tab) {
    console.error(`terminal-resume: Tab ${terminalId} not found`);
    return;
  }

  // Try to get cwd from tab or from tabData store
  let cwd = tab.cwd;
  if (!cwd) {
    const tabData = store.get('tabData', {});
    const data = tabData[terminalId];
    if (data && data.cwd) {
      cwd = data.cwd;
      tab.cwd = cwd; // Cache it on the tab object
    }
  }

  if (cwd) {
    viewManager.resumeTerminal(terminalId, cwd);
  } else {
    console.error(`terminal-resume: No cwd for tab ${terminalId}`);
    // Send error to terminal UI
    viewManager.sendTerminalMessage(terminalId, '\x1b[31mError: No working directory configured. Please close this tab and create a new one.\x1b[0m\r\n');
  }
});

ipcMain.on('terminal-close', (event, { terminalId }) => {
  closeTab(terminalId, true);
});

ipcMain.on('terminal-request-usage', async (event, { terminalId }) => {
  viewManager.requestUsageData(terminalId);
});

// Save clipboard image to temp file for terminal paste
ipcMain.handle('terminal-save-clipboard-image', async (event, { terminalId, imageBuffer }) => {
  try {
    const os = require('os');
    const tempDir = os.tmpdir();
    const timestamp = Date.now();
    const imagePath = path.join(tempDir, `claude-paste-${timestamp}.png`);

    // imageBuffer comes as an ArrayBuffer, convert to Buffer
    const buffer = Buffer.from(imageBuffer);
    await fs.promises.writeFile(imagePath, buffer);

    return { success: true, path: imagePath };
  } catch (err) {
    console.error('Failed to save clipboard image:', err);
    return { success: false, error: err.message };
  }
});

// Download management handlers
// Helper to validate download ID
function isValidDownloadId(id) {
  return typeof id === 'string' && id.length > 0;
}

ipcMain.handle('get-downloads', () => {
  if (!downloadManager) return { active: [], history: [] };
  return {
    active: downloadManager.getActiveDownloads(),
    history: downloadManager.getDownloadHistory(20)
  };
});

ipcMain.handle('pause-download', (event, downloadId) => {
  if (!downloadManager || !isValidDownloadId(downloadId)) return false;
  return downloadManager.pauseDownload(downloadId);
});

ipcMain.handle('resume-download', (event, downloadId) => {
  if (!downloadManager || !isValidDownloadId(downloadId)) return false;
  return downloadManager.resumeDownload(downloadId);
});

ipcMain.handle('cancel-download', (event, downloadId) => {
  if (!downloadManager || !isValidDownloadId(downloadId)) return false;
  return downloadManager.cancelDownload(downloadId);
});

ipcMain.handle('remove-download', (event, downloadId) => {
  if (!downloadManager || !isValidDownloadId(downloadId)) return false;
  return downloadManager.removeFromHistory(downloadId);
});

ipcMain.handle('clear-download-history', () => {
  if (!downloadManager) return;
  downloadManager.clearHistory();
});

ipcMain.handle('open-download', (event, downloadId) => {
  if (!downloadManager || !isValidDownloadId(downloadId)) return false;
  return downloadManager.openDownload(downloadId);
});

ipcMain.handle('show-download-in-folder', (event, downloadId) => {
  if (!downloadManager || !isValidDownloadId(downloadId)) return false;
  return downloadManager.showInFolder(downloadId);
});

ipcMain.handle('get-download-save-mode', () => {
  if (!downloadManager) return 'ask';
  return downloadManager.getSaveMode();
});

ipcMain.handle('set-download-save-mode', (event, mode) => {
  if (!downloadManager) return false;
  try {
    downloadManager.setSaveMode(mode);
    return true;
  } catch (err) {
    console.error('Failed to set download save mode:', err);
    return false;
  }
});

// History management handlers
ipcMain.handle('get-history-sessions', (event, options = {}) => {
  if (!historyManager) return [];
  return historyManager.getAllSessions(options);
});

ipcMain.handle('get-history-sessions-for-cwd', (event, cwd, limit = 20) => {
  if (!historyManager) return [];
  return historyManager.getSessionsForCwd(cwd, limit);
});

ipcMain.handle('get-history-session', (event, sessionId) => {
  if (!historyManager) return null;
  return historyManager.getSessionById(sessionId);
});

ipcMain.handle('read-history-session', async (event, sessionId) => {
  if (!historyManager) return null;
  try {
    return await historyManager.readSession(sessionId);
  } catch (err) {
    console.error(`Failed to read session ${sessionId}:`, err);
    return null;
  }
});

ipcMain.handle('delete-history-session', async (event, sessionId) => {
  if (!historyManager) return false;
  try {
    return await historyManager.deleteSession(sessionId);
  } catch (err) {
    console.error(`Failed to delete session ${sessionId}:`, err);
    return false;
  }
});

ipcMain.handle('export-history-session', async (event, sessionId) => {
  if (!historyManager || !mainWindow) return { success: false };

  const session = historyManager.getSessionById(sessionId);
  if (!session) return { success: false, error: 'Session not found' };

  // Generate default filename
  const date = new Date(session.timestamp);
  const dateStr = date.toISOString().slice(0, 10);
  const defaultName = `${session.cwdName || 'session'}-${dateStr}.txt`;

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled) {
    return { success: false, cancelled: true };
  }

  try {
    await historyManager.exportSession(sessionId, result.filePath);
    return { success: true, filePath: result.filePath };
  } catch (err) {
    console.error(`Failed to export session ${sessionId}:`, err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-history-settings', () => {
  if (!historyManager) return null;
  return historyManager.getRetentionSettings();
});

ipcMain.handle('update-history-settings', (event, settings) => {
  if (!historyManager) return false;
  try {
    historyManager.updateRetentionSettings(settings);
    return true;
  } catch (err) {
    console.error('Failed to update history settings:', err);
    return false;
  }
});

ipcMain.handle('get-history-stats', () => {
  if (!historyManager) return null;
  return historyManager.getStorageStats();
});

ipcMain.handle('clear-history', async () => {
  if (!historyManager) return false;
  try {
    await historyManager.clearAllHistory();
    return true;
  } catch (err) {
    console.error('Failed to clear history:', err);
    return false;
  }
});

ipcMain.handle('is-history-enabled', () => {
  if (!historyManager) return false;
  return historyManager.isEnabled();
});

// Streaming state handler from webviews
ipcMain.on('ai-streaming-state', (event, data) => {
  const { serviceId, isStreaming, taskDescription } = data;

  // Find the tab that sent this (webviews send serviceId as their tab type, not tab ID)
  // We need to find which tab's webContents sent this event
  const senderWebContents = event.sender;

  // Find the tab ID by matching the webContents
  let tabId = null;
  if (viewManager) {
    tabId = viewManager.getTabIdByWebContents(senderWebContents);
  }

  if (!tabId) {
    // Fallback: use serviceId if we can't find the tab
    tabId = serviceId;
  }

  // Forward streaming state to sidebar
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('streaming-state-changed', {
      tabId,
      isStreaming,
      taskDescription
    });
  }
});

// Notification handler from webviews
ipcMain.on('ai-response-complete', (event, data) => {
  const { serviceId, preview } = data;

  // Find the tab that sent this by matching webContents
  const senderWebContents = event.sender;
  let tabId = null;
  if (viewManager) {
    tabId = viewManager.getTabIdByWebContents(senderWebContents);
  }

  // Fallback to serviceId if we can't find by webContents
  if (!tabId) {
    tabId = serviceId;
  }

  const tab = tabManager.getTab(tabId);
  if (!tab) {
    console.log('[Main] ai-response-complete: Could not find tab for', tabId);
    return;
  }

  const serviceType = getServiceType(tab.serviceType);
  if (!serviceType) return;

  // Always mark tab as completed for badge (if not active)
  markTabCompleted(tabId);

  const settings = store.get('notifications');
  if (!settings.enabled) return;

  // Check notification mode
  const shouldNotify = (() => {
    switch (settings.mode) {
      case 'always':
        return true;
      case 'unfocused':
        return !mainWindow.isFocused();
      case 'inactive-tab':
        return viewManager.getActiveTabId() !== tabId;
      default:
        return true;
    }
  })();

  if (!shouldNotify) return;

  const title = `${tab.name} finished`;
  const body = preview || 'Response complete';

  const notification = new Notification({
    title: title,
    body: body,
    silent: false
  });

  notification.on('click', () => {
    switchToTab(serviceId);
    mainWindow.show();
    mainWindow.focus();
  });

  notification.show();
});

function createMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => showServicePicker(false)
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => {
            const activeTabId = viewManager?.getActiveTabId();
            if (activeTabId) {
              closeTab(activeTabId);
            }
          }
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Open DevTools',
          accelerator: 'CmdOrCtrl+Option+I',
          click: () => {
            const activeTabId = viewManager?.getActiveTabId();
            if (activeTabId) {
              viewManager.openDevTools(activeTabId);
            }
          }
        },
        {
          label: 'Open Sidebar DevTools',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.openDevTools();
            }
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// App lifecycle
app.whenReady().then(() => {
  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    const iconPath = path.join(__dirname, '..', 'assets', 'icon.icns');
    try {
      app.dock.setIcon(iconPath);
    } catch (e) {
      // Icon may not exist in dev
    }
  }

  createMenu();
  createWindow();
  registerShortcuts();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
