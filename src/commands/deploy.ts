import { Command } from 'commander';
import { post } from '../api.js';
import { requireConfig, resolveApiBase } from '../config.js';
import { formatSize } from '../utils.js';
import { success, error as clrError, warning, muted, bold, brand } from '../colors.js';
import { run, syncBeforeAction } from '../helpers/index.js';
import { withSpinner } from '../progress.js';
import { inspectPage } from './page-inspect.js';

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
  .option('--inspect [path]', 'After a successful deploy, run `page inspect` on the deployed URL (or URL + path) in the same command - one build-loop step instead of two. With --json, emits two JSON lines: deploy, then inspect.')
  // The settle knobs `page inspect` already has. An app whose first paint is behind
  // a model load / async boot inspects as an empty page without them, so a caller
  // that reaches for `--inspect` on such an app needs them HERE - it should not have
  // to abandon the combined command and re-run inspect standalone just to wait.
  .option('--wait <ms>', 'With --inspect: sleep this many ms before capturing (max 30000)')
  .option('--wait-for <selector>', "With --inspect: wait until this CSS selector appears before capturing (deterministic; the app's own ready signal)")
  .option('--wait-timeout <ms>', 'With --inspect: max ms to wait for --wait-for before giving up', '5000')
  .action((target: string, opts) => run('Deploy', async () => {
      if (target !== 'dev' && target !== 'prod') {
        console.error(clrError('Target must be "dev" or "prod"'));
        process.exit(1);
      }

      // A settle flag only means one thing on a deploy: "verify the page once it's
      // up, and give it time to come up." Asking for it without --inspect is not an
      // error to bounce back — it's the intent, so honour it.
      if (!opts.inspect && (opts.waitFor || deployCommand.getOptionValueSource('wait') !== undefined)) {
        opts.inspect = true;
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
        phases?: Array<{ name: string; status: string; summary: string; elapsedMs?: number }>;
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
        : await withSpinner(`Deploying to ${target}...`, doDeploy, { done: null });

      const d = res.data;

      // Deploy + verify in one command: after a successful deploy, run the
      // same inspect pipeline `page inspect` uses against the live URL. An
      // inspect failure is reported but never turns a successful deploy into
      // a nonzero exit - the deploy DID land.
      const inspectAfter = async (): Promise<void> => {
        if (!opts.inspect) return;
        if (!d.url) {
          console.error(warning('--inspect skipped: this deploy produced no URL (e.g. --only database)'));
          return;
        }
        const url = typeof opts.inspect === 'string' ? new URL(opts.inspect, d.url).toString() : d.url;
        if (!opts.json) console.log('');
        try {
          await inspectPage(url, {
            json: opts.json,
            wait: opts.wait,
            waitFor: opts.waitFor,
            waitTimeout: opts.waitTimeout,
          });
        } catch (err: any) {
          console.error(warning(`Inspect failed (deploy itself succeeded): ${err?.message ?? err}`));
        }
      };

      if (opts.json) {
        console.log(JSON.stringify(d));
        const failedJson = d.phases?.some(p => p.status === 'failed');
        if (!failedJson) await inspectAfter();
        return;
      }

      // Format output
      const batchLabel = d.batch ? muted(` (batch ${d.batch})`) : '';
      console.log(brand(bold(`Deploy to ${target}`)) + batchLabel);
      console.log(muted('─'.repeat(40)));

      if (d.phases && d.phases.length > 0) {
        for (const phase of d.phases) {
          const ms = phase.elapsedMs != null ? muted(` (${phase.elapsedMs}ms)`) : '';
          console.log(`${statusIcon(phase.status)} ${bold(phase.name)}: ${phase.summary}${ms}`);
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
        // server message ("Maximum of N databases reached (you have N). Drop one
        // first.") names no command. The droppable databases live in OTHER
        // projects, so the default project-scoped `gipity db list` shows nothing
        // — point the caller straight at the account-wide list + drop path so
        // they don't dead-end (or reach for raw DB access) to free a slot.
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
        // Functions are served from the API host, NOT the static Live URL -
        // for an API-only app the endpoint address IS the deliverable, so name
        // it instead of leaving it to be inferred from a template comment.
        if (d.phases?.some(p => p.name === 'functions')) {
          // Print the base the CLI actually calls (resolveApiBase honors the
          // --api-base flag and GIPITY_API_BASE env), not the raw stored
          // config.apiBase - otherwise on any override we'd advertise a host we
          // didn't deploy to and send the caller probing the wrong instance.
          console.log(`${muted('Functions:')} POST ${brand(`${resolveApiBase()}/api/${config.projectGuid}/fn/<name>`)}`);
          console.log(muted('  (same address on dev and prod; names: gipity fn list; verify the public path: gipity fn call <name> --anon)'));
        }
        await inspectAfter();
      }
  }));
