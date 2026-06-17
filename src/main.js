const { app, BrowserWindow, WebContentsView, ipcMain, globalShortcut, Notification, Menu, dialog, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('electron-store');

// Handle EPIPE errors on stdout/stderr (occurs when parent process closes pipe)
process.stdout?.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// Import core modules
const { SERVICE_TYPES, getServiceType, isValidServiceType, isTerminalAvailable } = require('./core/ServiceRegistry');
const TabManager = require('./core/TabManager');
const ViewManager = require('./core/ViewManager');
const DownloadManager = require('./core/DownloadManager');
const HistoryManager = require('./core/HistoryManager');
const PromptLibraryManager = require('./core/PromptLibraryManager');
const PromptImageManager = require('./core/PromptImageManager');
const TerminalThemes = require('./core/TerminalThemes');
const HooksManager = require('./core/HooksManager');
const McpPromptServer = require('./core/McpPromptServer');
const FirebaseSyncAdapter = require('./core/FirebaseSyncAdapter');
const SecretsManager = require('./core/SecretsManager');
const MarkdownFilesManager = require('./core/MarkdownFilesManager');

// Firebase configuration (hardcoded for prompt-library-pwa project)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCb1dAdSm_Xx3y1qDuMB3xSgO9Zd_FG6nQ",
  authDomain: "prompt-library-pwa.firebaseapp.com",
  projectId: "prompt-library-pwa",
  storageBucket: "prompt-library-pwa.firebasestorage.app",
  messagingSenderId: "636149115447",
  appId: "1:636149115447:web:d51e36784660a22ee0adb2"
};

// Set app name (shown in menu bar)
app.setName('Cross AI Browser');

/**
 * Sanitize text for use in notifications
 * Removes HTML tags, control characters, and normalizes whitespace
 */
function sanitizeNotificationText(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    // Remove HTML tags
    .replace(/<[^>]*>/g, '')
    // Remove control characters (except newline/space)
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    // Trim
    .trim()
    // Limit length
    .slice(0, 200);
}

// Initialize settings store
const store = new Store({
  defaults: {
    notifications: {
      enabled: true,
      mode: 'always', // 'always', 'unfocused', 'inactive-tab'
      soundComplete: 'crossai-chime', // sound for task finished (Stop/TaskCompleted)
      soundAttention: 'crossai-pulse' // sound for needs attention (permission, idle, question)
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
let hooksManager = null;
let promptLibraryManager = null;
let promptImageManager = null;
let secretsManager = null;
let firebaseSyncAdapter = null;
let mcpPromptServer = null;
let settingsView = null;
let settingsActive = false;
let servicePickerWindow = null;

// Markdown files: one manager (+ recursive watcher) per cwd, created lazily when
// a terminal first lists files. The watcher broadcasts change events to every
// terminal sharing that cwd.
const markdownManagers = new Map(); // cwd -> MarkdownFilesManager

function ensureMarkdownManager(cwd) {
  if (!cwd) return null;
  let mgr = markdownManagers.get(cwd);
  if (!mgr) {
    mgr = new MarkdownFilesManager(cwd, { trash: (p) => shell.trashItem(p) });
    mgr.watch(() => {
      viewManager.broadcastToTerminalsWithCwd(cwd, 'markdown-files-changed', {});
    });
    markdownManagers.set(cwd, mgr);
  }
  return mgr;
}

function releaseMarkdownManagerIfUnused(cwd) {
  if (!cwd) return;
  const tabData = store.get('tabData', {});
  const stillUsed = Object.values(tabData).some(d => d && d.cwd === cwd);
  if (!stillUsed) {
    const mgr = markdownManagers.get(cwd);
    if (mgr) { mgr.unwatch(); markdownManagers.delete(cwd); }
  }
}

function releaseAllMarkdownManagers() {
  for (const mgr of markdownManagers.values()) mgr.unwatch();
  markdownManagers.clear();
}

// Track tabs with unread completions and attention requests (for badge display)
const tabsWithCompletions = new Set();
const tabsNeedingAttention = new Set();

// Notify sidebar of badge changes
function sendBadges() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('completion-badges-updated', Array.from(tabsWithCompletions));
    mainWindow.webContents.send('attention-badges-updated', Array.from(tabsNeedingAttention));
  }
}

// Mark a tab as having an unread completion (green dot)
function markTabCompleted(tabId) {
  const activeTabId = viewManager?.getActiveTabId();
  const isWindowFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();

  if (tabId !== activeTabId || !isWindowFocused) {
    tabsWithCompletions.add(tabId);
    sendBadges();
  }
}

// Mark a tab as needing attention (yellow dot) — overrides green
function markTabNeedsAttention(tabId) {
  const activeTabId = viewManager?.getActiveTabId();
  const isWindowFocused = mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused();

  if (tabId !== activeTabId || !isWindowFocused) {
    tabsNeedingAttention.add(tabId);
    // Remove from completions since attention overrides it
    tabsWithCompletions.delete(tabId);
    sendBadges();
  }
}

// Clear all badges for a tab
function clearTabBadges(tabId) {
  let changed = false;
  if (tabsWithCompletions.has(tabId)) {
    tabsWithCompletions.delete(tabId);
    changed = true;
  }
  if (tabsNeedingAttention.has(tabId)) {
    tabsNeedingAttention.delete(tabId);
    changed = true;
  }
  if (changed) sendBadges();
}

// Note: Terminal hook completion is now handled entirely through ViewManager's
// onTerminalComplete callback, which handles Stop and Notification events

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 2048,
    height: 1152,
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

  // Initialize HooksManager for Claude Code hooks integration
  hooksManager = new HooksManager({ store });
  hooksManager.initialize().then(result => {
    if (result.success) {
      console.log(`[Main] HooksManager started on port ${result.port}`);
    } else {
      console.error('[Main] Failed to start HooksManager:', result.error);
    }
  });

  // Note: All hook events (Stop, Notification, TaskCompleted) are handled by
  // ViewManager which calls onTerminalComplete with (tabId, message, event)

  // Initialize PromptLibraryManager
  promptLibraryManager = new PromptLibraryManager({
    store,
    userDataPath: app.getPath('userData')
  });

  // Initialize PromptImageManager
  promptImageManager = new PromptImageManager(app.getPath('userData'));

  // Initialize SecretsManager (encrypted env vars for terminals)
  secretsManager = new SecretsManager({ userDataPath: app.getPath('userData') });

  // Initialize MCP Prompt Server for Claude Code integration
  mcpPromptServer = new McpPromptServer({
    promptLibraryManager,
    promptImageManager,
    store
  });
  mcpPromptServer.start().then(result => {
    if (result.success) {
      console.log(`[Main] McpPromptServer started on port ${result.port}`);
    } else {
      console.error('[Main] Failed to start McpPromptServer:', result.error);
    }
  });

  // Initialize FirebaseSyncAdapter for cloud sync
  firebaseSyncAdapter = new FirebaseSyncAdapter({
    store,
    promptLibraryManager,
    promptImageManager,
    userDataPath: app.getPath('userData')
  });

  // Initialize Firebase and restore session if credentials exist
  firebaseSyncAdapter.initialize(FIREBASE_CONFIG).then(async (result) => {
    if (result.success) {
      console.log('[Main] FirebaseSyncAdapter initialized');

      // Try to restore previous session
      const restoreResult = await firebaseSyncAdapter.restoreSession();
      if (restoreResult.success) {
        console.log('[Main] Firebase session restored for', restoreResult.user.email);
      }
    } else {
      console.error('[Main] Failed to initialize Firebase:', result.error);
    }
  });

  // Forward Firebase sync events to settings view
  firebaseSyncAdapter.on('migration-started', () => {
    if (settingsView && settingsView.webContents) {
      settingsView.webContents.send('firebase-sync-status', { type: 'syncing' });
    }
  });

  firebaseSyncAdapter.on('migration-complete', (data) => {
    if (settingsView && settingsView.webContents) {
      settingsView.webContents.send('firebase-sync-status', {
        type: 'migration-complete',
        ...data
      });
    }
  });

  // Queue for processing remote changes sequentially (prevents race conditions)
  const remoteSyncQueue = [];
  let isProcessingRemoteSync = false;

  async function processRemoteSyncQueue() {
    if (isProcessingRemoteSync || remoteSyncQueue.length === 0) return;
    isProcessingRemoteSync = true;

    while (remoteSyncQueue.length > 0) {
      const task = remoteSyncQueue.shift();
      try {
        await task();
      } catch (err) {
        console.error('[Main] Error processing remote sync task:', err.message);
      }
    }

    isProcessingRemoteSync = false;
  }

  // Handle real-time prompt changes from Firebase (e.g., from PWA)
  let remoteSyncAppliedCount = 0;
  let remoteSyncLogTimer = null;

  firebaseSyncAdapter.on('remote-prompt-changed', (remotePrompt) => {
    // Add to queue instead of processing immediately
    remoteSyncQueue.push(async () => {
      if (!promptLibraryManager) return;

      const { id, projectId, scope, type, title, prompt, labels, images, isFavorite, reusable, done, testing, order } = remotePrompt;

      // Resolve projectId to cwd
      const cwd = await firebaseSyncAdapter.resolveProjectIdToCwd(projectId);
      if (!cwd) return;

      // Check if this prompt already exists locally
      const existingPrompt = promptLibraryManager.getPromptById(cwd, id);

      const promptData = {
        id,
        type: type === 'note' ? 'note' : 'prompt',
        title: title || '',
        prompt: prompt || '',
        labels: labels || [],
        images: images || [],
        isFavorite: isFavorite || false,
        reusable: reusable || false,
        done: done || false,
        testing: testing || false,
        scope: scope || 'project',
        order: order || 0
      };

      if (existingPrompt) {
        await promptLibraryManager.updatePromptFromRemote(cwd, id, promptData);
      } else {
        await promptLibraryManager.createPromptFromRemote(cwd, promptData);
      }

      // Fire-and-forget download of any referenced images not present locally.
      for (const img of promptData.images) {
        if (img?.id && !promptImageManager.hasLocalImage(img.id)) {
          firebaseSyncAdapter.downloadImageFromStorage(img.id, img.filename).catch(() => {});
        }
      }

      // Batch log applied changes
      remoteSyncAppliedCount++;
      clearTimeout(remoteSyncLogTimer);
      remoteSyncLogTimer = setTimeout(() => {
        console.log(`[Main] Applied ${remoteSyncAppliedCount} remote prompt change(s)`);
        remoteSyncAppliedCount = 0;
      }, 500);
    });

    // Start processing queue
    processRemoteSyncQueue();
  });

  // Apply remote label registry changes locally
  firebaseSyncAdapter.on('remote-labels-changed', ({ labels, labelColors }) => {
    if (!promptLibraryManager) return;
    const localLabels = promptLibraryManager.getLabels();
    const localColors = promptLibraryManager.getLabelColors();
    // If already matching, skip to avoid sync loops.
    const sameList = localLabels.length === labels.length &&
      localLabels.every((l, i) => l === labels[i]);
    const sameColors = JSON.stringify(localColors) === JSON.stringify(labelColors);
    if (sameList && sameColors) return;
    promptLibraryManager.applyRemoteLabels(labels, labelColors);
  });

  // Push local label registry changes to Firebase
  promptLibraryManager.on('labels-updated', ({ labels, labelColors }) => {
    if (!firebaseSyncAdapter || !firebaseSyncAdapter.isSyncEnabled()) return;
    firebaseSyncAdapter.pushLabelsToFirebase(labels, labelColors).catch(() => {});
  });

  firebaseSyncAdapter.on('remote-prompt-deleted', ({ id }) => {
    console.log('[Main] Queued remote-prompt-deleted:', id);

    // Add to queue instead of processing immediately
    remoteSyncQueue.push(async () => {
      if (!promptLibraryManager) return;

      const deleted = await promptLibraryManager.deletePromptById(id);
      if (deleted) {
        console.log('[Main] Deleted prompt from remote:', id);
      }
    });

    // Start processing queue
    processRemoteSyncQueue();
  });

  // Forward prompt library events to relevant terminals
  promptLibraryManager.on('prompts-updated', (data) => {
    const { cwd, prompts } = data;
    // Broadcast to all terminal views that have this cwd
    if (viewManager) {
      viewManager.broadcastToTerminalsWithCwd(cwd, 'prompt-library-updated', { prompts });
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
    onTerminalComplete: (tabId, message, event) => {
      // Handle terminal task completion notification
      const tab = tabManager.getTab(tabId);
      if (!tab) return;

      // Mark tab with appropriate badge
      const isAttention = event && event.type === 'Notification';
      if (isAttention) {
        markTabNeedsAttention(tabId);
      } else {
        markTabCompleted(tabId);
      }

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

      // Determine notification title/body based on hook event type
      let title, body;
      if (event && event.type === 'Notification') {
        // Notification hook - differentiate by notificationType
        switch (event.notificationType) {
          case 'permission_prompt':
            title = `${tab.name} needs permission`;
            break;
          case 'idle_prompt':
            title = `${tab.name} is waiting`;
            break;
          case 'elicitation_dialog':
            title = `${tab.name} has a question`;
            break;
          default:
            title = event.title ? `${tab.name}: ${event.title}` : `${tab.name} needs attention`;
            break;
        }
        body = sanitizeNotificationText(message) || 'Claude needs your input';
      } else {
        // Stop or TaskCompleted - task finished
        title = `${tab.name} finished`;
        body = sanitizeNotificationText(message) || 'Task completed';
      }

      const soundSetting = isAttention
        ? store.get('notifications.soundAttention', 'crossai-pulse')
        : store.get('notifications.soundComplete', 'crossai-chime');
      const notification = new Notification({
        title: title,
        body: body,
        silent: soundSetting === 'none',
        sound: soundSetting !== 'none' ? soundSetting : undefined
      });

      notification.on('click', () => {
        switchToTab(tabId);
        mainWindow.show();
        mainWindow.focus();
      });

      notification.show();
    },
    historyManager,
    hooksManager,
    firebaseSyncAdapter,
    secretsManager
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
    // Also resize settings view if open
    if (settingsView) {
      const [width, height] = mainWindow.getContentSize();
      settingsView.setBounds({
        x: SIDEBAR_WIDTH,
        y: 0,
        width: width - SIDEBAR_WIDTH,
        height: height
      });
    }
  });

  // Auto-focus the active view when window gains focus
  mainWindow.on('focus', () => {
    viewManager.focusActiveView();
    // Clear completion badge for the active tab (it was set while window was unfocused)
    const activeTabId = viewManager.getActiveTabId();
    if (activeTabId) {
      clearTabBadges(activeTabId);
    }
  });

  mainWindow.on('closed', () => {
    viewManager.destroy();
    if (settingsView) {
      try { settingsView.webContents.close(); } catch (e) { /* already closed */ }
      settingsView = null;
    }
    if (downloadManager) {
      downloadManager.destroy();
      downloadManager = null;
    }
    if (historyManager) {
      historyManager.destroy();
      historyManager = null;
    }
    if (hooksManager) {
      hooksManager.destroy();
      hooksManager = null;
    }
    if (mcpPromptServer) {
      mcpPromptServer.stop();
      mcpPromptServer = null;
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
 * Get archived tabs formatted for renderer
 */
function getArchivedTabsForRenderer() {
  return tabManager.getArchivedTabs().map(tab => {
    const serviceType = getServiceType(tab.serviceType);
    return {
      id: tab.id,
      serviceType: tab.serviceType,
      name: tab.name,
      type: serviceType ? serviceType.type : 'web'
    };
  });
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

  // Hide settings view if it's active
  if (settingsActive && settingsView) {
    mainWindow.contentView.removeChildView(settingsView);
    settingsActive = false;
    mainWindow.webContents.send('settings-active-changed', false);
  }

  // Ensure view exists
  if (!viewManager.hasView(tabId)) {
    createViewForTab(tab);
  }

  viewManager.switchToTab(tabId);

  // Clear completion badge for this tab
  clearTabBadges(tabId);

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

  // Create service picker as a WebContentsView that fills the content area
  const pickerView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'service-picker-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  servicePickerWindow = pickerView; // Store reference (reusing variable name)
  mainWindow.contentView.addChildView(pickerView);

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
    mainWindow.contentView.removeChildView(servicePickerWindow);
    try { servicePickerWindow.webContents.close(); } catch (e) { /* already closed */ }
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
  viewManager.focusActiveView();
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

ipcMain.handle('get-attention-badges', () => {
  return Array.from(tabsNeedingAttention);
});

ipcMain.handle('get-running-terminals', () => {
  return viewManager.getRunningTerminals();
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
  const allowedKeys = ['notifications', 'notifications.enabled', 'notifications.mode', 'notifications.soundComplete', 'notifications.soundAttention', 'terminal.theme'];
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

// Notification sound handlers
ipcMain.handle('get-notification-sounds', () => {
  const custom = [
    { id: 'crossai-chime', name: 'Cross AI Chime', category: 'custom' },
    { id: 'crossai-bell', name: 'Cross AI Bell', category: 'custom' },
    { id: 'crossai-pulse', name: 'Cross AI Pulse', category: 'custom' },
  ];
  let system = [];
  const systemSoundsDir = '/System/Library/Sounds';
  try {
    system = fs.readdirSync(systemSoundsDir)
      .filter(f => f.endsWith('.aiff'))
      .map(f => ({ id: f.replace('.aiff', ''), name: f.replace('.aiff', ''), category: 'system' }));
  } catch (e) {
    // System sounds dir may not be accessible
  }
  return { custom, system };
});

ipcMain.handle('preview-notification-sound', (event, soundName) => {
  if (typeof soundName !== 'string' || !soundName || /[/\\]/.test(soundName)) return;
  const { execFile } = require('child_process');
  const userSound = path.join(app.getPath('home'), 'Library', 'Sounds', soundName + '.aiff');
  const systemSound = '/System/Library/Sounds/' + soundName + '.aiff';
  const soundPath = fs.existsSync(userSound) ? userSound : systemSound;
  if (fs.existsSync(soundPath)) {
    execFile('afplay', [soundPath]);
  }
});

// Firebase Cloud Sync handlers
ipcMain.handle('firebase-get-status', () => {
  if (!firebaseSyncAdapter) {
    return { user: null, syncing: false };
  }
  return {
    user: firebaseSyncAdapter.getCurrentUser(),
    syncing: firebaseSyncAdapter.isSyncing
  };
});

ipcMain.handle('firebase-login', async (event, email, password) => {
  console.log('[Main] firebase-login called with email:', email);

  if (!firebaseSyncAdapter) {
    console.log('[Main] firebaseSyncAdapter is null');
    return { success: false, error: 'Firebase not initialized' };
  }

  console.log('[Main] Calling signIn...');
  const result = await firebaseSyncAdapter.signIn(email, password);
  console.log('[Main] signIn result:', result);

  if (result.success) {
    // Check if we need to run migration
    if (!firebaseSyncAdapter.isMigrationComplete()) {
      console.log('[Main] Starting migration...');
      // Run migration in background
      firebaseSyncAdapter.migrateAllLocalPrompts().then(migrationResult => {
        console.log('[Main] Migration result:', migrationResult);
      });
    }
  }

  return result;
});

ipcMain.handle('firebase-logout', async () => {
  if (!firebaseSyncAdapter) {
    return { success: false, error: 'Firebase not initialized' };
  }

  await firebaseSyncAdapter.signOut();
  return { success: true };
});

ipcMain.handle('firebase-backfill-images', async () => {
  if (!firebaseSyncAdapter || !firebaseSyncAdapter.isSyncEnabled()) {
    return { success: false, error: 'Sync not enabled' };
  }
  try {
    const result = await firebaseSyncAdapter.backfillLocalImages(({ done, total }) => {
      if (settingsView && settingsView.webContents) {
        settingsView.webContents.send('firebase-backfill-progress', { done, total });
      }
    });
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.on('open-settings', () => {
  // If settings is already active, do nothing (it's already shown)
  if (settingsActive) {
    return;
  }

  // Create settings view if it doesn't exist
  if (!settingsView) {
    settingsView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'settings-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    settingsView.webContents.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  }

  // Hide the current active tab view
  viewManager.hideActiveView();

  // Show settings view
  mainWindow.contentView.addChildView(settingsView);

  // Position to fill content area (right of sidebar)
  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  settingsView.setBounds({
    x: SIDEBAR_WIDTH,
    y: 0,
    width: windowWidth - SIDEBAR_WIDTH,
    height: windowHeight
  });

  settingsActive = true;

  // Update window title
  mainWindow.setTitle('Settings - Cross AI Browser');

  // Notify sidebar
  mainWindow.webContents.send('settings-active-changed', true);
});

function closeSettings() {
  if (!settingsActive || !settingsView || !mainWindow) return;

  // Hide settings view (but don't destroy it)
  mainWindow.contentView.removeChildView(settingsView);
  settingsActive = false;

  // Show the previously active tab
  viewManager.showActiveView();

  // Update window title to active tab
  const activeTabId = viewManager.getActiveTabId();
  if (activeTabId) {
    const tab = tabManager.getTab(activeTabId);
    if (tab) {
      mainWindow.setTitle(`${tab.name} - Cross AI Browser`);
    }
  }

  // Notify sidebar
  mainWindow.webContents.send('settings-active-changed', false);
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

// Show rename dialog as a WebContentsView overlay (like service picker)
let renameDialogView = null;
let renameDialogTabId = null;

ipcMain.handle('show-rename-dialog', async (event, tabId) => {
  const tab = tabManager.getTab(tabId);
  if (!tab) return null;

  if (renameDialogView) {
    return null;
  }

  renameDialogTabId = tabId;

  // Create as WebContentsView (works with IPC)
  renameDialogView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'rename-dialog-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.contentView.addChildView(renameDialogView);

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
    mainWindow.contentView.removeChildView(renameDialogView);
    try { renameDialogView.webContents.close(); } catch (e) { /* already closed */ }
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

// Archive/unarchive tab handlers
ipcMain.handle('archive-tab', async (event, tabId) => {
  const tab = tabManager.getTab(tabId);
  if (!tab) return false;

  // Remember the active tab and index before archiving
  const activeTabId = viewManager.getActiveTabId();
  const tabIndex = tabManager.getTabIndex(tabId);

  // Destroy the view (kills PTY for terminals, removes WebContentsView)
  viewManager.destroyView(tabId);

  // Archive in TabManager (preserves tab metadata + tabData cwd)
  tabManager.archiveTab(tabId);

  // Only switch tabs if the archived tab was the active one
  if (activeTabId === tabId) {
    if (!tabManager.hasTabs()) {
      showServicePicker(true);
    } else {
      // Prefer adjacent tab (same index, or last tab if at end)
      const nextTab = tabManager.getTabAtIndex(tabIndex) || tabManager.getTabAtIndex(tabIndex - 1) || tabManager.getTabAtIndex(0);
      if (nextTab) {
        switchToTab(nextTab.id);
      }
    }
  }

  // Notify sidebar
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tabs-updated', getTabsForRenderer());
    mainWindow.webContents.send('archived-tabs-updated', getArchivedTabsForRenderer());
  }
  updateShortcuts();

  return true;
});

ipcMain.handle('unarchive-tab', async (event, tabId) => {
  const tab = tabManager.unarchiveTab(tabId);
  if (!tab) return false;

  // Re-create view (same path as app startup restoration)
  createViewForTab(tab);

  // Switch to the reactivated tab
  switchToTab(tab.id);

  // Notify sidebar
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tabs-updated', getTabsForRenderer());
    mainWindow.webContents.send('archived-tabs-updated', getArchivedTabsForRenderer());
  }
  updateShortcuts();

  return true;
});

ipcMain.handle('get-archived-tabs', () => {
  return getArchivedTabsForRenderer();
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
      }
    ];

    // Add Restart/Shutdown Claude options for terminal tabs
    if (tab.serviceType === 'claude-code') {
      template.push({ type: 'separator' });
      template.push({
        label: 'Restart Claude',
        click: () => resolve('restart')
      });
      template.push({
        label: 'Shutdown Claude',
        click: () => resolve('shutdown')
      });
    }

    template.push({ type: 'separator' });
    template.push({
      label: 'Archive Tab',
      click: () => resolve('archive')
    });
    template.push({
      label: 'Close Tab',
      click: () => resolve('close')
    });

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

ipcMain.on('terminal-shutdown', (event, { terminalId }) => {
  if (viewManager) {
    viewManager.shutdownTerminal(terminalId);
  }
});

ipcMain.on('terminal-close', (event, { terminalId }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  closeTab(terminalId, true);
  releaseMarkdownManagerIfUnused(cwd);
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

// Prompt library management handlers
ipcMain.handle('prompt-library-get', (event, { terminalId }) => {
  if (!promptLibraryManager) return [];
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return [];
  return promptLibraryManager.getPromptsForCwd(cwd);
});

ipcMain.handle('prompt-library-get-cwd', (event, { terminalId }) => {
  return store.get(`tabData.${terminalId}.cwd`) || null;
});

// ---- Markdown files tab ----
ipcMain.handle('markdown-list', (event, { terminalId }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return [];
  try { return ensureMarkdownManager(cwd).list(); }
  catch (err) { console.error('markdown-list failed:', err); return []; }
});

ipcMain.handle('markdown-read', (event, { terminalId, relPath }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  try { return ensureMarkdownManager(cwd).read(relPath); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-write', (event, { terminalId, relPath, content }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  if (typeof content !== 'string') return { error: 'Invalid content' };
  try { return ensureMarkdownManager(cwd).write(relPath, content); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-create', (event, { terminalId, relPath }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  try { return ensureMarkdownManager(cwd).create(relPath); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-delete', async (event, { terminalId, relPath }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  try { return await ensureMarkdownManager(cwd).delete(relPath); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle('markdown-rename', (event, { terminalId, fromRel, toRel }) => {
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return { error: 'No working directory' };
  try { return ensureMarkdownManager(cwd).rename(fromRel, toRel); }
  catch (err) { return { error: err.message }; }
});

// Open an http/https link from rendered markdown in the user's default browser.
ipcMain.handle('open-external', (event, { url }) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      shell.openExternal(url);
      return { ok: true };
    }
  } catch {}
  return { ok: false };
});

ipcMain.handle('prompt-library-create', async (event, { terminalId, prompt }) => {
  if (!promptLibraryManager) return null;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return null;
  try {
    const createdPrompt = await promptLibraryManager.createPrompt(cwd, prompt);
    // Sync to Firebase
    if (firebaseSyncAdapter && createdPrompt) {
      firebaseSyncAdapter.pushPromptToFirebase(cwd, createdPrompt).catch(err => {
        console.error('Failed to sync created prompt to Firebase:', err);
      });
    }
    return createdPrompt;
  } catch (err) {
    console.error('Failed to create prompt:', err);
    return { error: err.message };
  }
});

ipcMain.handle('prompt-library-update', async (event, { terminalId, promptId, updates }) => {
  if (!promptLibraryManager) return null;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return null;
  try {
    // Handle image cleanup if images are being updated
    if (updates.images !== undefined && promptImageManager) {
      const existingPrompt = promptLibraryManager.getPromptById(cwd, promptId);
      if (existingPrompt && existingPrompt.images) {
        const newImageIds = new Set((updates.images || []).map(img => img.id));
        const removedImages = existingPrompt.images.filter(img => !newImageIds.has(img.id));
        if (removedImages.length > 0) {
          await promptImageManager.removeImages(removedImages);
          if (firebaseSyncAdapter) {
            for (const img of removedImages) {
              firebaseSyncAdapter.deleteImageFromStorage(img.id).catch(() => {});
            }
          }
        }
      }
    }
    const updatedPrompt = await promptLibraryManager.updatePrompt(cwd, promptId, updates);
    // Sync to Firebase
    if (firebaseSyncAdapter && updatedPrompt) {
      firebaseSyncAdapter.pushPromptToFirebase(cwd, updatedPrompt).catch(err => {
        console.error('Failed to sync updated prompt to Firebase:', err);
      });
    }
    return updatedPrompt;
  } catch (err) {
    console.error('Failed to update prompt:', err);
    return { error: err.message };
  }
});

ipcMain.handle('prompt-library-delete', async (event, { terminalId, promptId }) => {
  if (!promptLibraryManager) return false;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return false;
  try {
    // Get prompt first to clean up images
    const prompt = promptLibraryManager.getPromptById(cwd, promptId);
    if (prompt && prompt.images && promptImageManager) {
      await promptImageManager.removeImages(prompt.images);
      if (firebaseSyncAdapter) {
        for (const img of prompt.images) {
          firebaseSyncAdapter.deleteImageFromStorage(img.id).catch(() => {});
        }
      }
    }
    const deleted = await promptLibraryManager.deletePrompt(cwd, promptId);
    // Sync deletion to Firebase
    if (deleted && firebaseSyncAdapter) {
      firebaseSyncAdapter.deleteRemotePrompt(promptId).catch(err => {
        console.error('Failed to sync prompt deletion to Firebase:', err);
      });
    }
    return deleted;
  } catch (err) {
    console.error('Failed to delete prompt:', err);
    return false;
  }
});

ipcMain.handle('prompt-library-duplicate', async (event, { terminalId, promptId }) => {
  if (!promptLibraryManager) return null;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return null;
  try {
    const duplicatedPrompt = await promptLibraryManager.duplicatePrompt(cwd, promptId);
    // Sync to Firebase
    if (firebaseSyncAdapter && duplicatedPrompt) {
      firebaseSyncAdapter.pushPromptToFirebase(cwd, duplicatedPrompt).catch(err => {
        console.error('Failed to sync duplicated prompt to Firebase:', err);
      });
    }
    return duplicatedPrompt;
  } catch (err) {
    console.error('Failed to duplicate prompt:', err);
    return { error: err.message };
  }
});

ipcMain.handle('prompt-library-reorder', async (event, { terminalId, promptIds, scope }) => {
  if (!promptLibraryManager) return false;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return false;
  try {
    const result = await promptLibraryManager.reorderPrompts(cwd, promptIds, scope || 'project');
    // Sync all reordered prompts to Firebase
    if (result && firebaseSyncAdapter) {
      const prompts = promptLibraryManager.getPromptsForCwd(cwd);
      for (const prompt of prompts) {
        firebaseSyncAdapter.pushPromptToFirebase(cwd, prompt).catch(err => {
          console.error('Failed to sync reordered prompt to Firebase:', err);
        });
      }
    }
    return result;
  } catch (err) {
    console.error('Failed to reorder prompts:', err);
    return false;
  }
});

ipcMain.handle('prompt-library-toggle-reusable', async (event, { terminalId, promptId }) => {
  if (!promptLibraryManager) return null;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return null;
  try {
    const updatedPrompt = await promptLibraryManager.toggleReusable(cwd, promptId);
    // Sync to Firebase
    if (firebaseSyncAdapter && updatedPrompt) {
      firebaseSyncAdapter.pushPromptToFirebase(cwd, updatedPrompt).catch(err => {
        console.error('Failed to sync toggled reusable to Firebase:', err);
      });
    }
    return updatedPrompt;
  } catch (err) {
    console.error('Failed to toggle reusable:', err);
    return null;
  }
});

ipcMain.handle('prompt-library-toggle-favorite', async (event, { terminalId, promptId }) => {
  if (!promptLibraryManager) return null;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return null;
  try {
    const updatedPrompt = await promptLibraryManager.toggleFavorite(cwd, promptId);
    // Sync to Firebase
    if (firebaseSyncAdapter && updatedPrompt) {
      firebaseSyncAdapter.pushPromptToFirebase(cwd, updatedPrompt).catch(err => {
        console.error('Failed to sync toggled favorite to Firebase:', err);
      });
    }
    return updatedPrompt;
  } catch (err) {
    console.error('Failed to toggle favorite:', err);
    return null;
  }
});

ipcMain.handle('prompt-library-mark-done', async (event, { terminalId, promptId }) => {
  if (!promptLibraryManager) return null;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return null;
  try {
    const updatedPrompt = await promptLibraryManager.markAsDone(cwd, promptId);
    // Sync to Firebase
    if (firebaseSyncAdapter && updatedPrompt) {
      firebaseSyncAdapter.pushPromptToFirebase(cwd, updatedPrompt).catch(err => {
        console.error('Failed to sync mark done to Firebase:', err);
      });
    }
    return updatedPrompt;
  } catch (err) {
    console.error('Failed to mark prompt done:', err);
    return null;
  }
});

ipcMain.handle('prompt-library-mark-testing', async (event, { terminalId, promptId }) => {
  if (!promptLibraryManager) return null;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return null;
  try {
    const updatedPrompt = await promptLibraryManager.markAsTesting(cwd, promptId);
    // Sync to Firebase
    if (firebaseSyncAdapter && updatedPrompt) {
      firebaseSyncAdapter.pushPromptToFirebase(cwd, updatedPrompt).catch(err => {
        console.error('Failed to sync mark testing to Firebase:', err);
      });
    }
    return updatedPrompt;
  } catch (err) {
    console.error('Failed to mark prompt testing:', err);
    return null;
  }
});

ipcMain.handle('prompt-library-restore', async (event, { terminalId, promptId }) => {
  if (!promptLibraryManager) return null;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return null;
  try {
    const updatedPrompt = await promptLibraryManager.restorePrompt(cwd, promptId);
    // Sync to Firebase
    if (firebaseSyncAdapter && updatedPrompt) {
      firebaseSyncAdapter.pushPromptToFirebase(cwd, updatedPrompt).catch(err => {
        console.error('Failed to sync restored prompt to Firebase:', err);
      });
    }
    return updatedPrompt;
  } catch (err) {
    console.error('Failed to restore prompt:', err);
    return null;
  }
});

ipcMain.handle('prompt-library-clear-done', async (event, { terminalId }) => {
  if (!promptLibraryManager) return 0;
  const cwd = store.get(`tabData.${terminalId}.cwd`);
  if (!cwd) return 0;
  try {
    // Get done prompts first to clean up images and sync deletions
    const prompts = promptLibraryManager.getPromptsForCwd(cwd);
    const donePrompts = prompts.filter(p => p.done);

    // Clean up images
    if (promptImageManager) {
      for (const prompt of donePrompts) {
        if (prompt.images) {
          await promptImageManager.removeImages(prompt.images);
          if (firebaseSyncAdapter) {
            for (const img of prompt.images) {
              firebaseSyncAdapter.deleteImageFromStorage(img.id).catch(() => {});
            }
          }
        }
      }
    }

    // Sync deletions to Firebase
    if (firebaseSyncAdapter) {
      for (const prompt of donePrompts) {
        firebaseSyncAdapter.deleteRemotePrompt(prompt.id).catch(err => {
          console.error('Failed to sync cleared prompt deletion to Firebase:', err);
        });
      }
    }

    return await promptLibraryManager.clearDonePrompts(cwd);
  } catch (err) {
    console.error('Failed to clear done prompts:', err);
    return 0;
  }
});

// Label management handlers
ipcMain.handle('prompt-library-get-labels', () => {
  if (!promptLibraryManager) return [];
  return promptLibraryManager.getLabels();
});

ipcMain.handle('prompt-library-get-label-colors', () => {
  if (!promptLibraryManager) return {};
  return promptLibraryManager.getLabelColors();
});

ipcMain.handle('prompt-library-add-label', async (event, { name }) => {
  if (!promptLibraryManager) return false;
  try {
    return promptLibraryManager.addLabel(name);
  } catch (err) {
    console.error('Failed to add label:', err);
    return false;
  }
});

ipcMain.handle('prompt-library-delete-label', async (event, { name }) => {
  if (!promptLibraryManager) return false;
  try {
    return promptLibraryManager.deleteLabel(name);
  } catch (err) {
    console.error('Failed to delete label:', err);
    return false;
  }
});

// Legacy category handlers (redirect to labels)
ipcMain.handle('prompt-library-get-categories', () => {
  if (!promptLibraryManager) return [];
  return promptLibraryManager.getLabels();
});

ipcMain.handle('prompt-library-add-category', async (event, { name }) => {
  if (!promptLibraryManager) return false;
  try {
    return promptLibraryManager.addLabel(name);
  } catch (err) {
    return false;
  }
});

ipcMain.handle('prompt-library-delete-category', async (event, { name }) => {
  if (!promptLibraryManager) return false;
  try {
    return promptLibraryManager.deleteLabel(name);
  } catch (err) {
    return false;
  }
});

// Panel state handlers
ipcMain.handle('prompt-panel-get-state', (event, { terminalId }) => {
  if (!promptLibraryManager) return { visible: false, width: 300 };
  return promptLibraryManager.getPanelState(terminalId);
});

ipcMain.on('prompt-panel-set-state', (event, { terminalId, state }) => {
  if (promptLibraryManager) {
    promptLibraryManager.setPanelState(terminalId, state);
  }
});

// Prompt image handlers
ipcMain.handle('prompt-image-add', async (event, { filePath }) => {
  if (!promptImageManager) return { success: false, error: 'Image manager not initialized' };
  try {
    return await promptImageManager.addImage(filePath);
  } catch (err) {
    console.error('Failed to add image:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('prompt-image-add-from-data-url', async (event, { dataUrl }) => {
  if (!promptImageManager) return { success: false, error: 'Image manager not initialized' };
  try {
    return await promptImageManager.addImageFromDataUrl(dataUrl);
  } catch (err) {
    console.error('Failed to add image from data URL:', err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('prompt-image-remove', async (event, { imageId }) => {
  if (!promptImageManager) return false;
  try {
    return await promptImageManager.removeImage(imageId);
  } catch (err) {
    console.error('Failed to remove image:', err);
    return false;
  }
});

ipcMain.handle('prompt-image-get-thumbnail', (event, { imageId }) => {
  if (!promptImageManager) {
    console.log('getThumbnail: promptImageManager not initialized');
    return null;
  }
  const result = promptImageManager.getThumbnailDataUrl(imageId);
  console.log('getThumbnail:', imageId, result ? `data URL (${result.length} chars)` : 'null');
  return result;
});

ipcMain.handle('prompt-image-get-path', (event, { imageId }) => {
  if (!promptImageManager) return null;
  return promptImageManager.getImagePath(imageId);
});

ipcMain.handle('prompt-image-copy-to-temp', async (event, { imageId }) => {
  if (!promptImageManager) return null;
  return await promptImageManager.copyToTemp(imageId);
});

ipcMain.handle('prompt-image-copy-to-clipboard', async (event, { imageId }) => {
  if (!promptImageManager) return null;
  return await promptImageManager.copyToClipboard(imageId);
});

ipcMain.handle('prompt-image-pick-files', async () => {
  if (!mainWindow) return { canceled: true };
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }
      ]
    });
    return result;
  } catch (err) {
    console.error('Failed to show file picker:', err);
    return { canceled: true };
  }
});

// === Secrets Store IPC (terminal windows only, via terminal-preload) ===
// Load-bearing rule: list responses never contain secret values.
// Values cross IPC solely via secrets-reveal.

function getTerminalCwd(terminalId) {
  return store.get(`tabData.${terminalId}.cwd`) || null;
}

ipcMain.handle('secrets-list', (event, { terminalId }) => {
  if (!secretsManager) return { available: false, secrets: [] };
  try {
    const cwd = getTerminalCwd(terminalId);
    return {
      available: secretsManager.isEncryptionAvailable(),
      secrets: [
        ...secretsManager.list('global'),
        ...(cwd ? secretsManager.list('project', cwd) : [])
      ]
    };
  } catch (err) {
    return { available: false, secrets: [], error: err.message };
  }
});

ipcMain.handle('secrets-create', async (event, { terminalId, scope, secret }) => {
  if (!secretsManager) return { error: 'Secrets store unavailable' };
  const cwd = getTerminalCwd(terminalId);
  if (scope === 'project' && !cwd) {
    return { error: 'No working directory for this terminal' };
  }
  try {
    return { secret: await secretsManager.create(scope, cwd, secret) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('secrets-update', async (event, { terminalId, scope, id, updates }) => {
  if (!secretsManager) return { error: 'Secrets store unavailable' };
  const cwd = getTerminalCwd(terminalId);
  if (scope === 'project' && !cwd) {
    return { error: 'No working directory for this terminal' };
  }
  try {
    return { secret: await secretsManager.update(scope, cwd, id, updates) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('secrets-delete', async (event, { terminalId, scope, id }) => {
  if (!secretsManager) return { error: 'Secrets store unavailable' };
  try {
    return { deleted: await secretsManager.delete(scope, getTerminalCwd(terminalId), id) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('secrets-reveal', (event, { terminalId, scope, id }) => {
  if (!secretsManager) return { error: 'Secrets store unavailable' };
  try {
    return { value: secretsManager.reveal(scope, getTerminalCwd(terminalId), id) };
  } catch (err) {
    return { error: err.message };
  }
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
  const body = sanitizeNotificationText(preview) || 'Response complete';

  const soundSetting = store.get('notifications.soundComplete', 'crossai-chime');
  const notification = new Notification({
    title: title,
    body: body,
    silent: soundSetting === 'none',
    sound: soundSetting !== 'none' ? soundSetting : undefined
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

/**
 * Copy bundled notification sounds to ~/Library/Sounds/ so macOS can find them by name.
 */
function installCustomSounds() {
  if (process.platform !== 'darwin') return;
  const userSoundsDir = path.join(app.getPath('home'), 'Library', 'Sounds');
  fs.mkdirSync(userSoundsDir, { recursive: true });
  const bundledSoundsDir = path.join(__dirname, '..', 'assets', 'sounds');
  if (!fs.existsSync(bundledSoundsDir)) return;
  for (const file of fs.readdirSync(bundledSoundsDir)) {
    if (file.endsWith('.aiff')) {
      const dest = path.join(userSoundsDir, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(path.join(bundledSoundsDir, file), dest);
      }
    }
  }
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

  installCustomSounds();
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
  releaseAllMarkdownManagers();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
