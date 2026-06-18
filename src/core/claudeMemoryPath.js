/**
 * claudeMemoryPath
 *
 * Maps a terminal working directory to the Claude auto-memory directory that
 * Claude Code keeps at ~/.claude/projects/<encoded-cwd>/memory/.
 *
 * Encoding (verified against real project dirs): replace every '/' with '-',
 * preserving case and spaces. Pure path math only — callers perform existence
 * checks so this stays deterministic and unit-testable. Deps are injectable.
 */
const os = require('os');
const path = require('path');

function memoryDirForCwd(cwd, deps = {}) {
  if (!cwd) throw new Error('memoryDirForCwd requires a cwd');
  const homedir = deps.homedir || os.homedir();
  const projectsRoot = deps.projectsRoot || path.join(homedir, '.claude', 'projects');
  const encoded = cwd.replace(/\//g, '-');
  const projectDir = path.join(projectsRoot, encoded);
  const memoryDir = path.join(projectDir, 'memory');
  return { encoded, projectDir, memoryDir };
}

module.exports = { memoryDirForCwd };
