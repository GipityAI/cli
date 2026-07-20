import { Command } from 'commander';
import { dirname } from 'node:path';
import { sync } from '../sync.js';
import { createProgressReporter } from '../progress.js';
import { error as clrError, muted } from '../colors.js';
import { findWindowsTwinProject, isWsl, wslPathToWindows } from '../utils.js';
import { getConfigPath } from '../config.js';

export const syncCommand = new Command('sync')
  .description('Sync files')
  .addHelpText('after', '\nAdd a .gipityignore at the project root to exclude paths (gitignore-style).')
  .option('--plan', 'Print the plan without applying any changes')
  .option('--force', 'Bypass the bulk-deletion guard')
  .option('--prune', 'Remove files that exist on Gipity but not locally (applies the bulk deletes the guard defers)')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      // JSON mode stays machine-clean; otherwise show live progress on a TTY.
      const progress = opts.json ? undefined : createProgressReporter();
      // confirmMerge arms the uncertain-merge guard: a first-time sync into a
      // folder that has its own files prompts on a TTY, proceeds with --yes, and
      // fail-safe ABORTS when non-interactive without --yes - so a script never
      // merges an unexpected folder into the project silently.
      const result = await sync({ plan: opts.plan, force: opts.force, prune: opts.prune, confirmMerge: true, progress });
      if (opts.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(result.summary);
        if (!opts.plan && result.applied > 0) {
          console.log(`\n${result.applied} action${result.applied > 1 ? 's' : ''} applied.`);
        }
        // The guard defers bulk server-side deletes (files on Gipity but not
        // local). Surface that here as a helpful hint - not a red error - with
        // the one command that resolves it. Only `gipity sync` shows this;
        // deploy/test/sandbox stay silent (their internal sync defers quietly).
        // WSL trap: a same-named folder under C:\Users\...\GipityProjects looks
        // like "the project" from Windows Explorer, but files dropped there
        // never sync. When a twin exists, say so - "Up to date." alone reads as
        // "your new files are in" when they're sitting on the Windows side.
        if (isWsl()) {
          const configPath = getConfigPath();
          const twin = configPath ? findWindowsTwinProject(dirname(configPath)) : null;
          if (twin) {
            console.log(muted(
              `\nNote: a Windows-side copy of this project exists at ${wslPathToWindows(twin)} and is NOT synced. ` +
              `If you added files there, move them into this folder so they sync.`,
            ));
          }
        }
        if (result.deferredDeletes > 0) {
          console.log(muted(
            `\n${result.deferredDeletes} file${result.deferredDeletes > 1 ? 's' : ''} on Gipity ` +
            `${result.deferredDeletes > 1 ? 'are' : 'is'} not present locally and ${result.deferredDeletes > 1 ? 'were' : 'was'} left untouched. ` +
            `Run 'gipity sync --prune' to remove ${result.deferredDeletes > 1 ? 'them' : 'it'}.`,
          ));
        }
        for (const e of result.errors) console.error(clrError(e));
      }
      // A refused merge or any sync error is a non-zero exit so scripts/CI can
      // detect that nothing was applied.
      if (result.aborted || result.errors.length > 0) process.exit(1);
    } catch (err: any) {
      console.error(clrError(`Sync failed: ${err.message}`));
      process.exit(1);
    }
  });
