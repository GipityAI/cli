import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const GIPITY_DIR = join(homedir(), '.gipity');
export const LOCAL_DIR = join(GIPITY_DIR, 'local');
export const LOCAL_PKG_DIR = join(LOCAL_DIR, 'node_modules', 'gipity');
export const LOCAL_ENTRY = join(LOCAL_PKG_DIR, 'dist', 'index.js');
export const STATE_FILE = join(GIPITY_DIR, 'update-state.json');
export const SETTINGS_FILE = join(GIPITY_DIR, 'settings.json');
export const UPDATE_LOG = join(GIPITY_DIR, 'update.log');

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
