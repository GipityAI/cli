import { Command } from 'commander';
import { get, del } from '../api.js';
import { requireConfig } from '../config.js';
import { formatSize } from '../utils.js';
import { info, error as clrError, muted, success } from '../colors.js';

interface FileEntry {
  name: string;
  type: string;
  size: number;
  modified: string;
}

export const fileCommand = new Command('file')
  .description('Browse remote files (without sync)');

fileCommand
  .command('ls [path]')
  .description('List files in remote project')
  .option('--json', 'Output as JSON')
  .action(async (path: string | undefined, opts) => {
    try {
      const config = requireConfig();
      const query = path ? `?path=${encodeURIComponent(path)}` : '';
      const res = await get<{ data: FileEntry[] }>(`/projects/${config.projectGuid}/files${query}`);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('(empty)');
        } else {
          for (const f of res.data) {
            const size = f.type === 'directory' ? '<DIR>' : formatSize(Number(f.size));
            const name = f.type === 'directory' ? info(`${f.name}/`) : f.name;
            console.log(`${muted(size.padStart(10))}  ${name}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`List failed: ${err.message}`));
      process.exit(1);
    }
  });

fileCommand
  .command('cat <path>')
  .description('Read a remote file')
  .option('--json', 'Output as JSON')
  .action(async (path: string, opts) => {
    try {
      const config = requireConfig();
      const res = await get<{ data: { content: string; size: number; mime: string } }>(
        `/projects/${config.projectGuid}/files/read?path=${encodeURIComponent(path)}`
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        process.stdout.write(res.data.content);
      }
    } catch (err: any) {
      console.error(clrError(`Read failed: ${err.message}`));
      process.exit(1);
    }
  });

fileCommand
  .command('tree [path]')
  .description('Show full file tree')
  .option('--json', 'Output as JSON')
  .action(async (path: string | undefined, opts) => {
    try {
      const config = requireConfig();
      const query = path ? `?path=${encodeURIComponent(path)}` : '';
      const res = await get<{ data: Array<{ path: string; size: number; type: string }> }>(
        `/projects/${config.projectGuid}/files/tree${query}`
      );

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('(empty)');
        } else {
          for (const f of res.data) {
            const size = f.type === 'dir' ? '' : `  (${formatSize(Number(f.size))})`;
            console.log(`${f.path}${size}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`Tree failed: ${err.message}`));
      process.exit(1);
    }
  });

fileCommand
  .command('rm <path>')
  .description('Delete a remote file or directory')
  .option('--json', 'Output as JSON')
  .action(async (path: string, opts) => {
    try {
      const config = requireConfig();
      const res = await del<{ success: boolean }>(
        `/projects/${config.projectGuid}/files?path=${encodeURIComponent(path)}`
      );

      if (opts.json) {
        console.log(JSON.stringify(res));
      } else {
        console.log(`Deleted: ${path}`);
      }
    } catch (err: any) {
      console.error(clrError(`Delete failed: ${err.message}`));
      process.exit(1);
    }
  });

