#!/usr/bin/env node
// Thin launcher. Resolves the user-local install at ~/.gipity/local/, runs
// it, and kicks off a detached background updater. Modeled on Claude Code.
import { spawnCommand } from '../platform.js';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
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
    const child = spawnCommand(process.execPath, [checkScript], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    // Async spawn 'error' bypasses the try/catch; swallow so the best-effort
    // updater never crashes the CLI.
    child.on('error', () => {});
    child.unref();
  } catch { /* updater is best-effort, never block */ }
}

/** Run a CLI entry IN-PROCESS via dynamic import instead of spawning a second
 *  Node. The entry's top-level `await program.parseAsync(...)` means the import
 *  promise resolves only after the command finishes, so awaiting it and letting
 *  the process exit naturally matches the old child's lifecycle - minus a whole
 *  Node cold-start per invocation. The CLI reads args via `process.argv.slice(2)`
 *  everywhere, so the shim occupying argv[1] is fine (and paths captured from
 *  argv[1], e.g. relay service units, now pin the update-following shim).
 *
 *  A rejection here is either a corrupt install (module failed to load) or a
 *  crash-level bug (commands handle their own failures with process.exit).
 *  Never fall back to re-running the command through another entry - it may
 *  have partially executed, and doubling a mutation is worse than an error. */
async function runEntry(entry: string): Promise<void> {
  try {
    await import(pathToFileURL(entry).href);
  } catch (err) {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  }
}

const execLocal = () => runEntry(LOCAL_ENTRY);

// Run our own dist/index.js (this checkout/install), bypassing the local
// bootstrapped copy. Used for dev links and as the bootstrap-failure fallback
// so the user is never blocked (they can retry via `gipity update --force`).
const execSelf = () => runEntry(resolve(__dirname, '..', 'index.js'));

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
if (isDevLink) {
  await execSelf();
} else if (!isBootstrapped() && !bootstrap(shimPkg.version, !isLoud)) {
  await execSelf();
} else {
  startBackgroundUpdater();
  await execLocal();
}
