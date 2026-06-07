import { Command } from 'commander';
import { runCheck } from '../updater/check.js';
import { success, warning, info, dim } from '../colors.js';

export const updateCommand = new Command('update')
  .description('Update the CLI')
  .action(async () => {
    console.log(info('Checking for updates...'));
    const result = await runCheck({ force: true, verbose: true });
    console.log('');
    if (result.updated) {
      console.log(success(`Updated ${result.from} → ${result.to}`));
      console.log(dim('The new version takes effect on your next gipity command.'));
    } else if (result.reason === 'up-to-date') {
      console.log(success('Already on the latest version.'));
    } else {
      console.log(warning(`No update applied: ${result.reason}`));
    }
  });
