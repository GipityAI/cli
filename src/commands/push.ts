import { Command } from 'commander';
import { resolve } from 'path';
import { pushFile } from '../sync.js';
import { error as clrError, success } from '../colors.js';

export const pushCommand = new Command('push')
  .description('Push a file')
  .argument('<file>', 'File path to push')
  .option('--quiet', 'Suppress output')
  .option('--background', 'Fork and exit immediately')
  .action(async (file: string, opts) => {
    try {
      const fullPath = resolve(file);

      if (opts.background) {
        // Detach a background `gipity push` and exit immediately. Goes through
        // spawnCommand (Node binary running our own entry script - no IPC
        // channel is needed, so spawn beats fork), which defaults
        // `windowsHide: true` so the detached child never flashes a console
        // window on Windows.
        const { spawnCommand } = await import('../platform.js');
        const child = spawnCommand(process.execPath, [process.argv[1], 'push', fullPath, '--quiet'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        return;
      }

      await pushFile(fullPath);

      if (!opts.quiet) {
        console.log(success(`Pushed ${file}`));
      }
    } catch (err: any) {
      if (!opts.quiet) {
        console.error(clrError(`Push failed: ${err.message}`));
      }
      process.exit(1);
    }
  });
