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
