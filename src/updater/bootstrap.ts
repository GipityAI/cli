import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { LOCAL_DIR, LOCAL_ENTRY, LOCAL_PKG_DIR, writeState, readState } from './state.js';

export function isBootstrapped(): boolean {
  return existsSync(LOCAL_ENTRY);
}

/**
 * Install gipity@<version> into ~/.gipity/local/. Synchronous: blocks the
 * user's first run with a one-line status. Returns true on success.
 *
 * `quiet` suppresses the status and fallback-reason lines — used for
 * subcommands where chatty startup output clutters tool transcripts (e.g.
 * `gipity scaffold`, `gipity skills`). Loud output is reserved for bare
 * `gipity`, `gipity claude`, and `gipity --version`.
 */
export function bootstrap(version: string, quiet = false): boolean {
  mkdirSync(LOCAL_DIR, { recursive: true });

  const pkgJsonPath = join(LOCAL_DIR, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({ name: 'gipity-local', private: true, version: '0.0.0' }, null, 2));
  }

  if (!quiet) process.stderr.write(`Setting up gipity local install at ~/.gipity/local (one-time)...\n`);
  const res = spawnSync('npm', ['install', '--no-audit', '--no-fund', `gipity@${version}`], {
    cwd: LOCAL_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });

  if (res.status !== 0 || !existsSync(LOCAL_ENTRY)) {
    if (!quiet) {
      const stderr = (res.stderr || '').toString();
      const notPublished = /E404|No matching version|notarget/i.test(stderr);
      if (notPublished) {
        process.stderr.write(`gipity v${version} is not yet published to npm — using the currently installed build.\n`);
      } else {
        const firstLine = stderr.split('\n').map(l => l.trim()).find(l => l.length > 0) || `npm exit ${res.status}`;
        const reason = firstLine.length > 160 ? firstLine.slice(0, 157) + '...' : firstLine;
        process.stderr.write(`gipity: could not set up local install (${reason}). Using the currently installed build.\n`);
      }
    }
    return false;
  }

  const state = readState();
  state.installedVersion = version;
  writeState(state);
  if (!quiet) process.stderr.write(`Done.\n\n`);
  return true;
}

export { LOCAL_PKG_DIR };
