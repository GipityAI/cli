import { Command } from 'commander';
import { sync } from '../sync.js';
import { createProgressReporter } from '../progress.js';
import { error as clrError } from '../colors.js';

export const syncCommand = new Command('sync')
  .description('Sync files (a .gipityignore at the project root excludes paths, gitignore-style)')
  .option('--plan', 'Print the plan without applying any changes')
  .option('--force', 'Bypass the bulk-deletion guard')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      // JSON mode stays machine-clean; otherwise show live progress on a TTY.
      const progress = opts.json ? undefined : createProgressReporter();
      const result = await sync({ plan: opts.plan, force: opts.force, progress });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(result.summary);
        if (!opts.plan && result.applied > 0) {
          console.log(`\n${result.applied} action${result.applied > 1 ? 's' : ''} applied.`);
        }
        if (result.skipped > 0) {
          console.error(clrError(`${result.skipped} action${result.skipped > 1 ? 's' : ''} skipped by guard.`));
        }
        for (const e of result.errors) console.error(clrError(e));
      }
      if (result.errors.length > 0) process.exit(1);
    } catch (err: any) {
      console.error(clrError(`Sync failed: ${err.message}`));
      process.exit(1);
    }
  });
