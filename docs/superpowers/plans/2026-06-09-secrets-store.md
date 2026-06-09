# Encrypted Secrets Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store secrets/API keys at global and project scope, encrypted at rest via Electron `safeStorage`, injected as environment variables into Claude Code terminal PTYs, managed from a Secrets section in the prompt-library panel.

**Architecture:** A new `SecretsManager` core module owns all file I/O (per-scope `.enc` files in `userData/secrets/`, atomic writes, cwd-hash project scoping — same patterns as `PromptStorageEngine`). `ViewManager` merges enabled secrets into the PTY env at spawn. Thin IPC handlers in `main.js` follow the `prompt-library-*` pattern; `terminal-preload.js` exposes a `secrets` API; the panel UI is a self-contained collapsible section in `prompt-library.js`. Secrets are local-only — `FirebaseSyncAdapter` never touches the `secrets/` directory.

**Tech Stack:** Electron `safeStorage` (Keychain-backed), Node `fs`/`crypto`, plain-Node tests (no framework, same style as `test/tab-attribution.test.js`).

**Spec:** `docs/superpowers/specs/2026-06-09-secrets-store-design.md`

**Testability note:** `SecretsManager` takes an injectable `encryptor` (defaults to a `safeStorage` wrapper). Tests run under plain Node with a fake encryptor — `require('electron')` under plain Node returns a path string, which is fine because the default encryptor factory is only invoked when no encryptor is passed.

**One addition beyond the spec:** secret names matching critical env vars (`PATH`, `HOME`, `SHELL`, `TERM`, `USER`, `LOGNAME`, `TMPDIR`, `CROSSAI_TAB_ID`) are rejected at validation, so a secret can never break terminal spawning.

---

## File Structure

- **Create** `src/core/SecretsManager.js` — storage, CRUD, validation, merged-env (one module; file I/O is small enough that a separate storage engine would be ceremony)
- **Create** `test/secrets-manager.test.js` — plain-Node tests with fake encryptor + temp dirs
- **Modify** `src/main.js` — instantiate `SecretsManager`, pass to `ViewManager`, add 5 IPC handlers
- **Modify** `src/core/ViewManager.js` — accept `secretsManager`, inject merged env at PTY spawn
- **Modify** `src/terminal-preload.js` — expose `secrets` API on `electronAPI`
- **Modify** `src/renderer/prompt-library.js` — Secrets section UI (rows, reveal/copy, inline add/edit form)
- **Modify** `src/renderer/prompt-library.css` — section styles (design-token variables only)
- **Modify** `CLAUDE.md` — document the feature

---

### Task 1: SecretsManager — storage, CRUD, validation

**Files:**
- Create: `src/core/SecretsManager.js`
- Test: `test/secrets-manager.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/secrets-manager.test.js`:

```js
// Tests for SecretsManager. Plain Node: node test/secrets-manager.test.js
// Uses a fake encryptor so safeStorage (Electron-only) is never touched.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SecretsManager = require('../src/core/SecretsManager');

// Reversible fake "encryption" with a marker so tests can assert that
// what hits disk is not the plaintext document.
const fakeEncryptor = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from('ENC:' + Buffer.from(plaintext, 'utf-8').toString('base64')),
  decrypt: (buffer) => {
    const str = buffer.toString('utf-8');
    if (!str.startsWith('ENC:')) throw new Error('not encrypted');
    return Buffer.from(str.slice(4), 'base64').toString('utf-8');
  }
};

const unavailableEncryptor = {
  isAvailable: () => false,
  encrypt: () => { throw new Error('unavailable'); },
  decrypt: () => { throw new Error('unavailable'); }
};

function makeManager(encryptor = fakeEncryptor) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
  return new SecretsManager({ userDataPath: dir, encryptor });
}

const CWD = '/Users/someone/projects/demo';
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('create returns metadata without the value; list never includes values', async () => {
  const mgr = makeManager();
  const meta = await mgr.create('global', null, { name: 'API_KEY', value: 'sk-12345' });
  assert.strictEqual(meta.name, 'API_KEY');
  assert.strictEqual(meta.scope, 'global');
  assert.strictEqual(meta.enabled, true);
  assert.strictEqual('value' in meta, false);
  const listed = mgr.list('global');
  assert.strictEqual(listed.length, 1);
  assert.strictEqual('value' in listed[0], false);
});

test('reveal returns the value by id', async () => {
  const mgr = makeManager();
  const meta = await mgr.create('project', CWD, { name: 'DB_URL', value: 'postgres://x' });
  assert.strictEqual(mgr.reveal('project', CWD, meta.id), 'postgres://x');
  assert.strictEqual(mgr.reveal('project', CWD, 'no-such-id'), null);
});

test('duplicate name in same scope is rejected', async () => {
  const mgr = makeManager();
  await mgr.create('global', null, { name: 'TOKEN', value: 'a' });
  await assert.rejects(() => mgr.create('global', null, { name: 'TOKEN', value: 'b' }), /already exists/);
});

test('invalid, reserved, and oversized inputs are rejected', async () => {
  const mgr = makeManager();
  await assert.rejects(() => mgr.create('global', null, { name: '1BAD', value: 'x' }), /environment variable name/);
  await assert.rejects(() => mgr.create('global', null, { name: 'HAS SPACE', value: 'x' }), /environment variable name/);
  await assert.rejects(() => mgr.create('global', null, { name: 'PATH', value: 'x' }), /reserved/);
  await assert.rejects(() => mgr.create('global', null, { name: 'BIG', value: 'x'.repeat(33 * 1024) }), /32 KB/);
  await assert.rejects(() => mgr.create('global', null, { name: 'EMPTY', value: '' }), /non-empty/);
});

test('update changes fields; renaming onto an existing name is rejected', async () => {
  const mgr = makeManager();
  const a = await mgr.create('global', null, { name: 'A', value: '1' });
  await mgr.create('global', null, { name: 'B', value: '2' });
  const updated = await mgr.update('global', null, a.id, { value: '9', enabled: false, note: 'hi' });
  assert.strictEqual(updated.enabled, false);
  assert.strictEqual(updated.note, 'hi');
  assert.strictEqual(mgr.reveal('global', null, a.id), '9');
  await assert.rejects(() => mgr.update('global', null, a.id, { name: 'B' }), /already exists/);
});

test('delete removes the secret', async () => {
  const mgr = makeManager();
  const meta = await mgr.create('global', null, { name: 'GONE', value: 'x' });
  assert.strictEqual(await mgr.delete('global', null, meta.id), true);
  assert.strictEqual(mgr.list('global').length, 0);
  assert.strictEqual(await mgr.delete('global', null, meta.id), false);
});

test('file on disk is not plaintext', async () => {
  const mgr = makeManager();
  await mgr.create('global', null, { name: 'SECRET_ON_DISK', value: 'super-secret-value' });
  const raw = fs.readFileSync(path.join(mgr.baseDir, 'global.enc'), 'utf-8');
  assert.strictEqual(raw.includes('super-secret-value'), false);
  assert.strictEqual(raw.includes('SECRET_ON_DISK'), false);
});

test('writes are refused when encryption is unavailable', async () => {
  const mgr = makeManager(unavailableEncryptor);
  await assert.rejects(() => mgr.create('global', null, { name: 'X', value: 'y' }), /not available/);
});

test('reads return empty (without destroying the file) when encryption is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-test-'));
  const writer = new SecretsManager({ userDataPath: dir, encryptor: fakeEncryptor });
  await writer.create('global', null, { name: 'KEEP', value: 'me' });
  const reader = new SecretsManager({ userDataPath: dir, encryptor: unavailableEncryptor });
  assert.deepStrictEqual(reader.list('global'), []);
  // file must still exist, un-renamed
  assert.strictEqual(fs.existsSync(path.join(dir, 'secrets', 'global.enc')), true);
});

test('corrupt file is backed up to .corrupt and a fresh store starts', async () => {
  const mgr = makeManager();
  await mgr.create('global', null, { name: 'OLD', value: 'x' });
  fs.writeFileSync(path.join(mgr.baseDir, 'global.enc'), 'garbage-not-encrypted');
  assert.deepStrictEqual(mgr.list('global'), []);
  assert.strictEqual(fs.existsSync(path.join(mgr.baseDir, 'global.enc.corrupt')), true);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err.message}`);
    }
  }
  console.log(failed ? `\n${failed}/${tests.length} tests failed` : `\nAll ${tests.length} tests passed`);
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node test/secrets-manager.test.js`
Expected: crash with `Cannot find module '../src/core/SecretsManager'`

- [ ] **Step 3: Implement SecretsManager**

Create `src/core/SecretsManager.js`:

```js
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
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
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
      console.warn('[SecretsManager] Secure storage unavailable — secrets cannot be read');
      return { version: 1, secrets: [] };
    }

    try {
      const buffer = fs.readFileSync(filePath);
      const doc = JSON.parse(this.encryptor.decrypt(buffer));
      if (!doc || !Array.isArray(doc.secrets)) throw new Error('Malformed secrets document');
      return doc;
    } catch (err) {
      console.error(`[SecretsManager] Corrupt secrets file ${filePath}: ${err.message} — backing up and starting fresh`);
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
      await fs.promises.writeFile(tempPath, encrypted);
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node test/secrets-manager.test.js`
Expected: `All 10 tests passed`

- [ ] **Step 5: Commit**

```bash
git add src/core/SecretsManager.js test/secrets-manager.test.js
git commit -m "Add SecretsManager: encrypted global/project secrets storage"
```

---

### Task 2: getMergedEnv merge semantics

**Files:**
- Modify: `test/secrets-manager.test.js` (append tests before the runner block)
- Modify: `src/core/SecretsManager.js` (only if a test fails — `getMergedEnv` already exists from Task 1)

- [ ] **Step 1: Write the failing tests**

Insert into `test/secrets-manager.test.js`, immediately before the `(async () => {` runner block:

```js
test('getMergedEnv merges scopes with project override and skips disabled', async () => {
  const mgr = makeManager();
  await mgr.create('global', null, { name: 'SHARED', value: 'global-val' });
  await mgr.create('global', null, { name: 'GLOBAL_ONLY', value: 'g' });
  await mgr.create('global', null, { name: 'DISABLED_ONE', value: 'nope', enabled: false });
  await mgr.create('project', CWD, { name: 'SHARED', value: 'project-val' });
  await mgr.create('project', CWD, { name: 'PROJECT_ONLY', value: 'p' });

  const env = mgr.getMergedEnv(CWD);
  assert.deepStrictEqual(env, {
    SHARED: 'project-val',
    GLOBAL_ONLY: 'g',
    PROJECT_ONLY: 'p'
  });
});

test('getMergedEnv without cwd returns global scope only', async () => {
  const mgr = makeManager();
  await mgr.create('global', null, { name: 'G', value: '1' });
  assert.deepStrictEqual(mgr.getMergedEnv(null), { G: '1' });
});

test('getMergedEnv returns empty object when encryption is unavailable', async () => {
  const mgr = makeManager(unavailableEncryptor);
  assert.deepStrictEqual(mgr.getMergedEnv(CWD), {});
});
```

- [ ] **Step 2: Run tests**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node test/secrets-manager.test.js`
Expected: `All 13 tests passed` (the Task 1 implementation already covers these; if any fail, fix `getMergedEnv` per the assertions above)

- [ ] **Step 3: Commit**

```bash
git add test/secrets-manager.test.js
git commit -m "Add merge-semantics tests for SecretsManager.getMergedEnv"
```

---

### Task 3: Wire into main.js and inject env in ViewManager

**Files:**
- Modify: `src/main.js` (manager instantiation ~line 198, ViewManager construction ~line 384, IPC handlers after the `prompt-image-*` block ~line 2007)
- Modify: `src/core/ViewManager.js` (constructor ~line 74, `setupTerminalPty` env block ~line 803)

- [ ] **Step 1: Instantiate SecretsManager in main.js**

Add to the requires at the top of `src/main.js`, next to the other core requires:

```js
const SecretsManager = require('./core/SecretsManager');
```

Add near `let promptLibraryManager = null;` (~line 91):

```js
let secretsManager = null;
```

Add right after the `PromptImageManager` instantiation (~line 204):

```js
  // Initialize SecretsManager (encrypted env vars for terminals)
  secretsManager = new SecretsManager({ userDataPath: app.getPath('userData') });
```

- [ ] **Step 2: Pass secretsManager to ViewManager**

In the `viewManager = new ViewManager({...})` call (~line 384), add `secretsManager` to the options object:

```js
  viewManager = new ViewManager({
    mainWindow,
    store,
    secretsManager,
    getSidebarWidth: () => SIDEBAR_WIDTH,
    // ... existing options unchanged
```

- [ ] **Step 3: Accept and use it in ViewManager**

In `src/core/ViewManager.js`, add `secretsManager` to the destructured constructor params and assign it (next to `this.firebaseSyncAdapter = firebaseSyncAdapter;`):

```js
  constructor({ mainWindow, store, getSidebarWidth, onTabsChanged, onTerminalComplete, historyManager, hooksManager, firebaseSyncAdapter, secretsManager }) {
```
```js
    this.secretsManager = secretsManager;
```

In `setupTerminalPty`, after the PATH setup block ends (`env.PATH = ...`, ~line 831) and before `try { const ptyProcess = pty.spawn(...)`:

```js
    // Inject enabled secrets (global + project, project wins) as env vars.
    // New terminals only; a decrypt failure must never block terminal launch.
    if (this.secretsManager) {
      try {
        Object.assign(env, this.secretsManager.getMergedEnv(cwd));
      } catch (err) {
        console.warn('[ViewManager] Failed to load secrets for terminal env:', err.message);
      }
    }
```

- [ ] **Step 4: Add IPC handlers in main.js**

Add after the `prompt-image-remove` handler block (~line 2007). Handlers return `{ error }` instead of throwing so the renderer can show the message:

```js
// === Secrets Store IPC (terminal windows only, via terminal-preload) ===
// Load-bearing rule: list responses never contain secret values.
// Values cross IPC solely via secrets-reveal.

function getTerminalCwd(terminalId) {
  return store.get(`tabData.${terminalId}.cwd`) || null;
}

ipcMain.handle('secrets-list', (event, { terminalId }) => {
  if (!secretsManager) return { available: false, secrets: [] };
  const cwd = getTerminalCwd(terminalId);
  return {
    available: secretsManager.isEncryptionAvailable(),
    secrets: [
      ...secretsManager.list('global'),
      ...(cwd ? secretsManager.list('project', cwd) : [])
    ]
  };
});

ipcMain.handle('secrets-create', async (event, { terminalId, scope, secret }) => {
  if (!secretsManager) return { error: 'Secrets store unavailable' };
  try {
    return { secret: await secretsManager.create(scope, getTerminalCwd(terminalId), secret) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('secrets-update', async (event, { terminalId, scope, id, updates }) => {
  if (!secretsManager) return { error: 'Secrets store unavailable' };
  try {
    return { secret: await secretsManager.update(scope, getTerminalCwd(terminalId), id, updates) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('secrets-delete', async (event, { terminalId, scope, id }) => {
  if (!secretsManager) return { error: 'Secrets store unavailable' };
  try {
    return { deleted: await secretsManager.delete(scope, getTerminalCwd(terminalId), id) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('secrets-reveal', (event, { terminalId, scope, id }) => {
  if (!secretsManager) return { error: 'Secrets store unavailable' };
  try {
    return { value: secretsManager.reveal(scope, getTerminalCwd(terminalId), id) };
  } catch (err) {
    return { error: err.message };
  }
});
```

- [ ] **Step 5: Syntax-check and run existing tests**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node --check src/main.js && node --check src/core/ViewManager.js && node test/secrets-manager.test.js && node test/tab-attribution.test.js`
Expected: both checks silent, both test files all passing

- [ ] **Step 6: Commit**

```bash
git add src/main.js src/core/ViewManager.js
git commit -m "Wire SecretsManager into main process: PTY env injection + IPC"
```

---

### Task 4: Preload API

**Files:**
- Modify: `src/terminal-preload.js` (inside the `electronAPI` object, after the `promptLibrary` block)

- [ ] **Step 1: Expose the secrets API**

The preload already holds `terminalId` in module scope (used by the `promptLibrary` methods). Add a sibling `secrets` object inside `contextBridge.exposeInMainWorld('electronAPI', {...})`, after the `promptLibrary` block:

```js
  // Secrets Store APIs (values only ever cross via reveal)
  secrets: {
    list: () => ipcRenderer.invoke('secrets-list', { terminalId }),
    create: (scope, secret) => ipcRenderer.invoke('secrets-create', { terminalId, scope, secret }),
    update: (scope, id, updates) => ipcRenderer.invoke('secrets-update', { terminalId, scope, id, updates }),
    remove: (scope, id) => ipcRenderer.invoke('secrets-delete', { terminalId, scope, id }),
    reveal: (scope, id) => ipcRenderer.invoke('secrets-reveal', { terminalId, scope, id })
  },
```

- [ ] **Step 2: Syntax-check**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node --check src/terminal-preload.js`
Expected: silent

- [ ] **Step 3: Commit**

```bash
git add src/terminal-preload.js
git commit -m "Expose secrets store API in terminal preload"
```

---

### Task 5: Secrets section UI in the prompt-library panel

**Files:**
- Modify: `src/renderer/prompt-library.js` (constructor state ~line 31, `render()` ~lines 780-830, new methods appended to the class)
- Modify: `src/renderer/prompt-library.css` (append section styles)

The section is self-contained: it keeps its own state (`this.secrets`, `this.secretsAvailable`, `this.secretsCollapsed`), renders below the Done section, and uses an inline form rather than the prompt editor. All DOM via `createElement`/`textContent`; all colors via design-token CSS variables.

- [ ] **Step 1: Add state and data loading**

In the constructor, next to `this.notesCollapsed = false;` (~line 31):

```js
    this.secretsCollapsed = true;
    this.secrets = [];           // metadata only — never values
    this.secretsAvailable = true;
    this.secretsEditing = null;  // null | 'new' | secret id
```

Append to the class:

```js
  /** Refresh secrets metadata from the main process. */
  async loadSecrets() {
    try {
      const result = await window.electronAPI.secrets.list();
      this.secrets = result.secrets || [];
      this.secretsAvailable = result.available !== false;
    } catch (err) {
      console.error('Failed to load secrets:', err);
      this.secrets = [];
    }
  }
```

In `init()` (~line 186), call `await this.loadSecrets();` immediately after the existing `await this.loadPrompts();` (~line 205).

- [ ] **Step 2: Render the section from renderPrompts()**

In `renderPrompts()` (~line 707), two changes. First, the early-return empty state (~line 792) must still show the secrets section — change `return;` at the end of the empty-state branch to:

```js
      this.promptsContainer.appendChild(emptyState);
      this.promptsContainer.appendChild(this.renderSecretsSection());
      return;
```

Second, after the Done section block (~line 829, after `this.promptsContainer.appendChild(doneSection); }`):

```js
    // 6. Secrets section (always rendered — it is the only entry point for adding secrets)
    this.promptsContainer.appendChild(this.renderSecretsSection());
```

- [ ] **Step 3: Implement the section renderer**

Append to the class:

```js
  /**
   * Build the SECRETS section: header with add button, masked rows, inline
   * add/edit form. Secrets are not draggable and never join prompt search
   * by value — only name matching below.
   */
  renderSecretsSection() {
    const section = document.createElement('div');
    section.className = 'prompt-section secrets-section';

    const header = document.createElement('div');
    header.className = 'prompt-section-header';

    const toggle = document.createElement('button');
    toggle.className = 'prompt-section-toggle';
    toggle.textContent = this.secretsCollapsed ? '▶' : '▼';

    const titleEl = document.createElement('span');
    titleEl.className = 'prompt-section-title';
    titleEl.textContent = `SECRETS (${this.secrets.length})`;

    const addBtn = document.createElement('button');
    addBtn.className = 'secrets-add-btn';
    addBtn.textContent = '+';
    addBtn.title = 'Add secret';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.secretsCollapsed = false;
      this.secretsEditing = 'new';
      this.renderPrompts();
    });

    header.appendChild(toggle);
    header.appendChild(titleEl);
    header.appendChild(addBtn);

    const body = document.createElement('div');
    body.className = 'prompt-section-cards';
    if (this.secretsCollapsed) body.style.display = 'none';

    if (!this.secretsAvailable) {
      const warn = document.createElement('div');
      warn.className = 'secrets-unavailable';
      warn.textContent = 'Secure storage is unavailable on this system — secrets are disabled.';
      body.appendChild(warn);
    } else {
      if (this.secretsEditing === 'new') {
        body.appendChild(this.createSecretForm(null));
      }
      const query = (this.searchQuery || '').toLowerCase();
      const visible = query
        ? this.secrets.filter(s => s.name.toLowerCase().includes(query))
        : this.secrets;
      visible.forEach(secret => {
        if (this.secretsEditing === secret.id) {
          body.appendChild(this.createSecretForm(secret));
        } else {
          body.appendChild(this.createSecretRow(secret));
        }
      });
      if (visible.length === 0 && this.secretsEditing !== 'new') {
        const empty = document.createElement('div');
        empty.className = 'secrets-empty';
        empty.textContent = query ? 'No secrets match.' : 'No secrets yet. Click + to add one.';
        body.appendChild(empty);
      }
    }

    header.addEventListener('click', () => {
      this.secretsCollapsed = !this.secretsCollapsed;
      this.renderPrompts();
    });

    section.appendChild(header);
    section.appendChild(body);
    return section;
  }

  /** One masked secret row: name, scope chip, dots, reveal/copy/edit/delete. */
  createSecretRow(secret) {
    const row = document.createElement('div');
    row.className = 'secret-row' + (secret.enabled ? '' : ' secret-disabled');

    const info = document.createElement('div');
    info.className = 'secret-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'secret-name';
    nameEl.textContent = secret.name;
    if (secret.note) nameEl.title = secret.note;

    const scopeEl = document.createElement('span');
    scopeEl.className = `secret-scope secret-scope-${secret.scope}`;
    scopeEl.textContent = secret.scope === 'global' ? 'G' : 'P';
    scopeEl.title = secret.scope === 'global' ? 'Global' : 'Project';

    const valueEl = document.createElement('span');
    valueEl.className = 'secret-value';
    valueEl.textContent = '••••••••';

    info.appendChild(nameEl);
    info.appendChild(scopeEl);
    info.appendChild(valueEl);

    const actions = document.createElement('div');
    actions.className = 'secret-actions';

    let revealed = false;
    const revealBtn = document.createElement('button');
    revealBtn.className = 'secret-action-btn';
    revealBtn.textContent = '👁';
    revealBtn.title = 'Reveal';
    revealBtn.addEventListener('click', async () => {
      if (revealed) {
        valueEl.textContent = '••••••••';
        revealed = false;
        return;
      }
      const result = await window.electronAPI.secrets.reveal(secret.scope, secret.id);
      if (result.value != null) {
        valueEl.textContent = result.value;
        revealed = true;
      }
    });

    const copyBtn = document.createElement('button');
    copyBtn.className = 'secret-action-btn';
    copyBtn.textContent = '📋';
    copyBtn.title = 'Copy value';
    copyBtn.addEventListener('click', async () => {
      const result = await window.electronAPI.secrets.reveal(secret.scope, secret.id);
      if (result.value != null) {
        await navigator.clipboard.writeText(result.value);
        copyBtn.textContent = '✓';
        setTimeout(() => { copyBtn.textContent = '📋'; }, 1200);
      }
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'secret-action-btn';
    editBtn.textContent = '✏️';
    editBtn.title = 'Edit';
    editBtn.addEventListener('click', () => {
      this.secretsEditing = secret.id;
      this.renderPrompts();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'secret-action-btn secret-delete-btn';
    deleteBtn.textContent = '🗑';
    deleteBtn.title = 'Delete';
    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete secret "${secret.name}"?`)) return;
      await window.electronAPI.secrets.remove(secret.scope, secret.id);
      await this.loadSecrets();
      this.renderPrompts();
    });

    actions.appendChild(revealBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  /** Inline add/edit form. Pass null to create, or existing metadata to edit. */
  createSecretForm(existing) {
    const form = document.createElement('div');
    form.className = 'secret-form';

    const nameInput = document.createElement('input');
    nameInput.className = 'secret-form-input';
    nameInput.placeholder = 'NAME (e.g. OPENAI_API_KEY)';
    nameInput.spellcheck = false;
    if (existing) nameInput.value = existing.name;

    const valueInput = document.createElement('input');
    valueInput.className = 'secret-form-input';
    valueInput.type = 'password';
    valueInput.placeholder = existing ? 'Value (leave blank to keep current)' : 'Value';
    valueInput.spellcheck = false;

    const noteInput = document.createElement('input');
    noteInput.className = 'secret-form-input';
    noteInput.placeholder = 'Note (optional)';
    if (existing && existing.note) noteInput.value = existing.note;

    const optionsRow = document.createElement('div');
    optionsRow.className = 'secret-form-options';

    const scopeSelect = document.createElement('select');
    scopeSelect.className = 'secret-form-select';
    for (const [val, label] of [['global', 'Global'], ['project', 'Project']]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label;
      scopeSelect.appendChild(opt);
    }
    if (existing) {
      scopeSelect.value = existing.scope;
      scopeSelect.disabled = true; // moving scopes = delete + recreate; YAGNI
    }

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'secret-form-enabled';
    const enabledCheck = document.createElement('input');
    enabledCheck.type = 'checkbox';
    enabledCheck.checked = existing ? existing.enabled : true;
    enabledLabel.appendChild(enabledCheck);
    enabledLabel.appendChild(document.createTextNode(' Inject into new terminals'));

    optionsRow.appendChild(scopeSelect);
    optionsRow.appendChild(enabledLabel);

    const errorEl = document.createElement('div');
    errorEl.className = 'secret-form-error';

    const buttonsRow = document.createElement('div');
    buttonsRow.className = 'secret-form-buttons';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'secret-form-save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const value = valueInput.value;
      let result;
      if (existing) {
        const updates = { name, note: noteInput.value, enabled: enabledCheck.checked };
        if (value) updates.value = value;
        result = await window.electronAPI.secrets.update(existing.scope, existing.id, updates);
      } else {
        result = await window.electronAPI.secrets.create(scopeSelect.value, {
          name,
          value,
          note: noteInput.value,
          enabled: enabledCheck.checked
        });
      }
      if (result.error) {
        errorEl.textContent = result.error;
        return;
      }
      this.secretsEditing = null;
      await this.loadSecrets();
      this.renderPrompts();
      this.showSecretsHint();
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secret-form-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      this.secretsEditing = null;
      this.renderPrompts();
    });

    buttonsRow.appendChild(saveBtn);
    buttonsRow.appendChild(cancelBtn);

    form.appendChild(nameInput);
    form.appendChild(valueInput);
    form.appendChild(noteInput);
    form.appendChild(optionsRow);
    form.appendChild(errorEl);
    form.appendChild(buttonsRow);
    return form;
  }

  /** One-shot hint: env changes only apply to newly spawned terminals. */
  showSecretsHint() {
    const existing = document.querySelector('.secrets-hint');
    if (existing) existing.remove();
    const hint = document.createElement('div');
    hint.className = 'secrets-hint';
    hint.textContent = 'Secrets apply to new terminal sessions.';
    const section = this.promptsContainer.querySelector('.secrets-section');
    if (section) section.appendChild(hint);
    setTimeout(() => hint.remove(), 4000);
  }
```

Note for the edit path: editing never pre-fills the value (the form never receives it). A blank value on save keeps the current one — that is why `updates.value` is only set when non-empty.

- [ ] **Step 4: Add the CSS**

Append to `src/renderer/prompt-library.css` (design tokens only — every color must be a `var()` with fallback):

```css
/* === Secrets section === */
.secrets-add-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
  font-size: 14px;
  cursor: pointer;
  padding: 0 4px;
}
.secrets-add-btn:hover {
  color: var(--color-text-primary, #ffffff);
}

.secret-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  background: var(--color-bg-card, #2a2a32);
  border: 1px solid var(--color-border-subtle, #2e2e34);
  border-radius: var(--radius-md, 6px);
  margin-bottom: 4px;
}
.secret-row.secret-disabled {
  opacity: 0.5;
}

.secret-info {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.secret-name {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--color-text-primary, #ffffff);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.secret-scope {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: var(--radius-sm, 4px);
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.7));
  background: var(--color-bg-elevated, #252530);
}
.secret-scope-project {
  color: var(--color-semantic-project, #818cf8);
}

.secret-value {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 80px;
}

.secret-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.secret-action-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 11px;
  padding: 2px;
  opacity: 0.6;
}
.secret-action-btn:hover {
  opacity: 1;
}

.secret-form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  background: var(--color-bg-elevated, #252530);
  border: 1px solid var(--color-border-default, #3c3c42);
  border-radius: var(--radius-md, 6px);
  margin-bottom: 4px;
}

.secret-form-input,
.secret-form-select {
  background: var(--color-bg-input, #1a1a1f);
  border: 1px solid var(--color-border-default, #3c3c42);
  border-radius: var(--radius-sm, 4px);
  color: var(--color-text-primary, #ffffff);
  font-size: 11px;
  padding: 4px 6px;
}
.secret-form-input:focus,
.secret-form-select:focus {
  outline: none;
  border-color: var(--color-border-focus, #6366f1);
}

.secret-form-options {
  display: flex;
  align-items: center;
  gap: 8px;
}

.secret-form-enabled {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.7));
}

.secret-form-error {
  color: var(--color-status-error, #ef4444);
  font-size: 10px;
  min-height: 12px;
}

.secret-form-buttons {
  display: flex;
  gap: 6px;
}

.secret-form-save {
  background: var(--color-primary-base, #6366f1);
  border: none;
  border-radius: var(--radius-sm, 4px);
  color: var(--color-text-primary, #ffffff);
  font-size: 11px;
  padding: 4px 10px;
  cursor: pointer;
}
.secret-form-save:hover {
  background: var(--color-primary-hover, #818cf8);
}

.secret-form-cancel {
  background: none;
  border: 1px solid var(--color-border-default, #3c3c42);
  border-radius: var(--radius-sm, 4px);
  color: var(--color-text-secondary, rgba(255, 255, 255, 0.7));
  font-size: 11px;
  padding: 4px 10px;
  cursor: pointer;
}

.secrets-empty,
.secrets-unavailable {
  font-size: 11px;
  color: var(--color-text-muted, rgba(255, 255, 255, 0.5));
  padding: 8px;
}
.secrets-unavailable {
  color: var(--color-status-warning, #f59e0b);
}

.secrets-hint {
  font-size: 10px;
  color: var(--color-status-info, #3b82f6);
  padding: 4px 8px;
}
```

If `--font-mono` does not exist in `design-tokens.js` typography, add it there first (per the design-system rule), e.g. `fontFamily.mono: "ui-monospace, 'SF Mono', Menlo, monospace"` — check how existing mono text in the terminal styles references it and match.

- [ ] **Step 5: Syntax-check**

Run: `export PATH="$(echo $HOME/.nvm/versions/node/*/bin):$PATH"; node --check src/renderer/prompt-library.js`
Expected: silent

- [ ] **Step 6: Commit**

```bash
git add src/renderer/prompt-library.js src/renderer/prompt-library.css design-tokens.js
git commit -m "Add Secrets section to library panel: masked rows, inline editor"
```

---

### Task 6: Manual verification (spec verification plan) and docs

**Files:**
- Modify: `CLAUDE.md` (add Secrets Store section after the Library section)

- [ ] **Step 1: Run the app and execute the spec's verification plan**

Run: `npm start`, open a Claude Code terminal tab, open the library panel (Cmd+Shift+P). Then:

1. Add a global secret `CROSSAI_TEST` = `global-val` and a project secret `CROSSAI_TEST` = `project-val` (in a tab whose cwd is your test project).
2. Open a **new** terminal in that project; run `echo $CROSSAI_TEST` → must print `project-val`.
3. Open a new terminal in a different cwd; `echo $CROSSAI_TEST` → must print `global-val`.
4. Disable the global secret, open another new terminal in the other cwd; `echo $CROSSAI_TEST` → must print nothing.
5. The terminal that was already running must still have its original value (edits don't touch live sessions).
6. `cat ~/Library/Application\ Support/Cross\ AI\ Browser/secrets/global.enc` → binary garbage, no plaintext values or names visible.
7. Reveal, copy, edit, and delete a secret in the panel; confirm the masked display, error display for a duplicate name, and the "applies to new terminal sessions" hint.
8. Watch the console during a Firebase sync; no `[FirebaseSyncAdapter]` output may reference the secrets directory (it has no code path to it — this is a sanity check).
9. Delete the test secrets when done.

- [ ] **Step 2: Update CLAUDE.md**

Add after the Library (Prompts + Notes) section:

```markdown
## Secrets Store
Encrypted secrets/API keys at global and project scope, injected as environment
variables into Claude Code terminal PTYs at spawn (project overrides global).

- `src/core/SecretsManager.js` — storage, CRUD, validation, merged-env
- Files: `~/Library/Application Support/Cross AI Browser/secrets/global.enc` and
  `<cwd-hash>.enc`, encrypted via Electron `safeStorage` (Keychain-backed)
- Local-only: never synced to Firebase
- UI: SECRETS section in the library panel (masked values; reveal/copy on demand)
- IPC list responses never contain values — only `secrets-reveal` returns one
- No plaintext fallback: writes refused if `safeStorage` is unavailable
- Tests: `test/secrets-manager.test.js` (plain Node, injected fake encryptor)
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document secrets store in CLAUDE.md"
```
