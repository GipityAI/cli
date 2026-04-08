import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { syncUp } from '../sync.js';
import { formatSize } from '../utils.js';

export const deployCommand = new Command('deploy')
  .description('Deploy project to dev or prod')
  .argument('[target]', 'dev or prod', 'dev')
  .option('--source-dir <dir>', 'Source directory to deploy from')
  .option('--no-sync', 'Skip sync-up before deploy')
  .option('--json', 'Output as JSON')
  .action(async (target: string, opts) => {
    try {
      if (target !== 'dev' && target !== 'prod') {
        console.error('Target must be "dev" or "prod"');
        process.exit(1);
      }

      const config = requireConfig();

      // Sync up first
      if (opts.sync !== false) {
        const syncResult = await syncUp();
        if (syncResult.pushed > 0 && !opts.json) {
          console.log(`Synced ${syncResult.pushed} file${syncResult.pushed > 1 ? 's' : ''}.`);
        }
      }

      // Deploy
      if (!opts.json) console.log(`Deploying to ${target}...`);

      const res = await post<{
        data: {
          fileCount: number;
          totalBytes: number;
          url: string;
          target: string;
          elapsedMs: number;
          projectType?: string;
          warning?: string;
        };
      }>(`/projects/${config.projectGuid}/deploy`, {
        target,
        sourceDir: opts.sourceDir,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
      } else {
        if (res.data.warning) {
          console.log(res.data.warning);
        } else {
          const d = res.data;
          const size = formatSize(d.totalBytes);
          const parts = [`${d.fileCount} files`, size, `${d.elapsedMs}ms`];
          console.log(`${d.url}  (${parts.join(', ')})`);
        }
      }
    } catch (err: any) {
      console.error(`Deploy failed: ${err.message}`);
      process.exit(1);
    }
  });
