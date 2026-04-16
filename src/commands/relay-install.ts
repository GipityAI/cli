/**
 * `gipity relay install` + `gipity relay autostart <on|off>` — service-unit
 * management for the relay daemon. Split out from `commands/relay.ts` so
 * that file stays focused on the small, everyday subcommands (status,
 * pause, resume, rename, revoke, log).
 *
 * Both commands are mounted onto the caller's `Command` instance — the
 * parent `relay` command passes itself in via `registerInstallCommands`.
 */
import { Command } from 'commander';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import { confirm } from '../utils.js';
import { bold, dim, success, error as clrError, muted, info } from '../colors.js';
import * as state from '../relay/state.js';
import { planFor, UnsupportedPlatformError } from '../relay/installers.js';

function requirePaired(): state.RelayDevice {
  const device = state.getDevice();
  if (!device) {
    console.error(`  ${clrError('Not paired.')} Run ${bold('gipity claude')} first.`);
    process.exit(1);
  }
  return device;
}

/** Absolute path to the currently-running `gipity` CLI. Embedded in the
 *  service unit so the launchd/systemd/Task Scheduler entry re-launches
 *  the same binary even if PATH changes. */
function resolveCliPath(): string {
  return resolve(process.argv[1] ?? 'gipity');
}

export function registerInstallCommands(relayCommand: Command): void {
  relayCommand
    .command('install')
    .description('Install the daemon as a login-time service (launchd / systemd / Task Scheduler)')
    .option('--print', 'Print the service-unit file and the commands, but don\'t run them')
    .action(async (opts: { print?: boolean }) => {
      requirePaired();
      const cliPath = resolveCliPath();
      let plan;
      try { plan = planFor({ cliPath }); }
      catch (err) {
        if (err instanceof UnsupportedPlatformError) {
          console.error(`  ${clrError(err.message)}`);
          console.error(`  ${dim('Supported: macOS (launchd), Linux (systemd --user), Windows (Task Scheduler).')}`);
        } else throw err;
        process.exit(1);
      }

      console.log('');
      console.log(`  ${bold('Install plan:')} ${plan.summary}`);
      console.log(`  ${bold('File:')}        ${plan.path}`);
      console.log('');

      if (opts.print) {
        console.log(`${dim('--- file content ---')}`);
        console.log(plan.content);
        console.log(`${dim('--- enable: ---')}`);
        console.log(plan.enableCmd);
        console.log('');
        return;
      }

      if (!(await confirm('  Write the file and enable the service now?'))) {
        console.log(`  ${muted('Cancelled. (Use --print to preview without installing.)')}`);
        return;
      }

      mkdirSync(dirname(plan.path), { recursive: true });
      writeFileSync(plan.path, plan.content);
      console.log(`  ${success(`Wrote ${plan.path}`)}`);

      const r = spawnSync('sh', ['-c', plan.enableCmd], { stdio: 'inherit' });
      if (r.status !== 0) {
        console.error(`\n  ${clrError('Enable command failed.')}`);
        console.error(`  ${dim(`Try manually: ${plan.enableCmd}`)}`);
        process.exit(1);
      }
      console.log('');
      console.log(`  ${success('Daemon installed and started.')}`);
      console.log(`  ${dim(`Check status: ${plan.statusCmd}`)}`);
      console.log(`  ${dim(`Tail logs:    gipity relay log`)}`);
    });

  relayCommand
    .command('autostart <on|off>')
    .description('Enable or disable the installed daemon starting at login')
    .action(async (mode: string) => {
      const want = mode.toLowerCase();
      if (want !== 'on' && want !== 'off') {
        console.error(`  ${clrError('Usage: gipity relay autostart <on|off>')}`);
        process.exit(1);
      }
      let plan;
      try { plan = planFor({ cliPath: resolveCliPath() }); }
      catch (err) {
        if (err instanceof UnsupportedPlatformError) {
          console.error(`  ${clrError(err.message)}`);
          process.exit(1);
        } else throw err;
      }
      const cmd = want === 'on' ? plan.enableCmd : plan.disableCmd;
      console.log(`  ${info('Running:')} ${dim(cmd)}`);
      const r = spawnSync('sh', ['-c', cmd], { stdio: 'inherit' });
      if (r.status !== 0) {
        console.error(`\n  ${clrError('Command failed.')}`);
        process.exit(1);
      }
      console.log(`  ${success(`Autostart ${want}.`)}`);
    });
}
