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
