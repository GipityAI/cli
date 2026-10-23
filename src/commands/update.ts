import { Command } from 'commander';
import { runCheck } from '../updater/check.js';
import { PKG_ROOT } from '../updater/state.js';
import { success, warning, info, dim } from '../colors.js';

export const updateCommand = new Command('update')
  .description('Update the CLI')
  .option('--json', 'Output as JSON')
  .action(async (opts: { json?: boolean }) => {
    if (!opts.json) console.log(info('Checking for updates...'));
    const result = await runCheck({ force: true, verbose: true });
    if (opts.json) {
      // upToDate is distinct from a failed update, which carries `reason`.
      console.log(JSON.stringify({
        updated: result.updated,
        upToDate: result.reason === 'up-to-date',
        from: result.from ?? null,
        to: result.to ?? null,
        devLink: result.reason === 'dev-link',
        reason: result.updated || result.reason === 'up-to-date' || result.reason === 'dev-link' ? null : result.reason ?? null,
      }));
      if (!result.updated && result.reason !== 'up-to-date' && result.reason !== 'dev-link') process.exitCode = 1;
      return;
    }
    console.log('');
    if (result.updated) {
      console.log(success(`Updated ${result.from} → ${result.to}`));
      console.log(dim(`Installed. This command ran on ${result.from}; everything from here on uses ${result.to}.`));
    } else if (result.reason === 'dev-link') {
      console.log(info(`This gipity is linked to a source checkout (${PKG_ROOT}) and runs its build, so it never auto-updates.`));
      console.log(dim('To update it, pull that checkout and run `just cli-link` there.'));
    } else if (result.reason === 'up-to-date') {
      console.log(success('Already on the latest version.'));
    } else {
      console.log(warning(`No update applied: ${result.reason}`));
      if (result.reason?.startsWith('npm install')) {
        console.log(dim('Full npm output: ~/.gipity/update.log'));
        console.log(dim('If it keeps failing, delete ~/.gipity/local and run any gipity command to reinstall.'));
      }
    }
  });
