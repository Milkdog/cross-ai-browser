/**
 * PromptStorageEngine - File I/O abstraction for prompt library storage
 *
 * Handles:
 * - Path generation with cwd hashing (reuses history pattern)
 * - Atomic JSON file writes (temp file → rename)
 * - Per-directory prompt storage (project scope)
 * - Global prompt storage (global scope)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class PromptStorageEngine {
  /**
   * @param {string} userDataPath - Electron app.getPath('userData')
   */
  constructor(userDataPath) {
    this.baseDir = path.join(userDataPath, 'prompts');
    this.globalFilePath = path.join(this.baseDir, 'global.json');
    this._ensureBaseDir();
  }

  /**
   * Ensure the prompts directory exists
   * @private
   */
  _ensureBaseDir() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  /**
   * Generate a deterministic hash for a working directory
   * Uses same algorithm as history StorageEngine for consistency
   * @param {string} cwd - Working directory path
   * @returns {string} 16-character hex hash
   */
  getCwdHash(cwd) {
    if (typeof cwd !== 'string' || !cwd) {
      throw new Error('cwd must be a non-empty string');
    }
    const normalized = path.normalize(cwd).toLowerCase();
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  /**
   * Get the full path for a directory's prompts JSON file
   * @param {string} cwd - Working directory
   * @returns {string} Full path to prompts.json file
   */
  getPromptsPath(cwd) {
    const cwdHash = this.getCwdHash(cwd);
    return path.join(this.baseDir, `${cwdHash}.json`);
  }

  /**
   * Read prompts for a working directory (project scope)
   * @param {string} cwd - Working directory
   * @returns {Array} Array of prompt objects, empty array if none exist
   */
  readPrompts(cwd) {
    const filePath = this.getPromptsPath(cwd);

    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      // Validate structure
      if (!Array.isArray(data)) {
        console.error('Prompts file is not an array, returning empty');
        return [];
      }

      return data;
    } catch (err) {
      console.error(`Failed to read prompts for ${cwd}:`, err.message);
      return [];
    }
  }

  /**
   * Write prompts for a working directory atomically (project scope)
   * @param {string} cwd - Working directory
   * @param {Array} prompts - Array of prompt objects
   * @returns {Promise<void>}
   */
  async writePrompts(cwd, prompts) {
    const filePath = this.getPromptsPath(cwd);
    const tempPath = `${filePath}.tmp`;

    try {
      const content = JSON.stringify(prompts, null, 2);
      await fs.promises.writeFile(tempPath, content, 'utf-8');
      await fs.promises.rename(tempPath, filePath);
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
   * Read global prompts
   * @returns {Array} Array of global prompt objects
   */
  readGlobalPrompts() {
    if (!fs.existsSync(this.globalFilePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(this.globalFilePath, 'utf-8');
      const data = JSON.parse(content);

      if (!Array.isArray(data)) {
        console.error('Global prompts file is not an array, returning empty');
        return [];
      }

      return data;
    } catch (err) {
      console.error('Failed to read global prompts:', err.message);
      return [];
    }
  }

  /**
   * Write global prompts atomically
   * @param {Array} prompts - Array of prompt objects
   * @returns {Promise<void>}
   */
  async writeGlobalPrompts(prompts) {
    const tempPath = `${this.globalFilePath}.tmp`;

    try {
      const content = JSON.stringify(prompts, null, 2);
      await fs.promises.writeFile(tempPath, content, 'utf-8');
      await fs.promises.rename(tempPath, this.globalFilePath);
    } catch (err) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  /**
   * Delete prompts file for a working directory
   * @param {string} cwd - Working directory
   * @returns {Promise<void>}
   */
  async deletePrompts(cwd) {
    const filePath = this.getPromptsPath(cwd);

    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  /**
   * Check if prompts exist for a working directory
   * @param {string} cwd - Working directory
   * @returns {boolean}
   */
  hasPrompts(cwd) {
    const filePath = this.getPromptsPath(cwd);
    return fs.existsSync(filePath);
  }

  /**
   * Get the base directory path
   * @returns {string}
   */
  getBaseDir() {
    return this.baseDir;
  }

  /**
   * Read every prompt stored on disk across all projects and the global list.
   * Used for sync backfills that don't need cwd attribution.
   * @returns {Array} Flat list of prompt objects
   */
  readAllPrompts() {
    const results = [];
    try {
      for (const p of this.readGlobalPrompts()) results.push(p);
    } catch {}
    try {
      const entries = fs.readdirSync(this.baseDir);
      for (const entry of entries) {
        if (entry === 'global.json' || !entry.endsWith('.json')) continue;
        try {
          const content = fs.readFileSync(path.join(this.baseDir, entry), 'utf-8');
          const data = JSON.parse(content);
          if (Array.isArray(data)) for (const p of data) results.push(p);
        } catch {}
      }
    } catch {}
    return results;
  }

  // Legacy aliases for backward compatibility during migration
  readCards(cwd) {
    return this.readPrompts(cwd);
  }

  async writeCards(cwd, cards) {
    return this.writePrompts(cwd, cards);
  }
}

module.exports = PromptStorageEngine;
