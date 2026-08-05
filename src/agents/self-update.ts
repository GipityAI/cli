/**
 * Install-type detection + update plans backing adapter `updatePlan()`s
 * (the relay daemon's daily harness auto-update; see relay/agent-updates.ts).
 *
 * The rule is conservative: only update through the SAME channel the binary
 * was installed with. An npm-global install (what our own ensureInstalled
 * paths set up) gets `npm install -g <pkg>@latest`; anything else falls back
 * to the agent's own self-updater when it has one (`claude update`), and is
 * otherwise left alone (brew, curl-script, GUI installs) - a wrong-channel
 * update could shadow or corrupt the real install.
 */
import { execSync } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { dirname, join, sep } from 'path';
import type { AgentUpdatePlan } from './types.js';

/** First PATH hit for `binary` (`which`/`where`), or null when absent. */
export function whichFirst(binary: string): string | null {
  const cmd = process.platform === 'win32' ? `where ${binary}` : `which ${binary}`;
  try {
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8', windowsHide: true });
    return out.split('\n').map(l => l.trim()).find(Boolean) || null;
  } catch {
    return null; // execSync throws when the binary isn't on PATH
  }
}

/**
 * True when `binPath` is an npm-global install of `pkg`: the bin shim either
 * realpath-resolves into `node_modules/<pkg>/` (Unix symlink shims) or sits
 * next to a `node_modules/<pkg>` dir (Windows .cmd shims live in the prefix
 * root beside node_modules).
 */
export function isNpmManaged(binPath: string, pkg: string): boolean {
  const marker = join('node_modules', ...pkg.split('/')) + sep;
  try {
    if (realpathSync(binPath).includes(marker)) return true;
  } catch { /* dangling symlink or unreadable - fall through */ }
  try {
    return existsSync(join(dirname(binPath), 'node_modules', ...pkg.split('/')));
  } catch {
    return false;
  }
}

/** npm-global update argv. Lifecycle scripts stay ENABLED - this is the same
 *  channel the original `npm install -g` used, and some agent packages need
 *  their scripts to finish an install. */
export function npmLatestArgv(pkg: string): string[] {
  return ['npm', 'install', '-g', '--no-audit', '--no-fund', `${pkg}@latest`];
}

/**
 * Pick the update plan for a resolved binary path (null when not installed).
 * `selfUpdateArgv` is the agent's own self-updater for non-npm installs, or
 * null when it has none (those installs stay manual).
 */
export function planForInstall(
  binPath: string | null,
  pkg: string,
  selfUpdateArgv: string[] | null,
): AgentUpdatePlan | null {
  if (!binPath) return null;
  if (isNpmManaged(binPath, pkg)) return { argv: npmLatestArgv(pkg), label: 'npm', pkg };
  return selfUpdateArgv ? { argv: selfUpdateArgv, label: selfUpdateArgv.join(' ') } : null;
}
