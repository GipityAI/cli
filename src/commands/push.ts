import { Command } from 'commander';
import { resolve } from 'path';
import { pushFile } from '../sync.js';
import { error as clrError } from '../colors.js';

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
        console.log('');
        console.log(`Pushed ${file}`);
        console.log('');
      }
    } catch (err: any) {
      if (!opts.quiet) {
        console.log('');
        console.error(clrError(`Push failed: ${err.message}`));
        console.log('');
      }
      process.exit(1);
    }
  });
