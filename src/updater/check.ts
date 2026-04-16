#!/usr/bin/env node
// Background updater. Invoked detached by the shim; can also be invoked
// directly by `gipity update --force`.
import { spawnSync } from 'child_process';
import { appendFileSync, existsSync } from 'fs';
import { LOCAL_DIR, LOCAL_ENTRY, UPDATE_LOG, readState, writeState, updatesDisabled } from './state.js';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

function log(line: string): void {
  try {
    appendFileSync(UPDATE_LOG, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* ignore */ }
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function fetchLatestVersion(): Promise<string> {
  const res = await fetch('https://registry.npmjs.org/gipity/latest', {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  const json = await res.json() as { version?: string };
  if (!json.version) throw new Error('no version in registry response');
  return json.version;
}

function installVersion(version: string): boolean {
  const res = spawnSync('npm', ['install', '--silent', '--no-audit', '--no-fund', `gipity@${version}`], {
    cwd: LOCAL_DIR,
    stdio: 'ignore',
  });
  return res.status === 0 && existsSync(LOCAL_ENTRY);
}

export interface CheckOptions {
  force?: boolean;
  verbose?: boolean;
}

export async function runCheck(opts: CheckOptions = {}): Promise<{ updated: boolean; from?: string; to?: string; reason?: string }> {
  const state = readState();

  if (!opts.force) {
    const dis = updatesDisabled();
    if (dis.disabled) {
      log(`skipped: ${dis.reason}`);
      return { updated: false, reason: dis.reason };
    }
    if (Date.now() - state.lastCheckAt < CHECK_INTERVAL_MS) {
      return { updated: false, reason: 'cache-fresh' };
    }
  }

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    state.lastError = `fetch failed: ${msg}`;
    state.lastCheckAt = Date.now();
    writeState(state);
    log(state.lastError);
    return { updated: false, reason: state.lastError };
  }

  const current = state.installedVersion ?? '0.0.0';
  if (compareSemver(latest, current) <= 0) {
    state.lastError = null;
    state.lastCheckAt = Date.now();
    writeState(state);
    log(`up-to-date (current=${current}, latest=${latest})`);
    return { updated: false, reason: 'up-to-date' };
  }

  log(`upgrading ${current} → ${latest}`);
  const ok = installVersion(latest);
  state.lastCheckAt = Date.now();
  if (ok) {
    state.installedVersion = latest;
    state.lastError = null;
    writeState(state);
    log(`upgraded to ${latest}`);
    return { updated: true, from: current, to: latest };
  }

  state.lastError = `npm install gipity@${latest} failed`;
  writeState(state);
  log(state.lastError);
  return { updated: false, reason: state.lastError };
}

// Direct invocation (detached background)
const isDirect = import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  const force = process.argv.includes('--force');
  runCheck({ force }).catch((e) => log(`unhandled: ${e instanceof Error ? e.message : String(e)}`));
}
