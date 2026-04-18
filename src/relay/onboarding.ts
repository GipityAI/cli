/**
 * One-time first-run relay onboarding. Called from `gipity claude` after
 * auth + project selection. Asks up to four Y/n questions (all default Y);
 * pressing Enter four times leaves the user with a paired + running
 * daemon that auto-starts on every subsequent `gipity claude` invocation,
 * and — if they said yes to the last question — also starts at OS login.
 */
import { hostname, platform as osPlatform } from 'os';
import { spawn, spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { post } from '../api.js';
import { prompt, confirm } from '../utils.js';
import { bold, brand, dim, success, error as clrError, muted, info } from '../colors.js';
import * as state from './state.js';
import { planFor, UnsupportedPlatformError } from './installers.js';

/** Normalize Node's `os.platform()` to what the backend accepts. */
function mapPlatform(p: string): 'darwin' | 'linux' | 'win32' {
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p;
  return 'linux';
}

/** Path to the currently-running `gipity` CLI (for embedding in service units). */
function resolveCliPath(): string {
  return resolve(process.argv[1] ?? 'gipity');
}

/** Spawn a fresh `gipity relay run` detached from this process. Fire-and-forget. */
export function ensureDaemonRunning(): void {
  if (state.isDaemonRunning()) return;
  try {
    const child = spawn(resolveCliPath(), ['relay', 'run'], {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
    });
    child.unref();
  } catch { /* best-effort */ }
}

/**
 * First-run prompt block. Idempotent: if the user has already answered
 * (`relay_enabled` is a boolean), this is a no-op. Non-interactive flows
 * (e.g. `gipity claude -p`) should skip calling this.
 */
export async function maybeOfferRelayOn(): Promise<void> {
  if (state.getRelayEnabled() !== undefined) {
    // Already answered — just ensure the daemon is running if they're opted in.
    if (state.isRelayEnabled() && !state.isPaused()) ensureDaemonRunning();
    return;
  }

  console.log(`  ${bold('Remote control of Claude Code')}`);
  console.log(`  ${dim('Drive this Claude Code from the web (')}${brand('gipity.ai')}${dim(') on any browser (desktop or phone).')}`);
  console.log('');
  console.log(`  ${dim('Enable now (takes 2 seconds) or turn on later with')} ${brand('gipity relay install')}`);
  console.log('');

  const enable = await confirm('  Enable remote control?', { default: 'yes' });
  if (!enable) {
    state.setRelayEnabled(false);
    console.log(`  ${muted('Skipped.')}`);
    console.log('');
    return;
  }

  // Device name — show hostname as the default; Enter accepts.
  const defaultName = hostname() || 'my-pc';
  const rawName = await prompt(`  Device name [${bold(defaultName)}]: `);
  const name = (rawName || defaultName).trim();
  if (!name || name.length > 100) {
    console.error(`  ${clrError('Device name must be 1–100 non-whitespace characters. Skipping.')}`);
    state.setRelayEnabled(false);
    return;
  }

  // Create the device directly (user-auth, no pair code).
  let token: string;
  let shortGuid: string;
  try {
    const res = await post<{
      data: { short_guid: string; name: string; platform: string; token: string };
    }>('/remote-devices', { name, platform: mapPlatform(osPlatform()) });
    token = res.data.token;
    shortGuid = res.data.short_guid;
  } catch (err: any) {
    console.error(`\n  ${clrError(`Could not create device: ${err?.message || err}`)}`);
    console.error(`  ${dim('Skipping relay setup. Try later with `gipity relay install`.')}`);
    state.setRelayEnabled(false);
    return;
  }

  state.setDevice({
    guid: shortGuid,
    name,
    platform: mapPlatform(osPlatform()),
    token,
    paired_at: new Date().toISOString(),
  });
  state.setRelayEnabled(true);

  // Start the daemon for this session.
  const startNow = await confirm('  Start the relay now (and on future `gipity claude` runs)?', { default: 'yes' });
  if (startNow) {
    ensureDaemonRunning();
  }

  // Offer OS-level autostart (launchd / systemd --user / Task Scheduler).
  const autostartOs = await confirm('  Also start at OS login (auto-start with Windows / macOS / Linux)?', { default: 'yes' });
  if (autostartOs) {
    try {
      const plan = planFor({ cliPath: resolveCliPath() });
      mkdirSync(dirname(plan.path), { recursive: true });
      writeFileSync(plan.path, plan.content);
      // Run argv directly — no shell — so paths with spaces / shell metas
      // can't break out. Fail-fast on the first non-zero exit.
      let allOk = true;
      for (const argv of plan.enableCmds) {
        const r = spawnSync(argv[0], argv.slice(1), { stdio: 'ignore' });
        if (r.status !== 0) { allOk = false; break; }
      }
      if (!allOk) {
        console.log(`  ${muted('Autostart install returned non-zero — you can run')} ${brand('gipity relay install')} ${muted('later.')}`);
      } else {
        console.log(`  ${success('Auto-start installed.')} ${dim(plan.summary)}`);
      }
    } catch (err) {
      if (err instanceof UnsupportedPlatformError) {
        console.log(`  ${muted(`Auto-start not supported on ${process.platform}; skipping.`)}`);
      } else {
        console.log(`  ${muted('Auto-start install hit an error — skipping. You can retry with `gipity relay install`.')}`);
      }
    }
  }

  console.log('');
  console.log(`  ${success(`Registered as ${bold(name)} (${shortGuid}).`)}`);
  console.log(`  ${dim('In the Gipity web CLI, type `/claude` to dispatch messages to this PC.')}`);
  console.log('');
  void info;
}
