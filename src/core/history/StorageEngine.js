/**
 * StorageEngine - File I/O abstraction for session history
 *
 * Handles:
 * - Path generation with cwd hashing
 * - Atomic file writes (temp file → rename)
 * - Gzip decompression for reading
 * - Directory management and cleanup
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);

class StorageEngine {
  /**
   * @param {string} userDataPath - Electron app.getPath('userData')
   */
  constructor(userDataPath) {
    this.historyDir = path.join(userDataPath, 'history');
    this._ensureHistoryDir();
  }

  /**
   * Ensure the history directory exists
   * @private
   */
  _ensureHistoryDir() {
    if (!fs.existsSync(this.historyDir)) {
      fs.mkdirSync(this.historyDir, { recursive: true });
    }
  }

  /**
   * Generate a deterministic hash for a working directory
   * @param {string} cwd - Working directory path
   * @returns {string} 16-character hex hash
   */
  getCwdHash(cwd) {
    if (typeof cwd !== 'string' || !cwd) {
      throw new Error('cwd must be a non-empty string');
    }
    // Normalize path and create hash
    const normalized = path.normalize(cwd).toLowerCase();
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /**
   * Get the full path for a session file
   * @param {string} cwd - Working directory
   * @param {number} timestamp - Session start timestamp
   * @returns {string} Full path to .gz file
   */
  getSessionPath(cwd, timestamp) {
    if (typeof timestamp !== 'number' || timestamp <= 0) {
      throw new Error('timestamp must be a positive number');
    }
    const cwdHash = this.getCwdHash(cwd);
    const dir = path.join(this.historyDir, cwdHash);
    return path.join(dir, `${timestamp}.gz`);
  }

  /**
   * Write compressed session data to disk atomically
   * @param {string} sessionPath - Target path for .gz file
   * @param {Buffer} compressedData - Gzip-compressed data
   * @returns {Promise<void>}
   */
  async writeSession(sessionPath, compressedData) {
    const dir = path.dirname(sessionPath);

    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write to temp file first for atomic operation
    const tempPath = `${sessionPath}.tmp`;

    try {
      await fs.promises.writeFile(tempPath, compressedData);
      await fs.promises.rename(tempPath, sessionPath);
    } catch (err) {
      // Clean up temp file on failure
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  /**
   * Read and decompress a session file
   * @param {string} sessionPath - Path to .gz file
   * @returns {Promise<string>} Decompressed session content
   */
  async readSession(sessionPath) {
    if (!fs.existsSync(sessionPath)) {
      throw new Error(`Session file not found: ${sessionPath}`);
    }

    try {
      const compressed = await fs.promises.readFile(sessionPath);
      const decompressed = await gunzip(compressed);
      return decompressed.toString('utf-8');
    } catch (err) {
      if (err.code === 'Z_DATA_ERROR') {
        throw new Error('Session file is corrupted');
      }
      throw err;
    }
  }

  /**
   * Delete a session file
   * @param {string} sessionPath - Path to .gz file
   * @returns {Promise<void>}
   */
  async deleteSession(sessionPath) {
    if (fs.existsSync(sessionPath)) {
      await fs.promises.unlink(sessionPath);

      // Clean up empty parent directory
      const dir = path.dirname(sessionPath);
      await this._pruneEmptyDir(dir);
    }
  }

  /**
   * Get the size of a session file
   * @param {string} sessionPath - Path to .gz file
   * @returns {Promise<number>} File size in bytes
   */
  async getSessionSize(sessionPath) {
    try {
      const stats = await fs.promises.stat(sessionPath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /**
   * List all session files with metadata
   * @returns {Promise<Array<{path: string, size: number, mtime: number}>>}
   */
  async listSessionFiles() {
    const files = [];

    if (!fs.existsSync(this.historyDir)) {
      return files;
    }

    const cwdDirs = await fs.promises.readdir(this.historyDir);

    for (const cwdHash of cwdDirs) {
      const cwdDir = path.join(this.historyDir, cwdHash);
      const stat = await fs.promises.stat(cwdDir);

      if (!stat.isDirectory()) continue;

      const sessionFiles = await fs.promises.readdir(cwdDir);

      for (const file of sessionFiles) {
        if (!file.endsWith('.gz')) continue;

        const filePath = path.join(cwdDir, file);
        const fileStat = await fs.promises.stat(filePath);

        files.push({
          path: filePath,
          size: fileStat.size,
          mtime: fileStat.mtimeMs
        });
      }
    }

    return files;
  }

  /**
   * Remove empty directories in history folder
   * @private
   */
  async _pruneEmptyDir(dir) {
    if (dir === this.historyDir) return;

    try {
      const contents = await fs.promises.readdir(dir);
      if (contents.length === 0) {
        await fs.promises.rmdir(dir);
      }
    } catch {
      // Ignore errors during pruning
    }
  }

  /**
   * Prune all empty directories
   * @returns {Promise<void>}
   */
  async pruneEmptyDirectories() {
    if (!fs.existsSync(this.historyDir)) return;

    const cwdDirs = await fs.promises.readdir(this.historyDir);

    for (const cwdHash of cwdDirs) {
      const cwdDir = path.join(this.historyDir, cwdHash);
      await this._pruneEmptyDir(cwdDir);
    }
  }

  /**
   * Get the base history directory path
   * @returns {string}
   */
  getHistoryDir() {
    return this.historyDir;
  }

  /**
   * Check if a session file exists
   * @param {string} sessionPath - Path to check
   * @returns {boolean}
   */
  sessionExists(sessionPath) {
    return fs.existsSync(sessionPath);
  }
}

module.exports = StorageEngine;
