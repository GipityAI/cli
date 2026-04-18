/**
 * `gipity relay` — user-facing command tree for managing the local relay
 * daemon. Setup itself now lives in `gipity claude`'s onboarding; this
 * file hosts the everyday management verbs (status, run, pause, resume,
 * rename, revoke, log) plus delegates install/autostart to
 * `relay-install.ts`. `relay` is a verb/command, not a product name.
 */
import { Command } from 'commander';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { post } from '../api.js';
import { confirm } from '../utils.js';
import {
  bold, brand, dim, success, error as clrError, muted,
} from '../colors.js';
import * as state from '../relay/state.js';
import * as daemon from '../relay/daemon.js';
import { registerInstallCommands } from './relay-install.js';

export const relayCommand = new Command('relay')
  .description('Pair this machine\'s Claude Code with the Gipity web CLI');

// ─── gipity relay status ───────────────────────────────────────────────

relayCommand
  .command('status')
  .description('Show pairing status, allowed projects, and pause state')
  .option('--json', 'Machine-readable output')
  .action((opts: { json?: boolean }) => {
    const s = state.loadState();

    if (opts.json) {
      // Redact the token — no reason for scripts to see it.
      const safe = {
        ...s,
        device: s.device ? { ...s.device, token: '***' } : null,
      };
      console.log(JSON.stringify(safe, null, 2));
      return;
    }

    console.log('');
    if (!s.device) {
      console.log(`  ${muted('No paired device.')} Run ${brand('gipity claude')} to pair this machine.`);
      return;
    }
    console.log(`  ${bold('Device:')}      ${brand(s.device.name)} ${muted(`(${s.device.guid})`)}`);
    console.log(`  ${bold('Platform:')}    ${s.device.platform}`);
    console.log(`  ${bold('Paired:')}      ${s.device.paired_at}`);
    console.log(`  ${bold('Paused:')}      ${s.paused ? 'yes' : 'no'}`);
    console.log('');
  });

// ─── gipity relay run ──────────────────────────────────────────────────

relayCommand
  .command('run')
  .description('Run the background service that receives commands from the web CLI')
  .option('-v, --verbose', 'Log every incoming command (project cwd, session chain, spawn argv) — useful for watching behavior live')
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
      console.log(`  ${muted('Background service isn\'t running.')}`);
      return;
    }
    const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!pid || isNaN(pid)) {
      console.error(`  ${clrError('PID file is empty or malformed.')}`);
      process.exit(1);
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (err: any) {
      if (err?.code === 'ESRCH') {
        console.log(`  ${muted(`PID ${pid} not running — cleaning up stale PID file.`)}`);
        try { unlinkSync(pidPath); } catch { /* ignore */ }
        return;
      }
      console.error(`  ${clrError(`Could not signal PID ${pid}: ${err?.message || err}`)}`);
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
        console.log(`  ${success('Background service force-stopped.')}`);
      } else {
        console.error(`  ${clrError(`Didn't shut down cleanly after 5s. Retry with --force to stop it.`)}`);
        process.exit(1);
      }
    } else {
      console.log(`  ${success('Background service stopped.')}`);
    }
  });

// ─── gipity relay pause / resume ───────────────────────────────────────

relayCommand
  .command('pause')
  .description('Temporarily stop accepting commands (without unpairing)')
  .action(() => {
    requirePaired();
    state.setPaused(true);
    console.log(`  ${success('Paused.')} ${dim('Run `gipity relay resume` to accept commands again.')}`);
  });

relayCommand
  .command('resume')
  .description('Resume accepting commands after a pause')
  .action(() => {
    requirePaired();
    state.setPaused(false);
    console.log(`  ${success('Resumed.')}`);
  });

// ─── gipity relay rename <name> ────────────────────────────────────────

relayCommand
  .command('rename <new-name>')
  .description('Rename this device (both locally and on the server)')
  .action(async (newName: string) => {
    const device = requirePaired();
    const name = newName.trim();
    if (!name || name.length > 100) {
      console.error(`  ${clrError('Device name must be 1–100 non-whitespace characters.')}`);
      process.exit(1);
    }
    try {
      // User-auth call: the user must be logged in on this PC.
      await post(`/remote-devices/${encodeURIComponent(device.guid)}/rename`, { name });
    } catch (err: any) {
      console.error(`\n  ${clrError(`Rename failed: ${err?.message || err}`)}`);
      if (err?.statusCode === 401) {
        console.error(`  ${dim('Run `gipity login` first — rename requires your user auth.')}`);
      }
      process.exit(1);
    }
    state.setDevice({ ...device, name });
    console.log(`  ${success(`Renamed to ${bold(name)}.`)}`);
  });

// ─── gipity relay revoke ───────────────────────────────────────────────

relayCommand
  .command('revoke')
  .description('Revoke this device on the server and forget the local token')
  .action(async () => {
    const device = requirePaired();
    if (!(await confirm(`  Revoke ${bold(device.name)} (${device.guid})?`))) {
      console.log(`  ${muted('Cancelled.')}`);
      return;
    }
    try {
      await post(`/remote-devices/${encodeURIComponent(device.guid)}/revoke`, {});
    } catch (err: any) {
      // Even if the server call fails, drop local state — a stale token is
      // worse than double-revoking. Warn loudly though.
      console.error(`  ${clrError(`Server revoke failed: ${err?.message || err}`)}`);
      console.error(`  ${dim('Local token cleared anyway. Visit the web CLI to confirm the server-side revoke.')}`);
    }
    state.clearDevice();
    console.log(`  ${success('Device revoked + local state cleared.')}`);
    console.log(`  ${dim('Any running background service will notice and exit within ~30s.')}`);
  });

// ─── gipity relay log ──────────────────────────────────────────────────

relayCommand
  .command('log')
  .description('Show the background service\'s recent log (tails ~/.gipity/relay.log)')
  .option('-n, --lines <n>', 'How many lines to print (default 100)', '100')
  .option('-f, --follow', 'Follow the log like `tail -f`')
  .action((opts: { lines: string; follow?: boolean }) => {
    const path = daemon.RELAY_LOG_PATH;
    if (!existsSync(path)) {
      console.log(`  ${muted('No log file yet. Start the service with `gipity relay run` (or install it).')}`);
      return;
    }
    const lines = parseInt(opts.lines, 10) || 100;
    try {
      const all = readFileSync(path, 'utf-8').split('\n');
      const tail = all.slice(-lines - 1).join('\n');
      process.stdout.write(tail);
    } catch (err: any) {
      console.error(`  ${clrError(`Could not read log: ${err?.message || err}`)}`);
      process.exit(1);
    }
    if (opts.follow) {
      // Defer real follow to `tail -f` — cross-platform fallback below.
      const tailCmd = process.platform === 'win32' ? null : 'tail';
      if (!tailCmd) {
        console.error(`  ${clrError('--follow is not supported on this platform yet.')}`);
        process.exit(1);
      }
      const child = spawn(tailCmd, ['-f', '-n', '0', path], { stdio: 'inherit' });
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
    console.error(`  ${clrError('No paired device.')} Run ${brand('gipity claude')} to pair this machine.`);
    process.exit(1);
  }
  return device;
}

