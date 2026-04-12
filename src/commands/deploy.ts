import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { formatSize } from '../utils.js';
import { success, error as clrError, warning, muted, bold, brand } from '../colors.js';
import { run, syncBeforeAction } from '../helpers/index.js';

// ── Status icons ───────────────────────────────────────────────────────

function statusIcon(status: string): string {
  if (status === 'ok') return success('✓');
  if (status === 'failed') return clrError('✗');
  if (status === 'warning') return warning('⚠');
  return muted('→');
}

// ── Main Deploy Command ────────────────────────────────────────────────

export const deployCommand = new Command('deploy')
  .description('Deploy project to dev or prod')
  .argument('[target]', 'dev or prod', 'dev')
  .option('--source-dir <dir>', 'Source directory to deploy from')
  .option('--only <phases>', 'Run only specific phases (comma-separated)')
  .option('--force', 'Re-run all phases, ignore checksums')
  .option('--no-sync', 'Skip sync-up before deploy')
  .option('--optimize', 'Run build optimization')
  .option('--json', 'Output as JSON')
  .action((target: string, opts) => run('Deploy', async () => {
      if (target !== 'dev' && target !== 'prod') {
        console.error(clrError('Target must be "dev" or "prod"'));
        process.exit(1);
      }

      const config = requireConfig();
      await syncBeforeAction(opts);

      if (!opts.json) console.log('');

      // Call server — pipeline runs entirely server-side
      const res = await post<{
        data: {
          fileCount: number;
          totalBytes: number;
          url: string;
          target: string;
          elapsedMs: number;
          batch?: number;
          phases?: Array<{ name: string; status: string; summary: string }>;
          warning?: string;
          customDomains?: string[];
          skippedFiles?: string[];
          examples?: string[];
        };
      }>(`/projects/${config.projectGuid}/deploy`, {
        target,
        sourceDir: opts.sourceDir,
        optimize: opts.optimize,
        force: opts.force,
        only: opts.only?.split(',').map((s: string) => s.trim()),
      });

      const d = res.data;

      if (opts.json) {
        console.log(JSON.stringify(d));
        return;
      }

      // Format output
      const batchLabel = d.batch ? muted(` (batch ${d.batch})`) : '';
      console.log(brand(bold(`Deploy to ${target}`)) + batchLabel);
      console.log(muted('─'.repeat(40)));

      if (d.phases && d.phases.length > 0) {
        for (const phase of d.phases) {
          console.log(`  ${statusIcon(phase.status)} ${bold(phase.name)}: ${phase.summary}`);
        }
      } else {
        // Fallback for simple deploys without phases
        const size = formatSize(d.totalBytes);
        console.log(`  ${success('✓')} ${d.fileCount} files (${size}) → ${success(d.url)}`);
      }

      if (d.customDomains?.length) {
        console.log(`  ${muted('Also:')} ${d.customDomains.join(', ')}`);
      }

      if (d.warning) {
        console.log(`  ${warning(d.warning)}`);
      }

      // Show example curl commands for public endpoints
      if (d.examples && d.examples.length > 0) {
        console.log('');
        console.log(bold('Test your endpoints:'));
        for (const ex of d.examples) {
          console.log(`  ${muted(ex)}`);
        }
      }

      console.log(muted('─'.repeat(40)));

      const hasFailed = d.phases?.some(p => p.status === 'failed');
      if (hasFailed) {
        console.log(clrError(`Deploy failed`) + muted(` (${d.elapsedMs}ms)`));
        process.exit(1);
      } else {
        console.log(success(`✓ Deployed to ${target}`) + muted(` (${d.elapsedMs}ms)`));
      }
      console.log('');

  }));
