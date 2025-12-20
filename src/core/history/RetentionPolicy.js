/**
 * RetentionPolicy - Cleanup logic for session history
 *
 * Handles:
 * - Time-based retention (delete sessions older than N days)
 * - Size-based retention (delete oldest sessions when over limit)
 * - Calculating cleanup plans
 * - Executing cleanup atomically
 */

class RetentionPolicy {
  /**
   * @param {Object} settings - Retention settings
   * @param {number} settings.maxAgeDays - Maximum age in days (default: 30)
   * @param {number} settings.maxSizeMB - Maximum total size in MB (default: 500)
   */
  constructor(settings = {}) {
    this.maxAgeDays = Math.max(1, settings.maxAgeDays || 30);
    this.maxSizeMB = Math.max(10, settings.maxSizeMB || 500);
  }

  /**
   * Update retention settings
   * @param {Object} settings - New settings
   */
  updateSettings(settings) {
    if (settings.maxAgeDays !== undefined) {
      this.maxAgeDays = Math.max(1, settings.maxAgeDays);
    }
    if (settings.maxSizeMB !== undefined) {
      this.maxSizeMB = Math.max(10, settings.maxSizeMB);
    }
  }

  /**
   * Get current settings
   * @returns {Object}
   */
  getSettings() {
    return {
      maxAgeDays: this.maxAgeDays,
      maxSizeMB: this.maxSizeMB
    };
  }

  /**
   * Calculate which sessions should be deleted
   * @param {Array<Object>} sessions - Array of session metadata objects
   * @returns {Object} Cleanup plan with toDelete, toKeep, and stats
   */
  calculateCleanup(sessions) {
    if (!sessions || sessions.length === 0) {
      return {
        toDelete: [],
        toKeep: [],
        reclaimedBytes: 0,
        reason: 'no_sessions'
      };
    }

    const now = Date.now();
    const maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;
    const cutoffTime = now - maxAgeMs;
    const maxSizeBytes = this.maxSizeMB * 1024 * 1024;

    // Sort by timestamp (oldest first)
    const sorted = [...sessions].sort((a, b) =>
      (a.timestamp || a.startTime) - (b.timestamp || b.startTime)
    );

    const toDelete = [];
    const toKeep = [];

    // First pass: mark sessions older than maxAge for deletion
    for (const session of sorted) {
      const sessionTime = session.timestamp || session.startTime;
      if (sessionTime < cutoffTime) {
        toDelete.push({ ...session, reason: 'age' });
      } else {
        toKeep.push(session);
      }
    }

    // Calculate current size of sessions to keep
    let totalSize = toKeep.reduce((sum, s) => sum + (s.compressedSize || s.fileSize || 0), 0);

    // Second pass: if still over size limit, delete oldest from toKeep
    if (totalSize > maxSizeBytes) {
      // Sort toKeep by timestamp (oldest first)
      toKeep.sort((a, b) =>
        (a.timestamp || a.startTime) - (b.timestamp || b.startTime)
      );

      while (toKeep.length > 0 && totalSize > maxSizeBytes) {
        const session = toKeep.shift();
        const sessionSize = session.compressedSize || session.fileSize || 0;
        totalSize -= sessionSize;
        toDelete.push({ ...session, reason: 'size' });
      }
    }

    // Calculate reclaimed space
    const reclaimedBytes = toDelete.reduce(
      (sum, s) => sum + (s.compressedSize || s.fileSize || 0),
      0
    );

    return {
      toDelete,
      toKeep,
      reclaimedBytes,
      reclaimedMB: Math.round(reclaimedBytes / (1024 * 1024) * 100) / 100,
      reason: toDelete.length > 0 ? 'cleanup_needed' : 'within_limits'
    };
  }

  /**
   * Execute cleanup by deleting sessions
   * @param {Array<Object>} toDelete - Sessions to delete
   * @param {StorageEngine} storageEngine - Storage engine for file operations
   * @returns {Promise<Object>} Cleanup results
   */
  async executeCleanup(toDelete, storageEngine) {
    const results = {
      deletedCount: 0,
      reclaimedBytes: 0,
      errors: []
    };

    for (const session of toDelete) {
      try {
        if (session.filePath) {
          await storageEngine.deleteSession(session.filePath);
        }
        results.deletedCount++;
        results.reclaimedBytes += session.compressedSize || session.fileSize || 0;
      } catch (err) {
        results.errors.push({
          sessionId: session.id,
          error: err.message
        });
      }
    }

    results.reclaimedMB = Math.round(results.reclaimedBytes / (1024 * 1024) * 100) / 100;

    return results;
  }

  /**
   * Check if cleanup is needed based on current state
   * @param {Array<Object>} sessions - Current sessions
   * @returns {boolean}
   */
  isCleanupNeeded(sessions) {
    const plan = this.calculateCleanup(sessions);
    return plan.toDelete.length > 0;
  }

  /**
   * Get storage statistics
   * @param {Array<Object>} sessions - Current sessions
   * @returns {Object} Storage stats
   */
  getStorageStats(sessions) {
    const totalBytes = sessions.reduce(
      (sum, s) => sum + (s.compressedSize || s.fileSize || 0),
      0
    );
    const maxBytes = this.maxSizeMB * 1024 * 1024;

    return {
      totalBytes,
      totalMB: Math.round(totalBytes / (1024 * 1024) * 100) / 100,
      maxMB: this.maxSizeMB,
      usagePercent: Math.round((totalBytes / maxBytes) * 100),
      sessionCount: sessions.length
    };
  }
}

module.exports = RetentionPolicy;
