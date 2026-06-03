import { Command } from 'commander';
import { post, get, ApiError } from '../api.js';
import { brand, bold, muted } from '../colors.js';
import { runBrowser } from '../helpers/index.js';

interface EvalResult {
  url: string;
  result: string;
  truncated: boolean;
}

type EvalJobRecord =
  | { status: 'running' }
  | ({ status: 'done' } & EvalResult)
  | { status: 'error'; httpStatus: number; code: string; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll the async eval job until it finishes. Eval runs server-side as a
 *  short-lived job (so a long --wait can't trip the gateway idle timeout);
 *  we submit, then poll the result out of the job store. */
async function pollEvalResult(evalJobId: string, waitMs: number): Promise<EvalResult> {
  // Generous client budget: the server work is bounded by --wait plus browser
  // open/settle overhead; give it that plus headroom before giving up.
  const deadline = Date.now() + waitMs + 60_000;
  let missCount = 0;
  while (Date.now() < deadline) {
    let rec: EvalJobRecord;
    try {
      rec = (await get<{ data: EvalJobRecord }>(`/tools/browser/eval/${evalJobId}`)).data;
    } catch (err) {
      // A 404 right after submit can happen if the record hasn't landed yet;
      // tolerate a few, then treat a persistent 404 as the job being gone.
      if (err instanceof ApiError && err.statusCode === 404 && missCount++ < 3) {
        await sleep(500);
        continue;
      }
      throw err;
    }
    if (rec.status === 'done') return rec;
    if (rec.status === 'error') throw new ApiError(rec.httpStatus, rec.code, rec.reason);
    await sleep(1000);
  }
  throw new ApiError(504, 'EVAL_TIMEOUT', 'Eval did not finish in time; narrow the expression or lower --wait');
}

// The long-tail escape hatch alongside `page inspect`'s fixed bundle: when the
// curated metrics don't cover what you need (computed styles, element rects,
// visibility, z-index stacks), eval an expression in page context and get the
// serialized result back. Runs in the same browser sandbox as inspect.
export const pageEvalCommand = new Command('eval')
  .description('Evaluate a JS expression in a real browser on a page (DOM, computed styles, element rects)')
  .argument('<url>', 'URL to load')
  .argument('<expr>', 'JavaScript expression to evaluate in page context (result is JSON-serialized)')
  .option('--wait <ms>', 'Sleep this many ms after DOMContentLoaded before evaluating (lets late async work settle)', '500')
  .option('--wait-for <selector>', 'Wait until this CSS selector appears before evaluating (deterministic; replaces --wait)')
  .option('--wait-timeout <ms>', 'Max ms to wait for --wait-for before giving up', '5000')
  .option('--json', 'Output as JSON')
  .action((url: string, expr: string, opts) => runBrowser('Page eval', url, async () => {
    const parsedWait = parseInt(opts.wait, 10);
    const waitMs = Number.isFinite(parsedWait) && parsedWait >= 0 ? parsedWait : 500;
    const parsedTimeout = parseInt(opts.waitTimeout, 10);
    const waitForTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : 5000;

    const kickoff = await post<{ data: { evalJobId: string } }>('/tools/browser/eval', {
      url, expr, waitMs,
      waitForSelector: opts.waitFor || undefined,
      waitForTimeoutMs: opts.waitFor ? waitForTimeoutMs : undefined,
    });
    const d = await pollEvalResult(kickoff.data.evalJobId, waitMs);

    if (opts.json) {
      console.log(JSON.stringify(d));
      return;
    }

    console.log(`\n${brand('Eval')} ${bold(d.url || url)}`);
    console.log(`  ${muted('Expression:')} ${expr}`);
    console.log(`\n${d.result || muted('(empty result)')}`);
    if (d.truncated) console.log(muted('\n(result truncated to fit context - narrow the expression for the full value)'));
    console.log('');
  }));
