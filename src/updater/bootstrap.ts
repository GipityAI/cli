import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LOCAL_DIR, LOCAL_ENTRY, LOCAL_PKG_DIR, writeState, readState } from './state.js';
import { npmInstallGipity, isWedged, resetLocalTree, acquireUpdateLock, releaseUpdateLock, type NpmInstallResult } from './install.js';

export function isBootstrapped(): boolean {
  return existsSync(LOCAL_ENTRY);
}

/**
 * Install gipity@<version> into ~/.gipity/local/. Synchronous: blocks the
 * user's first run with a one-line status. Returns true on success.
 *
 * `quiet` suppresses the status and fallback-reason lines - used for
 * subcommands where chatty startup output clutters tool transcripts (e.g.
 * `gipity add`, `gipity skill`). Loud output is reserved for bare
 * `gipity`, `gipity claude`, and `gipity --version`.
 */
export function bootstrap(version: string, quiet = false): boolean {
  mkdirSync(LOCAL_DIR, { recursive: true });

  const pkgJsonPath = join(LOCAL_DIR, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({ name: 'gipity-local', private: true, version: '0.0.0' }, null, 2));
  }

  if (!acquireUpdateLock()) {
    // A background updater is mid-install; run from the current build now and
    // pick up the local install on a later invocation.
    if (!quiet) process.stderr.write(`gipity: another update is in progress - using the currently installed build.\n`);
    return false;
  }
  if (!quiet) process.stderr.write(`Setting up gipity local install at ~/.gipity/local (one-time)...\n`);
  let res: NpmInstallResult;
  try {
    res = npmInstallGipity(version);
    if (!res.ok && !res.spawnError && isWedged(res.stderr)) {
      // Interrupted-install corruption fails every npm run in the dir forever;
      // wipe the tree and retry once.
      resetLocalTree();
      res = npmInstallGipity(version);
    }
  } finally {
    releaseUpdateLock();
  }

  if (!res.ok) {
    if (!quiet) {
      const notPublished = /E404|No matching version|notarget/i.test(res.stderr);
      if (notPublished) {
        process.stderr.write(`gipity v${version} is not yet published to npm - using the currently installed build.\n`);
      } else {
        // res.spawnError (e.g. ENOENT when npm can't be launched) carries the
        // real cause; res.status is null in that case, so prefer its message.
        const firstLine = res.stderr.split('\n').map(l => l.trim()).find(l => l.length > 0)
          || (res.spawnError ? res.spawnError.message : `npm exit ${res.status}`);
        const reason = firstLine.length > 160 ? firstLine.slice(0, 157) + '...' : firstLine;
        process.stderr.write(`gipity: could not set up local install (${reason}). Using the currently installed build.\n`);
      }
    }
    return false;
  }

  const state = readState();
  state.installedVersion = version;
  writeState(state);
  if (!quiet) process.stderr.write(`Done.\n`);
  return true;
}

export { LOCAL_PKG_DIR };
