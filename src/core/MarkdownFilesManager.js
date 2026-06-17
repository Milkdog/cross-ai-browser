/**
 * MarkdownFilesManager
 *
 * Filesystem access for the terminal's Markdown library tab. Owns the security
 * boundary: every relative path is resolved against the working directory and
 * verified to stay inside it before any read/write/create/delete/rename.
 *
 * Dependencies are injectable so the module is unit-testable under plain Node:
 *   - fs:    defaults to node:fs
 *   - trash: async (absPath) => void; defaults to fs.promises.unlink
 *            (main.js injects electron shell.trashItem so deletes go to the OS Trash)
 */
const nodeFs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out',
  '.next', '.cache', 'coverage', '.superpowers'
]);

class MarkdownFilesManager {
  constructor(cwd, deps = {}) {
    if (!cwd) throw new Error('MarkdownFilesManager requires a cwd');
    this.cwd = path.resolve(cwd);
    this.fs = deps.fs || nodeFs;
    this.trash = deps.trash || (async (p) => { await this.fs.promises.unlink(p); });
    this._watcher = null;
    this._watchTimer = null;
  }

  /** Resolve relPath against cwd; throw if it escapes the working directory. */
  _resolveInside(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) {
      throw new Error('Invalid path');
    }
    const abs = path.resolve(this.cwd, relPath);
    const rel = path.relative(this.cwd, abs);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes working directory: ${relPath}`);
    }
    return abs;
  }

  list() {
    const results = [];
    const walk = (absDir) => {
      let entries;
      try { entries = this.fs.readdirSync(absDir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          walk(path.join(absDir, entry.name));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const abs = path.join(absDir, entry.name);
          let stat;
          try { stat = this.fs.statSync(abs); } catch { continue; }
          const relPath = path.relative(this.cwd, abs);
          const dirName = path.dirname(relPath);
          results.push({
            relPath,
            name: entry.name,
            dir: dirName === '.' ? './' : dirName + path.sep,
            mtimeMs: stat.mtimeMs,
            size: stat.size
          });
        }
      }
    };
    walk(this.cwd);
    results.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return results;
  }

  read(relPath) {
    const abs = this._resolveInside(relPath);
    const content = this.fs.readFileSync(abs, 'utf8');
    const stat = this.fs.statSync(abs);
    return { content, mtimeMs: stat.mtimeMs };
  }

  write(relPath, content) {
    const abs = this._resolveInside(relPath);
    this.fs.writeFileSync(abs, content, 'utf8');
    const stat = this.fs.statSync(abs);
    return { mtimeMs: stat.mtimeMs };
  }

  create(relPath) {
    let rel = relPath;
    if (!rel.toLowerCase().endsWith('.md')) rel += '.md';
    const abs = this._resolveInside(rel);
    if (this.fs.existsSync(abs)) throw new Error('File already exists');
    this.fs.mkdirSync(path.dirname(abs), { recursive: true });
    this.fs.writeFileSync(abs, '', 'utf8');
    return { relPath: path.relative(this.cwd, abs) };
  }

  async delete(relPath) {
    const abs = this._resolveInside(relPath);
    await this.trash(abs);
    return { ok: true };
  }

  rename(fromRel, toRel) {
    const fromAbs = this._resolveInside(fromRel);
    let to = toRel;
    if (!to.toLowerCase().endsWith('.md')) to += '.md';
    const toAbs = this._resolveInside(to);
    if (this.fs.existsSync(toAbs)) throw new Error('Target already exists');
    this.fs.mkdirSync(path.dirname(toAbs), { recursive: true });
    this.fs.renameSync(fromAbs, toAbs);
    return { relPath: path.relative(this.cwd, toAbs) };
  }

  watch(onChange) {
    if (this._watcher) return;
    try {
      this._watcher = this.fs.watch(this.cwd, { recursive: true }, (_event, filename) => {
        if (filename) {
          const name = filename.toString();
          if (!name.toLowerCase().endsWith('.md')) return;
          if (name.split(path.sep).some(p => SKIP_DIRS.has(p))) return;
        }
        clearTimeout(this._watchTimer);
        this._watchTimer = setTimeout(() => onChange(), 150);
      });
    } catch {
      this._watcher = null; // recursive watch unsupported on this platform
    }
  }

  unwatch() {
    if (this._watcher) {
      try { this._watcher.close(); } catch {}
      this._watcher = null;
    }
    clearTimeout(this._watchTimer);
  }
}

module.exports = MarkdownFilesManager;
