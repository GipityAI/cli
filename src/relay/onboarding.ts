/**
 * One-time first-run relay onboarding. Called from `gipity claude` after
 * auth + project selection. Asks up to four Y/n questions (all default Y);
 * pressing Enter four times leaves the user with a paired + running
 * daemon that auto-starts on every subsequent `gipity claude` invocation,
 * and - if they said yes to the last question - also starts at OS login.
 */
import { hostname } from 'os';
import { prompt, confirm } from '../utils.js';
import { bold, brand, dim, success, error as clrError, muted, info } from '../colors.js';
import * as state from './state.js';
import { UnsupportedPlatformError } from './installers.js';
import { pairDevice, startDaemon, installAutostart } from './setup.js';

/** Spawn a fresh `gipity relay run` detached from this process. Fire-and-forget.
 *  Re-exported from the shared `setup` core so existing importers (`claude.ts`)
 *  keep their import path. */
export const ensureDaemonRunning = startDaemon;

/**
 * First-run prompt block. Idempotent: if the user has already answered
 * (`relay_enabled` is a boolean), this is a no-op. Non-interactive flows
 * (e.g. `gipity claude -p`) should skip calling this.
 */
export async function maybeOfferRelayOn(): Promise<void> {
  if (state.getRelayEnabled() !== undefined) {
    // Already answered - just ensure the daemon is running if they're opted in.
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

  // Device name - show hostname as the default; Enter accepts.
  const defaultName = hostname() || 'my-pc';
  const rawName = await prompt(`  Device name [${bold(defaultName)}]: `);
  const name = (rawName || defaultName).trim();
  if (!name || name.length > 100) {
    console.error(`  ${clrError('Device name must be 1–100 non-whitespace characters. Skipping.')}`);
    state.setRelayEnabled(false);
    return;
  }

  // Create the device directly (user-auth, no pair code). `pairDevice` writes
  // the device + flips relay_enabled on; we only have to render the outcome.
  let device;
  try {
    device = await pairDevice({ name });
  } catch (err: any) {
    console.error(`\n  ${clrError(`Could not create device: ${err?.message || err}`)}`);
    console.error(`  ${dim('Skipping relay setup. Try later with `gipity relay install`.')}`);
    state.setRelayEnabled(false);
    return;
  }

  // Start the daemon for this session.
  const startNow = await confirm('  Start the relay now (and on future `gipity claude` runs)?', { default: 'yes' });
  if (startNow) {
    startDaemon();
  }

  // Offer OS-level autostart (launchd / systemd --user / Task Scheduler).
  const autostartOs = await confirm('  Also start at OS login (auto-start with Windows / macOS / Linux)?', { default: 'yes' });
  if (autostartOs) {
    try {
      const res = installAutostart();
      if (!res.ok) {
        console.log(`  ${muted('Autostart install returned non-zero - you can run')} ${brand('gipity relay install')} ${muted('later.')}`);
      } else {
        console.log(`  ${success('Auto-start installed.')} ${dim(res.summary)}`);
      }
    } catch (err) {
      if (err instanceof UnsupportedPlatformError) {
        console.log(`  ${muted(`Auto-start not supported on ${process.platform}; skipping.`)}`);
      } else {
        console.log(`  ${muted('Auto-start install hit an error - skipping. You can retry with `gipity relay install`.')}`);
      }
    }
  }

  console.log('');
  console.log(`  ${success(`Registered as ${bold(device.name)} (${device.guid}).`)}`);
  console.log(`  ${dim('In the Gipity web CLI, type `/claude` to dispatch messages to this PC.')}`);
  console.log('');
  void info;
}
