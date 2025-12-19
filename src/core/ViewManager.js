/**
 * ViewManager - Handles BrowserView and PTY lifecycle management
 *
 * Manages:
 * - BrowserView creation/destruction for web services
 * - Terminal BrowserView + PTY processes for Claude Code
 * - View switching and bounds management
 * - Session sharing for web services of the same type
 */

const { BrowserView, dialog, Notification } = require('electron');
const path = require('path');
const pty = require('node-pty');
const { execFile } = require('child_process');
const { getServiceType } = require('./ServiceRegistry');

const SIDEBAR_WIDTH = 160;

// Pattern that indicates Claude Code is actively working
const CLAUDE_WORKING_PATTERN = /Esc to interrupt/i;

// Patterns that indicate Claude Code is ready for user input
const CLAUDE_PROMPT_PATTERNS = [
  />\s*$/,
  /\?\s*$/,
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
  /\(y\/n\)\s*$/i,
  /Press Enter/i,
];

class ViewManager {
  /**
   * @param {Object} options
   * @param {BrowserWindow} options.mainWindow - The main Electron window
   * @param {Object} options.store - electron-store instance
   * @param {Function} options.onTabsChanged - Callback when tabs change
   */
  constructor({ mainWindow, store, onTabsChanged }) {
    this.mainWindow = mainWindow;
    this.store = store;
    this.onTabsChanged = onTabsChanged;

    // View storage
    this.webViews = new Map();      // tabId -> BrowserView
    this.terminalViews = new Map(); // tabId -> BrowserView
    this.terminalPtys = new Map();  // tabId -> PTY process

    // Terminal state
    this.terminalReadyState = new Map();
    this.terminalOutputBuffer = new Map();
    this.terminalPromptState = new Map();
    this.promptCheckTimers = new Map();

    // Usage tracking for Claude Code tabs
    this.usageCache = {
      data: null,
      lastFetch: 0,
      fetchInterval: 30000,
      pendingFetch: null
    };
    this.usageUpdateTimers = new Map();

    // Active tab tracking
    this.activeTabId = null;
  }

  /**
   * Get preload script paths
   * @private
   */
  _getPreloadPath(type) {
    const basePath = path.join(__dirname, '..');
    if (type === 'web') {
      return path.join(basePath, 'webview-preload.js');
    }
    return path.join(basePath, 'terminal-preload.js');
  }

  /**
   * Create a view for a tab
   * @param {Object} tab - Tab from TabManager
   * @returns {BrowserView} The created view
   */
  createViewForTab(tab) {
    const serviceType = getServiceType(tab.serviceType);
    if (!serviceType) {
      throw new Error(`Unknown service type: ${tab.serviceType}`);
    }

    if (serviceType.type === 'web') {
      return this._createWebView(tab, serviceType);
    } else if (serviceType.type === 'terminal') {
      return this._createTerminalView(tab);
    }

    throw new Error(`Unsupported service type: ${serviceType.type}`);
  }

  /**
   * Create a web service BrowserView
   * @private
   */
  _createWebView(tab, serviceType) {
    const view = new BrowserView({
      webPreferences: {
        preload: this._getPreloadPath('web'),
        contextIsolation: true,
        nodeIntegration: false,
        partition: serviceType.sessionPartition,
        webSecurity: true,
        allowRunningInsecureContent: false,
        acceptFirstMouse: true
      }
    });

    this.webViews.set(tab.id, view);

    // Set custom user agent
    const userAgent = view.webContents.getUserAgent().replace(/Electron\/\S+ /, '');
    view.webContents.setUserAgent(userAgent);

    // Load the service URL
    view.webContents.loadURL(serviceType.url);

    // Handle new window requests (OAuth popups)
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url.includes('accounts.google.com') ||
          url.includes('auth0.com') ||
          url.includes('login') ||
          url.includes('oauth') ||
          url.includes('signin')) {
        return { action: 'allow' };
      }
      require('electron').shell.openExternal(url);
      return { action: 'deny' };
    });

    return view;
  }

  /**
   * Create a terminal BrowserView
   * @private
   */
  _createTerminalView(tab) {
    const view = new BrowserView({
      webPreferences: {
        preload: this._getPreloadPath('terminal'),
        contextIsolation: true,
        nodeIntegration: false,
        acceptFirstMouse: true
      }
    });

    this.terminalViews.set(tab.id, view);

    // Initialize terminal state
    this.terminalReadyState.set(tab.id, false);
    this.terminalOutputBuffer.set(tab.id, []);
    this.terminalPromptState.set(tab.id, {
      recentOutput: '',
      lastActivity: Date.now(),
      hasNotifiedSinceLastInput: false,
      wasWorking: false,
      lastMessage: '',
      cols: 80,
      rows: 30
    });

    // Load terminal HTML
    const terminalHtmlPath = path.join(__dirname, '..', 'renderer', 'terminal.html');
    view.webContents.loadURL(`file://${terminalHtmlPath}?id=${tab.id}`);

    return view;
  }

  /**
   * Setup PTY process for a terminal tab
   * @param {string} tabId - The tab ID
   * @param {string} cwd - Working directory
   * @param {number} cols - Terminal columns
   * @param {number} rows - Terminal rows
   * @param {string} mode - 'normal', 'continue', or 'resume'
   */
  setupTerminalPty(tabId, cwd, cols = 80, rows = 30, mode = 'normal') {
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';

    // Build claude command based on mode
    let claudeCmd = 'claude';
    if (mode === 'continue' || mode === true) {
      claudeCmd = 'claude --continue';
    } else if (mode === 'resume') {
      claudeCmd = 'claude --resume';
    }

    try {
      const ptyProcess = pty.spawn(shell, ['-c', claudeCmd], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' }
      });

      this.terminalPtys.set(tabId, ptyProcess);

      // Forward PTY output
      ptyProcess.onData(data => {
        this._handlePtyOutput(tabId, data);
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode, signal }) => {
        this._handlePtyExit(tabId, exitCode, signal);
      });

      return ptyProcess;
    } catch (error) {
      console.error(`Failed to spawn PTY for terminal ${tabId}:`, error);
      this._sendTerminalError(tabId, `Failed to start terminal: ${error.message}`);
      return null;
    }
  }

  /**
   * Handle PTY output
   * @private
   */
  _handlePtyOutput(tabId, data) {
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;

    // Send or buffer data
    if (this.terminalReadyState.get(tabId)) {
      view.webContents.send('terminal-data', data);
    } else {
      const buffer = this.terminalOutputBuffer.get(tabId) || [];
      buffer.push(data);
      this.terminalOutputBuffer.set(tabId, buffer);
    }

    // Track output for prompt detection
    const promptState = this.terminalPromptState.get(tabId);
    if (promptState) {
      const cleanData = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      promptState.recentOutput += cleanData;
      if (promptState.recentOutput.length > 3000) {
        promptState.recentOutput = promptState.recentOutput.slice(-3000);
      }
      promptState.lastActivity = Date.now();

      // Capture Claude's message
      const markers = ['⏺', '●', '◉'];
      for (const marker of markers) {
        const markerIdx = cleanData.lastIndexOf(marker);
        if (markerIdx !== -1) {
          const afterMarker = cleanData.slice(markerIdx + 1);
          const lineEnd = afterMarker.search(/[\n\r]/);
          const message = lineEnd !== -1 ? afterMarker.slice(0, lineEnd) : afterMarker;
          const trimmed = message.trim();
          if (trimmed && trimmed.length > 5) {
            promptState.lastMessage = trimmed;
          }
          break;
        }
      }

      this._checkForPromptAndNotify(tabId);
      this._triggerUsageUpdate(tabId);
    }
  }

  /**
   * Handle PTY exit
   * @private
   */
  _handlePtyExit(tabId, exitCode, signal) {
    console.log(`Terminal ${tabId} process exited with code ${exitCode}, signal ${signal}`);

    const view = this.terminalViews.get(tabId);
    if (view && !view.webContents.isDestroyed()) {
      if (exitCode === 127) {
        this._sendTerminalError(tabId, 'Error: "claude" command not found. Please install Claude Code CLI first.');
      }
      view.webContents.send('terminal-exit', { exitCode, signal });
    }

    this.terminalPtys.delete(tabId);
  }

  /**
   * Send error message to terminal
   * @private
   */
  _sendTerminalError(tabId, message) {
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;

    const errorMsg = `\r\n\x1b[31m${message}\x1b[0m\r\n`;
    if (this.terminalReadyState.get(tabId)) {
      view.webContents.send('terminal-data', errorMsg);
    } else {
      const buffer = this.terminalOutputBuffer.get(tabId) || [];
      buffer.push(errorMsg);
      this.terminalOutputBuffer.set(tabId, buffer);
    }
  }

  /**
   * Check for prompt and send notification
   * @private
   */
  _checkForPromptAndNotify(tabId) {
    const promptState = this.terminalPromptState.get(tabId);
    if (!promptState) return;

    const isCurrentlyWorking = CLAUDE_WORKING_PATTERN.test(promptState.recentOutput);

    if (isCurrentlyWorking) {
      promptState.wasWorking = true;
      if (this.promptCheckTimers.has(tabId)) {
        clearTimeout(this.promptCheckTimers.get(tabId));
        this.promptCheckTimers.delete(tabId);
      }
      return;
    }

    if (this.promptCheckTimers.has(tabId)) {
      clearTimeout(this.promptCheckTimers.get(tabId));
    }

    const timer = setTimeout(() => {
      if (promptState.hasNotifiedSinceLastInput) return;

      const recentLines = promptState.recentOutput.split('\n').slice(-5).join('\n');
      const isPromptReady = CLAUDE_PROMPT_PATTERNS.some(pattern => pattern.test(recentLines));
      const claudeFinishedWorking = promptState.wasWorking && !isCurrentlyWorking;

      if (claudeFinishedWorking || isPromptReady) {
        promptState.hasNotifiedSinceLastInput = true;
        promptState.wasWorking = false;
        this._sendTerminalNotification(tabId, recentLines);
      }
    }, 500);

    this.promptCheckTimers.set(tabId, timer);
  }

  /**
   * Send terminal notification
   * @private
   */
  _sendTerminalNotification(tabId, recentOutput) {
    const settings = this.store.get('notifications');
    if (!settings?.enabled) return;

    // Check notification mode
    const shouldNotify = (() => {
      switch (settings.mode) {
        case 'always':
          return true;
        case 'unfocused':
          return !this.mainWindow.isFocused();
        case 'inactive-tab':
          return this.activeTabId !== tabId;
        default:
          return true;
      }
    })();

    if (!shouldNotify) return;

    const promptState = this.terminalPromptState.get(tabId);
    let preview = promptState?.lastMessage || 'Ready for input';
    preview = preview.replace(/\s+/g, ' ').trim().slice(0, 100);

    const notification = new Notification({
      title: 'Claude Code',
      body: preview,
      silent: false
    });

    notification.on('click', () => {
      this.switchToTab(tabId);
      this.mainWindow.show();
      this.mainWindow.focus();
    });

    notification.show();
  }

  /**
   * Trigger usage update for a terminal (debounced)
   * @private
   */
  _triggerUsageUpdate(tabId) {
    if (this.usageUpdateTimers.has(tabId)) {
      clearTimeout(this.usageUpdateTimers.get(tabId));
    }

    const timer = setTimeout(async () => {
      const view = this.terminalViews.get(tabId);
      if (view && !view.webContents.isDestroyed()) {
        const usageData = await this._fetchUsageData();
        if (usageData) {
          view.webContents.send('usage-update', usageData);
        }
      }
    }, 2000);

    this.usageUpdateTimers.set(tabId, timer);
  }

  /**
   * Fetch usage data from Anthropic API
   * @private
   */
  async _fetchUsageData() {
    if (this.usageCache.data && Date.now() - this.usageCache.lastFetch < this.usageCache.fetchInterval) {
      return this.usageCache.data;
    }

    if (this.usageCache.pendingFetch) {
      return this.usageCache.pendingFetch;
    }

    this.usageCache.pendingFetch = (async () => {
      try {
        const accessToken = await this._getClaudeOAuthToken();

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
          throw new Error(`API returned ${response.status}`);
        }

        const apiData = await response.json();
        const result = this._parseUsageData(apiData);
        this.usageCache.data = result;
        this.usageCache.lastFetch = Date.now();
        this.usageCache.pendingFetch = null;
        return result;
      } catch (error) {
        console.error('Failed to fetch usage data:', error);
        this.usageCache.pendingFetch = null;
        return null;
      }
    })();

    return this.usageCache.pendingFetch;
  }

  /**
   * Get OAuth token from Keychain
   * @private
   */
  _getClaudeOAuthToken() {
    return new Promise((resolve, reject) => {
      execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], (error, stdout) => {
        if (error) {
          reject(new Error(`Failed to get credentials: ${error.message}`));
          return;
        }

        try {
          const hexString = stdout.trim();
          const rawBytes = Buffer.from(hexString, 'hex');
          const content = rawBytes.slice(1).toString('utf8');
          const match = content.match(/"claudeAiOauth"\s*:\s*\{\s*"accessToken"\s*:\s*"([^"]+)"/);
          if (!match) {
            reject(new Error('Could not find accessToken'));
            return;
          }
          resolve(match[1]);
        } catch (e) {
          reject(new Error(`Failed to parse credentials: ${e.message}`));
        }
      });
    });
  }

  /**
   * Parse usage API response
   * @private
   */
  _parseUsageData(apiData) {
    const session = this._parseSessionData(apiData);
    const weekly = this._parseWeeklyData(apiData);
    return { session, weekly };
  }

  _parseSessionData(apiData) {
    try {
      const fiveHour = apiData?.five_hour;
      if (fiveHour) {
        const percentUsed = Math.round(fiveHour.utilization || 0);
        const timeLeft = this._formatTimeRemaining(fiveHour.resets_at);
        return { percentUsed, timeLeft };
      }
    } catch (e) {
      console.error('Error parsing session data:', e);
    }
    return { percentUsed: 0, timeLeft: '--' };
  }

  _parseWeeklyData(apiData) {
    try {
      const sevenDay = apiData?.seven_day;
      if (sevenDay) {
        const percentUsed = Math.round(sevenDay.utilization || 0);
        const timeLeft = this._formatTimeRemaining(sevenDay.resets_at);
        return { percentUsed, timeLeft };
      }
    } catch (e) {
      console.error('Error parsing weekly data:', e);
    }
    return { percentUsed: 0, timeLeft: '--' };
  }

  _formatTimeRemaining(resetTimeStr) {
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
        return remainingHours > 0 ? `${diffDays}d ${remainingHours}h` : `${diffDays}d`;
      }

      if (diffHours > 0) {
        const remainingMins = diffMins % 60;
        return `${diffHours}h ${remainingMins}m`;
      }

      return `${diffMins}m`;
    } catch (e) {
      return '--';
    }
  }

  /**
   * Mark terminal as ready and flush buffered output
   * @param {string} tabId - The tab ID
   */
  markTerminalReady(tabId) {
    this.terminalReadyState.set(tabId, true);

    const buffer = this.terminalOutputBuffer.get(tabId);
    const view = this.terminalViews.get(tabId);

    if (buffer && buffer.length > 0 && view && !view.webContents.isDestroyed()) {
      buffer.forEach(data => {
        view.webContents.send('terminal-data', data);
      });
      this.terminalOutputBuffer.set(tabId, []);
    }
  }

  /**
   * Handle terminal input from renderer
   * @param {string} tabId - The tab ID
   * @param {string} data - The input data
   */
  handleTerminalInput(tabId, data) {
    const ptyProcess = this.terminalPtys.get(tabId);
    if (ptyProcess) {
      ptyProcess.write(data);

      // Reset notification state on Enter
      if (data.includes('\r') || data.includes('\n')) {
        const promptState = this.terminalPromptState.get(tabId);
        if (promptState) {
          promptState.hasNotifiedSinceLastInput = false;
          promptState.wasWorking = false;
          promptState.recentOutput = '';
          promptState.lastMessage = '';
        }
      }
    }
  }

  /**
   * Handle terminal resize
   * @param {string} tabId - The tab ID
   * @param {number} cols - New columns
   * @param {number} rows - New rows
   * @param {string} cwd - Working directory (for initial spawn)
   * @param {string} mode - PTY mode (for initial spawn)
   */
  handleTerminalResize(tabId, cols, rows, cwd = null, mode = 'normal') {
    const promptState = this.terminalPromptState.get(tabId);
    if (promptState) {
      promptState.cols = cols;
      promptState.rows = rows;
    }

    const ptyProcess = this.terminalPtys.get(tabId);
    if (ptyProcess) {
      try {
        ptyProcess.resize(cols, rows);
      } catch (e) {
        // Resize may fail if process is dead
      }
    } else if (cwd && this.terminalReadyState.get(tabId)) {
      // PTY not spawned yet - spawn it now
      this.setupTerminalPty(tabId, cwd, cols, rows, mode);
    }
  }

  /**
   * Reload a terminal (restart Claude)
   * @param {string} tabId - The tab ID
   * @param {string} cwd - Working directory
   */
  reloadTerminal(tabId, cwd) {
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;

    // Kill existing PTY
    const existingPty = this.terminalPtys.get(tabId);
    if (existingPty) {
      existingPty.kill();
      this.terminalPtys.delete(tabId);
    }

    // Clear and restart
    view.webContents.send('terminal-data', '\x1b[2J\x1b[H');
    view.webContents.send('terminal-data', '\x1b[90mRestarting Claude Code...\x1b[0m\r\n\r\n');

    const promptState = this.terminalPromptState.get(tabId) || {};
    const { cols = 80, rows = 30 } = promptState;

    this.setupTerminalPty(tabId, cwd, cols, rows, 'normal');
  }

  /**
   * Resume a terminal session
   * @param {string} tabId - The tab ID
   * @param {string} cwd - Working directory
   */
  resumeTerminal(tabId, cwd) {
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;

    const existingPty = this.terminalPtys.get(tabId);
    if (existingPty) {
      existingPty.kill();
      this.terminalPtys.delete(tabId);
    }

    view.webContents.send('terminal-data', '\x1b[2J\x1b[H');
    view.webContents.send('terminal-data', '\x1b[90mResuming Claude Code session...\x1b[0m\r\n\r\n');

    const promptState = this.terminalPromptState.get(tabId) || {};
    const { cols = 80, rows = 30 } = promptState;

    this.setupTerminalPty(tabId, cwd, cols, rows, 'continue');
  }

  /**
   * Request usage data for a terminal
   * @param {string} tabId - The tab ID
   */
  async requestUsageData(tabId) {
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;

    const usageData = await this._fetchUsageData();
    if (usageData) {
      view.webContents.send('usage-update', usageData);
    }
  }

  /**
   * Switch to a tab
   * @param {string} tabId - The tab ID to switch to
   */
  switchToTab(tabId) {
    if (this.activeTabId === tabId) return;

    // Remove current view
    if (this.activeTabId) {
      const currentWebView = this.webViews.get(this.activeTabId);
      const currentTerminalView = this.terminalViews.get(this.activeTabId);

      if (currentWebView) {
        this.mainWindow.removeBrowserView(currentWebView);
      }
      if (currentTerminalView) {
        this.mainWindow.removeBrowserView(currentTerminalView);
      }
    }

    // Add new view
    const webView = this.webViews.get(tabId);
    const terminalView = this.terminalViews.get(tabId);

    if (webView) {
      this.mainWindow.addBrowserView(webView);
    } else if (terminalView) {
      this.mainWindow.addBrowserView(terminalView);
    }

    this.activeTabId = tabId;
    this.updateViewBounds();
  }

  /**
   * Update view bounds based on window size
   */
  updateViewBounds() {
    if (!this.mainWindow) return;

    const [width, height] = this.mainWindow.getContentSize();
    const viewBounds = {
      x: SIDEBAR_WIDTH,
      y: 0,
      width: width - SIDEBAR_WIDTH,
      height: height
    };

    // Update all views
    for (const view of this.webViews.values()) {
      view.setBounds(viewBounds);
    }
    for (const view of this.terminalViews.values()) {
      view.setBounds(viewBounds);
    }
  }

  /**
   * Get the active tab ID
   * @returns {string|null}
   */
  getActiveTabId() {
    return this.activeTabId;
  }

  /**
   * Check if a view exists for a tab
   * @param {string} tabId
   * @returns {boolean}
   */
  hasView(tabId) {
    return this.webViews.has(tabId) || this.terminalViews.has(tabId);
  }

  /**
   * Destroy a tab's view and cleanup resources
   * @param {string} tabId - The tab ID
   */
  destroyView(tabId) {
    // Kill PTY if exists
    const ptyProcess = this.terminalPtys.get(tabId);
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch (e) {
        // Process may already be dead
      }
      this.terminalPtys.delete(tabId);
    }

    // Remove BrowserView
    const webView = this.webViews.get(tabId);
    const terminalView = this.terminalViews.get(tabId);

    if (webView) {
      if (this.activeTabId === tabId) {
        this.mainWindow.removeBrowserView(webView);
      }
      this.webViews.delete(tabId);
    }

    if (terminalView) {
      if (this.activeTabId === tabId) {
        this.mainWindow.removeBrowserView(terminalView);
      }
      this.terminalViews.delete(tabId);
    }

    // Cleanup terminal state
    this.terminalReadyState.delete(tabId);
    this.terminalOutputBuffer.delete(tabId);
    this.terminalPromptState.delete(tabId);

    if (this.promptCheckTimers.has(tabId)) {
      clearTimeout(this.promptCheckTimers.get(tabId));
      this.promptCheckTimers.delete(tabId);
    }

    if (this.usageUpdateTimers.has(tabId)) {
      clearTimeout(this.usageUpdateTimers.get(tabId));
      this.usageUpdateTimers.delete(tabId);
    }

    // Clear active if this was the active tab
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
    }
  }

  /**
   * Reload a web view
   * @param {string} tabId - The tab ID
   */
  reloadWebView(tabId) {
    const view = this.webViews.get(tabId);
    if (view) {
      view.webContents.reload();
    }
  }

  /**
   * Navigate back in web view
   * @param {string} tabId - The tab ID
   */
  goBack(tabId) {
    const view = this.webViews.get(tabId);
    if (view && view.webContents.canGoBack()) {
      view.webContents.goBack();
    }
  }

  /**
   * Navigate forward in web view
   * @param {string} tabId - The tab ID
   */
  goForward(tabId) {
    const view = this.webViews.get(tabId);
    if (view && view.webContents.canGoForward()) {
      view.webContents.goForward();
    }
  }

  /**
   * Focus the active view
   */
  focusActiveView() {
    if (!this.activeTabId) return;

    const webView = this.webViews.get(this.activeTabId);
    const terminalView = this.terminalViews.get(this.activeTabId);

    if (webView) {
      webView.webContents.focus();
    } else if (terminalView) {
      terminalView.webContents.focus();
    }
  }

  /**
   * Open devtools for a view
   * @param {string} tabId - The tab ID
   */
  openDevTools(tabId) {
    const webView = this.webViews.get(tabId);
    const terminalView = this.terminalViews.get(tabId);

    if (webView) {
      webView.webContents.openDevTools();
    } else if (terminalView) {
      terminalView.webContents.openDevTools();
    }
  }

  /**
   * Cleanup all resources
   */
  destroy() {
    // Kill all PTY processes
    for (const [tabId, ptyProcess] of this.terminalPtys) {
      try {
        ptyProcess.kill();
      } catch (e) {
        // Process may already be dead
      }
    }

    // Clear all timers
    for (const timer of this.promptCheckTimers.values()) {
      clearTimeout(timer);
    }
    for (const timer of this.usageUpdateTimers.values()) {
      clearTimeout(timer);
    }

    this.webViews.clear();
    this.terminalViews.clear();
    this.terminalPtys.clear();
    this.terminalReadyState.clear();
    this.terminalOutputBuffer.clear();
    this.terminalPromptState.clear();
    this.promptCheckTimers.clear();
    this.usageUpdateTimers.clear();
  }
}

module.exports = ViewManager;
