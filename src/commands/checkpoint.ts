import { Command } from 'commander';
import { get, post } from '../api.js';
import { requireConfig } from '../config.js';
import { syncDown } from '../sync.js';
import { formatAge } from '../utils.js';
import { error as clrError, muted, success } from '../colors.js';

interface Checkpoint {
  guid: string;
  label: string;
  created_at: string;
  fileCount: number;
  branched: boolean;
}

export const checkpointCommand = new Command('checkpoint')
  .description('Manage file checkpoints (snapshots for undo/restore)');

checkpointCommand
  .command('list')
  .description('List checkpoints')
  .option('--limit <n>', 'Max results', '20')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const config = requireConfig();
      const limit = parseInt(opts.limit, 10) || 20;
      const res = await get<{ data: Checkpoint[] }>(`/projects/${config.projectGuid}/checkpoints?limit=${limit}`);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.length === 0) {
          console.log('No checkpoints.');
        } else {
          for (const cp of res.data) {
            const age = formatAge(cp.created_at);
            const branch = cp.branched ? ' (branched)' : '';
            console.log(`  ${muted(cp.guid)}  ${cp.label || muted('(auto)')}  ${cp.fileCount} files  ${muted(age)}${branch}`);
          }
        }
      }
    } catch (err: any) {
      console.error(clrError(`List failed: ${err.message}`));
      process.exit(1);
    }
  });

checkpointCommand
  .command('restore <guid>')
  .description('Restore files to a checkpoint (creates a backup checkpoint first)')
  .option('--json', 'Output as JSON')
  .action(async (guid: string, opts) => {
    try {
      const config = requireConfig();
      const res = await post<{
        data: { restoredTo: string; backupCheckpoint: string };
      }>(`/projects/${config.projectGuid}/checkpoints/restore`, {
        checkpoint_guid: guid,
      });

      // Sync down restored files (confirm deletions — restore may remove files)
      const syncResult = await syncDown({ confirmDeletions: true });

      if (opts.json) {
        console.log(JSON.stringify({ ...res.data, synced: syncResult.pulled }));
      } else {
        console.log(success(`Restored to ${res.data.restoredTo}`));
        console.log(`Backup created: ${res.data.backupCheckpoint}`);
        if (syncResult.pulled > 0) {
          console.log(`Pulled ${syncResult.pulled} files to local.`);
        }
      }
    } catch (err: any) {
      console.error(clrError(`Restore failed: ${err.message}`));
      process.exit(1);
    }
  });

