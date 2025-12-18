const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, Notification, Menu } = require('electron');
const path = require('path');
const Store = require('electron-store');

// Set app name (shown in menu bar)
app.setName('Cross AI Browser');

// Initialize settings store
const store = new Store({
  defaults: {
    notifications: {
      enabled: true,
      mode: 'always' // 'always', 'unfocused', 'inactive-tab'
    }
  }
});

// AI Services configuration
const AI_SERVICES = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chat.openai.com',
    shortcut: 'CommandOrControl+1'
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    shortcut: 'CommandOrControl+2'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    shortcut: 'CommandOrControl+3'
  }
];

const SIDEBAR_WIDTH = 60;

let mainWindow = null;
let browserViews = {};
let activeServiceId = null;

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

  // Create BrowserViews for each AI service
  AI_SERVICES.forEach(service => {
    createBrowserView(service);
  });

  // Set default active service
  switchToService(AI_SERVICES[0].id);

  // Handle window resize
  mainWindow.on('resize', updateViewBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createBrowserView(service) {
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'webview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: `persist:${service.id}`,
      // Enable features needed for AI chat sites
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  browserViews[service.id] = view;

  // Set custom user agent to avoid detection issues
  const userAgent = view.webContents.getUserAgent().replace(/Electron\/\S+ /, '');
  view.webContents.setUserAgent(userAgent);

  // Load the service URL
  view.webContents.loadURL(service.url);

  // Handle new window requests (e.g., OAuth popups)
  view.webContents.setWindowOpenHandler(({ url }) => {
    // Allow OAuth and auth-related popups
    if (url.includes('accounts.google.com') ||
        url.includes('auth0.com') ||
        url.includes('login') ||
        url.includes('oauth') ||
        url.includes('signin')) {
      return { action: 'allow' };
    }
    // Open other links in default browser
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });
}

function updateViewBounds() {
  if (!mainWindow) return;

  const [width, height] = mainWindow.getContentSize();
  const viewBounds = {
    x: SIDEBAR_WIDTH,
    y: 0,
    width: width - SIDEBAR_WIDTH,
    height: height
  };

  Object.values(browserViews).forEach(view => {
    view.setBounds(viewBounds);
  });
}

function switchToService(serviceId) {
  if (!browserViews[serviceId] || activeServiceId === serviceId) return;

  // Remove current view
  if (activeServiceId && browserViews[activeServiceId]) {
    mainWindow.removeBrowserView(browserViews[activeServiceId]);
  }

  // Add new view
  mainWindow.addBrowserView(browserViews[serviceId]);
  activeServiceId = serviceId;

  updateViewBounds();

  // Notify sidebar of active service change
  mainWindow.webContents.send('active-service-changed', serviceId);
}

function registerShortcuts() {
  AI_SERVICES.forEach(service => {
    globalShortcut.register(service.shortcut, () => {
      switchToService(service.id);
    });
  });

  // Cycle through services with Cmd+Tab style
  globalShortcut.register('CommandOrControl+]', () => {
    const currentIndex = AI_SERVICES.findIndex(s => s.id === activeServiceId);
    const nextIndex = (currentIndex + 1) % AI_SERVICES.length;
    switchToService(AI_SERVICES[nextIndex].id);
  });

  globalShortcut.register('CommandOrControl+[', () => {
    const currentIndex = AI_SERVICES.findIndex(s => s.id === activeServiceId);
    const prevIndex = (currentIndex - 1 + AI_SERVICES.length) % AI_SERVICES.length;
    switchToService(AI_SERVICES[prevIndex].id);
  });
}

// IPC handlers
ipcMain.on('switch-service', (event, serviceId) => {
  switchToService(serviceId);
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

ipcMain.handle('get-services', () => {
  return AI_SERVICES;
});

ipcMain.handle('get-active-service', () => {
  return activeServiceId;
});

ipcMain.on('reload-service', (event, serviceId) => {
  if (browserViews[serviceId]) {
    browserViews[serviceId].webContents.reload();
  }
});

ipcMain.on('go-back', (event, serviceId) => {
  if (browserViews[serviceId] && browserViews[serviceId].webContents.canGoBack()) {
    browserViews[serviceId].webContents.goBack();
  }
});

ipcMain.on('go-forward', (event, serviceId) => {
  if (browserViews[serviceId] && browserViews[serviceId].webContents.canGoForward()) {
    browserViews[serviceId].webContents.goForward();
  }
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return store.store;
});

ipcMain.on('set-setting', (event, key, value) => {
  store.set(key, value);
});

// Notification handler from webviews
ipcMain.on('ai-response-complete', (event, data) => {
  const settings = store.get('notifications');
  if (!settings.enabled) return;

  const { serviceId, preview } = data;
  const service = AI_SERVICES.find(s => s.id === serviceId);
  if (!service) return;

  // Check notification mode
  const shouldNotify = (() => {
    switch (settings.mode) {
      case 'always':
        return true;
      case 'unfocused':
        return !mainWindow.isFocused();
      case 'inactive-tab':
        return activeServiceId !== serviceId;
      default:
        return true;
    }
  })();

  if (!shouldNotify) return;

  const title = `${service.name} finished`;
  const body = preview || 'Response complete';

  const notification = new Notification({
    title: title,
    body: body,
    silent: false
  });

  notification.on('click', () => {
    switchToService(serviceId);
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
            if (activeServiceId && browserViews[activeServiceId]) {
              browserViews[activeServiceId].webContents.openDevTools();
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
