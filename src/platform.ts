import { execSync } from 'child_process';

/**
 * Resolve a command to something Node's spawn/spawnSync can launch directly.
 *
 * On Windows, npm-installed CLIs (npm, npx, gipity, claude) are `.cmd` batch
 * shims, not `.exe`s. Node's spawn without `shell: true` cannot launch a bare
 * `npm` - it fails with ENOENT and a null exit status. Resolving the real path
 * (preferring `.exe`, falling back to `.cmd`) lets us spawn without `shell: true`
 * (which would otherwise require escaping arguments).
 */
export function resolveCommand(cmd: string): string {
  if (process.platform !== 'win32') return cmd;
  try {
    const lines = execSync(`where ${cmd}`, { encoding: 'utf-8' })
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
    // Prefer .exe (native) over .cmd (npm shim)
    return lines.find(l => l.endsWith('.exe')) || lines.find(l => l.endsWith('.cmd')) || cmd;
  } catch {
    return `${cmd}.cmd`;
  }
}
