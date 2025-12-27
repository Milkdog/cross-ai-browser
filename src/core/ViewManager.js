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
const os = require('os');
const { execFile } = require('child_process');
const { getServiceType } = require('./ServiceRegistry');

// node-pty is optional (not available on Windows)
let pty = null;
try {
  pty = require('node-pty');
} catch (e) {
  console.log('node-pty not available - terminal features disabled');
}

const DEFAULT_SIDEBAR_WIDTH = 160;

// Patterns that indicate Claude Code is actively working
// These should ONLY match content that appears while Claude is actively processing
const CLAUDE_WORKING_PATTERNS = [
  /Esc to interrupt/i,
  /escape to interrupt/i,
  // Spinner characters used by Claude Code (braille spinners)
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,
];

// Check if Claude is currently working
// Check recent output for working indicators
function isClaudeWorking(text, debug = false) {
  // Check the last 800 chars to handle longer output like to-do lists
  // but not so much that we match old content
  const recentText = text.slice(-800);

  if (debug) {
    // Always log pattern check results when debugging
    const results = CLAUDE_WORKING_PATTERNS.map(p => ({
      pattern: p.toString(),
      matches: p.test(recentText)
    }));
    const hasEscText = recentText.toLowerCase().includes('esc to interrupt');
    console.log('[ViewManager] Pattern check:', {
      hasEscText,
      textLen: recentText.length,
      last100: recentText.slice(-100),
      results
    });
  }

  for (const pattern of CLAUDE_WORKING_PATTERNS) {
    if (pattern.test(recentText)) {
      return true;
    }
  }
  return false;
}

// Patterns that indicate Claude Code is ready for user input
const CLAUDE_PROMPT_PATTERNS = [
  />\s*$/,
  /\?\s*$/,
  /\[Y\/n\]\s*$/i,
  /\[y\/N\]\s*$/i,
  /\(y\/n\)\s*$/i,
  /Press Enter/i,
  /Claude Code/i,  // The prompt line
];

class ViewManager {
  /**
   * @param {Object} options
   * @param {BrowserWindow} options.mainWindow - The main Electron window
   * @param {Object} options.store - electron-store instance
   * @param {Function} options.getSidebarWidth - Function to get current sidebar width
   * @param {Function} options.onTabsChanged - Callback when tabs change
   * @param {HistoryManager} options.historyManager - Optional history manager for session recording
   * @param {Function} options.onTerminalCompleted - Callback when terminal task completes
   */
  constructor({ mainWindow, store, getSidebarWidth, onTabsChanged, historyManager, onTerminalCompleted }) {
    this.mainWindow = mainWindow;
    this.store = store;
    this.getSidebarWidth = getSidebarWidth || (() => DEFAULT_SIDEBAR_WIDTH);
    this.onTabsChanged = onTabsChanged;
    this.historyManager = historyManager;
    this.onTerminalCompleted = onTerminalCompleted;

    // View storage
    this.webViews = new Map();      // tabId -> BrowserView
    this.terminalViews = new Map(); // tabId -> BrowserView
    this.terminalPtys = new Map();  // tabId -> PTY process

    // Terminal state
    this.terminalReadyState = new Map();
    this.terminalOutputBuffer = new Map();
    this.terminalPromptState = new Map();
    this.promptCheckTimers = new Map();

    // History session tracking: tabId -> sessionId
    this.terminalSessions = new Map();

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
      rows: 30,
      startupGracePeriod: true,  // Suppress notifications during initial load
      hasHadUserInput: false,    // Track if user has sent any input
      stoppedDebounceTimer: null // Debounce timer for "stopped working" detection
    });

    // End startup grace period after 5 seconds
    setTimeout(() => {
      const state = this.terminalPromptState.get(tab.id);
      if (state && state.startupGracePeriod) {
        console.log(`[ViewManager] Ending startup grace period for tab ${tab.id}`);
        state.startupGracePeriod = false;
      }
    }, 5000);

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
    if (!pty) {
      this._sendTerminalError(tabId, 'Terminal not available on this platform');
      return null;
    }

    // Check if there's already a PTY for this tab
    const existingPty = this.terminalPtys.get(tabId);
    if (existingPty) {
      return existingPty;
    }

    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';

    // Build claude command based on mode
    let claudeCmd = 'claude';
    if (mode === 'continue' || mode === true) {
      claudeCmd = 'claude --continue';
    } else if (mode === 'resume') {
      claudeCmd = 'claude --resume';
    }

    // Use login shell (-l) to ensure PATH is set up from user's profile
    // This is crucial for packaged apps launched from Finder
    const shellArgs = process.platform === 'win32'
      ? ['-Command', claudeCmd]
      : ['-l', '-c', claudeCmd];

    // Build environment with common PATH additions for CLI tools
    const env = { ...process.env, TERM: 'xterm-256color' };
    if (process.platform !== 'win32') {
      // Ensure common CLI tool directories are in PATH
      const homedir = os.homedir();
      const additionalPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        `${homedir}/.local/bin`,
        `${homedir}/.npm-global/bin`,
        `${homedir}/.nvm/versions/node/*/bin`,
        '/usr/local/opt/node/bin'
      ].join(':');
      env.PATH = `${additionalPaths}:${env.PATH || '/usr/bin:/bin'}`;
    }

    try {
      const ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env
      });

      this.terminalPtys.set(tabId, ptyProcess);

      // Start history recording if enabled
      if (this.historyManager) {
        const sessionId = this.historyManager.startSession(tabId, cwd, { mode });
        if (sessionId) {
          this.terminalSessions.set(tabId, sessionId);
        }
      }

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

    // Capture to history
    const sessionId = this.terminalSessions.get(tabId);
    if (sessionId && this.historyManager) {
      this.historyManager.captureOutput(sessionId, data);
    }

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
      // Comprehensive ANSI/terminal escape sequence stripping
      const cleanData = data
        // CSI sequences: \x1b[...
        .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        // OSC sequences: \x1b]...\x07 or \x1b]...\x1b\\
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        // Single character escapes
        .replace(/\x1b[78DMEcn]/g, '')
        // Two character escapes
        .replace(/\x1b[()][AB012]/g, '')
        // Control characters (except newline/carriage return)
        .replace(/[\x00-\x09\x0b\x0c\x0e-\x1a\x1c-\x1f]/g, '');
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

    // End history session
    const sessionId = this.terminalSessions.get(tabId);
    if (sessionId && this.historyManager) {
      this.historyManager.endSession(sessionId, exitCode).catch(err => {
        console.error(`Failed to save history session ${sessionId}:`, err);
      });
      this.terminalSessions.delete(tabId);
    }

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
   * Send a message to the terminal (public method for IPC handlers)
   * @param {string} tabId - The tab ID
   * @param {string} message - The message to send (can include ANSI codes)
   */
  sendTerminalMessage(tabId, message) {
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;

    if (this.terminalReadyState.get(tabId)) {
      view.webContents.send('terminal-data', message);
    } else {
      const buffer = this.terminalOutputBuffer.get(tabId) || [];
      buffer.push(message);
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

    // Debug: Log working state checks periodically
    const shouldDebug = !promptState.lastDebugLog || Date.now() - promptState.lastDebugLog > 5000;
    const isCurrentlyWorking = isClaudeWorking(promptState.recentOutput, shouldDebug);

    if (shouldDebug) {
      const recentSnippet = promptState.recentOutput.slice(-300).replace(/\n/g, '\\n');
      console.log('[ViewManager] Working check:', {
        tabId,
        isCurrentlyWorking,
        wasWorking: promptState.wasWorking,
        recentOutputLen: promptState.recentOutput.length,
        snippet: recentSnippet
      });
      promptState.lastDebugLog = Date.now();
    }

    // Track when streaming state changes for terminal (with debouncing)
    if (isCurrentlyWorking && !promptState.wasWorking) {
      // Started working - clear any pending "stopped" timer and update immediately
      if (promptState.stoppedDebounceTimer) {
        clearTimeout(promptState.stoppedDebounceTimer);
        promptState.stoppedDebounceTimer = null;
      }
      console.log('[ViewManager] Claude started working, tab:', tabId);
      promptState.wasWorking = true;
      this._sendTerminalStreamingState(tabId, true, promptState.lastMessage);
    } else if (!isCurrentlyWorking && promptState.wasWorking) {
      // Stopped working - debounce to avoid rapid oscillation
      if (!promptState.stoppedDebounceTimer) {
        promptState.stoppedDebounceTimer = setTimeout(() => {
          promptState.stoppedDebounceTimer = null;
          // Re-check if still not working
          if (!isClaudeWorking(promptState.recentOutput)) {
            console.log('[ViewManager] Claude stopped working (confirmed), tab:', tabId);
            promptState.wasWorking = false;
            this._sendTerminalStreamingState(tabId, false, null);
          }
        }, 500); // Wait 500ms before confirming "stopped"
      }
    }

    if (isCurrentlyWorking) {
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
      if (promptState.hasNotifiedSinceLastInput) {
        console.log('[ViewManager] Skipping notification - already notified since last input');
        return;
      }

      const recentLines = promptState.recentOutput.split('\n').slice(-5).join('\n');
      const isPromptReady = CLAUDE_PROMPT_PATTERNS.some(pattern => pattern.test(recentLines));
      const claudeFinishedWorking = promptState.wasWorking && !isCurrentlyWorking;

      console.log('[ViewManager] Notification check:', {
        tabId,
        wasWorking: promptState.wasWorking,
        isCurrentlyWorking,
        claudeFinishedWorking,
        isPromptReady,
        recentLinesPreview: recentLines.slice(-100)
      });

      if (claudeFinishedWorking || isPromptReady) {
        console.log('[ViewManager] Sending notification for tab:', tabId);
        promptState.hasNotifiedSinceLastInput = true;
        promptState.wasWorking = false;
        this._sendTerminalNotification(tabId, recentLines);
      }
    }, 200);  // Reduced from 500ms for faster detection

    this.promptCheckTimers.set(tabId, timer);
  }

  /**
   * Send terminal streaming state to main window
   * @private
   */
  _sendTerminalStreamingState(tabId, isStreaming, taskDescription) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('streaming-state-changed', {
        tabId,
        isStreaming,
        taskDescription: taskDescription || (isStreaming ? 'Working...' : null)
      });
    }
  }

  /**
   * Send terminal notification
   * @private
   */
  _sendTerminalNotification(tabId, recentOutput) {
    // Check if we're in startup grace period (suppress false notifications on initial load)
    const promptState = this.terminalPromptState.get(tabId);
    if (promptState?.startupGracePeriod && !promptState?.hasHadUserInput) {
      console.log('[ViewManager] Suppressing notification - startup grace period, no user input yet');
      return;
    }

    // Always notify parent of completion (for badge)
    if (this.onTerminalCompleted) {
      this.onTerminalCompleted(tabId);
    }

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

      const promptState = this.terminalPromptState.get(tabId);
      if (promptState) {
        // Mark that user has sent input - enables notifications after startup
        promptState.hasHadUserInput = true;
        promptState.startupGracePeriod = false;

        // Reset notification state on Enter
        if (data.includes('\r') || data.includes('\n')) {
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

    const sidebarWidth = this.getSidebarWidth();
    const [width, height] = this.mainWindow.getContentSize();
    const viewBounds = {
      x: sidebarWidth,
      y: 0,
      width: width - sidebarWidth,
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
   * Get tab ID by webContents
   * @param {WebContents} webContents - The webContents to find
   * @returns {string|null} The tab ID or null if not found
   */
  getTabIdByWebContents(webContents) {
    for (const [tabId, view] of this.webViews) {
      if (view.webContents === webContents) {
        return tabId;
      }
    }
    for (const [tabId, view] of this.terminalViews) {
      if (view.webContents === webContents) {
        return tabId;
      }
    }
    return null;
  }

  /**
   * Destroy a tab's view and cleanup resources
   * @param {string} tabId - The tab ID
   */
  destroyView(tabId) {
    // End or abort history session
    const sessionId = this.terminalSessions.get(tabId);
    if (sessionId && this.historyManager) {
      // Try to end gracefully (save what we have)
      this.historyManager.endSession(sessionId, -1).catch(() => {
        // If end fails, abort
        this.historyManager.abortSession(sessionId);
      });
      this.terminalSessions.delete(tabId);
    }

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

    // Clear debounce timer before deleting state
    const promptState = this.terminalPromptState.get(tabId);
    if (promptState?.stoppedDebounceTimer) {
      clearTimeout(promptState.stoppedDebounceTimer);
    }
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
    // End all active history sessions
    if (this.historyManager) {
      for (const [tabId, sessionId] of this.terminalSessions) {
        this.historyManager.abortSession(sessionId);
      }
    }
    this.terminalSessions.clear();

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

  /**
   * Broadcast a message to all terminal views
   * @param {string} channel - IPC channel name
   * @param {*} data - Data to send
   */
  broadcastToTerminals(channel, data) {
    for (const [tabId, view] of this.terminalViews) {
      try {
        view.webContents.send(channel, data);
      } catch (e) {
        // View may be destroyed
      }
    }
  }
}

module.exports = ViewManager;
