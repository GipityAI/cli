import { Command } from 'commander';
import { get, post } from '../api.js';
import { requireConfig } from '../config.js';
import { success, error as clrError, warning, muted, bold, dim } from '../colors.js';
import { run, syncBeforeAction } from '../helpers/index.js';

function statusIcon(status: string): string {
  if (status === 'passed') return success('✓');
  if (status === 'failed') return clrError('✗');
  if (status === 'skipped') return muted('→');
  return muted('?');
}

interface TestStatusResponse {
  data: {
    runGuid: string;
    status: string;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
    totalFiles: number;
    completedFiles: number;
    startedAt: string;
    updatedAt: string;
    finishedAt: string | null;
    results: Array<{
      path: string;
      name: string;
      status: string;
      durationMs: number;
      error?: string;
      retryCount: number;
      isFlaky: boolean;
    }>;
  };
}

async function pollTestStatus(projectGuid: string, runGuid: string, opts: { json?: boolean }): Promise<TestStatusResponse['data']> {
  // Adaptive polling: fast at first (tests often finish quickly with warm pool),
  // then back off for long-running suites.
  const startTime = Date.now();
  const getPollInterval = () => {
    const elapsed = Date.now() - startTime;
    if (elapsed < 5000) return 300;    // first 5s: poll every 300ms
    if (elapsed < 20000) return 1000;  // next 15s: poll every 1s
    return 3000;                        // after 20s: poll every 3s
  };
  let lastResultCount = 0;

  while (true) {
    const res = await get<TestStatusResponse>(`/projects/${projectGuid}/test/status/${runGuid}`);
    const data = res.data;

    // Show progress for new results (non-JSON mode)
    if (!opts.json && data.results.length > lastResultCount) {
      const newResults = data.results.slice(lastResultCount);

      // Group new results by path for display
      const groups = new Map<string, typeof newResults>();
      for (const r of newResults) {
        const key = r.path || '(root)';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(r);
      }

      for (const [path, results] of groups) {
        // Only print path header if it's the first time we see this path
        const existingPaths = new Set(data.results.slice(0, lastResultCount).map(r => r.path));
        if (!existingPaths.has(path)) {
          console.log(`  ${dim(path)}`);
        }
        for (const r of results) {
          const icon = r.isFlaky ? warning('~') : statusIcon(r.status);
          const time = muted(`(${r.durationMs}ms)`);
          const flaky = r.isFlaky ? warning(' [flaky]') : '';
          console.log(`    ${icon} ${r.name} ${time}${flaky}`);
          if (r.status === 'failed' && r.error) {
            console.log(`      ${clrError(r.error)}`);
          }
        }
      }

      lastResultCount = data.results.length;
    }

    // Done?
    if (data.status !== 'running') {
      return data;
    }

    // Show progress indicator (overwrite in-place) — only in real terminals
    if (!opts.json && process.stdout.isTTY) {
      if (data.totalFiles === 0) {
        process.stdout.write(`\r  ${muted('Starting...')}          `);
      } else {
        const pct = Math.round((data.completedFiles / data.totalFiles) * 100);
        process.stdout.write(`\r  ${muted(`${data.completedFiles}/${data.totalFiles} files (${pct}%)`)}`);
      }
    }

    await new Promise(resolve => setTimeout(resolve, getPollInterval()));
  }
}

// ── Main Command ───────────────────────────────────────────────────────

export const testCommand = new Command('test')
  .description('Run tests against the deployed app')
  .argument('[path]', 'Test path filter (e.g. "api", "e2e/portal")')
  .option('--timeout <ms>', 'Per-test timeout in ms', '30000')
  .option('--retry <n>', 'Retry failed tests N times', '0')
  .option('--no-sync', 'Skip sync-up before tests')
  .option('--json', 'Output as JSON')
  .action((filterPath: string | undefined, opts) => run('Test', async () => {
      const config = requireConfig();
      await syncBeforeAction(opts);

      if (!opts.json) {
        console.log('');
        console.log(bold(`Running tests: ${filterPath || 'all'}`));
        console.log('');
      }

      // Kick off async test run
      const kickoff = await post<{
        data: { runGuid: string; status: string };
      }>(`/projects/${config.projectGuid}/test/run`, {
        filterPath: filterPath || null,
        timeout: parseInt(opts.timeout),
        retry: parseInt(opts.retry),
      });

      const runGuid = kickoff.data.runGuid;

      if (!opts.json) {
        console.log(`  ${muted(`Run: ${runGuid}`)}`);
        console.log('');
      }

      // Poll for results (streams results as they complete)
      const data = await pollTestStatus(config.projectGuid, runGuid, opts);

      if (!opts.json && process.stdout.isTTY) {
        // Clear progress line
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      // Print any remaining results not yet shown (edge case: final batch)
      // (pollTestStatus already printed results incrementally)

      console.log('');

      // Summary
      const parts: string[] = [];
      if (data.passed > 0) parts.push(success(`${data.passed} passed`));
      if (data.failed > 0) parts.push(clrError(`${data.failed} failed`));
      if (data.skipped > 0) parts.push(muted(`${data.skipped} skipped`));
      console.log(`${parts.join(', ')} ${muted(`(${data.durationMs}ms)`)}`);
      console.log('');

      if (data.failed > 0) process.exit(1);
  }));

// ── Status subcommand (check on a running test) ──────────────────────

testCommand
  .command('status')
  .description('Check status of a test run')
  .argument('<runGuid>', 'Test run GUID (e.g. tr_abc123)')
  .option('--json', 'Output as JSON')
  .option('--follow', 'Follow until complete (poll)')
  .action((runGuid: string, opts) => run('Status', async () => {
      const config = requireConfig();

      if (opts.follow) {
        const data = await pollTestStatus(config.projectGuid, runGuid, opts);
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        }
        return;
      }

      const res = await get<TestStatusResponse>(`/projects/${config.projectGuid}/test/status/${runGuid}`);
      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      const icon = data.status === 'running' ? muted('⧗') : data.status === 'passed' ? success('✓') : clrError('✗');
      console.log('');
      console.log(`  ${icon} ${bold(data.status)} — ${data.passed}/${data.total} passed`);
      if (data.totalFiles > 0) {
        console.log(`  ${muted(`Files: ${data.completedFiles}/${data.totalFiles}`)}`);
      }
      if (data.durationMs) {
        console.log(`  ${muted(`Duration: ${data.durationMs}ms`)}`);
      }
      if (data.failed > 0) {
        console.log('');
        const failures = data.results.filter(r => r.status === 'failed');
        for (const f of failures) {
          console.log(`  ${clrError('✗')} ${f.path}/${f.name}`);
          if (f.error) console.log(`    ${clrError(f.error)}`);
        }
      }
      console.log('');
  }));

// ── History subcommand ─────────────────────────────────────────────────

testCommand
  .command('history')
  .description('Show recent test run history')
  .option('--limit <n>', 'Number of runs to show', '10')
  .option('--json', 'Output as JSON')
  .action((opts) => run('History', async () => {
      const config = requireConfig();
      const res = await get<{
        data: Array<{
          run_guid: string; status: string; total: number; passed: number;
          failed: number; duration_ms: number; started_at: string;
        }>;
      }>(`/projects/${config.projectGuid}/test/history?limit=${opts.limit}`);

      if (opts.json) { console.log(JSON.stringify(res.data)); return; }
      if (res.data.length === 0) { console.log(muted('No test runs yet.')); return; }

      console.log('');
      console.log(bold('Test History'));
      for (const entry of res.data) {
        const icon = entry.status === 'passed' ? success('✓') : entry.status === 'running' ? muted('⧗') : clrError('✗');
        const date = new Date(entry.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        console.log(`  ${icon} ${muted(date)} ${entry.passed}/${entry.total} passed ${muted(entry.run_guid)}`);
      }
      console.log('');
  }));
