#!/usr/bin/env node
// Background updater. Invoked detached by the shim; can also be invoked
// directly by `gipity update --force`.
import { appendFileSync } from 'fs';
import { UPDATE_LOG, readState, writeState, updatesDisabled } from './state.js';
import { npmInstallGipity, isWedged, resetLocalTree, acquireUpdateLock, releaseUpdateLock, type NpmInstallResult } from './install.js';

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

function installVersion(version: string): { ok: boolean; detail?: string } {
  let res: NpmInstallResult = npmInstallGipity(version);
  if (!res.ok && !res.spawnError && isWedged(res.stderr)) {
    // Interrupted-install corruption fails every npm run in the dir forever;
    // wipe the tree and retry once.
    log(`wedged install tree detected; wiping node_modules and retrying:\n${res.stderr.trim().slice(-2000)}`);
    resetLocalTree();
    res = npmInstallGipity(version);
    if (res.ok) log('clean reinstall succeeded');
  }
  if (res.ok) return { ok: true };
  if (res.spawnError) {
    log(`npm spawn failed: ${res.spawnError.message}`);
    return { ok: false, detail: res.spawnError.message };
  }
  if (res.stderr.trim()) log(`npm stderr (exit ${res.status}):\n${res.stderr.trim().slice(-2000)}`);
  if (res.status === 0) return { ok: false, detail: 'npm succeeded but the installed package is missing dist/index.js' };
  const firstLine = res.stderr.split('\n').map(l => l.trim()).find(l => l.length > 0) || `npm exit ${res.status}`;
  return { ok: false, detail: firstLine.length > 160 ? firstLine.slice(0, 157) + '...' : firstLine };
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

  if (!acquireUpdateLock()) {
    log('skipped: another update is already in progress');
    return { updated: false, reason: 'another update is already in progress' };
  }
  log(`upgrading ${current} → ${latest}`);
  // Stamp before the (possibly long) install so concurrent gipity commands
  // don't all decide an update is due; the lock is the hard guard.
  state.lastCheckAt = Date.now();
  writeState(state);
  let install: { ok: boolean; detail?: string };
  try {
    install = installVersion(latest);
  } finally {
    releaseUpdateLock();
  }
  if (install.ok) {
    state.installedVersion = latest;
    state.lastError = null;
    writeState(state);
    log(`upgraded to ${latest}`);
    return { updated: true, from: current, to: latest };
  }

  state.lastError = `npm install gipity@${latest} failed` + (install.detail ? `: ${install.detail}` : '');
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
