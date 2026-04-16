/**
 * Local state for `gipity relay`.
 *
 * One file, `~/.gipity/relay.json`, mode 0600:
 *   {
 *     device: { guid, name, platform, token, paired_at },
 *     // (no allowlist — daemon materializes any of the user's projects on demand)
 *     paused: boolean,
 *   }
 *
 * The `token` field is the raw device bearer returned by /pair/claim — it
 * never leaves this file or the Authorization header. A future chunk will
 * move it to OS keychain (macOS Keychain, libsecret, wincred); the state
 * module's public surface is designed to absorb that change.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface RelayDevice {
  guid: string;
  name: string;
  platform: string;
  token: string;
  paired_at: string;
}

/** A project the daemon is allowed to dispatch into. `cwd` is the absolute
 *  path on this machine where `gipity claude -p …` should be spawned. */
export interface RelayState {
  device: RelayDevice | null;
  paused: boolean;
  /** Tri-state: `undefined` = never asked, `true` = opted in, `false` = opted out.
   *  When `true`, `gipity claude` will ensure the daemon is running before
   *  launching Claude Code. */
  relay_enabled?: boolean;
  /** True once the first-run onboarding prompt has been shown. */
  onboard_shown?: boolean;
}

const RELAY_DIR = join(homedir(), '.gipity');
const RELAY_FILE = join(RELAY_DIR, 'relay.json');
const FILE_MODE = 0o600;

function emptyState(): RelayState {
  return { device: null, paused: false };
}

export function loadState(): RelayState {
  if (!existsSync(RELAY_FILE)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(RELAY_FILE, 'utf-8'));
    return {
      device: raw.device ?? null,
      paused: Boolean(raw.paused),
      relay_enabled: typeof raw.relay_enabled === 'boolean' ? raw.relay_enabled : undefined,
      onboard_shown: Boolean(raw.onboard_shown),
    };
  } catch {
    // Corrupted file — bail out to empty so the caller can rewrite cleanly.
    return emptyState();
  }
}

export function saveState(state: RelayState): void {
  mkdirSync(RELAY_DIR, { recursive: true });
  writeFileSync(RELAY_FILE, JSON.stringify(state, null, 2) + '\n');
  // Token is inside — enforce owner-only even if the file existed with
  // looser permissions before.
  try { chmodSync(RELAY_FILE, FILE_MODE); } catch { /* Windows best-effort */ }
}

/** Load → mutate → save in one step. The mutator may return a new state or
 *  mutate in place. Keeps every setter to a single line. */
function mutate(fn: (s: RelayState) => void): void {
  const s = loadState();
  fn(s);
  saveState(s);
}

// ─── Device ────────────────────────────────────────────────────────────

export function getDevice(): RelayDevice | null {
  return loadState().device;
}

export function setDevice(device: RelayDevice): void {
  mutate(s => { s.device = device; });
}

export function clearDevice(): void {
  // Forget the device → also clear pause flag (scoped to the device).
  mutate(s => { s.device = null; s.paused = false; });
}

// ─── Pause ─────────────────────────────────────────────────────────────

export function isPaused(): boolean {
  return loadState().paused;
}

export function setPaused(paused: boolean): void {
  mutate(s => { s.paused = paused; });
}

// ─── First-run onboarding prompt flag ──────────────────────────────────

export function wasOnboardShown(): boolean {
  return Boolean(loadState().onboard_shown);
}

export function markOnboardShown(): void {
  mutate(s => { s.onboard_shown = true; });
}

// ─── Relay-enabled preference (tri-state) ──────────────────────────────

/** `undefined` = never asked; `true` = opted in; `false` = opted out. */
export function getRelayEnabled(): boolean | undefined {
  return loadState().relay_enabled;
}

export function isRelayEnabled(): boolean {
  return loadState().relay_enabled === true;
}

export function setRelayEnabled(enabled: boolean): void {
  mutate(s => { s.relay_enabled = enabled; });
}

// ─── Daemon PID file (lives at ~/.gipity/relay.pid) ────────────────────

const RELAY_PID_FILE = join(RELAY_DIR, 'relay.pid');

export function getDaemonPidPath(): string {
  return RELAY_PID_FILE;
}

/** Write the current process PID exclusively. Throws if another daemon
 *  already holds the lock — callers can treat that as "don't start." */
export function writeDaemonPid(pid: number): void {
  mkdirSync(RELAY_DIR, { recursive: true });
  writeFileSync(RELAY_PID_FILE, String(pid), { flag: 'wx' });
}

export function clearDaemonPid(): void {
  try { unlinkSync(RELAY_PID_FILE); } catch { /* not there — fine */ }
}

/** True if a daemon is currently running (fresh PID in file + process alive). */
export function isDaemonRunning(): boolean {
  if (!existsSync(RELAY_PID_FILE)) return false;
  try {
    const raw = readFileSync(RELAY_PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!pid || isNaN(pid)) return false;
    // `kill 0` sends no signal but checks if the PID is addressable.
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH (no such process) or EPERM (exists but not ours) both mean "stale" here.
    // For our purposes "process not ours to restart" = treat as not running.
    try { unlinkSync(RELAY_PID_FILE); } catch { /* ignore */ }
    return false;
  }
}
