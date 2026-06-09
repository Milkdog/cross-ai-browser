/**
 * HooksManager - Manages Claude Code hooks integration
 *
 * Responsibilities:
 * - Start/stop local HTTP server for hook callbacks
 * - Install hooks into ~/.claude/settings.json
 * - Validate and route incoming hook requests
 * - Emit events for hook triggers (UserPromptSubmit, Stop, Notification, SubagentStart, SubagentStop, TaskCompleted, PreToolUse)
 */

const http = require('http');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

// Hook types we support
const SUPPORTED_HOOKS = [
  'UserPromptSubmit', 'Stop', 'Notification',
  'SubagentStart', 'SubagentStop', 'TaskCompleted', 'PreToolUse'
];

// Max request body size (64KB - last_assistant_message can be large)
const MAX_BODY_SIZE = 64 * 1024;

class HooksManager extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.store - electron-store instance
   */
  constructor({ store }) {
    super();
    this.store = store;
    this.server = null;
    this.port = null;
    this.isInitialized = false;
  }

  /**
   * Initialize the hooks manager (start HTTP server)
   * @returns {Promise<{success: boolean, port?: number, error?: string}>}
   */
  async initialize() {
    if (this.isInitialized) {
      return { success: true, port: this.port };
    }

    try {
      await this._startServer();
      this.isInitialized = true;
      console.log(`[HooksManager] HTTP server started on port ${this.port}`);
      return { success: true, port: this.port };
    } catch (err) {
      console.error('[HooksManager] Failed to start HTTP server:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Start the HTTP server on a dynamic port
   * @private
   */
  _startServer() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res);
      });

      // Handle server errors
      this.server.on('error', (err) => {
        console.error('[HooksManager] Server error:', err);
        reject(err);
      });

      // Listen on port 0 to get a random available port
      // Bind to localhost only for security
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP requests
   * @private
   */
  _handleRequest(req, res) {
    // Set CORS headers for local requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    // Only accept POST to /hook
    if (req.method !== 'POST' || req.url !== '/hook') {
      res.statusCode = 404;
      res.end(JSON.stringify({ success: false, error: 'Not found' }));
      return;
    }

    // Collect request body with proper cleanup to prevent memory leaks
    let body = '';
    let bodySize = 0;
    let handled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    };

    const onData = (chunk) => {
      if (handled) return;
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        handled = true;
        cleanup();
        res.statusCode = 413;
        res.end(JSON.stringify({ success: false, error: 'Request too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    };

    const onEnd = () => {
      if (handled) return;
      handled = true;
      cleanup();
      try {
        const data = JSON.parse(body);
        this._processHookEvent(data, res, req.headers['x-crossai-tab-id']);
      } catch (err) {
        console.error('[HooksManager] Invalid JSON:', err.message);
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    };

    const onError = (err) => {
      if (handled) return;
      handled = true;
      cleanup();
      console.error('[HooksManager] Request error:', err);
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: 'Request error' }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  }

  /**
   * Process a hook event from Claude Code
   * @private
   */
  _processHookEvent(data, res, tabIdHeader) {
    const hookType = data.hook_event_name;

    // Validate hook type
    if (!hookType || !SUPPORTED_HOOKS.includes(hookType)) {
      console.warn('[HooksManager] Unknown hook type:', hookType);
      res.statusCode = 400;
      res.end(JSON.stringify({ success: false, error: 'Unknown hook type' }));
      return;
    }

    // Tab ID forwarded by the hook command from the terminal's CROSSAI_TAB_ID
    // env var. Blank/absent for Claude Code sessions started outside the app.
    const tabId = typeof tabIdHeader === 'string' && /^[\w-]{1,64}$/.test(tabIdHeader.trim())
      ? tabIdHeader.trim()
      : undefined;

    // Extract relevant data based on hook type
    const eventData = {
      type: hookType,
      sessionId: data.session_id,
      cwd: data.cwd,
      tabId,
      transcriptPath: data.transcript_path,
      timestamp: Date.now()
    };

    // Add hook-specific data
    if (hookType === 'UserPromptSubmit') {
      eventData.prompt = data.prompt;
    } else if (hookType === 'Notification') {
      eventData.message = data.message;
      eventData.title = data.title;
      eventData.notificationType = data.notification_type;
    } else if (hookType === 'Stop') {
      eventData.stopHookActive = data.stop_hook_active;
      eventData.lastAssistantMessage = data.last_assistant_message;
    } else if (hookType === 'SubagentStart' || hookType === 'SubagentStop') {
      eventData.agentType = data.agent_type;
    } else if (hookType === 'TaskCompleted') {
      eventData.taskSubject = data.task_subject;
      eventData.taskDescription = data.task_description;
    } else if (hookType === 'PreToolUse') {
      eventData.toolName = data.tool_name;
      eventData.toolInput = data.tool_input;
    }

    // Emit event for listeners
    this.emit('hook-triggered', eventData);

    // Respond success
    res.statusCode = 200;
    res.end(JSON.stringify({ success: true }));
  }

  /**
   * Get the server URL for hook configuration
   * @returns {string|null}
   */
  getServerUrl() {
    if (!this.port) return null;
    return `http://127.0.0.1:${this.port}/hook`;
  }

  /**
   * Check if hooks are installed in Claude settings
   * @returns {Promise<boolean>}
   */
  async isInstalled() {
    try {
      const settings = await this._readClaudeSettings();
      if (!settings || !settings.hooks) return false;

      // Check if our hooks are present with the correct URL
      const serverUrl = this.getServerUrl();
      if (!serverUrl) return false;

      for (const hookType of SUPPORTED_HOOKS) {
        const hookConfig = settings.hooks[hookType];
        if (!Array.isArray(hookConfig) || hookConfig.length === 0) {
          return false;
        }

        // Check if any hook command includes our server URL and the current
        // command shape (tab ID header) — otherwise reinstall to upgrade it
        const hasOurHook = hookConfig.some(entry => {
          if (!entry.hooks || !Array.isArray(entry.hooks)) return false;
          return entry.hooks.some(h =>
            h.type === 'command' && h.command &&
            h.command.includes(`127.0.0.1:${this.port}`) &&
            h.command.includes('X-CrossAI-Tab-Id')
          );
        });

        if (!hasOurHook) return false;
      }

      return true;
    } catch (err) {
      console.error('[HooksManager] Error checking installation:', err);
      return false;
    }
  }

  /**
   * Install hooks into ~/.claude/settings.json
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async installHooks() {
    if (!this.port) {
      return { success: false, error: 'Server not started' };
    }

    try {
      // Ensure ~/.claude directory exists
      const claudeDir = path.join(os.homedir(), '.claude');
      await fs.mkdir(claudeDir, { recursive: true });

      // Read existing settings
      let settings = await this._readClaudeSettings() || {};

      // Merge our hooks with existing
      settings.hooks = settings.hooks || {};

      const serverUrl = this.getServerUrl();
      // CROSSAI_TAB_ID is set in the env of terminals we spawn (ViewManager),
      // and hook commands run as shell children of that terminal, so the
      // expansion identifies the exact tab. For sessions outside the app the
      // var is unset, the header value is blank, and curl drops the header.
      const curlCommand = `curl -s --max-time 2 -X POST ${serverUrl} -H 'Content-Type: application/json' -H "X-CrossAI-Tab-Id: $CROSSAI_TAB_ID" -d @-`;

      for (const hookType of SUPPORTED_HOOKS) {
        // Create or update the hook config
        // We use a specific marker in the command to identify our hooks
        const hookEntry = {
          hooks: [
            {
              type: 'command',
              command: curlCommand
            }
          ]
        };

        // Check if there's already an entry without our hook
        const existingHooks = settings.hooks[hookType] || [];

        // Remove any existing Cross AI Browser hooks (identified by our port or localhost pattern)
        const filteredHooks = existingHooks.filter(entry => {
          if (!entry.hooks || !Array.isArray(entry.hooks)) return true;
          return !entry.hooks.some(h =>
            h.type === 'command' && h.command && h.command.includes('127.0.0.1:') && h.command.includes('/hook')
          );
        });

        // Add our hook
        settings.hooks[hookType] = [...filteredHooks, hookEntry];
      }

      // Write settings atomically
      await this._writeClaudeSettings(settings);

      console.log('[HooksManager] Hooks installed successfully');
      return { success: true };
    } catch (err) {
      console.error('[HooksManager] Failed to install hooks:', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Read Claude settings file
   * @private
   * @returns {Promise<Object|null>}
   */
  async _readClaudeSettings() {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        return null; // File doesn't exist
      }
      throw err;
    }
  }

  /**
   * Write Claude settings file atomically
   * @private
   */
  async _writeClaudeSettings(settings) {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const tempPath = `${settingsPath}.tmp`;

    // Write to temp file first
    await fs.writeFile(tempPath, JSON.stringify(settings, null, 2), 'utf-8');

    // Atomic rename
    await fs.rename(tempPath, settingsPath);
  }

  /**
   * Stop the HTTP server and cleanup
   */
  destroy() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.port = null;
    this.isInitialized = false;
    this.removeAllListeners();
    console.log('[HooksManager] Destroyed');
  }
}

module.exports = HooksManager;
