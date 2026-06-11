import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { post, get, ApiError } from '../api.js';
import { brand, bold, muted, warning } from '../colors.js';
import { run } from '../helpers/index.js';

export interface EvalResult {
  url: string;
  result: string;
  truncated: boolean;
  navigationIncomplete?: boolean;
  note?: string;
}

type EvalJobRecord =
  | { status: 'running' }
  | ({ status: 'done' } & EvalResult)
  | { status: 'error'; httpStatus: number; code: string; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A single browser session is held open synchronously for the whole --wait, so
// the server caps it at the gateway idle timeout. Longer is impossible in one
// shot; watching an app past 30s means several windows, not one big wait.
export const MAX_WAIT_MS = 30_000;

/** Parse --wait (defaulting to 500ms), clamping to the per-call cap. When the
 *  caller asks for more than the cap, clamp and explain — to stderr, so --json
 *  stdout stays clean — and point at the windowed watch primitive instead of
 *  leaking the server's raw "Too big" validation error. */
export function capWaitMs(rawWait: string, url: string): number {
  const parsed = parseInt(rawWait, 10);
  const wait = Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
  if (wait <= MAX_WAIT_MS) return wait;
  console.error(warning(
    `--wait ${wait}ms exceeds the ${MAX_WAIT_MS}ms cap (one browser session is held open synchronously; longer trips the gateway timeout) — using ${MAX_WAIT_MS}ms. ` +
    `To watch an app that keeps changing past 30s, cover the span with staggered windows in one command: gipity page test "${url}" --clients N --stagger S.`,
  ));
  return MAX_WAIT_MS;
}

/** Poll the async eval job until it finishes. Eval runs server-side as a
 *  short-lived job (so a long --wait can't trip the gateway idle timeout);
 *  we submit, then poll the result out of the job store. `expectedWorkMs` is
 *  the time the server-side work is expected to take (settle + any in-page
 *  awaits); the client budget is that plus 60s of headroom. */
export async function pollEvalResult(evalJobId: string, expectedWorkMs: number): Promise<EvalResult> {
  // Generous client budget: the server work is bounded by --wait plus browser
  // open/settle overhead; give it that plus headroom before giving up.
  const deadline = Date.now() + expectedWorkMs + 60_000;
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

// The in-page execution budget for an eval body's OWN runtime (its `await`/
// `setTimeout` pauses), enforced by agent-browser's per-command CDP timeout
// (AGENT_BROWSER_DEFAULT_TIMEOUT) — distinct from --wait, which only sleeps
// BEFORE the eval. Used to translate the opaque timeout envelope into guidance.
const EVAL_EXEC_BUDGET_MS = 20_000;

/** When the eval body's own runtime overruns the in-page execution budget,
 *  agent-browser aborts the `Runtime.evaluate` CDP call and the failure comes
 *  back as a `{success:false, error:"CDP command timed out: Runtime.evaluate"}`
 *  envelope that the server surfaces verbatim as the eval `result` — opaque to
 *  the caller (no timeout named, no distinction from the page or --wait). Detect
 *  exactly that envelope and return an actionable message; null otherwise. */
export function evalExecTimeoutMessage(result: string): string | null {
  let parsed: { success?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!parsed || parsed.success !== false || typeof parsed.error !== 'string') return null;
  if (!/CDP command timed out:\s*Runtime\.evaluate/i.test(parsed.error)) return null;
  return (
    `the expression hit the ~${EVAL_EXEC_BUDGET_MS / 1000}s in-page execution budget — the eval body ` +
    `(including its own await/setTimeout pauses) ran longer than that. This budget is the time the ` +
    `expression itself is allowed to run; it is separate from --wait, which only sleeps BEFORE the eval ` +
    `and cannot extend it. Split a long interactive check into several shorter 'page eval' calls (e.g. ` +
    `one per state to verify), keeping each body's in-page waits well under ${EVAL_EXEC_BUDGET_MS / 1000}s.`
  );
}

// The long-tail escape hatch alongside `page inspect`'s fixed bundle: when the
// curated metrics don't cover what you need (computed styles, element rects,
// visibility, z-index stacks), eval an expression in page context and get the
// serialized result back. Runs in the same browser sandbox as inspect.
//
// The body runs as an async function, so it can be an inline expression OR a
// multi-statement script with `return`/`await`. Pass a saved script with
// --file to functionally exercise a page's own code paths headlessly (drive
// tools, undo/redo, transforms) and `return` a JSON-serializable result —
// no /tmp + shell command-substitution harness needed.
export const pageEvalCommand = new Command('eval')
  .description('Evaluate JS in a real browser on a page (DOM, computed styles, element rects; inline expr or --file script)')
  .argument('<url>', 'URL to load')
  .argument('[expr]', 'JavaScript to evaluate in page context (inline expression or statement body with return/await; result is JSON-serialized). Omit when using --file.')
  .option('--file <path>', 'Read the script body from a file instead of the inline <expr> arg (mutually exclusive). Runs as an async function body, so top-level return/await work.')
  .option('--wait <ms>', 'Sleep this many ms after DOMContentLoaded before evaluating (lets late async work settle; max 30000)', '500')
  .option('--wait-for <selector>', 'Wait until this CSS selector appears before evaluating (deterministic; replaces --wait)')
  .option('--wait-timeout <ms>', 'Max ms to wait for --wait-for before giving up', '5000')
  .option('--json', 'Output as JSON')
  .action((url: string, exprArg: string | undefined, opts) => run('Page eval', async () => {
    // Arg-shape errors go through commander's error() so the enableHelpAfterError
    // hook renders this command's help inline with the one-line error LAST
    // (survives `| tail`), same as commander-detected errors like a missing url.
    if (exprArg !== undefined && opts.file) {
      pageEvalCommand.error('error: Pass either an inline <expr> arg or --file <path>, not both');
    }
    if (exprArg === undefined && !opts.file) {
      pageEvalCommand.error('error: Provide an inline <expr> arg or --file <path>');
    }
    let expr = exprArg as string;
    if (opts.file) {
      try {
        expr = readFileSync(opts.file, 'utf8');
      } catch {
        pageEvalCommand.error(`error: Cannot read file: ${opts.file}`);
      }
    }

    const waitMs = capWaitMs(opts.wait, url);
    const parsedTimeout = parseInt(opts.waitTimeout, 10);
    const waitForTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : 5000;

    const kickoff = await post<{ data: { evalJobId: string } }>('/tools/browser/eval', {
      url, expr, waitMs,
      waitForSelector: opts.waitFor || undefined,
      waitForTimeoutMs: opts.waitFor ? waitForTimeoutMs : undefined,
    });
    const d = await pollEvalResult(kickoff.data.evalJobId, waitMs);

    const execTimeout = evalExecTimeoutMessage(d.result);
    if (execTimeout) throw new Error(execTimeout);

    if (opts.json) {
      console.log(JSON.stringify(d));
      return;
    }

    console.log(`${brand('Eval')} ${bold(d.url || url)}`);
    if (d.navigationIncomplete) {
      console.log(`${warning('⚠ Navigation incomplete:')} ${d.note || 'page did not reach full load'}`);
    }
    console.log(opts.file ? `${muted('Script:')} ${opts.file}` : `${muted('Expression:')} ${expr}`);
    console.log(`\n${d.result || muted('(empty result)')}`);
    if (d.truncated) console.log(muted('\n(result truncated to fit context - narrow the expression for the full value)'));
  }));

// Each `page eval` call runs to completion before the next starts, so two evals
// fired back-to-back never coexist in time - they CANNOT test whether two live
// clients see each other (presence, shared state). For that, use the genuinely-
// concurrent `page test --observe` instead, which overlaps N clients and reports
// whether they actually ran together.
pageEvalCommand.addHelpText('after', `
Examples:
  gipity page eval "https://dev.gipity.ai/me/app/" "document.title"
  # Functionally test a page's own code paths: save a script that drives the UI
  # and returns a JSON-serializable result, then run it (no /tmp + shell quoting):
  gipity page eval "https://dev.gipity.ai/me/app/" --file ./tests/draw-flow.js --json

The eval body runs under a ~20s in-page execution budget (its own await/setTimeout
pauses count; --wait only sleeps BEFORE the eval and does not extend it). For a long
interactive sequence, split it into several shorter evals (one per state to verify)
rather than one body with many long waits.

Testing realtime/shared state across clients?
  Separate 'page eval' calls run sequentially (one finishes before the next
  starts), so they never overlap and will each see only themselves - a false
  negative. Use 'gipity page test <url> --observe <expr>' for genuinely
  concurrent clients with overlap verification.`);
