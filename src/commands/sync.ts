import { Command } from 'commander';
import { syncDown, syncUp, syncCheck } from '../sync.js';

export const syncCommand = new Command('sync')
  .description('Sync files between local and Gipity')
  .argument('[direction]', 'up, down, or check', 'check')
  .option('--json', 'Output as JSON')
  .action(async (direction: string, opts) => {
    try {
      let result;

      switch (direction) {
        case 'down':
          result = await syncDown();
          break;
        case 'up':
          result = await syncUp();
          break;
        case 'check':
          result = await syncCheck();
          break;
        default:
          console.error(`Unknown direction: ${direction}. Use: up, down, or check`);
          process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        if (result.pulled > 0) {
          console.log(`Pulled ${result.pulled} change${result.pulled > 1 ? 's' : ''}:`);
        } else if (result.pushed > 0) {
          console.log(`Pushed ${result.pushed} change${result.pushed > 1 ? 's' : ''}:`);
        }
        console.log(result.summary);
      }
    } catch (err: any) {
      console.error(`Sync failed: ${err.message}`);
      process.exit(1);
    }
  });
