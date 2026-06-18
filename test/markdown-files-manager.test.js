const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MarkdownFilesManager = require('../src/core/MarkdownFilesManager');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (err) { console.error(`✗ ${name}\n   ${err.message}`); process.exitCode = 1; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`✓ ${name}`); passed++; }
  catch (err) { console.error(`✗ ${name}\n   ${err.message}`); process.exitCode = 1; }
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdfm-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# claude');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'not markdown');
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.md'), '# hidden ok');
  fs.mkdirSync(path.join(root, 'docs', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'sub', 'guide.md'), '# guide');
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'README.md'), '# noise');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD.md'), '# noise');
  return root;
}

(async () => {
  const root = makeRoot();
  const mgr = new MarkdownFilesManager(root);

  test('list finds .md recursively, includes hidden dirs, skips noise dirs', () => {
    const rels = mgr.list().map(f => f.relPath).sort();
    assert.deepStrictEqual(rels, [
      'CLAUDE.md',
      path.join('.claude', 'settings.md'),
      path.join('docs', 'sub', 'guide.md')
    ].sort());
  });

  test('list excludes non-.md files', () => {
    assert.ok(!mgr.list().some(f => f.name === 'notes.txt'));
  });

  test('list rows carry name and dir', () => {
    const row = mgr.list().find(f => f.relPath === 'CLAUDE.md');
    assert.strictEqual(row.name, 'CLAUDE.md');
    assert.strictEqual(row.dir, './');
  });

  test('list rows carry a numeric mtimeMs (date column depends on it)', () => {
    const row = mgr.list().find(f => f.relPath === 'CLAUDE.md');
    assert.strictEqual(typeof row.mtimeMs, 'number');
    assert.ok(row.mtimeMs > 0);
  });

  test('read returns file content', () => {
    assert.strictEqual(mgr.read('CLAUDE.md').content, '# claude');
  });

  test('write persists content', () => {
    mgr.write('CLAUDE.md', '# changed');
    assert.strictEqual(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '# changed');
  });

  test('create makes an empty file and appends .md', () => {
    const res = mgr.create('newdir/fresh');
    assert.strictEqual(res.relPath, path.join('newdir', 'fresh.md'));
    assert.strictEqual(fs.readFileSync(path.join(root, 'newdir', 'fresh.md'), 'utf8'), '');
  });

  test('create rejects an existing file', () => {
    assert.throws(() => mgr.create('CLAUDE.md'));
  });

  test('rename moves the file', () => {
    mgr.create('torename.md');
    const res = mgr.rename('torename.md', 'renamed.md');
    assert.strictEqual(res.relPath, 'renamed.md');
    assert.ok(fs.existsSync(path.join(root, 'renamed.md')));
    assert.ok(!fs.existsSync(path.join(root, 'torename.md')));
  });

  await testAsync('delete uses the injected trash with an absolute path', async () => {
    const calls = [];
    const m2 = new MarkdownFilesManager(root, { trash: async (p) => { calls.push(p); } });
    m2.create('todelete.md');
    await m2.delete('todelete.md');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0], path.join(root, 'todelete.md'));
  });

  test('read rejects path traversal', () => {
    assert.throws(() => mgr.read('../escape.md'));
  });

  test('write rejects path traversal', () => {
    assert.throws(() => mgr.write('../../etc/evil.md', 'x'));
  });

  test('create rejects absolute path escape', () => {
    assert.throws(() => mgr.create('/tmp/evil.md'));
  });

  test('rename rejects traversal on either side', () => {
    assert.throws(() => mgr.rename('CLAUDE.md', '../evil.md'));
  });

  console.log(`\n${passed} assertions passed`);
})();
