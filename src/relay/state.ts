/**
 * Local state for `gipity relay`.
 *
 * One file, `$GIPITY_DIR/relay.json` (default `~/.gipity/relay.json`), mode 0600:
 *   {
 *     device: { guid, name, platform, token, paired_at },
 *     // (no allowlist - daemon materializes any of the user's projects on demand)
 *     paused: boolean,
 *   }
 *
 * The `token` field is the raw device bearer returned by POST /remote-devices - it
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
  /** Tri-state consent for reporting non-PII host/version diagnostics on the
   *  heartbeat: `undefined` = never asked (treated as on), `true` = opted in,
   *  `false` = opted out. Default-on; user can decline at setup or later via
   *  `gipity relay diagnostics off`. See {@link diagnosticsConsented}. */
  diagnostics_consent?: boolean;
  /** Long-lived gip_at_* agent API token the daemon exports (as GIPITY_TOKEN)
   *  to spawned children (`gipity sync`, `gipity claude -p`). Children then
   *  authenticate statelessly instead of racing sibling processes on the
   *  shared session's single-use refresh token. Minted by the daemon at
   *  startup; guid kept for best-effort revocation on unpair. */
  agent_token?: string | null;
  agent_token_guid?: string | null;
}

// GIPITY_DIR scopes the relay/device state the same way it scopes auth.json (see
// auth.ts). Without this, a separate auth context (e.g. GIPITY_DIR=~/.giprunner-prod
// logged in as ec-giprunner@914-6.com) would still read the DEFAULT ~/.gipity device —
// which is paired to a DIFFERENT account — and project/chat creation fails with
// "deviceGuid does not match a paired device". Scoping it lets each auth context pair
// and own its own device. Unset GIPITY_DIR → ~/.gipity, unchanged for normal users.
const RELAY_DIR = process.env.GIPITY_DIR || join(homedir(), '.gipity');
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
      diagnostics_consent: typeof raw.diagnostics_consent === 'boolean' ? raw.diagnostics_consent : undefined,
      agent_token: typeof raw.agent_token === 'string' ? raw.agent_token : null,
      agent_token_guid: typeof raw.agent_token_guid === 'string' ? raw.agent_token_guid : null,
    };
  } catch {
    // Corrupted file - bail out to empty so the caller can rewrite cleanly.
    return emptyState();
  }
}

export function saveState(state: RelayState): void {
  mkdirSync(RELAY_DIR, { recursive: true });
  // `mode` on write means a NEWLY-created file is owner-only from the first
  // byte - no window where it exists at the umask default (typically 0644)
  // before a follow-up chmod tightens it. The chmodSync still runs to fix a
  // file that already existed with looser permissions (mode is ignored for
  // an existing file).
  writeFileSync(RELAY_FILE, JSON.stringify(state, null, 2) + '\n', { mode: FILE_MODE });
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
  // Forget the device → also clear the pause flag and the agent token
  // (both scoped to the device). Server-side token revocation is the
  // caller's job (best-effort, see revokeRelayAgentToken).
  mutate(s => { s.device = null; s.paused = false; s.agent_token = null; s.agent_token_guid = null; });
}

// ─── Agent token (exported to spawned children as GIPITY_TOKEN) ────────

export function getAgentToken(): { token: string; guid: string | null } | null {
  const s = loadState();
  return s.agent_token ? { token: s.agent_token, guid: s.agent_token_guid ?? null } : null;
}

export function setAgentToken(token: string | null, guid: string | null): void {
  mutate(s => { s.agent_token = token; s.agent_token_guid = guid; });
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

// ─── Diagnostics consent (tri-state, default-on) ───────────────────────

/** Stored preference: `undefined` = never asked; `true`/`false` = explicit. */
export function getDiagnosticsConsent(): boolean | undefined {
  return loadState().diagnostics_consent;
}

export function setDiagnosticsConsent(consent: boolean): void {
  mutate(s => { s.diagnostics_consent = consent; });
}

/** Effective consent used by the daemon: default-on unless the user explicitly
 *  opted out OR a headless opt-out env var (GIPITY_NO_DIAGNOSTICS / DO_NOT_TRACK)
 *  is set. Truthy env value ("1"/"true"/anything non-empty) disables. */
export function diagnosticsConsented(): boolean {
  const env = process.env.GIPITY_NO_DIAGNOSTICS ?? process.env.DO_NOT_TRACK;
  if (env && env !== '0' && env.toLowerCase() !== 'false') return false;
  return loadState().diagnostics_consent !== false;
}

// ─── Daemon PID file (lives at ~/.gipity/relay.pid) ────────────────────

const RELAY_PID_FILE = join(RELAY_DIR, 'relay.pid');

export function getDaemonPidPath(): string {
  return RELAY_PID_FILE;
}

/** Write the current process PID exclusively. Throws if another daemon
 *  already holds the lock - callers can treat that as "don't start." */
export function writeDaemonPid(pid: number): void {
  mkdirSync(RELAY_DIR, { recursive: true });
  writeFileSync(RELAY_PID_FILE, String(pid), { flag: 'wx' });
}

export function clearDaemonPid(): void {
  try { unlinkSync(RELAY_PID_FILE); } catch { /* not there - fine */ }
}

/** True if a daemon is currently running (fresh PID in file + process alive). */
export function isDaemonRunning(): boolean {
  if (!existsSync(RELAY_PID_FILE)) return false;
  try {
    const raw = readFileSync(RELAY_PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    // A corrupt/empty pid file is stale - clear it so it can't trap a restart.
    if (!pid || isNaN(pid)) { try { unlinkSync(RELAY_PID_FILE); } catch { /* ignore */ } return false; }
    // Our OWN pid in the file = stale from a previous incarnation, NOT a live peer.
    // In a container the daemon is always pid 1, so `--restart` brings us back as
    // pid 1 with the dead run's relay.pid (also 1) left behind; process.kill(1,0)
    // would say "alive" (it's us) and trap us in a permanent restart loop. We write
    // our pid only AFTER this check, so finding it here means the file predates us.
    if (pid === process.pid) { try { unlinkSync(RELAY_PID_FILE); } catch { /* ignore */ } return false; }
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
