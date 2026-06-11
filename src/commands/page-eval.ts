import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { post, get, ApiError } from '../api.js';
import { brand, bold, muted, warning, error as clrError } from '../colors.js';
import { run } from '../helpers/index.js';

export interface EvalResult {
  url: string;
  result: string;
  truncated: boolean;
  navigationIncomplete?: boolean;
  note?: string;
}

// Shown when an eval runs cleanly but returns nothing serializable. Turns a
// bare/opaque `null` into a deterministic, actionable nudge so the agent shapes
// a returnable value instead of guessing and retrying.
export const EVAL_NO_VALUE_HINT =
  'The eval ran but returned no JSON-serializable value. A statement body with no `return`, an assignment, a void call, or a DOM node/function all serialize to null. ' +
  'End the script with an expression — or an explicit `return` — that yields plain data, e.g. `return { label: input.value, count: items.length }` or `return JSON.stringify(payload)`.';

/** Normalize a raw eval result for display. The eval can come back as a useful
 *  serialized value, the literal `null`/`undefined`/empty string, or — when the
 *  script returns undefined — agent-browser's raw envelope leaking through
 *  (`{"success":true,"data":{"origin":…,"result":null},"error":null}`). The last
 *  two mean the same thing to the agent: no value came back. Unwrap the leaked
 *  envelope so it never reaches the agent as an opaque blob, and flag the
 *  no-value cases so the caller can attach EVAL_NO_VALUE_HINT. */
export function normalizeEvalResult(raw: string): { result: string; noValue: boolean } {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') {
    return { result: trimmed, noValue: true };
  }
  // A leaked agent-browser eval envelope (only emitted when the eval returns
  // undefined): unwrap to the inner value. Strict shape match — exact key set
  // plus a string origin — so a genuine user object never trips this.
  if (trimmed.startsWith('{') && trimmed.includes('"result"')) {
    try {
      const env = JSON.parse(trimmed);
      const isEnvelope = env && typeof env === 'object'
        && Object.keys(env).every((k) => k === 'success' || k === 'data' || k === 'error')
        && env.data && typeof env.data === 'object'
        && typeof env.data.origin === 'string' && 'result' in env.data;
      if (isEnvelope) {
        const inner = env.data.result;
        if (inner == null) return { result: 'null', noValue: true };
        return { result: typeof inner === 'string' ? inner : JSON.stringify(inner), noValue: false };
      }
    } catch { /* not the envelope — fall through and show the raw value */ }
  }
  return { result: raw, noValue: false };
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
    if (exprArg !== undefined && opts.file) {
      console.error(clrError('Pass either an inline <expr> arg or --file <path>, not both'));
      process.exit(1);
    }
    if (exprArg === undefined && !opts.file) {
      console.error(clrError('Provide an inline <expr> arg or --file <path>'));
      process.exit(1);
    }
    let expr = exprArg as string;
    if (opts.file) {
      try {
        expr = readFileSync(opts.file, 'utf8');
      } catch {
        console.error(clrError(`Cannot read file: ${opts.file}`));
        process.exit(1);
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
    const { result, noValue } = normalizeEvalResult(d.result);

    if (opts.json) {
      console.log(JSON.stringify(noValue ? { ...d, result, hint: EVAL_NO_VALUE_HINT } : { ...d, result }));
      return;
    }

    console.log(`${brand('Eval')} ${bold(d.url || url)}`);
    if (d.navigationIncomplete) {
      console.log(`${warning('⚠ Navigation incomplete:')} ${d.note || 'page did not reach full load'}`);
    }
    console.log(opts.file ? `${muted('Script:')} ${opts.file}` : `${muted('Expression:')} ${expr}`);
    console.log(`\n${result.trim() ? result : muted('(empty result)')}`);
    if (noValue) console.log(muted(`\n${EVAL_NO_VALUE_HINT}`));
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

Testing realtime/shared state across clients?
  Separate 'page eval' calls run sequentially (one finishes before the next
  starts), so they never overlap and will each see only themselves - a false
  negative. Use 'gipity page test <url> --observe <expr>' for genuinely
  concurrent clients with overlap verification.`);
