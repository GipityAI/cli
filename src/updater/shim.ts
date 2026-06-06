#!/usr/bin/env node
// Thin launcher. Resolves the user-local install at ~/.gipity/local/, exec's
// it, and kicks off a detached background updater. Modeled on Claude Code.
import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { LOCAL_ENTRY } from './state.js';
import { isBootstrapped, bootstrap } from './bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..', '..');
const shimPkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));

// Dev-link detection. Published tarballs ship `dist/**` only (see package.json
// `files`), so a sibling `src/` means `gipity` was `npm link`ed from a source
// checkout. In that case run THIS checkout's own dist and skip the bootstrap +
// background updater entirely - otherwise the shim would defer to the last
// PUBLISHED build in ~/.gipity/local/ and silently shadow your local changes.
// Nothing persistent is written, so `just cli-unlink` (npm unlink) is the only
// cleanup needed: once `gipity` no longer resolves to this checkout, dev mode
// stops applying on its own.
const isDevLink = existsSync(join(pkgRoot, 'src'));

function startBackgroundUpdater(): void {
  const checkScript = join(__dirname, 'check.js');
  try {
    const child = spawn(process.execPath, [checkScript], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch { /* updater is best-effort, never block */ }
}

function execLocal(): never {
  const args = process.argv.slice(2);
  const res = spawnSync(process.execPath, [LOCAL_ENTRY, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

function execSelf(): never {
  // Run our own dist/index.js (this checkout/install), bypassing the local
  // bootstrapped copy. Used for dev links and as the bootstrap-failure fallback
  // so the user is never blocked (they can retry via `gipity update --force`).
  const ownEntry = resolve(__dirname, '..', 'index.js');
  const args = process.argv.slice(2);
  const res = spawnSync(process.execPath, [ownEntry, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

// Loud startup output (bootstrap status, npm-fallback notice) is reserved for
// the handful of commands where users expect a visible chrome banner. All other
// subcommands - scaffold, skills, fn, test, deploy, etc. - run silently so
// their output stays clean in transcripts and agent tool results.
const rawArgs = process.argv.slice(2);
const firstArg = rawArgs[0];
const isLoud =
  rawArgs.length === 0 ||
  firstArg === 'claude' ||
  firstArg === '--version' ||
  firstArg === '-v' ||
  firstArg === 'version';

// Dev link: run this checkout's own build, no bootstrap, no auto-update.
if (isDevLink) execSelf();

if (!isBootstrapped()) {
  const ok = bootstrap(shimPkg.version, !isLoud);
  if (!ok) execSelf();
}

startBackgroundUpdater();
execLocal();
