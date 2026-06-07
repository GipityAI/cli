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
        // Fork to background - import child_process dynamically
        const { fork } = await import('child_process');
        const child = fork(process.argv[1], ['push', fullPath, '--quiet'], {
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
