import { Command } from 'commander';
import { post } from '../api.js';
import { brand, bold, muted, warning, success, error as clrError } from '../colors.js';
import { run } from '../helpers/index.js';

// Only the fields we read off the inspect bundle.
interface DebugBundle {
  console?: string[];
}

interface ClientResult {
  i: number;
  lines: string[];
  error?: string;
}

// Lines worth surfacing - genuine errors and crash signatures, not benign warnings.
const BAD = /^error:|uncaught|unhandled|message handler error|\bcrash|RuntimeError/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one passive page load via the inspect endpoint and return its console. */
async function inspectClient(url: string, waitMs: number, i: number): Promise<ClientResult> {
  try {
    const res = await post<{ data: DebugBundle }>('/tools/browser/inspect', { url, waitMs });
    return { i, lines: res.data.console ?? [] };
  } catch (err) {
    return { i, lines: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// Headless multi-client realtime check: spin N staggered browser clients at a
// deployed URL and flag error/crash lines across their consoles. The verifier
// for realtime apps (host election, presence, world sync, reconnection) -
// promotes the internal multi-client-test script to a first-class command.
//
// Passive page loads only: each client just loads the URL and settles. An app
// that connects to realtime only after a user action (e.g. a lobby that joins
// on a button press) needs a URL-param test mode so the load alone exercises
// the path - see the app-realtime skill.
export const pageTestCommand = new Command('test')
  .description('Multi-client realtime check: load a URL in N staggered headless clients, flag console errors')
  .argument('<url>', 'Deployed URL to load in every client')
  .option('--clients <n>', 'Number of headless clients to launch', '2')
  .option('--stagger <s>', 'Seconds between client starts (client 0 settles first, e.g. as host)', '12')
  .option('--wait <ms>', 'Milliseconds each client stays open after load (max 30000)', '24000')
  .option('--json', 'Output as JSON')
  .action((url: string, opts) => run('Page test', async () => {
    const clients = Math.max(1, parseInt(opts.clients, 10) || 2);
    const stagger = Math.max(0, parseInt(opts.stagger, 10) || 0);
    const wait = Math.min(30000, Math.max(2000, parseInt(opts.wait, 10) || 24000));

    if (!opts.json) {
      console.log(`${brand('Page test')} ${bold(url)}`);
      console.log(`${muted(`${clients} client(s), stagger ${stagger}s, ${wait}ms open each`)}`);
    }

    const runs: Promise<ClientResult>[] = [];
    for (let i = 0; i < clients; i++) {
      runs.push((async () => {
        await sleep(i * stagger * 1000);
        if (!opts.json) console.log(`${muted(`client ${i}${i === 0 ? ' (first)' : ''} starting`)}`);
        return inspectClient(url, wait, i);
      })());
    }
    const results = (await Promise.all(runs)).sort((a, b) => a.i - b.i);

    let problems = 0;
    for (const r of results) {
      if (r.error) problems++;
      else problems += r.lines.filter((l) => BAD.test(l)).length;
    }

    if (opts.json) {
      console.log(JSON.stringify({ url, clients, stagger, wait, problems, results }));
      if (problems > 0) process.exitCode = 1;
      return;
    }

    for (const r of results) {
      console.log(`\n${bold(`=== client ${r.i}${r.i === 0 ? ' (first)' : ''} ===`)}`);
      if (r.error) { console.log(`${clrError(`page inspect failed: ${r.error}`)}`); continue; }
      if (r.lines.length === 0) { console.log(`${muted('(no console output)')}`); continue; }
      for (const line of r.lines) {
        const bad = BAD.test(line);
        console.log(`${bad ? warning('⚠ ' + line) : ' ' + line}`);
      }
    }

    console.log(
      problems === 0
        ? `\n${success('✓ no error/crash lines across all clients')}`
        : `\n${clrError(`⚠ ${problems} error/crash line(s) flagged above`)}`,
    );
    if (problems > 0) process.exitCode = 1;
  }));
