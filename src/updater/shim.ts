#!/usr/bin/env node
// Thin launcher. Resolves the user-local install at ~/.gipity/local/, exec's
// it, and kicks off a detached background updater. Modeled on Claude Code.
import { spawn, spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { LOCAL_ENTRY } from './state.js';
import { isBootstrapped, bootstrap } from './bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shimPkg = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf-8'));

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
  // Fallback: bootstrap failed. Run our own dist/index.js so the user is not
  // blocked. They can retry the bootstrap later via `gipity update --force`.
  const ownEntry = resolve(__dirname, '..', 'index.js');
  const args = process.argv.slice(2);
  const res = spawnSync(process.execPath, [ownEntry, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  process.exit(res.status ?? 1);
}

if (!isBootstrapped()) {
  const ok = bootstrap(shimPkg.version);
  if (!ok) execSelf();
}

startBackgroundUpdater();
execLocal();
