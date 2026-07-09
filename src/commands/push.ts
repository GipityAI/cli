import { Command } from 'commander';
import { resolve } from 'path';
import { pushFile } from '../sync.js';
import { error as clrError, success } from '../colors.js';

export const pushCommand = new Command('push')
  .description('Push one or more files')
  .argument('<files...>', 'File path(s) to push')
  .option('--quiet', 'Suppress output')
  .option('--background', 'Fork and exit immediately')
  .action(async (files: string[], opts) => {
    try {
      const fullPaths = files.map(f => resolve(f));

      if (opts.background) {
        // Detach a background `gipity push` and exit immediately. Goes through
        // spawnCommand (Node binary running our own entry script - no IPC
        // channel is needed, so spawn beats fork), which defaults
        // `windowsHide: true` so the detached child never flashes a console
        // window on Windows.
        const { spawnCommand } = await import('../platform.js');
        const child = spawnCommand(process.execPath, [process.argv[1], 'push', ...fullPaths, '--quiet'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return;
      }

      // Sequential on purpose: pushFile takes the per-project sync lock, so
      // parallel pushes would just contend on it. One process pushing N files
      // still beats the old N processes × N lock acquisitions.
      for (const fullPath of fullPaths) {
        await pushFile(fullPath);
      }

      if (!opts.quiet) {
        console.log(success(files.length === 1 ? `Pushed ${files[0]}` : `Pushed ${files.length} files`));
      }
    } catch (err: any) {
      if (!opts.quiet) {
        console.error(clrError(`Push failed: ${err.message}`));
      }
      process.exit(1);
    }
  });
