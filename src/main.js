const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, Notification, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('electron-store');

// Import core modules
const { SERVICE_TYPES, getServiceType, isValidServiceType } = require('./core/ServiceRegistry');
const TabManager = require('./core/TabManager');
const ViewManager = require('./core/ViewManager');

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
    tabData: {} // Additional tab data (cwd for terminals)
  }
});

const SIDEBAR_WIDTH = 160;

let mainWindow = null;
let tabManager = null;
let viewManager = null;
let servicePickerWindow = null;

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

  // Initialize ViewManager
  viewManager = new ViewManager({
    mainWindow,
    store,
    onTabsChanged: () => {
      mainWindow.webContents.send('tabs-updated', getTabsForRenderer());
      updateShortcuts();
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

  pickerView.webContents.loadFile(
    path.join(__dirname, 'renderer', 'service-picker.html'),
    { query: isFirstTime ? { firstTime: 'true' } : {} }
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
  const allowedKeys = ['notifications', 'notifications.enabled', 'notifications.mode'];
  if (allowedKeys.includes(key)) {
    store.set(key, value);
  }
});

let settingsWindow = null;
ipcMain.on('open-settings', () => {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  const { x, y } = mainWindow.getBounds();
  settingsWindow = new BrowserWindow({
    width: 280,
    height: 200,
    x: x + 70,
    y: y + mainWindow.getBounds().height - 250,
    parent: mainWindow,
    modal: false,
    frame: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'sidebar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });

  settingsWindow.on('blur', () => {
    if (settingsWindow) {
      settingsWindow.close();
    }
  });
});

// Tab management handlers
ipcMain.handle('create-tab', async (event, serviceType) => {
  return createTab(serviceType);
});

ipcMain.handle('select-folder-and-create-tab', async (event, serviceType) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
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
    properties: ['openDirectory'],
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
  if (tab && tab.cwd) {
    viewManager.handleTerminalResize(terminalId, cols, rows, tab.cwd, tab.mode || 'normal');
    // Clear mode after first use
    tab.mode = 'normal';
  } else {
    viewManager.handleTerminalResize(terminalId, cols, rows);
  }
});

ipcMain.on('terminal-reload', (event, { terminalId }) => {
  const tab = tabManager.getTab(terminalId);
  if (tab && tab.cwd) {
    viewManager.reloadTerminal(terminalId, tab.cwd);
  }
});

ipcMain.on('terminal-resume', (event, { terminalId }) => {
  const tab = tabManager.getTab(terminalId);
  if (tab && tab.cwd) {
    viewManager.resumeTerminal(terminalId, tab.cwd);
  }
});

ipcMain.on('terminal-close', (event, { terminalId }) => {
  closeTab(terminalId, true);
});

ipcMain.on('terminal-request-usage', async (event, { terminalId }) => {
  viewManager.requestUsageData(terminalId);
});

// Notification handler from webviews
ipcMain.on('ai-response-complete', (event, data) => {
  const settings = store.get('notifications');
  if (!settings.enabled) return;

  const { serviceId, preview } = data;

  // Find tab by service type or ID
  const tab = tabManager.getTab(serviceId);
  if (!tab) return;

  const serviceType = getServiceType(tab.serviceType);
  if (!serviceType) return;

  // Check notification mode
  const shouldNotify = (() => {
    switch (settings.mode) {
      case 'always':
        return true;
      case 'unfocused':
        return !mainWindow.isFocused();
      case 'inactive-tab':
        return viewManager.getActiveTabId() !== serviceId;
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
