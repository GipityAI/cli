/**
 * `gipity relay install` + `gipity relay autostart <on|off>` - service-unit
 * management for the relay daemon. Split out from `commands/relay.ts` so
 * that file stays focused on the small, everyday subcommands (status,
 * pause, resume, rename, revoke, log).
 *
 * Both commands are mounted onto the caller's `Command` instance - the
 * parent `relay` command passes itself in via `registerInstallCommands`.
 */
import { Command } from 'commander';
import { confirm } from '../utils.js';
import { bold, dim, success, error as clrError, muted, info } from '../colors.js';
import * as state from '../relay/state.js';
import { planFor, UnsupportedPlatformError } from '../relay/installers.js';
import { installAutostart, removeAutostart, resolveCliPath } from '../relay/setup.js';

function requirePaired(): state.RelayDevice {
  const device = state.getDevice();
  if (!device) {
    console.error(`${clrError('No paired device.')} Run ${bold('gipity claude')} to pair this machine.`);
    process.exit(1);
  }
  return device;
}

export function registerInstallCommands(relayCommand: Command): void {
  relayCommand
    .command('install')
    .description('Install the background service')
    .option('--print', 'Print the service-unit file and the commands, but don\'t run them')
    .action(async (opts: { print?: boolean }) => {
      requirePaired();
      let plan;
      try { plan = planFor({ cliPath: resolveCliPath() }); }
      catch (err) {
        if (err instanceof UnsupportedPlatformError) {
          console.error(clrError(err.message));
          console.error(muted('Supported on macOS, Linux, and Windows.'));
        } else throw err;
        process.exit(1);
      }

      console.log(`${bold('Install plan:')} ${plan.summary}`);
      console.log(`${bold('File:')}        ${plan.path}`);

      if (opts.print) {
        console.log('');
        console.log(`${dim('--- file content ---')}`);
        console.log(plan.content);
        console.log(`${dim('--- enable: ---')}`);
        console.log(plan.enableDisplay);
        return;
      }

      if (!(await confirm('Write the file and enable the service now?'))) {
        console.log(muted('Cancelled. (Use --print to preview without installing.)'));
        return;
      }

      // Shared helper writes the unit + runs the enable commands; `inherit`
      // surfaces launchctl/systemctl/schtasks output for this interactive path.
      const res = installAutostart({ stdio: 'inherit' });
      console.log(success(`Wrote ${res.path}`));
      if (!res.ok) {
        console.error(clrError(`Couldn't enable autostart. Try manually: ${plan.enableDisplay}`));
        process.exit(1);
      }
      console.log(success('Background service installed and started.'));
      console.log(muted(`Check status: ${plan.statusDisplay}`));
      console.log(muted(`Tail logs:    gipity relay log`));
    });

  relayCommand
    .command('autostart <on|off>')
    .description('Start the service at login')
    .action(async (mode: string) => {
      const want = mode.toLowerCase();
      if (want !== 'on' && want !== 'off') {
        console.error(clrError('Usage: gipity relay autostart <on|off>'));
        process.exit(1);
      }
      try {
        if (want === 'on') {
          const plan = planFor({ cliPath: resolveCliPath() });
          console.log(`${info('Running:')} ${dim(plan.enableDisplay)}`);
          const res = installAutostart({ stdio: 'inherit' });
          if (!res.ok) {
            console.error(clrError('Command failed.'));
            process.exit(1);
          }
        } else {
          // Disable is best-effort - the task may already be stopped.
          const { plan } = removeAutostart({ stdio: 'inherit' });
          console.log(`${info('Running:')} ${dim(plan.disableDisplay)}`);
        }
      } catch (err) {
        if (err instanceof UnsupportedPlatformError) {
          console.error(clrError(err.message));
          process.exit(1);
        } else throw err;
      }
      console.log(success(`Autostart ${want}.`));
    });
}
