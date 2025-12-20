/**
 * HistoryManager - Main coordinator for terminal session history
 *
 * Manages:
 * - Session lifecycle (start, capture, finalize)
 * - Metadata persistence via electron-store
 * - Retention policy enforcement
 * - UI event emission
 */

const EventEmitter = require('events');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const StorageEngine = require('./history/StorageEngine');
const SessionRecorder = require('./history/SessionRecorder');
const RetentionPolicy = require('./history/RetentionPolicy');

class HistoryManager extends EventEmitter {
  /**
   * @param {Object} options
   * @param {Object} options.store - electron-store instance
   * @param {string} options.userDataPath - app.getPath('userData')
   */
  constructor({ store, userDataPath }) {
    super();
    this.store = store;
    this.userDataPath = userDataPath;

    // Initialize components
    this.storageEngine = new StorageEngine(userDataPath);
    this.retentionPolicy = new RetentionPolicy(this._getRetentionSettings());

    // Active recording sessions: sessionId -> SessionRecorder
    this.activeRecorders = new Map();

    // Initialize store structure
    this._initializeStore();
  }

  /**
   * Initialize store with default structure
   * @private
   */
  _initializeStore() {
    if (!this.store.has('history')) {
      this.store.set('history', {
        sessions: [],
        settings: {
          maxAgeDays: 30,
          maxSizeMB: 500,
          enabled: true
        }
      });
    }
  }

  /**
   * Get retention settings from store
   * @private
   */
  _getRetentionSettings() {
    const history = this.store.get('history', {});
    return history.settings || { maxAgeDays: 30, maxSizeMB: 500 };
  }

  /**
   * Check if history capture is enabled
   * @returns {boolean}
   */
  isEnabled() {
    const history = this.store.get('history', {});
    return history.settings?.enabled !== false;
  }

  /**
   * Start recording a new session
   * @param {string} tabId - Terminal tab ID
   * @param {string} cwd - Working directory
   * @param {Object} metadata - Additional metadata (name, mode, etc.)
   * @returns {string} Session ID
   */
  startSession(tabId, cwd, metadata = {}) {
    if (!this.isEnabled()) {
      return null;
    }

    const sessionId = `session-${crypto.randomUUID()}`;
    const recorder = new SessionRecorder(sessionId, cwd);

    this.activeRecorders.set(sessionId, {
      recorder,
      tabId,
      cwd,
      metadata,
      startTime: Date.now()
    });

    this.emit('session-started', {
      sessionId,
      tabId,
      cwd,
      timestamp: Date.now()
    });

    return sessionId;
  }

  /**
   * Capture PTY output for a session
   * @param {string} sessionId - Session ID
   * @param {string|Buffer} data - Output data
   */
  captureOutput(sessionId, data) {
    const recording = this.activeRecorders.get(sessionId);
    if (recording && recording.recorder.isActive()) {
      try {
        recording.recorder.write(data);
      } catch (err) {
        console.error(`Failed to capture output for session ${sessionId}:`, err);
        // Abort the recording to prevent further issues
        this.abortSession(sessionId);
      }
    }
  }

  /**
   * End a session and save to disk
   * @param {string} sessionId - Session ID
   * @param {number} exitCode - Process exit code
   * @returns {Promise<Object>} Session metadata
   */
  async endSession(sessionId, exitCode) {
    const recording = this.activeRecorders.get(sessionId);
    if (!recording) {
      return null;
    }

    try {
      // Finalize recording and get compressed data
      const result = await recording.recorder.finalize(exitCode);

      // Generate file path
      const filePath = this.storageEngine.getSessionPath(recording.cwd, recording.startTime);

      // Write to disk
      await this.storageEngine.writeSession(filePath, result.compressed);

      // Create session metadata
      const sessionMeta = {
        id: sessionId,
        tabId: recording.tabId,
        cwd: recording.cwd,
        cwdHash: this.storageEngine.getCwdHash(recording.cwd),
        cwdName: path.basename(recording.cwd),
        timestamp: recording.startTime,
        endTime: Date.now(),
        duration: result.duration,
        exitCode: result.exitCode,
        uncompressedSize: result.uncompressedSize,
        compressedSize: result.compressedSize,
        filePath,
        ...recording.metadata
      };

      // Save to store
      this._addToHistory(sessionMeta);

      // Run retention policy
      await this._runRetentionCleanup();

      // Emit events
      this.emit('session-ended', sessionMeta);
      this._emitUpdate();

      return sessionMeta;
    } catch (err) {
      console.error(`Failed to save session ${sessionId}:`, err);
      throw err;
    } finally {
      // Always cleanup the recorder to prevent memory leaks
      this.activeRecorders.delete(sessionId);
    }
  }

  /**
   * Abort a session without saving
   * @param {string} sessionId - Session ID
   */
  abortSession(sessionId) {
    const recording = this.activeRecorders.get(sessionId);
    if (recording) {
      recording.recorder.abort();
      this.activeRecorders.delete(sessionId);
    }
  }

  /**
   * Add session to history store
   * @private
   */
  _addToHistory(sessionMeta) {
    const history = this.store.get('history');
    history.sessions.unshift(sessionMeta);
    this.store.set('history', history);
  }

  /**
   * Run retention cleanup
   * @private
   */
  async _runRetentionCleanup() {
    const history = this.store.get('history');
    const plan = this.retentionPolicy.calculateCleanup(history.sessions);

    if (plan.toDelete.length === 0) {
      return;
    }

    // Execute cleanup
    await this.retentionPolicy.executeCleanup(plan.toDelete, this.storageEngine);

    // Update store with remaining sessions
    history.sessions = plan.toKeep;
    this.store.set('history', history);

    // Prune empty directories
    await this.storageEngine.pruneEmptyDirectories();
  }

  /**
   * Emit update event for UI
   * @private
   */
  _emitUpdate() {
    const history = this.store.get('history');
    const stats = this.retentionPolicy.getStorageStats(history.sessions);

    this.emit('history-updated', {
      sessions: history.sessions,
      stats
    });
  }

  // ==================== Query Methods ====================

  /**
   * Get all sessions
   * @param {Object} options - Query options
   * @param {number} options.limit - Max sessions to return
   * @param {number} options.offset - Offset for pagination
   * @returns {Array<Object>} Session metadata array
   */
  getAllSessions({ limit = 50, offset = 0 } = {}) {
    const history = this.store.get('history');
    return history.sessions.slice(offset, offset + limit);
  }

  /**
   * Get sessions for a specific working directory
   * @param {string} cwd - Working directory
   * @param {number} limit - Max sessions to return
   * @returns {Array<Object>} Session metadata array
   */
  getSessionsForCwd(cwd, limit = 20) {
    const cwdHash = this.storageEngine.getCwdHash(cwd);
    const history = this.store.get('history');

    return history.sessions
      .filter(s => s.cwdHash === cwdHash)
      .slice(0, limit);
  }

  /**
   * Get a session by ID
   * @param {string} sessionId - Session ID
   * @returns {Object|null} Session metadata
   */
  getSessionById(sessionId) {
    const history = this.store.get('history');
    return history.sessions.find(s => s.id === sessionId) || null;
  }

  // ==================== Action Methods ====================

  /**
   * Read session content
   * @param {string} sessionId - Session ID
   * @returns {Promise<string>} Decompressed session content
   */
  async readSession(sessionId) {
    const session = this.getSessionById(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    return this.storageEngine.readSession(session.filePath);
  }

  /**
   * Export session to a file
   * @param {string} sessionId - Session ID
   * @param {string} destPath - Destination file path
   * @returns {Promise<void>}
   */
  async exportSession(sessionId, destPath) {
    const content = await this.readSession(sessionId);

    // Strip ANSI codes for plain text export
    const plainText = this._stripAnsi(content);

    await fs.promises.writeFile(destPath, plainText, 'utf-8');
  }

  /**
   * Delete a session
   * @param {string} sessionId - Session ID
   * @returns {Promise<boolean>}
   */
  async deleteSession(sessionId) {
    const session = this.getSessionById(sessionId);
    if (!session) {
      return false;
    }

    // Delete file
    await this.storageEngine.deleteSession(session.filePath);

    // Remove from store
    const history = this.store.get('history');
    history.sessions = history.sessions.filter(s => s.id !== sessionId);
    this.store.set('history', history);

    // Emit update
    this.emit('session-deleted', { sessionId });
    this._emitUpdate();

    return true;
  }

  /**
   * Clear all history
   * @returns {Promise<void>}
   */
  async clearAllHistory() {
    const history = this.store.get('history');

    // Delete all session files
    for (const session of history.sessions) {
      try {
        await this.storageEngine.deleteSession(session.filePath);
      } catch {
        // Ignore errors during bulk delete
      }
    }

    // Clear store
    history.sessions = [];
    this.store.set('history', history);

    // Prune directories
    await this.storageEngine.pruneEmptyDirectories();

    this._emitUpdate();
  }

  // ==================== Settings Methods ====================

  /**
   * Get retention settings
   * @returns {Object}
   */
  getRetentionSettings() {
    const history = this.store.get('history');
    return {
      ...history.settings,
      ...this.retentionPolicy.getSettings()
    };
  }

  /**
   * Update retention settings
   * @param {Object} settings - New settings
   */
  updateRetentionSettings(settings) {
    const history = this.store.get('history');

    if (settings.maxAgeDays !== undefined) {
      history.settings.maxAgeDays = Math.max(1, settings.maxAgeDays);
    }
    if (settings.maxSizeMB !== undefined) {
      history.settings.maxSizeMB = Math.max(10, settings.maxSizeMB);
    }
    if (settings.enabled !== undefined) {
      history.settings.enabled = Boolean(settings.enabled);
    }

    this.store.set('history', history);
    this.retentionPolicy.updateSettings(history.settings);
  }

  /**
   * Get storage statistics
   * @returns {Object}
   */
  getStorageStats() {
    const history = this.store.get('history');
    return this.retentionPolicy.getStorageStats(history.sessions);
  }

  // ==================== Utility Methods ====================

  /**
   * Strip ANSI escape codes from text
   * @private
   */
  _stripAnsi(text) {
    // eslint-disable-next-line no-control-regex
    return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  }

  /**
   * Get active recording count
   * @returns {number}
   */
  getActiveRecordingCount() {
    return this.activeRecorders.size;
  }

  /**
   * Cleanup resources
   */
  destroy() {
    // Abort all active recordings
    for (const [sessionId] of this.activeRecorders) {
      this.abortSession(sessionId);
    }
    this.activeRecorders.clear();
    this.removeAllListeners();
  }
}

module.exports = HistoryManager;
