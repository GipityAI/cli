import { Command } from 'commander';
import { get, del, post } from '../api.js';
import { resolveProjectContext } from '../config.js';
import { formatSize } from '../utils.js';
import { info, muted } from '../colors.js';
import { run, printList } from '../helpers/index.js';

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
  .action((path: string | undefined, opts) => run('List', async () => {
    const { config } = await resolveProjectContext();
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await get<{ data: FileEntry[] }>(`/projects/${config.projectGuid}/files${query}`);

    printList(res.data, opts, '(empty)', f => {
      const size = f.type === 'directory' ? '<DIR>' : formatSize(Number(f.size));
      const name = f.type === 'directory' ? info(`${f.name}/`) : f.name;
      return `${muted(size.padStart(10))}  ${name}`;
    });
  }));

fileCommand
  .command('cat <path>')
  .description('Read a remote file')
  .option('--json', 'Output as JSON')
  .action((path: string, opts) => run('Read', async () => {
    const { config } = await resolveProjectContext();
    const res = await get<{ data: { content: string; size: number; mime: string } }>(
      `/projects/${config.projectGuid}/files/read?path=${encodeURIComponent(path)}`
    );

    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      process.stdout.write(res.data.content);
    }
  }));

fileCommand
  .command('tree [path]')
  .description('Show full file tree')
  .option('--json', 'Output as JSON')
  .action((path: string | undefined, opts) => run('Tree', async () => {
    const { config } = await resolveProjectContext();
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await get<{ data: Array<{ path: string; size: number; type: string }> }>(
      `/projects/${config.projectGuid}/files/tree${query}`
    );

    printList(res.data, opts, '(empty)', f => {
      const size = f.type === 'dir' ? '' : `  (${formatSize(Number(f.size))})`;
      return `${f.path}${size}`;
    });
  }));

fileCommand
  .command('rm <path>')
  .description('Delete a remote file or directory')
  .option('--json', 'Output as JSON')
  .action((path: string, opts) => run('Delete', async () => {
    const { config } = await resolveProjectContext();
    const res = await del<{ success: boolean }>(
      `/projects/${config.projectGuid}/files?path=${encodeURIComponent(path)}`
    );

    if (opts.json) {
      console.log(JSON.stringify(res));
    } else {
      console.log(`Deleted: ${path}`);
    }
  }));

interface VersionEntry {
  version: number;
  size: number;
  mime: string | null;
  source: string;
  created_at: string;
  current: boolean;
}

fileCommand
  .command('versions <path>')
  .description('List version history of a file')
  .option('--limit <n>', 'Max versions to return', '20')
  .option('--json', 'Output as JSON')
  .action((path: string, opts) => run('Versions', async () => {
    const { config } = await resolveProjectContext();
    const query = `?path=${encodeURIComponent(path)}&limit=${opts.limit}`;
    const res = await get<{ data: VersionEntry[] }>(
      `/projects/${config.projectGuid}/files/versions${query}`
    );

    printList(res.data, opts, 'No versions found', (v: VersionEntry) => {
      const date = new Date(v.created_at).toISOString().replace('T', ' ').slice(0, 19);
      const marker = v.current ? muted('  ← current') : '';
      return `${info(`v${v.version}`)}  ${muted(date)}  ${formatSize(v.size).padStart(8)}  [${v.source}]${marker}`;
    });
  }));

fileCommand
  .command('restore <path> <version>')
  .description('Switch a file to a specific version (older or newer)')
  .option('--json', 'Output as JSON')
  .action((path: string, version: string, opts) => run('Restore', async () => {
    const { config } = await resolveProjectContext();
    const res = await post<{ data: { path: string; version: number; size: number } }>(
      `/projects/${config.projectGuid}/files/version-restore`,
      { path, version: Number(version) },
    );

    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      console.log(`Restored ${res.data.path} to v${res.data.version} (${formatSize(res.data.size)})`);
    }
  }));

interface RollbackData {
  filesRestored: number;
  filesRemoved: number;
  dirsRestored: number;
  dirsRemoved: number;
  filesUnchanged: number;
  resolvedDatetime: string;
}

fileCommand
  .command('rollback <datetime>')
  .description('Roll back files to a point in time (or "latest" to undo)')
  .option('--path <dir>', 'Scope to a directory')
  .option('--no-recursive', 'Direct children only')
  .option('--json', 'Output as JSON')
  .action((datetime: string, opts) => run('Rollback', async () => {
    const { config } = await resolveProjectContext();
    const res = await post<{ data: RollbackData }>(
      `/projects/${config.projectGuid}/rollback`,
      { datetime, path: opts.path, recursive: opts.recursive !== false },
    );

    if (opts.json) {
      console.log(JSON.stringify(res.data));
    } else {
      const d = res.data;
      const parts: string[] = [];
      if (d.filesRestored > 0) parts.push(`${d.filesRestored} files restored`);
      if (d.filesRemoved > 0) parts.push(`${d.filesRemoved} files removed`);
      if (d.dirsRestored > 0) parts.push(`${d.dirsRestored} dirs restored`);
      if (d.dirsRemoved > 0) parts.push(`${d.dirsRemoved} dirs removed`);
      if (d.filesUnchanged > 0) parts.push(`${d.filesUnchanged} unchanged`);
      console.log(parts.length > 0 ? `Rolled back: ${parts.join(', ')}` : 'No changes needed.');
    }
  }));
