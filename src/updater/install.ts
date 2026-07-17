// Shared npm-install runner for the bootstrap and background-update paths,
// plus recovery for the wedged-tree failure mode and a lock that keeps two
// updaters out of ~/.gipity/local at the same time.
import { existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { GIPITY_DIR, LOCAL_DIR, LOCAL_ENTRY } from './state.js';
import { resolveCommand, spawnSyncCommand } from '../platform.js';

export const UPDATE_LOCK = join(GIPITY_DIR, 'update.lock');
const LOCK_STALE_MS = 10 * 60 * 1000;

export interface NpmInstallResult {
  ok: boolean;
  status: number | null;
  stderr: string;
  spawnError?: Error;
}

/**
 * Run `npm install gipity@<version>` in ~/.gipity/local with stderr captured
 * so failures carry the real cause (npm --silent suppresses even its error
 * report, so it is deliberately absent).
 *
 * --ignore-scripts: this can run unattended in the background, so don't let a
 * compromised package's install lifecycle hooks execute. gipity ships
 * precompiled (dist/) and its deps need no build step, so nothing is lost.
 */
export function npmInstallGipity(version: string): NpmInstallResult {
  const res = spawnSyncCommand(resolveCommand('npm'), ['install', '--no-audit', '--no-fund', '--ignore-scripts', `gipity@${version}`], {
    cwd: LOCAL_DIR,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf-8',
  });
  return {
    ok: res.status === 0 && existsSync(LOCAL_ENTRY),
    status: res.status,
    stderr: (res.stderr || '').toString(),
    spawnError: res.error,
  };
}

// An interrupted install (shutdown mid-upgrade, an overlapping npm process)
// leaves node_modules half-renamed, after which npm fails every install in
// the dir with one of these until the tree is wiped. Reproduced: ENOTEMPTY
// renaming node_modules/gipity over a leftover node_modules/.gipity-<hash>
// staging dir. Deliberately narrow - transient failures (network, registry,
// E404) must NOT wipe a still-working tree.
const WEDGE_CODES = /\b(ENOTEMPTY|EEXIST|ENOTDIR|EISDIR|EJSONPARSE)\b/;

export function isWedged(stderr: string): boolean {
  return WEDGE_CODES.test(stderr);
}

/** Wipe the local install tree back to a pristine, installable state.
 *  `dir` is overridable for tests only. */
export function resetLocalTree(dir: string = LOCAL_DIR): void {
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
  rmSync(join(dir, 'package-lock.json'), { force: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gipity-local', private: true, version: '0.0.0' }, null, 2));
}

/**
 * Take the cross-process update lock. The shim spawns a detached updater on
 * every gipity command, so during a long install another invocation would
 * otherwise start a second npm install in the same dir (a reproduced way to
 * corrupt it). A lock older than LOCK_STALE_MS is from a dead updater
 * (machine shutdown mid-install) and is taken over.
 * `lockPath` is overridable for tests only.
 */
export function acquireUpdateLock(lockPath: string = UPDATE_LOCK): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
        writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return true;
      }
    } catch { /* lost the race to another process */ }
    return false;
  }
}

export function releaseUpdateLock(lockPath: string = UPDATE_LOCK): void {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}
