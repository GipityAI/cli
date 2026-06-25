import { Command } from 'commander';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { LOCAL_PKG_DIR, LOCAL_ENTRY, STATE_FILE, SETTINGS_FILE, UPDATE_LOG, readState, readSettings, updatesDisabled } from '../updater/state.js';
import { bold, dim, success, warning, error as clrError, muted } from '../colors.js';
import { getAuth, sessionExpired } from '../auth.js';
import { isClaudeInstalled, isClaudeAuthenticated, probeClaudeAuthenticated } from '../claude-setup.js';
import * as relayState from '../relay/state.js';
import { planFor, UnsupportedPlatformError } from '../relay/installers.js';
import { resolveCliPath } from '../relay/setup.js';

const NODE_MIN_MAJOR = 18;

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

export interface EnvReport {
  /** Everything an onboarded user needs is in place. */
  ready: boolean;
  node: { ok: boolean; version: string };
  gipity: { installed: boolean; version: string; logged_in: boolean; email: string | null; session_expired: boolean };
  claude: { installed: boolean; authenticated: boolean };
  relay: {
    paired: boolean;
    running: boolean;
    paused: boolean;
    /** OS login-service unit is installed (starts the relay at login). null on
     *  a platform we don't generate a unit for. */
    autostart: boolean | null;
    device: { name: string; guid: string } | null;
  };
  /** Gipity CLI install + update settings. */
  cli: {
    shim_version: string;
    local_version: string | null;
    local_install_ok: boolean;
    auto_updates: boolean;
    updates_disabled_reason: string | null;
    last_check_at: number;
    last_error: string | null;
  };
}

/** Whether the relay's OS login-service unit file exists. Reflects "autostart
 *  has been installed" (by `relay setup`/`relay install`); cheap and poll-safe.
 *  null on an unsupported platform. */
function relayAutostartInstalled(): boolean | null {
  try {
    return existsSync(planFor({ cliPath: resolveCliPath() }).path);
  } catch (err) {
    if (err instanceof UnsupportedPlatformError) return null;
    return null;
  }
}

/**
 * Snapshot of the local environment a GUI/installer needs to drive onboarding:
 * Node, the Gipity CLI + login state, Claude Code install + auth, and the relay
 * pairing/daemon state. The single "state of the world" the desktop onboarding
 * client polls (`gipity doctor --json`).
 */
export function gatherEnv(opts: { probeClaude?: boolean } = {}): EnvReport {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10) || 0;
  const auth = getAuth();
  const expired = auth ? sessionExpired() : false;
  const device = relayState.getDevice();

  const node = { ok: nodeMajor >= NODE_MIN_MAJOR, version: process.versions.node };
  const gipity = {
    installed: true, // we're running it
    version: shimVersion(),
    logged_in: !!auth && !expired,
    email: auth?.email ?? null,
    session_expired: expired,
  };
  const claude = { installed: isClaudeInstalled(), authenticated: false };
  // Default: cheap heuristic (poll-safe). With --probe-claude: a real (billed)
  // `claude -p` ping for a definitive answer.
  claude.authenticated = claude.installed && (opts.probeClaude ? probeClaudeAuthenticated() : isClaudeAuthenticated());
  const relay = {
    paired: !!device,
    running: relayState.isDaemonRunning(),
    paused: relayState.isPaused(),
    autostart: relayAutostartInstalled(),
    device: device ? { name: device.name, guid: device.guid } : null,
  };

  const dis = updatesDisabled();
  const updState = readState();
  const cli = {
    shim_version: shimVersion(),
    local_version: localVersion(),
    local_install_ok: existsSync(LOCAL_ENTRY),
    auto_updates: !dis.disabled,
    updates_disabled_reason: dis.disabled ? (dis.reason ?? null) : null,
    last_check_at: updState.lastCheckAt,
    last_error: updState.lastError,
  };

  const ready = node.ok && gipity.logged_in && claude.installed && claude.authenticated && relay.paired && relay.running;
  return { ready, node, gipity, claude, relay, cli };
}

function yn(v: boolean): string {
  return v ? success('yes') : warning('no');
}

export const doctorCommand = new Command('doctor')
  .description('Check install + environment health')
  .option('--json', 'Machine-readable environment report (for installers/GUIs)')
  .option('--probe-claude', 'Verify Claude Code auth with a real (billed) `claude -p` ping instead of the cheap heuristic')
  .action((opts: { json?: boolean; probeClaude?: boolean }) => {
    const env = gatherEnv({ probeClaude: opts.probeClaude });

    if (opts.json) {
      console.log(JSON.stringify(env, null, 2));
      return;
    }

    // ── Environment (what onboarding cares about) ──────────────────────
    console.log(bold('Gipity - doctor'));
    console.log('');
    console.log(bold('Environment'));
    console.log(`${muted('node            ')} ${env.node.version}  ${env.node.ok ? success('✓') : clrError(`(need ${NODE_MIN_MAJOR}+)`)}`);
    console.log(`${muted('gipity login    ')} ${env.gipity.logged_in ? success(`logged in as ${env.gipity.email}`) : (env.gipity.session_expired ? warning(`session expired (${env.gipity.email})`) : warning('not logged in'))}`);
    console.log(`${muted('claude code     ')} installed ${yn(env.claude.installed)} · authenticated ${yn(env.claude.authenticated)}`);
    const autostartLabel = env.relay.autostart === null ? muted('n/a') : yn(env.relay.autostart);
    console.log(`${muted('relay           ')} paired ${yn(env.relay.paired)} · running ${yn(env.relay.running)} · autostart ${autostartLabel}${env.relay.paused ? warning(' · paused') : ''}${env.relay.device ? muted(`  (${env.relay.device.name})`) : ''}`);
    console.log(`${muted('ready           ')} ${env.ready ? success('yes') : warning('no - run `gipity claude` (or the desktop app) to finish setup')}`);

    // ── CLI install / update health ────────────────────────────────────
    const state = readState();
    const settings = readSettings();
    const dis = updatesDisabled();
    const local = localVersion();
    const localOk = existsSync(LOCAL_ENTRY);

    console.log('');
    console.log(bold('CLI install'));
    console.log(`${muted('shim version    ')} ${shimVersion()}`);
    console.log(`${muted('local version   ')} ${local ?? dim('not installed')}  ${localOk ? success('✓') : warning('(running from shim fallback)')}`);
    console.log(`${muted('local install   ')} ${LOCAL_PKG_DIR}`);
    console.log('');
    console.log(`${muted('auto-updates    ')} ${dis.disabled ? warning(`disabled (${dis.reason})`) : success('enabled')}`);
    console.log(`${muted('settings file   ')} ${existsSync(SETTINGS_FILE) ? SETTINGS_FILE : dim('(default)')}  autoUpdates=${settings.autoUpdates}`);
    console.log(`${muted('last check      ')} ${rel(state.lastCheckAt)}`);
    console.log(`${muted('last error      ')} ${state.lastError ? clrError(state.lastError) : dim('none')}`);
    console.log(`${muted('state file      ')} ${existsSync(STATE_FILE) ? STATE_FILE : dim('(none yet)')}`);
    console.log(`${muted('update log      ')} ${existsSync(UPDATE_LOG) ? `${UPDATE_LOG} (${statSync(UPDATE_LOG).size} bytes)` : dim('(none yet)')}`);
    console.log('');
    console.log(dim('Force an update with: gipity update'));
  });
