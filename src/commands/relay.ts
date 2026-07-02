/**
 * `gipity relay` - user-facing command tree for managing the local relay
 * daemon. Setup itself now lives in `gipity claude`'s onboarding; this
 * file hosts the everyday management verbs (status, run, pause, resume,
 * rename, revoke, log) plus delegates install/autostart to
 * `relay-install.ts`. `relay` is a verb/command, not a product name.
 */
import { Command } from 'commander';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { post, ApiError } from '../api.js';
import { confirm } from '../utils.js';
import {
  bold, brand, dim, success, error as clrError, muted,
} from '../colors.js';
import * as state from '../relay/state.js';
import * as daemon from '../relay/daemon.js';
import { UnsupportedPlatformError } from '../relay/installers.js';
import { pairDevice, startDaemon, installAutostart, removeAutostart } from '../relay/setup.js';
import { registerInstallCommands } from './relay-install.js';

export const relayCommand = new Command('relay')
  .description('Pair with the web CLI');

// ─── gipity relay setup ────────────────────────────────────────────────
// Non-interactive pair + (optionally) start + autostart, for installers and
// GUIs (e.g. the desktop onboarding client) that can't drive prompts. The
// interactive equivalent is the first-run block in `gipity claude`.

relayCommand
  .command('setup')
  .description('Pair this machine and start the relay - non-interactive (for installers/GUIs)')
  .option('--name <name>', 'Device name shown in the web CLI (default: this machine\'s hostname)')
  .option('--no-start', 'Pair only; do not start the relay daemon now')
  .option('--no-autostart', 'Skip the OS login service (use when a supervising app owns the daemon)')
  .option('--force', 'Re-pair even if already paired (revokes the old device first)')
  .option('--json', 'Machine-readable output')
  .action(async (opts: { name?: string; start: boolean; autostart: boolean; force?: boolean; json?: boolean }) => {
    const fail = (code: string, message: string): never => {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, code, error: message }));
      } else {
        console.error(clrError(message));
        if (code === 'not_authenticated') console.error(muted('Run `gipity login` first.'));
      }
      process.exit(1);
    };

    // 1. Pair (idempotent unless --force).
    let device;
    try {
      device = await pairDevice({ name: opts.name, force: opts.force });
    } catch (err: any) {
      if (err instanceof ApiError && err.statusCode === 401) {
        return fail('not_authenticated', 'Not logged in - cannot pair this machine.');
      }
      return fail('pair_failed', `Could not pair: ${err?.message || err}`);
    }

    // 2. Start the daemon now (unless --no-start).
    let daemonStarted = false;
    if (opts.start) {
      startDaemon();
      daemonStarted = true;
    }

    // 3. Install OS autostart (unless --no-autostart). Option B desktop clients
    //    pass --no-autostart because the app itself supervises `relay run`.
    const autostart = { requested: opts.autostart, installed: false, supported: true, summary: '' };
    if (opts.autostart) {
      try {
        const res = installAutostart();
        autostart.installed = res.ok;
        autostart.summary = res.summary;
      } catch (err) {
        if (err instanceof UnsupportedPlatformError) {
          autostart.supported = false;
        } else {
          return fail('autostart_failed', `Autostart install failed: ${(err as any)?.message || err}`);
        }
      }
    }

    // 4. Report.
    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        device: { guid: device.guid, name: device.name, platform: device.platform, reused: device.reused },
        daemon_started: daemonStarted,
        autostart,
      }));
      return;
    }
    console.log(success(`${device.reused ? 'Already paired' : 'Paired'} as ${bold(device.name)} ${muted(`(${device.guid})`)}.`));
    if (daemonStarted) console.log(success('Relay started.'));
    if (autostart.requested) {
      if (!autostart.supported) console.log(muted(`Auto-start not supported on ${process.platform}; skipped.`));
      else if (autostart.installed) console.log(`${success('Auto-start installed.')} ${dim(autostart.summary)}`);
      else console.log(muted('Auto-start enable returned non-zero - retry with `gipity relay install`.'));
    }
    console.log(dim('In the Gipity web CLI, type `/claude` to dispatch messages to this machine.'));
  });

// ─── gipity relay status ───────────────────────────────────────────────

relayCommand
  .command('status')
  .description('Show pairing status')
  .option('--json', 'Machine-readable output')
  .action((opts: { json?: boolean }) => {
    const s = state.loadState();

    if (opts.json) {
      // Redact the token - no reason for scripts to see it. `daemon_running`
      // lets a supervising app (the desktop client) poll liveness and decide
      // whether to (re)spawn `relay run` without parsing the PID file itself.
      const safe = {
        ...s,
        device: s.device ? { ...s.device, token: '***' } : null,
        daemon_running: state.isDaemonRunning(),
      };
      console.log(JSON.stringify(safe, null, 2));
      return;
    }

    if (!s.device) {
      console.log(`${muted('No paired device.')} Run ${brand('gipity claude')} to pair this machine.`);
      return;
    }
    console.log(`${bold('Device:')}      ${brand(s.device.name)} ${muted(`(${s.device.guid})`)}`);
    console.log(`${bold('Platform:')}    ${s.device.platform}`);
    console.log(`${bold('Paired:')}      ${s.device.paired_at}`);
    console.log(`${bold('Paused:')}      ${s.paused ? 'yes' : 'no'}`);
    console.log(`${bold('Running:')}     ${state.isDaemonRunning() ? 'yes' : 'no'}`);
  });

// ─── gipity relay run ──────────────────────────────────────────────────

relayCommand
  .command('run')
  .description('Run the background service')
  .option('-v, --verbose', 'Log every incoming command (project cwd, session chain, spawn argv) - useful for watching behavior live')
  .action(async (opts: { verbose?: boolean }) => {
    // Tests bound the run via this env so they don't hang on SIGKILL.
    const maxRunMs = process.env.GIPITY_RELAY_MAX_RUN_MS
      ? parseInt(process.env.GIPITY_RELAY_MAX_RUN_MS, 10)
      : undefined;
    const code = await daemon.run({ maxRunMs, verbose: opts.verbose });
    process.exit(code);
  });

// ─── gipity relay stop ─────────────────────────────────────────────────

relayCommand
  .command('stop')
  .description('Stop the background service')
  .option('--force', 'Force-stop if it doesn\'t exit cleanly within 5s')
  .action(async (opts: { force?: boolean }) => {
    const pidPath = state.getDaemonPidPath();
    if (!existsSync(pidPath)) {
      console.log(muted('Background service isn\'t running.'));
      return;
    }
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!pid || isNaN(pid)) {
      console.error(clrError('PID file is empty or malformed.'));
      process.exit(1);
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (err: any) {
      if (err?.code === 'ESRCH') {
        console.log(muted(`PID ${pid} not running - cleaning up stale PID file.`));
        try { unlinkSync(pidPath); } catch { /* ignore */ }
        return;
      }
      console.error(clrError(`Could not signal PID ${pid}: ${err?.message || err}`));
      process.exit(1);
    }

    // Wait up to 5s for clean shutdown.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(r => setTimeout(r, 100));
    }

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* gone */ }

    if (alive) {
      if (opts.force) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
        console.log(success('Background service force-stopped.'));
      } else {
        console.error(clrError(`Didn't shut down cleanly after 5s. Retry with --force to stop it.`));
        process.exit(1);
      }
    } else {
      console.log(success('Background service stopped.'));
    }
  });

// ─── gipity relay pause / resume ───────────────────────────────────────

relayCommand
  .command('pause')
  .description('Pause without unpairing')
  .action(() => {
    requirePaired();
    state.setPaused(true);
    console.log(`${success('Paused.')} ${muted('Run `gipity relay resume` to accept commands again.')}`);
  });

relayCommand
  .command('resume')
  .description('Resume after a pause')
  .action(() => {
    requirePaired();
    state.setPaused(false);
    console.log(success('Resumed.'));
  });

// ─── gipity relay rename <name> ────────────────────────────────────────

relayCommand
  .command('rename <new-name>')
  .description('Rename this device')
  .action(async (newName: string) => {
    const device = requirePaired();
    const name = newName.trim();
    if (!name || name.length > 100) {
      console.error(clrError('Device name must be 1–100 non-whitespace characters.'));
      process.exit(1);
    }
    try {
      // User-auth call: the user must be logged in on this PC.
      await post(`/remote-devices/${encodeURIComponent(device.guid)}/rename`, { name });
    } catch (err: any) {
      console.error(clrError(`Rename failed: ${err?.message || err}`));
      if (err?.statusCode === 401) {
        console.error(muted('Run `gipity login` first - rename requires your user auth.'));
      }
      process.exit(1);
    }
    state.setDevice({ ...device, name });
    console.log(success(`Renamed to ${bold(name)}.`));
  });

// ─── gipity relay revoke ───────────────────────────────────────────────

relayCommand
  .command('revoke')
  .description('Revoke and forget this device')
  .action(async () => {
    const device = requirePaired();
    if (!(await confirm(`Revoke ${bold(device.name)} (${device.guid})?`))) {
      console.log(muted('Cancelled.'));
      return;
    }
    try {
      await post(`/remote-devices/${encodeURIComponent(device.guid)}/revoke`, {});
    } catch (err: any) {
      // Even if the server call fails, drop local state - a stale token is
      // worse than double-revoking. Warn loudly though.
      console.error(clrError(`Server revoke failed: ${err?.message || err}`));
      console.error(muted('Local token cleared anyway. Visit the web CLI to confirm the server-side revoke.'));
    }
    state.clearDevice();

    // Remove the OS autostart unit too. Otherwise the login service relaunches
    // `relay run`, which - finding no device but a valid login - silently
    // re-registers a NEW device, undoing this revoke (on macOS the old
    // KeepAlive=true even relaunched on the clean exit). Best-effort: an
    // unsupported OS or a missing unit is fine.
    let autostartRemoved = false;
    try {
      autostartRemoved = removeAutostart().ok;
    } catch { /* unsupported platform / no unit - ignore */ }

    // Stop the currently-running daemon now rather than waiting for it to
    // notice via a 401 on its next poll (~up to a hold cycle).
    const pidPath = state.getDaemonPidPath();
    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
      if (pid && !isNaN(pid)) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    }

    console.log(success('Device revoked + local state cleared.'));
    console.log(muted(autostartRemoved
      ? 'Auto-start removed and the background service was signalled to stop.'
      : 'The background service was signalled to stop.'));
  });

// ─── gipity relay log ──────────────────────────────────────────────────

relayCommand
  .command('log')
  .description('Tail the service log')
  .option('-n, --lines <n>', 'How many lines to print (default 100)', '100')
  .option('-f, --follow', 'Follow the log like `tail -f`')
  .action((opts: { lines: string; follow?: boolean }) => {
    const path = daemon.RELAY_LOG_PATH;
    if (!existsSync(path)) {
      console.log(muted('No log file yet. Start the service with `gipity relay run` (or install it).'));
      return;
    }
    const lines = parseInt(opts.lines, 10) || 100;
    try {
      const all = readFileSync(path, 'utf-8').split('\n');
      const tail = all.slice(-lines - 1).join('\n');
      process.stdout.write(tail);
    } catch (err: any) {
      console.error(clrError(`Could not read log: ${err?.message || err}`));
      process.exit(1);
    }
    if (opts.follow) {
      // Defer real follow to `tail -f` - cross-platform fallback below.
      const tailCmd = process.platform === 'win32' ? null : 'tail';
      if (!tailCmd) {
        console.error(clrError('--follow is not supported on this platform yet.'));
        process.exit(1);
      }
      const child = spawn(tailCmd, ['-f', '-n', '0', path], { stdio: 'inherit' });
      // `tail` missing surfaces asynchronously via 'error' (not a throw); without
      // this handler Node would crash with a raw stack trace.
      child.on('error', (err: NodeJS.ErrnoException) => {
        console.error(clrError(err.code === 'ENOENT'
          ? "`tail` not found - can't follow the log on this system."
          : `Failed to follow log: ${err.message}`));
        process.exit(1);
      });
      process.on('SIGINT', () => child.kill('SIGINT'));
      child.on('exit', code => process.exit(code ?? 0));
    }
  });

// install + autostart subcommands live in their own module.
registerInstallCommands(relayCommand);

// ─── helpers ────────────────────────────────────────────────────────────

function requirePaired(): state.RelayDevice {
  const device = state.getDevice();
  if (!device) {
    console.error(`${clrError('No paired device.')} Run ${brand('gipity claude')} to pair this machine.`);
    process.exit(1);
  }
  return device;
}

