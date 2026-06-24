import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig } from '../config.js';
import { formatSize } from '../utils.js';
import { success, error as clrError, warning, muted, bold, brand } from '../colors.js';
import { run, syncBeforeAction } from '../helpers/index.js';
import { withSpinner } from '../progress.js';

// ── Status icons ───────────────────────────────────────────────────────

function statusIcon(status: string): string {
  if (status === 'ok') return success('✓');
  if (status === 'failed') return clrError('✗');
  if (status === 'warning') return warning('⚠');
  return muted('→');
}

// ── Main Deploy Command ────────────────────────────────────────────────

export const deployCommand = new Command('deploy')
  .description('Deploy to dev or prod')
  .argument('[target]', 'dev or prod', 'dev')
  .option('--source-dir <dir>', 'Source directory to deploy from')
  .option('--only <phases>', 'Run only specific phases (comma-separated)')
  .option('--force', 'Re-run all phases (ignore checksums) and bypass the sync bulk-deletion guard')
  .option('--no-sync', 'Skip sync-up before deploy')
  .option('--optimize', 'Force Vite build optimization on (default for prod; use this to optimize a dev deploy too)')
  .option('--no-optimize', 'Skip build optimization and upload files as-is - the escape hatch for plain-HTML apps whose <script src> tags are not type="module"')
  .option('--json', 'Output as JSON')
  .action((target: string, opts) => run('Deploy', async () => {
      if (target !== 'dev' && target !== 'prod') {
        console.error(clrError('Target must be "dev" or "prod"'));
        process.exit(1);
      }

      const config = requireConfig();
      await syncBeforeAction(opts);

      // Call server - the multi-phase pipeline runs entirely server-side, so
      // this single POST can block for many seconds. Animate the spinner while
      // we wait so it never reads as hung. JSON mode skips it (shares stdout).
      type DeployData = {
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
      const doDeploy = () => post<{ data: DeployData }>(`/projects/${config.projectGuid}/deploy`, {
        target,
        sourceDir: opts.sourceDir,
        optimize: opts.optimize,
        force: opts.force,
        only: opts.only?.split(',').map((s: string) => s.trim()),
      });
      const res = opts.json
        ? await doDeploy()
        : await withSpinner(`Deploying to ${target}…`, doDeploy, { done: null });

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
          console.log(`${statusIcon(phase.status)} ${bold(phase.name)}: ${phase.summary}`);
        }
      } else {
        // Fallback for simple deploys without phases
        const size = formatSize(d.totalBytes);
        console.log(`${success('✓')} ${d.fileCount} files (${size})`);
      }

      if (d.customDomains?.length) {
        console.log(`${muted('Also:')} ${d.customDomains.join(', ')}`);
      }

      if (d.warning) {
        console.log(`${warning(d.warning)}`);
      }

      // Show example curl commands for public endpoints
      if (d.examples && d.examples.length > 0) {
        console.log('');
        console.log(bold('Test your endpoints:'));
        for (const ex of d.examples) {
          console.log(`${muted(ex)}`);
        }
      }

      console.log(muted('─'.repeat(40)));

      const failedPhases = d.phases?.filter(p => p.status === 'failed') ?? [];
      if (failedPhases.length > 0) {
        // The database phase can fail on the account-wide database cap, whose
        // server message ("Maximum of N databases reached. Drop one first.")
        // names no command. The droppable databases live in OTHER projects, so
        // the default project-scoped `gipity db list` shows nothing — point the
        // caller straight at the account-wide list + drop path so they don't
        // dead-end (or reach for raw DB access) to free a slot.
        if (failedPhases.some(p => /databases? reached|database (cap|limit)/i.test(p.summary))) {
          console.log('');
          console.log(muted('Free a slot under the account database cap:'));
          console.log(`  ${brand('gipity db list --all')}            ${muted('# every database counting toward the cap, by project')}`);
          console.log(`  ${brand('gipity db drop <name> --project <slug>')} ${muted('# drop one from another project')}`);
        }
        console.log(clrError(`Deploy failed`) + muted(` (${d.elapsedMs}ms)`));
        process.exit(1);
      } else {
        console.log(success(`✓ Deployed to ${target}`) + muted(` (${d.elapsedMs}ms)`));
        // The live URL is the one thing the caller (often an agent) needs next
        // - to open it, inspect it, or report it. Always surface it so nobody
        // has to reconstruct the URL convention or guess a subdomain.
        if (d.url) console.log(`${muted('Live:')} ${brand(d.url)}`);
      }
  }));
