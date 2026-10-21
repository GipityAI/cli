import { Command } from 'commander';
import { runCheck } from '../updater/check.js';
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
        reason: result.updated || result.reason === 'up-to-date' ? null : result.reason ?? null,
      }));
      if (!result.updated && result.reason !== 'up-to-date') process.exitCode = 1;
      return;
    }
    console.log('');
    if (result.updated) {
      console.log(success(`Updated ${result.from} → ${result.to}`));
      console.log(dim(`Installed. This command ran on ${result.from}; everything from here on uses ${result.to}.`));
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
