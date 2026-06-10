/**
 * SecretsManager - Encrypted secrets/API keys at global and project scope.
 *
 * - Per-scope files in userData/secrets/: global.enc, <cwd-hash>.enc
 * - Encrypted at rest with Electron safeStorage (injectable for tests)
 * - list() returns metadata only; values leave this module solely via
 *   reveal() and getMergedEnv()
 * - No plaintext fallback: writes are refused when encryption is unavailable
 *
 * Local-only by design: FirebaseSyncAdapter must never read this directory.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_VALUE_BYTES = 32 * 1024;
// Overriding these via env injection would break terminal spawning.
const RESERVED_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'TERM', 'USER', 'LOGNAME', 'TMPDIR', 'CROSSAI_TAB_ID'
]);

function createSafeStorageEncryptor() {
  const { safeStorage } = require('electron');
  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (buffer) => safeStorage.decryptString(buffer)
  };
}

class SecretsManager {
  /**
   * @param {Object} options
   * @param {string} options.userDataPath - Electron app.getPath('userData')
   * @param {Object} [options.encryptor] - { isAvailable, encrypt, decrypt } (tests only)
   */
  constructor({ userDataPath, encryptor }) {
    this.baseDir = path.join(userDataPath, 'secrets');
    this.encryptor = encryptor || createSafeStorageEncryptor();
    this._warnedUnavailable = false;
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    }
  }

  isEncryptionAvailable() {
    try {
      return this.encryptor.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Same algorithm as PromptStorageEngine/history StorageEngine so a project's
   * secrets, prompts, and history all share one hash for a given cwd.
   */
  getCwdHash(cwd) {
    if (typeof cwd !== 'string' || !cwd) {
      throw new Error('cwd must be a non-empty string');
    }
    const normalized = path.normalize(cwd).toLowerCase();
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  _filePath(scope, cwd) {
    if (scope === 'global') return path.join(this.baseDir, 'global.enc');
    if (scope === 'project') return path.join(this.baseDir, `${this.getCwdHash(cwd)}.enc`);
    throw new Error(`Unknown scope: ${scope}`);
  }

  _readStore(scope, cwd) {
    const filePath = this._filePath(scope, cwd);
    if (!fs.existsSync(filePath)) return { version: 1, secrets: [] };

    // Never treat an undecryptable-because-locked store as corrupt.
    if (!this.isEncryptionAvailable()) {
      if (!this._warnedUnavailable) {
        this._warnedUnavailable = true;
        console.warn('[SecretsManager] Secure storage unavailable — secrets cannot be read');
      }
      return { version: 1, secrets: [] };
    }

    let buffer;
    try {
      buffer = fs.readFileSync(filePath);
    } catch (err) {
      // Transient I/O failure is not corruption — leave the file alone.
      console.error(`[SecretsManager] Cannot read secrets file ${filePath} (${err.code || err.name})`);
      return { version: 1, secrets: [] };
    }

    try {
      const doc = JSON.parse(this.encryptor.decrypt(buffer));
      if (!doc || !Array.isArray(doc.secrets)) throw new Error('Malformed secrets document');
      return doc;
    } catch (err) {
      console.error(`[SecretsManager] Corrupt secrets file ${filePath} (${err.name}) — backing up and starting fresh`);
      try {
        fs.renameSync(filePath, `${filePath}.corrupt`);
      } catch {
        // If even the backup rename fails, leave the file in place.
      }
      return { version: 1, secrets: [] };
    }
  }

  async _writeStore(scope, cwd, doc) {
    if (!this.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system');
    }
    const filePath = this._filePath(scope, cwd);
    const tempPath = `${filePath}.tmp`;
    const encrypted = this.encryptor.encrypt(JSON.stringify(doc));
    try {
      await fs.promises.writeFile(tempPath, encrypted, { mode: 0o600 });
      await fs.promises.rename(tempPath, filePath);
    } catch (err) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // Ignore cleanup errors
      }
      throw err;
    }
  }

  _validate(name, value) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error('Secret name must be a valid environment variable name (letters, digits, underscores; not starting with a digit)');
    }
    if (RESERVED_NAMES.has(name.toUpperCase())) {
      throw new Error(`"${name}" is a reserved environment variable name`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('Secret value must be a non-empty string');
    }
    if (Buffer.byteLength(value, 'utf-8') > MAX_VALUE_BYTES) {
      throw new Error('Secret value exceeds the 32 KB limit');
    }
  }

  /** Strip the value — this is the only shape list()/create()/update() return. */
  _toMetadata(secret, scope) {
    const { id, name, note, enabled, createdAt, updatedAt } = secret;
    return { id, name, note, enabled, createdAt, updatedAt, scope };
  }

  /** @returns {Array} metadata only — never values */
  list(scope, cwd) {
    return this._readStore(scope, cwd).secrets.map(s => this._toMetadata(s, scope));
  }

  /** @returns {string|null} the decrypted value, only on explicit request */
  reveal(scope, cwd, id) {
    const secret = this._readStore(scope, cwd).secrets.find(s => s.id === id);
    return secret ? secret.value : null;
  }

  async create(scope, cwd, { name, value, note = '', enabled = true }) {
    this._validate(name, value);
    const doc = this._readStore(scope, cwd);
    if (doc.secrets.some(s => s.name === name)) {
      throw new Error(`A secret named "${name}" already exists in this scope`);
    }
    const now = Date.now();
    const secret = {
      id: crypto.randomUUID(),
      name,
      value,
      note: typeof note === 'string' ? note : '',
      enabled: enabled !== false,
      createdAt: now,
      updatedAt: now
    };
    doc.secrets.push(secret);
    await this._writeStore(scope, cwd, doc);
    return this._toMetadata(secret, scope);
  }

  async update(scope, cwd, id, updates) {
    const doc = this._readStore(scope, cwd);
    const secret = doc.secrets.find(s => s.id === id);
    if (!secret) throw new Error('Secret not found');

    const name = updates.name !== undefined ? updates.name : secret.name;
    const value = updates.value !== undefined ? updates.value : secret.value;
    this._validate(name, value);
    if (doc.secrets.some(s => s.id !== id && s.name === name)) {
      throw new Error(`A secret named "${name}" already exists in this scope`);
    }

    secret.name = name;
    secret.value = value;
    if (updates.note !== undefined) secret.note = typeof updates.note === 'string' ? updates.note : '';
    if (updates.enabled !== undefined) secret.enabled = !!updates.enabled;
    secret.updatedAt = Date.now();

    await this._writeStore(scope, cwd, doc);
    return this._toMetadata(secret, scope);
  }

  /** @returns {boolean} true if a secret was removed */
  async delete(scope, cwd, id) {
    const doc = this._readStore(scope, cwd);
    const before = doc.secrets.length;
    doc.secrets = doc.secrets.filter(s => s.id !== id);
    if (doc.secrets.length === before) return false;
    await this._writeStore(scope, cwd, doc);
    return true;
  }

  /**
   * Enabled secrets as { NAME: value }, project overriding global.
   * Used for PTY env injection and by the main process for its own needs.
   */
  getMergedEnv(cwd) {
    const env = {};
    for (const s of this._readStore('global').secrets) {
      if (s.enabled) env[s.name] = s.value;
    }
    if (cwd) {
      for (const s of this._readStore('project', cwd).secrets) {
        if (s.enabled) env[s.name] = s.value;
      }
    }
    return env;
  }
}

module.exports = SecretsManager;
