import { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { LOCAL_PKG_DIR, LOCAL_ENTRY, STATE_FILE, SETTINGS_FILE, UPDATE_LOG, readState, readSettings, updatesDisabled } from '../updater/state.js';
import { bold, dim, success, warning, error as clrError, muted } from '../colors.js';

function localVersion(): string | null {
  const pkgPath = join(LOCAL_PKG_DIR, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try { return JSON.parse(readFileSync(pkgPath, 'utf-8')).version ?? null; }
  catch { return null; }
}

function shimVersion(): string {
  // The running file is the shim itself when invoked from the global bin, OR
  // the local install when invoked via the shim's exec. Either way, the
  // package.json two levels above this file holds the version we report.
  try {
    const url = new URL('../../package.json', import.meta.url);
    return JSON.parse(readFileSync(url, 'utf-8')).version;
  } catch { return 'unknown'; }
}

function rel(t: number): string {
  if (!t) return 'never';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const doctorCommand = new Command('doctor')
  .description('Show install health and auto-update status')
  .action(() => {
    const state = readState();
    const settings = readSettings();
    const dis = updatesDisabled();
    const local = localVersion();
    const localOk = existsSync(LOCAL_ENTRY);

    console.log('');
    console.log(bold('Gipity CLI — doctor'));
    console.log('');
    console.log(`  ${muted('shim version    ')} ${shimVersion()}`);
    console.log(`  ${muted('local version   ')} ${local ?? dim('not installed')}  ${localOk ? success('✓') : warning('(running from shim fallback)')}`);
    console.log(`  ${muted('local install   ')} ${LOCAL_PKG_DIR}`);
    console.log('');
    console.log(`  ${muted('auto-updates    ')} ${dis.disabled ? warning(`disabled (${dis.reason})`) : success('enabled')}`);
    console.log(`  ${muted('settings file   ')} ${existsSync(SETTINGS_FILE) ? SETTINGS_FILE : dim('(default)')}  autoUpdates=${settings.autoUpdates}`);
    console.log(`  ${muted('last check      ')} ${rel(state.lastCheckAt)}`);
    console.log(`  ${muted('last error      ')} ${state.lastError ? clrError(state.lastError) : dim('none')}`);
    console.log(`  ${muted('state file      ')} ${existsSync(STATE_FILE) ? STATE_FILE : dim('(none yet)')}`);
    console.log(`  ${muted('update log      ')} ${existsSync(UPDATE_LOG) ? `${UPDATE_LOG} (${statSync(UPDATE_LOG).size} bytes)` : dim('(none yet)')}`);
    console.log('');
    console.log(dim('  Force an update with: gipity update'));
    console.log(dim('  Disable auto-update:  export DISABLE_AUTOUPDATER=1  (or set autoUpdates: false in settings.json)'));
    console.log('');
  });
