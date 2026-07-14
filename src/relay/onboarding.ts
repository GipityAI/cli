/**
 * Interactive relay setup — the single flow that pairs this computer as a
 * relay, starts the daemon, and (optionally) installs the OS login service.
 * ONE implementation, shared by both entry points:
 *
 *   - `gipity claude`  → `maybeOfferRelayOn()`  (mode 'offer-once': runs on the
 *                        very first launch, then never nags again).
 *   - `gipity setup`   → `runRelaySetup({ mode: 'run-now' })` (the user asked
 *                        for it explicitly, so always run — even to re-pair or
 *                        fix autostart on a machine that already answered).
 *
 * All the non-interactive primitives live in `setup.ts` (`pairDevice`,
 * `startDaemon`, `installAutostart`); this module is only the prompts + copy.
 */
import { readFileSync } from 'node:fs';
import { prompt, confirm } from '../utils.js';
import { bold, brand, dim, success, error as clrError, muted } from '../colors.js';
import * as state from './state.js';
import { UnsupportedPlatformError } from './installers.js';
import { pairDevice, startDaemon, installAutostart, friendlyDeviceName } from './setup.js';

/** Spawn a fresh `gipity relay run` detached from this process. Fire-and-forget.
 *  Re-exported from the shared `setup` core so existing importers (`claude.ts`)
 *  keep their import path. */
export const ensureDaemonRunning = startDaemon;

export interface RelaySetupOpts {
  /**
   * `offer-once`  — first-run behavior for `gipity claude`. If the user has
   *                 already answered (`relay_enabled` is a boolean), this is a
   *                 no-op beyond ensuring the daemon is running.
   * `run-now`     — the user ran `gipity setup` on purpose, so always run the
   *                 full interactive flow regardless of a previous answer.
   */
  mode: 'offer-once' | 'run-now';
}

/**
 * Pair this computer as a relay and get it running. Returns `true` if the relay
 * ended up enabled (or was already), `false` if the user declined or a step
 * failed. Non-interactive flows (e.g. `gipity claude -p`) must not call this.
 */
/** True inside Windows Subsystem for Linux (either env marker or kernel
 *  string). Used to explain autostart failures accurately - WSL ships without
 *  a systemd user session unless the user opts in via /etc/wsl.conf. */
function isWsl(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf-8'));
  } catch {
    return false;
  }
}

export async function runRelaySetup(opts: RelaySetupOpts): Promise<boolean> {
  const alreadyAnswered = state.getRelayEnabled() !== undefined;

  // `gipity claude` first-run: honor the user's prior choice and don't re-ask.
  if (opts.mode === 'offer-once' && alreadyAnswered) {
    if (state.isRelayEnabled() && !state.isPaused()) ensureDaemonRunning();
    return state.isRelayEnabled();
  }

  // We only ever REGISTER an unregistered machine. If this computer already has
  // a device, re-running setup must not silently create a second one — nor
  // quietly reuse the old name after asking for a new one (the original bug:
  // you'd type a new name and it would still show the old one). Surface the
  // existing registration plainly and point at revoke as the way to start over.
  const existingDevice = state.getDevice();
  if (existingDevice) {
    // Keep setup's promise: leave the relay enabled and running.
    state.setRelayEnabled(true);
    if (!state.isPaused()) ensureDaemonRunning();
    if (opts.mode === 'run-now') {
      console.log(`  ${bold('This computer is already set up as a relay')}`);
      console.log('');
      console.log(`  ${success('Registered as')} ${bold(existingDevice.name)} ${muted(`(${existingDevice.guid})`)}`);
      if (state.isPaused()) {
        console.log(`  ${dim('The relay is paused — resume it with')} ${brand('gipity relay resume')}${dim('.')}`);
      } else {
        console.log(`  ${dim('The relay is running. Open')} ${brand('gipity.ai')}${dim(' and type `/claude` to drive Claude Code here.')}`);
      }
      console.log('');
      console.log(`  ${dim('To register this computer again — for example under a different name —')}`);
      console.log(`  ${dim('unregister it first, then re-run setup:')}`);
      console.log(`      ${brand('gipity relay revoke')}   ${dim('# unpairs this computer and removes the login service')}`);
      console.log(`      ${brand('gipity setup')}          ${dim('# register it again (asks for a new name)')}`);
      console.log('');
    }
    return true;
  }

  // Header. `gipity setup` frames it as the deliberate action it is; the
  // `gipity claude` first-run frames it as an optional add-on it's offering.
  if (opts.mode === 'run-now') {
    console.log(`  ${bold('Set up this computer as a relay')}`);
    console.log(`  ${dim('A relay runs Claude Code (or Codex) here so you can drive it from the web (')}${brand('gipity.ai')}${dim(') on any browser.')}`);
    console.log(`  ${dim('It uses your Claude or Codex subscription — the cheapest way to pay for tokens.')}`);
  } else {
    console.log(`  ${bold('Remote control of Claude Code')}`);
    console.log(`  ${dim('Drive this Claude Code from the web (')}${brand('gipity.ai')}${dim(') on any browser (desktop or phone).')}`);
    console.log('');
    console.log(`  ${dim('Enable now (takes 2 seconds) or turn on later with')} ${brand('gipity setup')}`);
  }
  console.log('');

  const promptText = opts.mode === 'run-now'
    ? '  Set up remote control on this computer?'
    : '  Enable remote control?';
  const enable = await confirm(promptText, { default: 'yes' });
  if (!enable) {
    state.setRelayEnabled(false);
    console.log(`  ${muted('Skipped.')}`);
    console.log('');
    return false;
  }

  // Device name - show a friendly default (owner + device kind); Enter accepts.
  const defaultName = friendlyDeviceName();
  const rawName = await prompt(`  Device name [${bold(defaultName)}]: `);
  const name = (rawName || defaultName).trim();
  if (!name || name.length > 100) {
    console.error(`  ${clrError('Device name must be 1–100 non-whitespace characters. Skipping.')}`);
    state.setRelayEnabled(false);
    return false;
  }

  // Create the device directly (user-auth, no pair code). `pairDevice` writes
  // the device + flips relay_enabled on; we only have to render the outcome.
  let device;
  try {
    device = await pairDevice({ name });
  } catch (err: any) {
    console.error(`\n  ${clrError(`Could not create device: ${err?.message || err}`)}`);
    console.error(`  ${dim('Skipping for now - we\'ll offer again next time. Or turn it on with `gipity setup`.')}`);
    // Deliberately DON'T persist relay_enabled here: the user SAID YES, and
    // this is a transient failure (network blip, server down). Leaving the
    // tri-state unset means onboarding re-offers on the next `gipity claude`
    // run instead of silently opting the user out forever.
    return false;
  }

  // Start the daemon for this session.
  const startNow = await confirm('  Start the relay now (and on future `gipity build` runs)?', { default: 'yes' });
  if (startNow) {
    startDaemon();
  }

  // Offer OS-level autostart (launchd / systemd --user / Task Scheduler).
  const autostartOs = await confirm('  Also start at OS login (auto-start with Windows / macOS / Linux)?', { default: 'yes' });
  if (autostartOs) {
    try {
      const res = installAutostart();
      if (!res.ok) {
        if (isWsl()) {
          // WSL: `systemctl --user` fails unless systemd is enabled in
          // /etc/wsl.conf, so name the actual cause + the fix instead of a
          // generic non-zero. The relay itself is unaffected (it's already
          // running this session, and `gipity claude` restarts it).
          console.log(`  ${muted('Auto-start needs systemd, which this WSL distro has off. The relay still runs -')}`);
          console.log(`  ${muted('it started just now and `gipity build` restarts it. For boot-time auto-start:')}`);
          console.log(`  ${muted('add [boot] systemd=true to /etc/wsl.conf, restart WSL, then run')} ${brand('gipity relay install')}${muted('.')}`);
        } else {
          console.log(`  ${muted('Autostart install returned non-zero - you can run')} ${brand('gipity relay install')} ${muted('later.')}`);
        }
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

  // Diagnostics consent - default on, clearly opt-out. Only ask once.
  if (state.getDiagnosticsConsent() === undefined) {
    const diag = await confirm(
      '  Share anonymous diagnostics (CPU/GPU/memory/disk/versions) to improve reliability?',
      { default: 'yes' },
    );
    state.setDiagnosticsConsent(diag);
    console.log(`  ${dim(diag
      ? 'Thanks - no personal data or file paths are ever sent. Turn off anytime with `gipity relay diagnostics off`.'
      : 'Diagnostics off. Turn on anytime with `gipity relay diagnostics on`.')}`);
  }

  console.log('');
  console.log(`  ${success(`Registered as ${bold(device.name)} (${device.guid}).`)}`);
  console.log(`  ${dim('In the Gipity web CLI, type `/claude` to dispatch messages to this PC.')}`);
  console.log('');
  return true;
}

/**
 * First-run prompt block for `gipity claude`. Idempotent: if the user has
 * already answered, this is a no-op (beyond keeping the daemon alive).
 * Non-interactive flows (e.g. `gipity claude -p`) should skip calling this.
 */
export async function maybeOfferRelayOn(): Promise<void> {
  await runRelaySetup({ mode: 'offer-once' });
}
