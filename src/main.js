const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, Notification, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const Store = require('electron-store');
const pty = require('node-pty');

// Set app name (shown in menu bar)
app.setName('Cross AI Browser');

// Initialize settings store
const store = new Store({
  defaults: {
    notifications: {
      enabled: true,
      mode: 'always' // 'always', 'unfocused', 'inactive-tab'
    },
    terminalTabs: [] // Persisted terminal tabs
  }
});

// AI Services configuration (web-based services)
const AI_SERVICES = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chat.openai.com',
    shortcut: 'CommandOrControl+1',
    type: 'web'
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    shortcut: 'CommandOrControl+2',
    type: 'web'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    shortcut: 'CommandOrControl+3',
    type: 'web'
  }
];

const SIDEBAR_WIDTH = 60;

let mainWindow = null;
let browserViews = {}; // Web service views
let terminalViews = {}; // Terminal BrowserViews
let terminalPtys = {}; // PTY processes for terminals
let terminalTabs = []; // Terminal tab metadata: { id, name, cwd }
let terminalReadyState = {}; // Track which terminals are ready to receive data
let terminalOutputBuffer = {}; // Buffer PTY output until terminal is ready
let terminalPromptState = {}; // Track prompt detection state for notifications
let activeServiceId = null;

// Usage tracking for usage bars
let usageCache = {
  data: null,
  lastFetch: 0,
  fetchInterval: 30000, // 30 seconds cache TTL
  pendingFetch: null
};
let usageUpdateTimers = {}; // Per-terminal debounce timers

// Pattern that indicates Claude Code is actively working
const CLAUDE_WORKING_PATTERN = /Esc to interrupt/i;

// Patterns that indicate Claude Code is ready for user input
const CLAUDE_PROMPT_PATTERNS = [
  />\s*$/,                    // Main prompt: ">"
  /\?\s*$/,                   // Question prompt ending with "?"
  /\[Y\/n\]\s*$/i,           // Yes/no prompt
  /\[y\/N\]\s*$/i,           // Yes/no prompt (default no)
  /\(y\/n\)\s*$/i,           // Alternative yes/no
  /Press Enter/i,            // Press enter to continue
];

// Debounce timers for prompt detection
let promptCheckTimers = {};

function checkForPromptAndNotify(terminalId) {
  const promptState = terminalPromptState[terminalId];
  if (!promptState) return;

  // Check if Claude is currently working ("Esc to interrupt" visible)
  const isCurrentlyWorking = CLAUDE_WORKING_PATTERN.test(promptState.recentOutput);

  if (isCurrentlyWorking) {
    // Mark that Claude was working - we'll notify when it stops
    promptState.wasWorking = true;
    // Clear any pending notification timer
    if (promptCheckTimers[terminalId]) {
      clearTimeout(promptCheckTimers[terminalId]);
      delete promptCheckTimers[terminalId];
    }
    return;
  }

  // Clear existing timer for this terminal
  if (promptCheckTimers[terminalId]) {
    clearTimeout(promptCheckTimers[terminalId]);
  }

  // Debounce: wait 500ms after last output to check for prompt
  promptCheckTimers[terminalId] = setTimeout(() => {
    if (promptState.hasNotifiedSinceLastInput) {
      return;
    }

    // Get recent lines for analysis
    const recentLines = promptState.recentOutput.split('\n').slice(-5).join('\n');

    // Notify if: Claude was working and stopped, OR a prompt pattern is detected
    const isPromptReady = CLAUDE_PROMPT_PATTERNS.some(pattern => pattern.test(recentLines));
    const claudeFinishedWorking = promptState.wasWorking && !isCurrentlyWorking;

    if (claudeFinishedWorking || isPromptReady) {
      promptState.hasNotifiedSinceLastInput = true;
      promptState.wasWorking = false;
      sendTerminalNotification(terminalId, recentLines);
    }
  }, 500);
}

function sendTerminalNotification(terminalId, recentOutput) {
  const settings = store.get('notifications');
  if (!settings.enabled) return;

  const terminal = terminalTabs.find(t => t.id === terminalId);
  if (!terminal) return;

  // Check notification mode
  const shouldNotify = (() => {
    switch (settings.mode) {
      case 'always':
        return true;
      case 'unfocused':
        return !mainWindow.isFocused();
      case 'inactive-tab':
        return activeServiceId !== terminalId;
      default:
        return true;
    }
  })();

  if (!shouldNotify) return;

  // Use the captured last message from the prompt state
  const promptState = terminalPromptState[terminalId];
  let preview = promptState?.lastMessage || '';

  // Debug: log what we're seeing
  console.log('=== NOTIFICATION DEBUG ===');
  console.log('Using captured message:', preview);

  // Fallback if no captured message
  if (!preview) {
    preview = 'Ready for input';
  }

  // Clean up the preview
  preview = preview.replace(/\s+/g, ' ').trim().slice(0, 100);

  const notification = new Notification({
    title: `Claude Code (${terminal.name})`,
    body: preview,
    silent: false
  });

  notification.on('click', () => {
    switchToService(terminalId);
    mainWindow.show();
    mainWindow.focus();
  });

  notification.show();
}

// Usage data fetching for usage bars
// Uses official Anthropic OAuth API endpoint for accurate usage data

// Get OAuth token from macOS Keychain
function getClaudeOAuthToken() {
  return new Promise((resolve, reject) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Failed to get credentials from Keychain: ${error.message}`));
        return;
      }

      try {
        // The output is hex-encoded data with additional MCP OAuth data
        const hexString = stdout.trim();
        const rawBytes = Buffer.from(hexString, 'hex');

        // Skip first byte (control character)
        const content = rawBytes.slice(1).toString('utf8');

        // Extract the accessToken directly from claudeAiOauth section
        // Format: "claudeAiOauth":{"accessToken":"sk-ant-oat01-...",
        const match = content.match(/"claudeAiOauth"\s*:\s*\{\s*"accessToken"\s*:\s*"([^"]+)"/);
        if (!match) {
          reject(new Error('Could not find accessToken in credentials'));
          return;
        }

        resolve(match[1]);
      } catch (e) {
        reject(new Error(`Failed to parse credentials: ${e.message}`));
      }
    });
  });
}

// Fetch usage data from official Anthropic API
async function fetchUsageData() {
  // Return cached data if recent enough
  if (usageCache.data && Date.now() - usageCache.lastFetch < usageCache.fetchInterval) {
    return usageCache.data;
  }

  // Prevent concurrent fetches
  if (usageCache.pendingFetch) {
    return usageCache.pendingFetch;
  }

  usageCache.pendingFetch = (async () => {
    try {
      console.log('=== USAGE: Fetching OAuth token from Keychain...');
      const accessToken = await getClaudeOAuthToken();
      console.log('=== USAGE: Got OAuth token, calling API...');

      // Call the official Anthropic usage API
      const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'cross-ai-browser/1.0',
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20'
        }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      const apiData = await response.json();
      console.log('=== USAGE: API response:', JSON.stringify(apiData));

      const result = parseUsageData(apiData);
      console.log('=== USAGE: parsed result:', JSON.stringify(result));
      usageCache.data = result;
      usageCache.lastFetch = Date.now();
      usageCache.pendingFetch = null;
      return result;
    } catch (error) {
      console.error('=== USAGE: Failed to fetch usage data:', error);
      usageCache.pendingFetch = null;
      return null;
    }
  })();

  return usageCache.pendingFetch;
}

function parseUsageData(apiData) {
  const session = parseSessionData(apiData);
  const weekly = parseWeeklyData(apiData);
  return { session, weekly };
}

function parseSessionData(apiData) {
  try {
    // API returns: { five_hour: { utilization: 6.0, resets_at: "2025-..." } }
    const fiveHour = apiData?.five_hour;
    if (fiveHour) {
      const percentUsed = Math.round(fiveHour.utilization || 0);
      const timeLeft = formatTimeRemaining(fiveHour.resets_at);
      return { percentUsed, timeLeft };
    }
  } catch (e) {
    console.error('Error parsing session data:', e);
  }
  return { percentUsed: 0, timeLeft: '--' };
}

function parseWeeklyData(apiData) {
  try {
    // API returns: { seven_day: { utilization: 35.0, resets_at: "2025-..." } }
    const sevenDay = apiData?.seven_day;
    if (sevenDay) {
      const percentUsed = Math.round(sevenDay.utilization || 0);
      const timeLeft = formatTimeRemaining(sevenDay.resets_at);
      return { percentUsed, timeLeft };
    }
  } catch (e) {
    console.error('Error parsing weekly data:', e);
  }
  return { percentUsed: 0, timeLeft: '--' };
}

function formatTimeRemaining(resetTimeStr) {
  if (!resetTimeStr) return '--';

  try {
    const resetTime = new Date(resetTimeStr);
    const now = new Date();
    const diffMs = resetTime - now;

    if (diffMs <= 0) return 'now';

    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      const remainingHours = diffHours % 24;
      if (remainingHours > 0) {
        return `${diffDays}d ${remainingHours}h`;
      }
      return `${diffDays}d`;
    }

    if (diffHours > 0) {
      const remainingMins = diffMins % 60;
      return `${diffHours}h ${remainingMins}m`;
    }

    return `${diffMins}m`;
  } catch (e) {
    console.error('Error formatting time remaining:', e);
    return '--';
  }
}

// Trigger usage update for a terminal (debounced)
function triggerUsageUpdate(terminalId) {
  if (usageUpdateTimers[terminalId]) {
    clearTimeout(usageUpdateTimers[terminalId]);
  }

  usageUpdateTimers[terminalId] = setTimeout(async () => {
    console.log('=== USAGE: triggerUsageUpdate firing for', terminalId);
    const view = terminalViews[terminalId];
    if (view && !view.webContents.isDestroyed()) {
      const usageData = await fetchUsageData();
      console.log('=== USAGE: got usageData:', usageData);
      if (usageData) {
        console.log('=== USAGE: sending usage-update to renderer');
        view.webContents.send('usage-update', usageData);
      }
    }
  }, 2000); // 2 second debounce
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

  // Create BrowserViews for each AI service
  AI_SERVICES.forEach(service => {
    createBrowserView(service);
  });

  // Restore terminal tabs from store (only if directory still exists)
  const savedTerminals = store.get('terminalTabs', []);
  const validTerminals = savedTerminals.filter(terminal => {
    try {
      return fs.existsSync(terminal.cwd) && fs.statSync(terminal.cwd).isDirectory();
    } catch {
      return false;
    }
  });

  // Update stored terminals to only include valid ones
  if (validTerminals.length !== savedTerminals.length) {
    store.set('terminalTabs', validTerminals.map(t => ({ id: t.id, name: t.name, cwd: t.cwd })));
  }

  validTerminals.forEach(terminal => {
    createTerminalTab(terminal.id, terminal.name, terminal.cwd, false);
  });

  // Set default active service
  switchToService(AI_SERVICES[0].id);

  // Handle window resize
  mainWindow.on('resize', updateViewBounds);

  // Auto-focus the active view when window gains focus
  mainWindow.on('focus', () => {
    if (activeServiceId) {
      const terminalView = terminalViews[activeServiceId];
      const webView = browserViews[activeServiceId];
      if (terminalView) {
        terminalView.webContents.focus();
      } else if (webView) {
        webView.webContents.focus();
      }
    }
  });

  mainWindow.on('closed', () => {
    // Cleanup terminal processes
    Object.values(terminalPtys).forEach(ptyProcess => {
      try {
        ptyProcess.kill();
      } catch (e) {
        // Process may already be dead
      }
    });
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
      allowRunningInsecureContent: false,
      acceptFirstMouse: true  // Allow click-through when window is inactive
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

function createTerminalTab(terminalId, name, cwd, switchTo = true, mode = 'normal') {
  // Create BrowserView for terminal
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, 'terminal-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      acceptFirstMouse: true  // Allow click-through when window is inactive
    }
  });

  terminalViews[terminalId] = view;

  // Load terminal HTML with terminal ID as query param
  const terminalHtmlPath = path.join(__dirname, 'renderer', 'terminal.html');
  view.webContents.loadURL(`file://${terminalHtmlPath}?id=${terminalId}`);

  // Add to terminal tabs list (mode is stored for PTY spawning)
  const tabData = { id: terminalId, name, cwd, mode };
  terminalTabs.push(tabData);

  // Persist terminal tabs
  store.set('terminalTabs', terminalTabs);

  // Notify sidebar of new tab
  if (mainWindow) {
    mainWindow.webContents.send('tabs-updated', getAllTabs());
  }

  // Switch to the new terminal
  if (switchTo) {
    switchToService(terminalId);
  }

  return terminalId;
}

function setupTerminalPty(terminalId, cwd, cols = 80, rows = 30, mode = 'normal') {
  const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';

  // Initialize output buffer for this terminal
  terminalOutputBuffer[terminalId] = [];

  // Initialize prompt detection state
  terminalPromptState[terminalId] = {
    recentOutput: '',
    lastActivity: Date.now(),
    hasNotifiedSinceLastInput: false,
    wasWorking: false,  // Track if "Esc to interrupt" was visible
    lastMessage: ''     // Store the last Claude message for notification
  };

  // Build claude command based on mode
  // - 'normal': fresh session
  // - 'continue': continue most recent session (--continue)
  // - 'resume': interactive session picker (--resume)
  let claudeCmd = 'claude';
  if (mode === 'continue' || mode === true) {
    claudeCmd = 'claude --continue';
  } else if (mode === 'resume') {
    claudeCmd = 'claude --resume';
  }

  try {
    const ptyProcess = pty.spawn(shell, ['-c', claudeCmd], {
      name: 'xterm-256color',
      cols: cols,
      rows: rows,
      cwd: cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    });

    terminalPtys[terminalId] = ptyProcess;

    // Forward PTY output to terminal view (with buffering)
    ptyProcess.onData(data => {
      const view = terminalViews[terminalId];
      if (view && !view.webContents.isDestroyed()) {
        // If terminal renderer is ready, send directly; otherwise buffer
        if (terminalReadyState[terminalId]) {
          view.webContents.send('terminal-data', data);
        } else {
          terminalOutputBuffer[terminalId].push(data);
        }
      }

      // Track output for prompt detection
      const promptState = terminalPromptState[terminalId];
      if (promptState) {
        // Strip ANSI codes for pattern matching
        const cleanData = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
        promptState.recentOutput += cleanData;
        // Keep only last 3000 chars to capture full responses
        if (promptState.recentOutput.length > 3000) {
          promptState.recentOutput = promptState.recentOutput.slice(-3000);
        }
        promptState.lastActivity = Date.now();

        // Capture Claude's message when we see the ⏺ marker
        const markers = ['⏺', '●', '◉'];
        for (const marker of markers) {
          const markerIdx = cleanData.lastIndexOf(marker);
          if (markerIdx !== -1) {
            // Extract message after marker until newline or end
            const afterMarker = cleanData.slice(markerIdx + 1);
            const lineEnd = afterMarker.search(/[\n\r]/);
            const message = lineEnd !== -1 ? afterMarker.slice(0, lineEnd) : afterMarker;
            const trimmed = message.trim();
            if (trimmed && trimmed.length > 5) {
              promptState.lastMessage = trimmed;
              console.log('Captured message:', trimmed);
            }
            break;
          }
        }

        // Check for prompt patterns (with debounce)
        checkForPromptAndNotify(terminalId);

        // Trigger usage bar update (debounced)
        triggerUsageUpdate(terminalId);
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`Terminal ${terminalId} process exited with code ${exitCode}, signal ${signal}`);

      const view = terminalViews[terminalId];
      if (view && !view.webContents.isDestroyed()) {
        // For command not found, show error message
        if (exitCode === 127) {
          const errorMsg = '\r\n\x1b[31mError: "claude" command not found. Please install Claude Code CLI first.\x1b[0m\r\n';
          if (terminalReadyState[terminalId]) {
            view.webContents.send('terminal-data', errorMsg);
          } else {
            terminalOutputBuffer[terminalId].push(errorMsg);
          }
        }

        // Send exit event to renderer so it can show reload/close options
        view.webContents.send('terminal-exit', { exitCode, signal });
      }

      // Clean up PTY reference
      delete terminalPtys[terminalId];
    });

    return ptyProcess;
  } catch (error) {
    console.error(`Failed to spawn PTY for terminal ${terminalId}:`, error);

    // Send error message to terminal view
    const view = terminalViews[terminalId];
    if (view && !view.webContents.isDestroyed()) {
      const errorMsg = `\r\n\x1b[31mFailed to start terminal: ${error.message}\x1b[0m\r\n`;
      if (terminalReadyState[terminalId]) {
        view.webContents.send('terminal-data', errorMsg);
      } else {
        terminalOutputBuffer[terminalId].push(errorMsg);
      }
    }

    return null;
  }
}

// Alias for spawning PTY with specific size
function setupTerminalPtyWithSize(terminalId, cwd, cols, rows, mode = 'normal') {
  return setupTerminalPty(terminalId, cwd, cols, rows, mode);
}

function closeTerminalTab(terminalId) {
  // Kill PTY process
  const ptyProcess = terminalPtys[terminalId];
  if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch (e) {
      // Process may already be dead
    }
    delete terminalPtys[terminalId];
  }

  // Remove BrowserView
  const view = terminalViews[terminalId];
  if (view) {
    if (mainWindow && activeServiceId === terminalId) {
      mainWindow.removeBrowserView(view);
    }
    delete terminalViews[terminalId];
  }

  // Clean up terminal state
  delete terminalReadyState[terminalId];
  delete terminalOutputBuffer[terminalId];
  delete terminalPromptState[terminalId];
  if (promptCheckTimers[terminalId]) {
    clearTimeout(promptCheckTimers[terminalId]);
    delete promptCheckTimers[terminalId];
  }
  if (usageUpdateTimers[terminalId]) {
    clearTimeout(usageUpdateTimers[terminalId]);
    delete usageUpdateTimers[terminalId];
  }

  // Remove from terminal tabs list
  const index = terminalTabs.findIndex(t => t.id === terminalId);
  if (index !== -1) {
    terminalTabs.splice(index, 1);
  }

  // Persist terminal tabs
  store.set('terminalTabs', terminalTabs);

  // If this was the active tab, switch to another
  if (activeServiceId === terminalId) {
    const allTabs = getAllTabs();
    if (allTabs.length > 0) {
      switchToService(allTabs[0].id);
    }
  }

  // Notify sidebar
  if (mainWindow) {
    mainWindow.webContents.send('tabs-updated', getAllTabs());
  }
}

function getAllTabs() {
  // Combine web services and terminal tabs
  const webTabs = AI_SERVICES.map((service, index) => ({
    id: service.id,
    name: service.name,
    type: 'web',
    shortcut: index < 9 ? `⌘${index + 1}` : null,
    closeable: false
  }));

  const termTabs = terminalTabs.map((terminal, index) => ({
    id: terminal.id,
    name: terminal.name,
    type: 'terminal',
    shortcut: (AI_SERVICES.length + index) < 9 ? `⌘${AI_SERVICES.length + index + 1}` : null,
    closeable: true
  }));

  return [...webTabs, ...termTabs];
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

  // Update web service views
  Object.values(browserViews).forEach(view => {
    view.setBounds(viewBounds);
  });

  // Update terminal views
  Object.values(terminalViews).forEach(view => {
    view.setBounds(viewBounds);
  });
}

function switchToService(serviceId) {
  const isWebService = AI_SERVICES.some(s => s.id === serviceId);
  const isTerminal = terminalTabs.some(t => t.id === serviceId);

  if (!isWebService && !isTerminal) return;
  if (activeServiceId === serviceId) return;

  // Remove current view
  if (activeServiceId) {
    const currentWebView = browserViews[activeServiceId];
    const currentTerminalView = terminalViews[activeServiceId];

    if (currentWebView) {
      mainWindow.removeBrowserView(currentWebView);
    }
    if (currentTerminalView) {
      mainWindow.removeBrowserView(currentTerminalView);
    }
  }

  // Add new view
  if (isWebService) {
    mainWindow.addBrowserView(browserViews[serviceId]);
  } else if (isTerminal) {
    mainWindow.addBrowserView(terminalViews[serviceId]);
  }

  activeServiceId = serviceId;
  updateViewBounds();

  // Notify sidebar of active service change
  mainWindow.webContents.send('active-service-changed', serviceId);
}

function registerShortcuts() {
  // Register numbered shortcuts for tabs (delegated to updateShortcuts)
  updateShortcuts();

  // Cycle through services with Cmd+] / Cmd+[
  globalShortcut.register('CommandOrControl+]', () => {
    const allTabs = getAllTabs();
    const currentIndex = allTabs.findIndex(t => t.id === activeServiceId);
    const nextIndex = (currentIndex + 1) % allTabs.length;
    switchToService(allTabs[nextIndex].id);
  });

  globalShortcut.register('CommandOrControl+[', () => {
    const allTabs = getAllTabs();
    const currentIndex = allTabs.findIndex(t => t.id === activeServiceId);
    const prevIndex = (currentIndex - 1 + allTabs.length) % allTabs.length;
    switchToService(allTabs[prevIndex].id);
  });
}

// Re-register shortcuts when tabs change (to support dynamic numbering)
function updateShortcuts() {
  // Unregister all numbered shortcuts
  for (let i = 1; i <= 9; i++) {
    globalShortcut.unregister(`CommandOrControl+${i}`);
  }

  // Re-register for current tabs
  const allTabs = getAllTabs();
  allTabs.forEach((tab, index) => {
    if (index < 9) {
      globalShortcut.register(`CommandOrControl+${index + 1}`, () => {
        switchToService(tab.id);
      });
    }
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

ipcMain.handle('get-all-tabs', () => {
  return getAllTabs();
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

// Terminal handlers
ipcMain.handle('add-terminal', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select folder for Claude Code'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0];
    const folderName = path.basename(folderPath);
    const terminalId = `terminal-${crypto.randomUUID()}`;

    createTerminalTab(terminalId, folderName, folderPath);
    updateShortcuts();

    return { success: true, terminalId };
  }

  return { success: false };
});

// Create a new terminal with interactive session picker (--resume)
ipcMain.handle('resume-terminal-session', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select folder for Claude Code (Resume Session)'
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0];
    const folderName = path.basename(folderPath);
    const terminalId = `terminal-${crypto.randomUUID()}`;

    // Create terminal with 'resume' mode for interactive session picker
    createTerminalTab(terminalId, `${folderName} (Resume)`, folderPath, true, 'resume');
    updateShortcuts();

    return { success: true, terminalId };
  }

  return { success: false };
});

ipcMain.on('close-terminal', async (event, terminalId) => {
  // Show confirmation dialog before closing
  const terminal = terminalTabs.find(t => t.id === terminalId);
  const tabName = terminal ? terminal.name : 'Claude Code';

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Close Tab', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Close Claude Code Tab',
    message: `Close "${tabName}"?`,
    detail: 'The session will be terminated. Use the Resume button in the sidebar to continue a previous session.'
  });

  if (response === 0) {
    closeTerminalTab(terminalId);
    updateShortcuts();
  }
});

// Terminal PTY communication
ipcMain.on('terminal-ready', (event, { terminalId }) => {
  const terminal = terminalTabs.find(t => t.id === terminalId);
  if (terminal) {
    // Mark terminal as ready to receive data
    terminalReadyState[terminalId] = true;
    // Note: PTY will be spawned when we receive the first resize event with actual dimensions

    // Flush any buffered output to the terminal
    const buffer = terminalOutputBuffer[terminalId];
    if (buffer && buffer.length > 0) {
      const view = terminalViews[terminalId];
      if (view && !view.webContents.isDestroyed()) {
        buffer.forEach(data => {
          view.webContents.send('terminal-data', data);
        });
      }
      // Clear the buffer
      terminalOutputBuffer[terminalId] = [];
    }
  }
});

ipcMain.on('terminal-input', (event, { terminalId, data }) => {
  const ptyProcess = terminalPtys[terminalId];
  if (ptyProcess) {
    ptyProcess.write(data);

    // Reset notification state when user sends input (especially on Enter)
    if (data.includes('\r') || data.includes('\n')) {
      const promptState = terminalPromptState[terminalId];
      if (promptState) {
        promptState.hasNotifiedSinceLastInput = false;
        promptState.wasWorking = false;
        promptState.recentOutput = '';
        promptState.lastMessage = '';
      }
    }
  }
});

ipcMain.on('terminal-resize', (event, { terminalId, cols, rows }) => {
  // Store dimensions for potential reload
  if (terminalPromptState[terminalId]) {
    terminalPromptState[terminalId].cols = cols;
    terminalPromptState[terminalId].rows = rows;
  }

  const ptyProcess = terminalPtys[terminalId];
  if (ptyProcess) {
    try {
      ptyProcess.resize(cols, rows);
    } catch (e) {
      // Resize may fail if process is dead
    }
  } else {
    // PTY not spawned yet - spawn it now with correct dimensions
    const terminal = terminalTabs.find(t => t.id === terminalId);
    if (terminal && terminalReadyState[terminalId]) {
      // Use stored mode (normal, continue, or resume) for initial spawn
      const mode = terminal.mode || 'normal';
      setupTerminalPtyWithSize(terminalId, terminal.cwd, cols, rows, mode);
      // Clear mode after first spawn so reloads start fresh
      terminal.mode = 'normal';
    }
  }
});

// Handle terminal reload request (restart Claude in the same terminal)
ipcMain.on('terminal-reload', (event, { terminalId }) => {
  const terminal = terminalTabs.find(t => t.id === terminalId);
  const view = terminalViews[terminalId];

  if (!terminal || !view || view.webContents.isDestroyed()) return;

  // Kill existing PTY if still running
  const existingPty = terminalPtys[terminalId];
  if (existingPty) {
    existingPty.kill();
    delete terminalPtys[terminalId];
  }

  // Clear terminal and show restart message
  view.webContents.send('terminal-data', '\x1b[2J\x1b[H'); // Clear screen
  view.webContents.send('terminal-data', '\x1b[90mRestarting Claude Code...\x1b[0m\r\n\r\n');

  // Get current terminal dimensions from the view
  const { cols, rows } = terminalPromptState[terminalId] || { cols: 80, rows: 30 };

  // Spawn new PTY
  setupTerminalPty(terminalId, terminal.cwd, cols, rows);
});

// Handle terminal resume request (restart Claude with --continue to resume session)
ipcMain.on('terminal-resume', (event, { terminalId }) => {
  const terminal = terminalTabs.find(t => t.id === terminalId);
  const view = terminalViews[terminalId];

  if (!terminal || !view || view.webContents.isDestroyed()) return;

  // Kill existing PTY if still running
  const existingPty = terminalPtys[terminalId];
  if (existingPty) {
    existingPty.kill();
    delete terminalPtys[terminalId];
  }

  // Clear terminal and show resume message
  view.webContents.send('terminal-data', '\x1b[2J\x1b[H'); // Clear screen
  view.webContents.send('terminal-data', '\x1b[90mResuming Claude Code session...\x1b[0m\r\n\r\n');

  // Get current terminal dimensions
  const promptState = terminalPromptState[terminalId] || {};
  const { cols = 80, rows = 30 } = promptState;

  // Spawn new PTY with --continue flag
  setupTerminalPty(terminalId, terminal.cwd, cols, rows, 'continue');
});

// Handle terminal close request
ipcMain.on('terminal-close', (event, { terminalId }) => {
  closeTerminalTab(terminalId);
});

// Handle usage data request from terminal renderer
ipcMain.on('terminal-request-usage', async (event, { terminalId }) => {
  const view = terminalViews[terminalId];
  if (!view || view.webContents.isDestroyed()) return;

  const usageData = await fetchUsageData();
  if (usageData) {
    view.webContents.send('usage-update', usageData);
  }
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
            } else if (activeServiceId && terminalViews[activeServiceId]) {
              terminalViews[activeServiceId].webContents.openDevTools();
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
