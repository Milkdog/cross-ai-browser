/**
 * ViewManager - Handles BrowserView and PTY lifecycle management
 *
 * Manages:
 * - BrowserView creation/destruction for web services
 * - Terminal BrowserView + PTY processes for Claude Code
 * - View switching and bounds management
 * - Session sharing for web services of the same type
 */

const { BrowserView, dialog, shell } = require('electron');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { getServiceType } = require('./ServiceRegistry');

// Allowed origins for navigation security
const ALLOWED_WEB_ORIGINS = [
  'https://chat.openai.com',
  'https://chatgpt.com',
  'https://auth.openai.com',
  'https://auth0.openai.com',
  'https://claude.ai',
  'https://gemini.google.com',
  'https://accounts.google.com',
  'https://auth0.com',
  'https://login.microsoftonline.com',
  'https://appleid.apple.com'
];

/**
 * Check if a URL origin is in the allowed list
 * @param {string} urlString - The URL to check
 * @returns {boolean} True if the origin is allowed
 */
function isAllowedOrigin(urlString) {
  try {
    const url = new URL(urlString);
    return ALLOWED_WEB_ORIGINS.some(allowed => {
      const allowedUrl = new URL(allowed);
      // Check exact origin match or valid subdomain
      return url.origin === allowedUrl.origin ||
        url.hostname.endsWith('.' + allowedUrl.hostname);
    });
  } catch {
    return false;
  }
}

// node-pty is optional (not available on Windows)
let pty = null;
try {
  pty = require('node-pty');
} catch (e) {
  console.log('node-pty not available - terminal features disabled');
}

const DEFAULT_SIDEBAR_WIDTH = 160;


class ViewManager {
  /**
   * @param {Object} options
   * @param {BrowserWindow} options.mainWindow - The main Electron window
   * @param {Object} options.store - electron-store instance
   * @param {Function} options.getSidebarWidth - Function to get current sidebar width
   * @param {Function} options.onTabsChanged - Callback when tabs change
   * @param {Function} options.onTerminalComplete - Callback when terminal task completes (tabId, message)
   * @param {HistoryManager} options.historyManager - Optional history manager for session recording
   * @param {HooksManager} options.hooksManager - Optional hooks manager for Claude Code hooks
   * @param {FirebaseSyncAdapter} options.firebaseSyncAdapter - Optional Firebase sync adapter
   */
  constructor({ mainWindow, store, getSidebarWidth, onTabsChanged, onTerminalComplete, historyManager, hooksManager, firebaseSyncAdapter }) {
    this.mainWindow = mainWindow;
    this.store = store;
    this.getSidebarWidth = getSidebarWidth || (() => DEFAULT_SIDEBAR_WIDTH);
    this.onTabsChanged = onTabsChanged;
    this.onTerminalComplete = onTerminalComplete;
    this.historyManager = historyManager;
    this.hooksManager = hooksManager;
    this.firebaseSyncAdapter = firebaseSyncAdapter;

    // View storage
    this.webViews = new Map();      // tabId -> BrowserView
    this.terminalViews = new Map(); // tabId -> BrowserView
    this.terminalPtys = new Map();  // tabId -> PTY process

    // Terminal state
    this.terminalReadyState = new Map();
    this.terminalOutputBuffer = new Map();
    this.terminalPromptState = new Map();

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

    // Hooks installation tracking
    this.hooksInstallAttempted = false;

    // Set up hooks event handlers
    this._setupHooksHandlers();
  }

  /**
   * Set up event handlers for Claude Code hooks
   * @private
   */
  _setupHooksHandlers() {
    if (!this.hooksManager) return;

    this.hooksManager.on('hook-triggered', (event) => {
      this._handleHookEvent(event);
    });
  }

  /**
   * Handle a hook event from Claude Code
   * @private
   */
  _handleHookEvent(event) {
    const { type, cwd, prompt, message } = event;

    // Find the tab ID for this cwd
    const tabId = this._getTabIdForCwd(cwd);
    if (!tabId) {
      console.warn('[ViewManager] Hook event for unknown cwd:', cwd);
      return;
    }

    switch (type) {
      case 'UserPromptSubmit':
        // Claude started working
        this._sendStreamingState(tabId, true, this._extractTaskDescription(prompt));
        break;

      case 'Stop':
        // Claude finished working
        this._sendStreamingState(tabId, false, null);
        // Delay slightly to allow final PTY output to arrive before extracting message
        setTimeout(() => {
          const completionMessage = this._extractCompletionMessage(tabId);
          this._sendCompletionEvent(tabId, completionMessage);
          // Notify main.js for system notification
          if (this.onTerminalComplete) {
            this.onTerminalComplete(tabId, completionMessage);
          }
          // Clear the recent output buffer after extracting the message
          const promptState = this.terminalPromptState.get(tabId);
          if (promptState) {
            promptState.recentOutput = '';
          }
        }, 300);
        break;

      case 'Notification':
        // Claude sent a notification (e.g., permission request)
        this._sendCompletionEvent(tabId, message || 'Claude needs attention');
        break;
    }
  }

  /**
   * Find tab ID by working directory
   * @private
   */
  _getTabIdForCwd(cwd) {
    if (!cwd) return null;

    // Normalize the cwd path for comparison
    const normalizedCwd = cwd.replace(/\/+$/, ''); // Remove trailing slashes

    // Debug: log what we're searching through
    const terminalViewIds = Array.from(this.terminalViews.keys());
    const cwdsInViews = terminalViewIds.map(id => ({
      id,
      cwd: this.store.get(`tabData.${id}.cwd`)
    }));
    console.log('[ViewManager] _getTabIdForCwd looking for:', normalizedCwd);
    console.log('[ViewManager] terminalViews has:', cwdsInViews);

    for (const [tabId] of this.terminalViews) {
      const tabCwd = this.store.get(`tabData.${tabId}.cwd`);
      if (tabCwd) {
        const normalizedTabCwd = tabCwd.replace(/\/+$/, '');
        if (normalizedCwd === normalizedTabCwd) {
          return tabId;
        }
      }
    }
    return null;
  }

  /**
   * Extract task description from prompt (first 50 chars)
   * @private
   */
  _extractTaskDescription(prompt, maxLength = 50) {
    if (!prompt) return null;
    const cleaned = prompt.trim().replace(/\s+/g, ' ');
    return cleaned.length > maxLength
      ? cleaned.substring(0, maxLength) + '...'
      : cleaned;
  }

  /**
   * Extract completion message from recent terminal output
   * Looks for text after the last ● (black circle) bullet character
   * @private
   */
  _extractCompletionMessage(tabId) {
    const promptState = this.terminalPromptState.get(tabId);
    if (!promptState || !promptState.recentOutput) {
      console.log('[ViewManager] No recent output for tab', tabId);
      return 'Task completed';
    }

    const rawOutput = promptState.recentOutput;

    // Search for white-colored ⏺ in raw output: \x1b[38;2;255;255;255m⏺
    // This is the specific pattern Claude Code uses for completion messages
    const whiteDotPattern = '\x1b[38;2;255;255;255m⏺';
    let lastDotIndex = rawOutput.lastIndexOf(whiteDotPattern);
    console.log('[ViewManager] White dot index:', lastDotIndex);

    if (lastDotIndex === -1) {
      // Fallback: search in cleaned output
      const cleanOutput = rawOutput.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      lastDotIndex = cleanOutput.lastIndexOf('⏺');
      if (lastDotIndex === -1) {
        return 'Task completed';
      }
      let message = cleanOutput.slice(lastDotIndex + 1).trim();
      const newlineIndex = message.indexOf('\n');
      if (newlineIndex !== -1) {
        message = message.slice(0, newlineIndex).trim();
      }
      message = message.replace(/\s+/g, ' ').trim();
      if (message.length > 100) {
        message = message.slice(0, 100) + '...';
      }
      return message || 'Task completed';
    }

    // Extract text after the white dot pattern, strip ANSI codes from the result
    let message = rawOutput.slice(lastDotIndex + whiteDotPattern.length);
    // Strip ANSI codes and take first line
    message = message.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();

    // Take just the first line
    const newlineIndex = message.indexOf('\n');
    if (newlineIndex !== -1) {
      message = message.slice(0, newlineIndex).trim();
    }

    // Clean up and limit length
    message = message.replace(/\s+/g, ' ').trim();
    if (message.length > 100) {
      message = message.slice(0, 100) + '...';
    }

    return message || 'Task completed';
  }

  /**
   * Send streaming state to sidebar and terminal
   * @private
   */
  _sendStreamingState(tabId, isStreaming, taskDescription) {
    // Send to sidebar
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('streaming-state-changed', {
        tabId,
        isStreaming,
        taskDescription
      });
    }
    // Send to terminal (for ready indicator)
    const terminalView = this.terminalViews.get(tabId);
    if (terminalView && !terminalView.webContents.isDestroyed()) {
      terminalView.webContents.send('terminal-streaming-state', isStreaming);
    }
  }

  /**
   * Send completion event (for badge and notification)
   * @private
   */
  _sendCompletionEvent(tabId, preview) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      // Use existing ai-response-complete channel which handles badges and notifications
      this.mainWindow.webContents.send('terminal-response-complete', {
        tabId,
        preview
      });
    }
  }

  /**
   * Ensure hooks are installed (called on first terminal spawn)
   * @private
   */
  async _ensureHooksInstalled() {
    if (this.hooksInstallAttempted || !this.hooksManager) return;

    this.hooksInstallAttempted = true;

    const isInstalled = await this.hooksManager.isInstalled();
    if (!isInstalled) {
      const result = await this.hooksManager.installHooks();
      if (!result.success) {
        console.warn('[ViewManager] Failed to install hooks:', result.error);
      }
    }
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
        sandbox: true,
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

    // Navigation security: Restrict navigation to allowed origins
    view.webContents.on('will-navigate', (event, navigationUrl) => {
      if (!isAllowedOrigin(navigationUrl)) {
        console.warn(`[ViewManager] Blocked navigation to: ${navigationUrl}`);
        event.preventDefault();
        // Open blocked URLs in external browser
        shell.openExternal(navigationUrl);
      }
    });

    // Handle new window requests (OAuth popups)
    // Uses strict hostname validation to prevent subdomain spoofing attacks
    view.webContents.setWindowOpenHandler(({ url }) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        // Invalid URL, deny
        return { action: 'deny' };
      }

      const hostname = parsedUrl.hostname;

      // Strict allowlist for OAuth/auth popup domains
      const allowedPopupHosts = [
        'accounts.google.com',
        'auth0.com',
        'login.microsoftonline.com',
        'appleid.apple.com',
        // The AI service domains themselves (for potential OAuth flows)
        'chat.openai.com',
        'chatgpt.com',
        'auth.openai.com',
        'auth0.openai.com',
        'claude.ai',
        'gemini.google.com'
      ];

      // Check if hostname exactly matches or is a valid subdomain of allowed hosts
      const isAllowedHost = allowedPopupHosts.some(allowed =>
        hostname === allowed || hostname.endsWith('.' + allowed)
      );

      if (isAllowedHost) {
        return { action: 'allow' };
      }

      // All other URLs open in external browser
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
        sandbox: true,
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

      // Ensure Claude Code hooks are installed (on first terminal spawn)
      this._ensureHooksInstalled();

      // Start history recording if enabled
      if (this.historyManager) {
        const sessionId = this.historyManager.startSession(tabId, cwd, { mode });
        if (sessionId) {
          this.terminalSessions.set(tabId, sessionId);
        }
      }

      // Update project info in Firebase (for folder name resolution)
      if (this.firebaseSyncAdapter) {
        this.firebaseSyncAdapter.updateProjectInfo(cwd).catch(err => {
          console.warn('[ViewManager] Failed to update Firebase project info:', err);
        });
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

    // Track output for usage updates and completion message extraction
    const promptState = this.terminalPromptState.get(tabId);
    if (promptState) {
      promptState.lastActivity = Date.now();
      // Keep a sliding window of recent output for extracting completion messages
      promptState.recentOutput = (promptState.recentOutput || '') + data;
      // Limit to last 4KB to avoid memory issues
      if (promptState.recentOutput.length > 4096) {
        promptState.recentOutput = promptState.recentOutput.slice(-4096);
      }
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
          const rawData = stdout.trim();

          // Handle both hex-encoded and plain text formats
          let content;
          if (/^[0-9a-fA-F]+$/.test(rawData)) {
            const rawBytes = Buffer.from(rawData, 'hex');
            content = rawBytes.slice(1).toString('utf8');
          } else {
            content = rawData;
          }

          // Try primary pattern (nested under claudeAiOauth)
          const match = content.match(/"claudeAiOauth"\s*:\s*\{\s*"accessToken"\s*:\s*"([^"]+)"/);
          if (match) {
            resolve(match[1]);
            return;
          }

          // Try alternate pattern (accessToken at top level)
          const altMatch = content.match(/"accessToken"\s*:\s*"([^"]+)"/);
          if (altMatch) {
            resolve(altMatch[1]);
            return;
          }

          reject(new Error('Could not find accessToken in credentials'));
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
   * Broadcast a message to all terminal views that have a specific cwd
   * @param {string} cwd - The working directory to match
   * @param {string} channel - The IPC channel name
   * @param {Object} data - Data to send
   */
  broadcastToTerminalsWithCwd(cwd, channel, data) {
    for (const [tabId, view] of this.terminalViews) {
      const tabCwd = this.store.get(`tabData.${tabId}.cwd`);
      if (tabCwd === cwd && !view.webContents.isDestroyed()) {
        view.webContents.send(channel, data);
      }
    }
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
    this.terminalPromptState.delete(tabId);

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
    for (const timer of this.usageUpdateTimers.values()) {
      clearTimeout(timer);
    }

    this.webViews.clear();
    this.terminalViews.clear();
    this.terminalPtys.clear();
    this.terminalReadyState.clear();
    this.terminalOutputBuffer.clear();
    this.terminalPromptState.clear();
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
