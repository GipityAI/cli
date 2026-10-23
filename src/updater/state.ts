import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

export const GIPITY_DIR = join(homedir(), '.gipity');
export const LOCAL_DIR = join(GIPITY_DIR, 'local');
export const LOCAL_PKG_DIR = join(LOCAL_DIR, 'node_modules', 'gipity');
export const LOCAL_ENTRY = join(LOCAL_PKG_DIR, 'dist', 'index.js');
export const STATE_FILE = join(GIPITY_DIR, 'update-state.json');
export const SETTINGS_FILE = join(GIPITY_DIR, 'settings.json');
export const UPDATE_LOG = join(GIPITY_DIR, 'update.log');

/** Root of the gipity package this code runs from. Walks up to its
 *  package.json because the depth differs: dist/updater/*.js are separate
 *  files, while dist/index.js is a bundle that inlines this module. */
function findPkgRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).name === 'gipity') return dir;
    } catch { /* no package.json here */ }
    const up = dirname(dir);
    if (up === dir) return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    dir = up;
  }
}
export const PKG_ROOT = findPkgRoot();

/** Published tarballs ship `dist/**` only (package.json `files`), so a sibling
 *  `src/` means `gipity` was `npm link`ed from a source checkout. A dev link
 *  runs that checkout's own build and never auto-updates: installing a
 *  published copy into ~/.gipity/local would be pointless (nothing runs it). */
export function isDevLink(): boolean {
  return existsSync(join(PKG_ROOT, 'src'));
}

export interface UpdateState {
  installedVersion: string | null;
  lastCheckAt: number;
  lastError: string | null;
  updateChannel: 'stable';
}

export interface Settings {
  autoUpdates: boolean;
}

const DEFAULT_STATE: UpdateState = {
  installedVersion: null,
  lastCheckAt: 0,
  lastError: null,
  updateChannel: 'stable',
};

const DEFAULT_SETTINGS: Settings = {
  autoUpdates: true,
};

function ensureDir(): void {
  mkdirSync(GIPITY_DIR, { recursive: true });
}

export function readState(): UpdateState {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    return { ...DEFAULT_STATE, ...JSON.parse(readFileSync(STATE_FILE, 'utf-8')) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(state: UpdateState): void {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function readSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function writeSettings(settings: Settings): void {
  ensureDir();
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function updatesDisabled(): { disabled: boolean; reason?: string } {
  if (process.env['DISABLE_AUTOUPDATER'] === '1') return { disabled: true, reason: 'DISABLE_AUTOUPDATER=1' };
  if (process.env['CI']) return { disabled: true, reason: 'CI environment' };
  if (!readSettings().autoUpdates) return { disabled: true, reason: 'autoUpdates: false in settings.json' };
  return { disabled: false };
}
