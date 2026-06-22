/**
 * ViewManager - Handles WebContentsView and PTY lifecycle management
 *
 * Manages:
 * - WebContentsView creation/destruction for web services
 * - Terminal WebContentsView + PTY processes for Claude Code
 * - View switching and bounds management
 * - Session sharing for web services of the same type
 */

const { WebContentsView, dialog, shell, Menu, clipboard, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { getServiceType } = require('./ServiceRegistry');
const UsageMonitor = require('./UsageMonitor');

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
   * @param {Function} options.onTerminalComplete - Callback when terminal task completes (tabId, message, event)
   * @param {HistoryManager} options.historyManager - Optional history manager for session recording
   * @param {HooksManager} options.hooksManager - Optional hooks manager for Claude Code hooks
   * @param {FirebaseSyncAdapter} options.firebaseSyncAdapter - Optional Firebase sync adapter
   */
  constructor({ mainWindow, store, getSidebarWidth, onTabsChanged, onTerminalComplete, historyManager, hooksManager, firebaseSyncAdapter, secretsManager }) {
    this.mainWindow = mainWindow;
    this.store = store;
    this.getSidebarWidth = getSidebarWidth || (() => DEFAULT_SIDEBAR_WIDTH);
    this.onTabsChanged = onTabsChanged;
    this.onTerminalComplete = onTerminalComplete;
    this.historyManager = historyManager;
    this.hooksManager = hooksManager;
    this.firebaseSyncAdapter = firebaseSyncAdapter;
    this.secretsManager = secretsManager;

    // View storage
    this.webViews = new Map();      // tabId -> WebContentsView
    this.terminalViews = new Map(); // tabId -> WebContentsView
    this.terminalPtys = new Map();  // tabId -> PTY process

    // Terminal state
    this.terminalReadyState = new Map();
    this.terminalOutputBuffer = new Map();
    this.terminalPromptState = new Map();
    // Tabs showing the Resume/New/Close choice overlay (no PTY running). While a
    // tab is in here, a resize must NOT lazily auto-spawn a session behind it.
    this.awaitingSessionChoice = new Set();

    // History session tracking: tabId -> sessionId
    this.terminalSessions = new Map();

    // Streaming safety timeout: tabId -> setTimeout ID
    this.streamingTimeouts = new Map();
    // Subagent depth tracking: tabId -> count of active subagents
    this.subagentDepth = new Map();
    this.STREAMING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

    // Hook session routing: bind a Claude Code sessionId to a specific tab so
    // multiple tabs in the same cwd don't cross-pollute their streaming state.
    this.hookSessionToTab = new Map();   // sessionId -> tabId
    this.hookTabToSession = new Map();   // tabId -> sessionId (active binding)

    // Usage bars for Claude Code tabs — polling/parsing lives in UsageMonitor;
    // we just broadcast its payloads to terminal views.
    this.usageMonitor = new UsageMonitor({
      onUsage: (payload) => this.broadcastToTerminals('usage-update', payload),
      hasConsumers: () => this.terminalViews.size > 0
    });

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
    const { type, cwd, sessionId } = event;

    // Resolve the tab ID. Events from our own terminals carry it directly;
    // otherwise fall back to sessionId binding / cwd matching.
    const tabId = this._getTabIdForHookEvent(sessionId, cwd, event.tabId);
    if (!tabId) {
      console.warn('[ViewManager] Hook event for unknown cwd:', cwd);
      return;
    }

    switch (type) {
      case 'UserPromptSubmit':
        // Claude started working - start streaming with safety timeout
        this.subagentDepth.set(tabId, 0);
        this._setStreamingWithTimeout(tabId, true, this._extractTaskDescription(event.prompt));
        break;

      case 'Stop': {
        if (event.stopHookActive) {
          // Conversation continuing (e.g., tool use approval) - keep streaming, reset timeout
          this._resetStreamingTimeout(tabId);
          break;
        }
        const depth = this.subagentDepth.get(tabId) || 0;
        if (depth > 0) {
          // Subagents still active - keep streaming, reset timeout
          this._resetStreamingTimeout(tabId);
          break;
        }
        // Fully stopped - clear streaming and notify
        this._setStreamingWithTimeout(tabId, false, null);
        const completionMessage = this._extractMessageFromHook(event.lastAssistantMessage);
        this._sendCompletionEvent(tabId, completionMessage);
        if (this.onTerminalComplete) {
          this.onTerminalComplete(tabId, completionMessage, event);
        }
        break;
      }

      case 'SubagentStart':
        this.subagentDepth.set(tabId, (this.subagentDepth.get(tabId) || 0) + 1);
        this._resetStreamingTimeout(tabId);
        break;

      case 'SubagentStop':
        this.subagentDepth.set(tabId, Math.max(0, (this.subagentDepth.get(tabId) || 0) - 1));
        this._resetStreamingTimeout(tabId);
        break;

      // case 'TaskCompleted': {
      //   // Task finished - always stop streaming
      //   this._setStreamingWithTimeout(tabId, false, null);
      //   const taskMessage = event.taskSubject || 'Task completed';
      //   this._sendCompletionEvent(tabId, taskMessage);
      //   if (this.onTerminalComplete) {
      //     this.onTerminalComplete(tabId, taskMessage, event);
      //   }
      //   break;
      // }

      case 'Notification': {
        // Skip idle_prompt — it's redundant with the Stop hook's "finished" notification
        if (event.notificationType === 'idle_prompt') break;

        // Actionable notifications: permission_prompt, elicitation_dialog, etc.
        const notifMessage = event.message || 'Claude needs attention';
        this._sendCompletionEvent(tabId, notifMessage);
        if (this.onTerminalComplete) {
          this.onTerminalComplete(tabId, notifMessage, event);
        }
        break;
      }

      case 'PreToolUse': {
        // Update streaming task description with current tool activity
        const toolDesc = this._formatToolActivity(event.toolName, event.toolInput);
        if (toolDesc) {
          this._sendStreamingState(tabId, true, toolDesc);
          this._resetStreamingTimeout(tabId);
        }
        break;
      }
    }
  }

  /**
   * Find every tab ID whose cwd matches the given path (exact match preferred,
   * then subdirectory matches for subagent invocations from child dirs).
   * @private
   */
  _findTabIdsForCwd(cwd) {
    if (!cwd) return [];
    const normalizedCwd = cwd.replace(/\/+$/, '');

    const exact = [];
    const subdir = [];
    for (const [tabId] of this.terminalViews) {
      const tabCwd = this.store.get(`tabData.${tabId}.cwd`);
      if (!tabCwd) continue;
      const normalizedTabCwd = tabCwd.replace(/\/+$/, '');
      if (normalizedCwd === normalizedTabCwd) {
        exact.push(tabId);
      } else if (normalizedCwd.startsWith(normalizedTabCwd + '/')) {
        subdir.push({ tabId, depth: normalizedTabCwd.length });
      }
    }

    // Deeper tab cwds are more specific parents of the event cwd; among equals
    // (and among exact matches) prefer the active tab over creation order.
    const activeFirst = (a, b) =>
      (b === this.activeTabId) - (a === this.activeTabId);
    exact.sort(activeFirst);
    subdir.sort((a, b) =>
      (b.depth - a.depth) || activeFirst(a.tabId, b.tabId));

    return [...exact, ...subdir.map(s => s.tabId)];
  }

  /**
   * Find tab ID by working directory (back-compat: returns the first match).
   * Prefer `_getTabIdForHookEvent` when a sessionId is available — it
   * disambiguates multiple tabs sharing the same cwd.
   * @private
   */
  _getTabIdForCwd(cwd) {
    return this._findTabIdsForCwd(cwd)[0] || null;
  }

  /**
   * Resolve the tab a hook event belongs to. Events from our own terminals
   * carry the tab ID directly (CROSSAI_TAB_ID env var forwarded by the hook
   * command); the sessionId binding and cwd heuristic only cover Claude Code
   * sessions started outside the app.
   * @private
   */
  _getTabIdForHookEvent(sessionId, cwd, eventTabId) {
    // Exact attribution: the event tells us which terminal it came from.
    if (eventTabId && this.terminalViews.has(eventTabId)) {
      if (sessionId) this._bindHookSession(sessionId, eventTabId);
      return eventTabId;
    }

    if (sessionId && this.hookSessionToTab.has(sessionId)) {
      const cached = this.hookSessionToTab.get(sessionId);
      // Drop the binding if the tab has gone away.
      if (this.terminalViews.has(cached)) return cached;
      this.hookSessionToTab.delete(sessionId);
      this.hookTabToSession.delete(cached);
    }

    const candidates = this._findTabIdsForCwd(cwd);
    if (candidates.length === 0) return null;

    // Prefer a tab not already bound to a different (live) session.
    let chosen = candidates.find(tabId => {
      const existingSession = this.hookTabToSession.get(tabId);
      return !existingSession || !this.hookSessionToTab.has(existingSession);
    });
    if (!chosen) chosen = candidates[0]; // fall back: ambiguous, keep prior behavior

    if (sessionId) this._bindHookSession(sessionId, chosen);
    return chosen;
  }

  /**
   * Bind a Claude Code sessionId to a tab, evicting any stale binding.
   * @private
   */
  _bindHookSession(sessionId, tabId) {
    const oldSession = this.hookTabToSession.get(tabId);
    if (oldSession && oldSession !== sessionId) {
      this.hookSessionToTab.delete(oldSession);
    }
    this.hookSessionToTab.set(sessionId, tabId);
    this.hookTabToSession.set(tabId, sessionId);
  }

  /**
   * Drop the hook session binding for a tab (Claude exited or restarted in it,
   * or the tab closed). Without this, the dead session keeps the tab "taken"
   * and its next session gets misrouted to another tab.
   * @private
   */
  _clearHookSessionBinding(tabId) {
    const boundSession = this.hookTabToSession.get(tabId);
    if (boundSession) {
      this.hookSessionToTab.delete(boundSession);
      this.hookTabToSession.delete(tabId);
    }
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
   * Extract notification body from the Stop hook's last_assistant_message
   * Takes the first line, cleans whitespace, truncates to 150 chars
   * @private
   */
  _extractMessageFromHook(lastAssistantMessage) {
    if (!lastAssistantMessage) return 'Task completed';

    // Take the first non-empty line
    const lines = lastAssistantMessage.split('\n');
    let message = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        message = trimmed;
        break;
      }
    }

    if (!message) return 'Task completed';

    // Clean whitespace and truncate
    message = message.replace(/\s+/g, ' ').trim();
    if (message.length > 150) {
      message = message.slice(0, 150) + '...';
    }

    return message;
  }

  /**
   * Format tool activity into a human-readable description
   * @private
   */
  _formatToolActivity(toolName, toolInput) {
    if (!toolName) return null;

    switch (toolName) {
      case 'Bash':
        if (toolInput && toolInput.command) {
          const cmd = toolInput.command.length > 60
            ? toolInput.command.slice(0, 60) + '...'
            : toolInput.command;
          return `Running: ${cmd}`;
        }
        return 'Running command';
      case 'Edit':
      case 'Write':
        if (toolInput && toolInput.file_path) {
          const fileName = toolInput.file_path.split('/').pop();
          return `Editing: ${fileName}`;
        }
        return 'Editing file';
      case 'Read':
        if (toolInput && toolInput.file_path) {
          const fileName = toolInput.file_path.split('/').pop();
          return `Reading: ${fileName}`;
        }
        return 'Reading file';
      case 'Grep':
        if (toolInput && toolInput.pattern) {
          return `Searching: ${toolInput.pattern}`;
        }
        return 'Searching code';
      case 'Glob':
        if (toolInput && toolInput.pattern) {
          return `Finding: ${toolInput.pattern}`;
        }
        return 'Finding files';
      case 'Task':
        return 'Running agent';
      case 'WebSearch':
        return 'Searching web';
      case 'WebFetch':
        return 'Fetching URL';
      default:
        return `Using ${toolName}`;
    }
  }

  /**
   * Set streaming state with a safety timeout to prevent stuck indicators
   * @private
   */
  _setStreamingWithTimeout(tabId, isStreaming, taskDescription) {
    this._sendStreamingState(tabId, isStreaming, taskDescription);

    if (isStreaming) {
      this._resetStreamingTimeout(tabId);
    } else {
      this._clearStreamingTimeout(tabId);
    }
  }

  /**
   * Reset the safety timeout for streaming (called on activity)
   * @private
   */
  _resetStreamingTimeout(tabId) {
    this._clearStreamingTimeout(tabId);

    const timeoutId = setTimeout(() => {
      console.warn(`[ViewManager] Streaming timeout reached for tab ${tabId}, forcing off`);
      this._sendStreamingState(tabId, false, null);
      this.streamingTimeouts.delete(tabId);
      this.subagentDepth.delete(tabId);
    }, this.STREAMING_TIMEOUT_MS);

    this.streamingTimeouts.set(tabId, timeoutId);
  }

  /**
   * Clear the safety timeout for streaming
   * @private
   */
  _clearStreamingTimeout(tabId) {
    const existing = this.streamingTimeouts.get(tabId);
    if (existing) {
      clearTimeout(existing);
      this.streamingTimeouts.delete(tabId);
    }
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
   * Send terminal running state to sidebar
   * @private
   */
  _sendTerminalRunningState(tabId, isRunning) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('terminal-running-state-changed', {
        tabId,
        isRunning
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
   * @returns {WebContentsView} The created view
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
   * Attach a standard browser-style context menu to a WebContentsView.
   * Includes spelling suggestions in editable fields, link/image actions,
   * and Cut/Copy/Paste. Safe to call once per view.
   * @private
   */
  _attachContextMenu(view) {
    if (!view || !view.webContents) return;

    view.webContents.on('context-menu', (_event, params) => {
      const template = [];
      const wc = view.webContents;

      // Spelling suggestions for misspelled words in editable fields
      if (params.misspelledWord) {
        if (Array.isArray(params.dictionarySuggestions) && params.dictionarySuggestions.length > 0) {
          for (const suggestion of params.dictionarySuggestions) {
            template.push({
              label: suggestion,
              click: () => wc.replaceMisspelling(suggestion)
            });
          }
        } else {
          template.push({ label: 'No spelling suggestions', enabled: false });
        }
        template.push({
          label: 'Add to Dictionary',
          click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord)
        });
        template.push({ type: 'separator' });
      }

      // Link actions
      if (params.linkURL) {
        template.push({
          label: 'Open Link in Browser',
          click: () => shell.openExternal(params.linkURL)
        });
        template.push({
          label: 'Copy Link',
          click: () => clipboard.writeText(params.linkURL)
        });
        template.push({ type: 'separator' });
      }

      // Image actions
      if (params.hasImageContents && params.srcURL) {
        template.push({
          label: 'Save Image As…',
          click: () => wc.downloadURL(params.srcURL)
        });
        template.push({
          label: 'Copy Image',
          click: () => wc.copyImageAt(params.x, params.y)
        });
        template.push({
          label: 'Copy Image Address',
          click: () => clipboard.writeText(params.srcURL)
        });
        template.push({ type: 'separator' });
      }

      // Editing / clipboard actions
      const { editFlags } = params;
      if (editFlags?.canCut) template.push({ role: 'cut' });
      if (editFlags?.canCopy) template.push({ role: 'copy' });
      if (editFlags?.canPaste) template.push({ role: 'paste' });

      // Copy plain selection when the field isn't editable
      if (params.selectionText && !editFlags?.canCopy) {
        template.push({
          label: 'Copy',
          click: () => clipboard.writeText(params.selectionText)
        });
      }

      // Web search for the selected text (web views only; harmless if triggered elsewhere)
      if (params.selectionText && params.selectionText.trim().length > 0) {
        const query = params.selectionText.trim().slice(0, 200);
        template.push({ type: 'separator' });
        template.push({
          label: `Search Google for "${query.length > 30 ? query.slice(0, 30) + '…' : query}"`,
          click: () => shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`)
        });
      }

      // Navigation helpers when clicking empty page area
      if (template.length === 0 || (!params.linkURL && !params.hasImageContents && !params.selectionText && !editFlags?.canPaste)) {
        if (template.length > 0) template.push({ type: 'separator' });
        if (wc.canGoBack()) template.push({ label: 'Back', click: () => wc.goBack() });
        if (wc.canGoForward()) template.push({ label: 'Forward', click: () => wc.goForward() });
        template.push({ label: 'Reload', click: () => wc.reload() });
      }

      if (template.length === 0) return;

      const win = BrowserWindow.fromWebContents(wc) || this.mainWindow;
      Menu.buildFromTemplate(template).popup({ window: win });
    });
  }

  /**
   * Create a web service WebContentsView
   * @private
   */
  _createWebView(tab, serviceType) {
    const view = new WebContentsView({
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

    // Standard browser-style right-click menu (spelling, links, images, clipboard)
    this._attachContextMenu(view);

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
   * Create a terminal WebContentsView
   * @private
   */
  _createTerminalView(tab) {
    const view = new WebContentsView({
      webPreferences: {
        preload: this._getPreloadPath('terminal'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        acceptFirstMouse: true
      }
    });

    this.terminalViews.set(tab.id, view);

    // Context menu for terminal tabs too (mainly enables Paste and spelling in
    // the prompt library editor that lives inside the same WebContentsView).
    this._attachContextMenu(view);

    this.usageMonitor.start();

    // Initialize terminal state
    this.terminalReadyState.set(tab.id, false);
    this.terminalOutputBuffer.set(tab.id, []);
    this.terminalPromptState.set(tab.id, {
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

    // Use login + interactive shell (-l -i) so both .zprofile/.zlogin and .zshrc
    // are sourced. Login mode ensures PATH is set up for packaged apps launched
    // from Finder; interactive mode picks up aliases/functions/exports in .zshrc.
    const shellArgs = process.platform === 'win32'
      ? ['-Command', claudeCmd]
      : ['-l', '-i', '-c', claudeCmd];

    // Build environment with common PATH additions for CLI tools.
    // CROSSAI_TAB_ID lets the Claude Code hook command report exactly which
    // terminal tab an event came from (forwarded as an HTTP header).
    const env = { ...process.env, TERM: 'xterm-256color', CROSSAI_TAB_ID: tabId };
    if (process.platform !== 'win32') {
      // Ensure common CLI tool directories are in PATH
      const homedir = os.homedir();
      const additionalPaths = [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        `${homedir}/.local/bin`,
        `${homedir}/.npm-global/bin`,
        `${homedir}/.volta/bin`,
        '/usr/local/opt/node/bin'
      ];

      // Resolve nvm node version directory (glob doesn't work in PATH strings)
      const nvmVersionsDir = path.join(homedir, '.nvm', 'versions', 'node');
      try {
        const versions = fs.readdirSync(nvmVersionsDir);
        if (versions.length > 0) {
          // Use the last (highest) version
          const latest = versions.sort().pop();
          additionalPaths.push(path.join(nvmVersionsDir, latest, 'bin'));
        }
      } catch (e) {
        // nvm not installed, skip
      }

      env.PATH = `${additionalPaths.join(':')}:${env.PATH || '/usr/bin:/bin'}`;
    }

    // Inject enabled secrets (global + project, project wins) as env vars.
    // New terminals only; a decrypt failure must never block terminal launch.
    if (this.secretsManager) {
      try {
        Object.assign(env, this.secretsManager.getMergedEnv(cwd));
      } catch (err) {
        console.warn('[ViewManager] Failed to load secrets for terminal env:', err.message);
      }
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

      // Notify sidebar that terminal is running
      this._sendTerminalRunningState(tabId, true);

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

    const promptState = this.terminalPromptState.get(tabId);
    if (promptState) {
      promptState.lastActivity = Date.now();
    }
  }

  /**
   * Handle PTY exit
   * @private
   */
  _handlePtyExit(tabId, exitCode, signal) {
    if (exitCode !== 0 && !this._lastExitLogged?.has(tabId)) {
      console.warn(`Terminal ${tabId} exited with code ${exitCode}`);
      if (!this._lastExitLogged) this._lastExitLogged = new Set();
      this._lastExitLogged.add(tabId);
      setTimeout(() => this._lastExitLogged?.delete(tabId), 5000);
    }

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
      // The overlay is now up; don't let a stray resize auto-spawn behind it.
      this.awaitingSessionChoice.add(tabId);
    }

    this.terminalPtys.delete(tabId);

    // Clear streaming/subagent state (fallback when PTY dies without Stop hook)
    this._clearStreamingTimeout(tabId);
    this.subagentDepth.delete(tabId);
    this._clearHookSessionBinding(tabId);
    this._sendStreamingState(tabId, false, null);

    // Notify sidebar that terminal stopped
    this._sendTerminalRunningState(tabId, false);
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
   * Offer the Resume / New Session / Close choice for a non-brand-new terminal
   * instead of auto-starting a session. Records the latest size and asks the
   * renderer to show the overlay; does NOT spawn a PTY. Idempotent.
   * @param {string} tabId
   * @param {number} cols
   * @param {number} rows
   */
  presentSessionChoice(tabId, cols = 80, rows = 30) {
    // A session is already running, or there's no view to show the overlay in.
    if (this.terminalPtys.get(tabId)) return;
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;

    const promptState = this.terminalPromptState.get(tabId);
    if (promptState) {
      promptState.cols = cols;
      promptState.rows = rows;
    }

    if (this.awaitingSessionChoice.has(tabId)) return; // overlay already requested
    this.awaitingSessionChoice.add(tabId);
    view.webContents.send('terminal-show-session-choice');
  }

  /**
   * @param {string} tabId
   * @returns {boolean} whether a live PTY currently exists for this tab
   */
  hasTerminalPty(tabId) {
    return this.terminalPtys.has(tabId);
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
      // Don't auto-spawn while the user is being asked to choose Resume/New.
      if (this.awaitingSessionChoice.has(tabId)) return;
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
    this.awaitingSessionChoice.delete(tabId);

    // Kill existing PTY
    const existingPty = this.terminalPtys.get(tabId);
    if (existingPty) {
      existingPty.kill();
      this.terminalPtys.delete(tabId);
    }

    // Clear streaming/subagent state before restart
    this._clearStreamingTimeout(tabId);
    this.subagentDepth.delete(tabId);
    this._clearHookSessionBinding(tabId);
    this._sendStreamingState(tabId, false, null);

    // Clear and restart
    view.webContents.send('terminal-data', '\x1b[2J\x1b[H');
    view.webContents.send('terminal-data', '\x1b[90mRestarting Claude Code...\x1b[0m\r\n\r\n');

    const promptState = this.terminalPromptState.get(tabId) || {};
    const { cols = 80, rows = 30 } = promptState;

    this.setupTerminalPty(tabId, cwd, cols, rows, 'normal');
  }

  /**
   * Shutdown a terminal (kill PTY without destroying the view or tab)
   * @param {string} tabId - The tab ID
   */
  shutdownTerminal(tabId) {
    // Kill existing PTY
    const existingPty = this.terminalPtys.get(tabId);
    if (existingPty) {
      existingPty.kill();
      this.terminalPtys.delete(tabId);
    }

    // End history session
    const sessionId = this.terminalSessions.get(tabId);
    if (sessionId && this.historyManager) {
      this.historyManager.endSession(sessionId, -1).catch(err => {
        console.error(`Failed to save history session ${sessionId}:`, err);
      });
      this.terminalSessions.delete(tabId);
    }

    // Clear streaming/subagent state
    this._clearStreamingTimeout(tabId);
    this.subagentDepth.delete(tabId);
    this._clearHookSessionBinding(tabId);

    // Send shutdown message to terminal view
    const view = this.terminalViews.get(tabId);
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.send('terminal-data', '\r\n\x1b[90mClaude Code has been shut down.\x1b[0m\r\n');
      view.webContents.send('terminal-exit', { exitCode: 0, signal: null });
      this.awaitingSessionChoice.add(tabId);
    }

    // Notify sidebar that terminal stopped
    this._sendTerminalRunningState(tabId, false);
    // Clear streaming state
    this._sendStreamingState(tabId, false, null);
  }

  /**
   * Resume a terminal session
   * @param {string} tabId - The tab ID
   * @param {string} cwd - Working directory
   */
  resumeTerminal(tabId, cwd) {
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;
    this.awaitingSessionChoice.delete(tabId);

    const existingPty = this.terminalPtys.get(tabId);
    if (existingPty) {
      existingPty.kill();
      this.terminalPtys.delete(tabId);
    }

    // Clear streaming/subagent state before resume
    this._clearStreamingTimeout(tabId);
    this.subagentDepth.delete(tabId);
    this._clearHookSessionBinding(tabId);
    this._sendStreamingState(tabId, false, null);

    view.webContents.send('terminal-data', '\x1b[2J\x1b[H');
    view.webContents.send('terminal-data', '\x1b[90mResuming Claude Code session...\x1b[0m\r\n\r\n');

    const promptState = this.terminalPromptState.get(tabId) || {};
    const { cols = 80, rows = 30 } = promptState;

    this.setupTerminalPty(tabId, cwd, cols, rows, 'continue');
  }

  /**
   * Send the current cached usage data (or last error) to a terminal.
   * Never triggers an API call — the central poll loop is the sole fetcher.
   * @param {string} tabId - The tab ID
   */
  requestUsageData(tabId) {
    const view = this.terminalViews.get(tabId);
    if (!view || view.webContents.isDestroyed()) return;

    const payload = this.usageMonitor.getPayload();
    if (payload) {
      view.webContents.send('usage-update', payload);
    }
    // If neither data nor error yet, stay silent — first poll will broadcast.
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
        this.mainWindow.contentView.removeChildView(currentWebView);
      }
      if (currentTerminalView) {
        this.mainWindow.contentView.removeChildView(currentTerminalView);
      }
    }

    // Add new view
    const webView = this.webViews.get(tabId);
    const terminalView = this.terminalViews.get(tabId);

    if (webView) {
      this.mainWindow.contentView.addChildView(webView);
    } else if (terminalView) {
      this.mainWindow.contentView.addChildView(terminalView);
    }

    this.activeTabId = tabId;
    this.updateViewBounds();

    // Push latest usage data immediately when switching to a terminal tab
    if (terminalView) {
      this.requestUsageData(tabId);
    }
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
   * Get list of terminal tab IDs with running PTY processes
   * @returns {string[]}
   */
  getRunningTerminals() {
    return Array.from(this.terminalPtys.keys());
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

    // Remove WebContentsView
    const webView = this.webViews.get(tabId);
    const terminalView = this.terminalViews.get(tabId);

    if (webView) {
      if (this.activeTabId === tabId) {
        this.mainWindow.contentView.removeChildView(webView);
      }
      this.webViews.delete(tabId);
      try { webView.webContents.close(); } catch (e) { /* already closed */ }
    }

    if (terminalView) {
      if (this.activeTabId === tabId) {
        this.mainWindow.contentView.removeChildView(terminalView);
      }
      this.terminalViews.delete(tabId);
      try { terminalView.webContents.close(); } catch (e) { /* already closed */ }
    }

    // Cleanup terminal state
    this.terminalReadyState.delete(tabId);
    this.terminalOutputBuffer.delete(tabId);
    this.terminalPromptState.delete(tabId);
    this.awaitingSessionChoice.delete(tabId);
    this._clearStreamingTimeout(tabId);
    this.subagentDepth.delete(tabId);

    // Drop any hook session binding pointing at this tab
    this._clearHookSessionBinding(tabId);

    // Stop usage polling if no terminal views remain
    if (this.terminalViews.size === 0) {
      this.usageMonitor.stop();
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
   * Hide the active view (remove from window but keep reference)
   * Used when showing settings or other overlays
   */
  hideActiveView() {
    if (!this.activeTabId) return;

    const webView = this.webViews.get(this.activeTabId);
    const terminalView = this.terminalViews.get(this.activeTabId);

    if (webView) {
      this.mainWindow.contentView.removeChildView(webView);
    } else if (terminalView) {
      this.mainWindow.contentView.removeChildView(terminalView);
    }
  }

  /**
   * Show the active view (add back to window)
   * Used when hiding settings or other overlays
   */
  showActiveView() {
    if (!this.activeTabId) return;

    const webView = this.webViews.get(this.activeTabId);
    const terminalView = this.terminalViews.get(this.activeTabId);

    if (webView) {
      this.mainWindow.contentView.addChildView(webView);
    } else if (terminalView) {
      this.mainWindow.contentView.addChildView(terminalView);
    }

    this.updateViewBounds();
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
    this.usageMonitor.stop();
    for (const timer of this.streamingTimeouts.values()) {
      clearTimeout(timer);
    }

    // Close all webContents before clearing
    for (const view of this.webViews.values()) {
      try { view.webContents.close(); } catch (e) { /* already closed */ }
    }
    for (const view of this.terminalViews.values()) {
      try { view.webContents.close(); } catch (e) { /* already closed */ }
    }

    this.webViews.clear();
    this.terminalViews.clear();
    this.terminalPtys.clear();
    this.terminalReadyState.clear();
    this.terminalOutputBuffer.clear();
    this.terminalPromptState.clear();
    this.streamingTimeouts.clear();
    this.subagentDepth.clear();
    this.hookSessionToTab.clear();
    this.hookTabToSession.clear();
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
