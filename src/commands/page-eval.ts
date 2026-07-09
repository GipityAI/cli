import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import { post, get, ApiError } from '../api.js';
import { brand, bold, muted, warning, success } from '../colors.js';
import { run } from '../helpers/index.js';
import { getAuth } from '../auth.js';
import { resolveProjectContext } from '../config.js';
import { uploadPublicFixture, deleteFixture, HostedFixture } from '../page-fixtures.js';

export interface EvalResult {
  url: string;
  result: string;
  truncated: boolean;
  // Result of the second expression run after an in-place reload (--reload).
  reloadResult?: string;
  reloadTruncated?: boolean;
  // Auth handoff state when --auth ran (same shape page inspect reports).
  auth?: { requested: boolean; established: boolean; detail?: string };
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

// A one-line inline expr is worth echoing back — it's the thing you're asserting
// on. A multi-line driver script is not: echoing 30 lines of the caller's own
// source above the result buries the value, and an echo that lands right before
// `(empty result)` reads like the parser choked on the script rather than like
// the script returned nothing. Collapse anything bigger than a single short line
// to its first line plus a shape summary.
const EXPR_ECHO_MAX_CHARS = 120;

export function summarizeExpr(expr: string): string {
  const lines = expr.split('\n');
  const meaningful = lines.filter((l) => l.trim() !== '');
  const oneLine = meaningful.length <= 1;
  if (oneLine && expr.trim().length <= EXPR_ECHO_MAX_CHARS) return expr.trim();

  const first = (meaningful[0] ?? '').trim();
  const head = first.length > EXPR_ECHO_MAX_CHARS ? `${first.slice(0, EXPR_ECHO_MAX_CHARS - 1)}…` : first;
  const shape = oneLine
    ? `(${expr.trim().length} chars)`
    : `(+${meaningful.length - 1} more ${meaningful.length - 1 === 1 ? 'line' : 'lines'}, ${expr.trim().length} chars)`;
  return `${head} ${shape}`;
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

// Agents instinctively reach for a flag to pass the script (`--js`, `--script`,
// `--code`, …); the JS is actually the positional <expr> (or --file for a saved
// script). Without these, commander answers `--js` with "did you mean --json?" —
// a trap, since --json is a real flag that changes output but still leaves the
// script unset, sending the agent in a loop. Capture the common guesses as
// hidden decoy options so the action can redirect to the positional arg exactly.
const JS_DECOY_FLAGS = ['--js', '--javascript', '--script', '--code', '--expr', '--eval', '--exec'];

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
  .description('Evaluate JS in a real browser on a page (DOM, computed styles, element rects; inline expr or --file script). ONE client per call - to verify realtime/presence across concurrent clients use `page test --observe` instead')
  .argument('<url>', 'URL to load')
  .argument('[expr]', 'JavaScript to evaluate in page context (inline expression or statement body with return/await; result is JSON-serialized). Omit when using --file. Time budget: the body has ~20s to finish after page load - keep driver scripts within it.')
  .option('--file <path>', 'Read the script body from a file instead of the inline <expr> arg (mutually exclusive). Runs as an async function body, so top-level return/await work. Same ~20s post-load budget as <expr>.')
  .option(
    '--fixture <path>',
    'Host a local file and expose it to the eval as `fixtureUrl` (and under `fixtures` by basename) to fetch in-page. For verifying a render/parse path against a real binary (an MP3, an image) - no size limit, auto-deleted after the run. Repeat for several files (single-value so it never swallows the inline <expr>).',
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    '--reload <expr>',
    'After the first eval, reload the page IN PLACE (localStorage/sessionStorage/cookies preserved) and evaluate this second expression against the post-reload DOM. One command verifies persisted state survives a reload: seed/assert state with <expr>, then assert the restored UI here.',
  )
  .option('--reload-file <path>', 'Read the post-reload expression from a file instead of inline --reload (mutually exclusive)')
  .option('--wait <ms>', 'Sleep this many ms after DOMContentLoaded before evaluating (lets late async work settle; max 30000)', '500')
  .option('--wait-for <selector>', 'Wait until this CSS selector appears before evaluating (deterministic; replaces --wait)')
  .option('--wait-timeout <ms>', 'Max ms to wait for --wait-for before giving up', '5000')
  .option('--auth', 'Evaluate signed in as you (your Gipity account), so a page behind a Sign-in-with-Gipity login is reachable. Only works for apps using Sign in with Gipity, hosted on *.gipity.ai.')
  .option('--json', 'Output as JSON')
  .action((url: string, exprArg: string | undefined, opts) => run('Page eval', async () => {
    // A JS-intent flag guess (captured as a hidden decoy below): redirect to the
    // positional <expr> precisely, before the inline/--file shape checks fire.
    const decoy = JS_DECOY_FLAGS.find((f) => opts[f.slice(2)] !== undefined);
    if (decoy) {
      pageEvalCommand.error(
        `error: ${decoy} is not a flag — pass the JavaScript as the positional <expr> argument ` +
        `(or --file <path> for a saved script), e.g. gipity page eval "<url>" 'document.title'`,
      );
    }
    // Arg-shape errors go through commander's error() so the enableHelpAfterError
    // hook renders this command's help inline with the one-line error LAST
    // (survives `| tail`), same as commander-detected errors like a missing url.
    if (exprArg !== undefined && opts.file) {
      pageEvalCommand.error('error: Pass either an inline <expr> arg or --file <path>, not both');
    }
    if (exprArg === undefined && !opts.file) {
      pageEvalCommand.error('error: Provide an inline <expr> arg or --file <path>');
    }
    // Catch a swapped <url>/<expr> locally: the server's bare "Invalid URL"
    // names neither the bad argument nor the expected order, so it reads like
    // the page failed to evaluate rather than like a mis-invocation.
    if (!/^https?:\/\//i.test(url)) {
      const flatUrl = url.replace(/\s+/g, ' ').trim();
      const shownUrl = flatUrl.length > 60 ? `${flatUrl.slice(0, 57)}...` : flatUrl;
      pageEvalCommand.error(
        exprArg !== undefined && /^https?:\/\//i.test(exprArg)
          ? `error: arguments are swapped — the URL is the FIRST positional: gipity page eval "${exprArg}" '<expr>'`
          : `error: <url> must be an absolute http(s) URL (got: "${shownUrl}") — usage: gipity page eval <url> [expr]`,
      );
    }
    let expr = exprArg as string;
    if (opts.file) {
      try {
        expr = readFileSync(opts.file, 'utf8');
      } catch {
        pageEvalCommand.error(`error: Cannot read file: ${opts.file}`);
      }
    }

    // Post-reload expression: inline --reload or --reload-file, same shape
    // rules as the primary <expr>/--file pair.
    if (opts.reload !== undefined && opts.reloadFile) {
      pageEvalCommand.error('error: Pass either --reload <expr> or --reload-file <path>, not both');
    }
    let reloadExpr: string | undefined = opts.reload;
    if (opts.reloadFile) {
      try {
        reloadExpr = readFileSync(opts.reloadFile, 'utf8');
      } catch {
        pageEvalCommand.error(`error: Cannot read file: ${opts.reloadFile}`);
      }
    }

    const waitMs = capWaitMs(opts.wait, url);
    const parsedTimeout = parseInt(opts.waitTimeout, 10);
    const waitForTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : 5000;

    // --fixture: host each file publicly, then splice `fixtures` / `fixtureUrl`
    // into the eval scope so the page can fetch the bytes. The prelude makes the
    // body a statement (const/return), so the server's expression form fails to
    // parse and it falls back to the function-body form - which runs both inline
    // exprs (wrapped in `return (...)`) and --file scripts. Cleanup in `finally`.
    const fixturePaths: string[] = opts.fixture ?? [];
    const hosted: HostedFixture[] = [];
    let projectGuid: string | undefined;
    let sentExpr = expr;
    try {
      if (fixturePaths.length) {
        const { config } = await resolveProjectContext({});
        projectGuid = config.projectGuid;
        for (const p of fixturePaths) {
          console.log(muted(`Hosting fixture ${p}…`));
          hosted.push(await uploadPublicFixture(projectGuid!, p));
        }
        const map: Record<string, string> = {};
        for (const h of hosted) map[h.name] = h.url;
        const prelude = `const fixtures=${JSON.stringify(map)};const fixtureUrl=${JSON.stringify(hosted[0].url)};`;
        sentExpr = opts.file ? `${prelude}\n${expr}` : `${prelude}\nreturn (${expr});`;
      }

      const kickoff = await post<{ data: { evalJobId: string } }>('/tools/browser/eval', {
        url, expr: sentExpr, waitMs,
        reloadExpr,
        waitForSelector: opts.waitFor || undefined,
        waitForTimeoutMs: opts.waitFor ? waitForTimeoutMs : undefined,
        auth: opts.auth || undefined,
      });
      // The reload leg re-runs the settle before its eval — budget for both.
      const d = await pollEvalResult(kickoff.data.evalJobId, reloadExpr !== undefined ? waitMs * 2 : waitMs);
      const { result, noValue } = normalizeEvalResult(d.result);
      const reload = d.reloadResult !== undefined ? normalizeEvalResult(d.reloadResult) : undefined;

      const execTimeout = evalExecTimeoutMessage(d.result);
      if (execTimeout) throw new Error(execTimeout);

      if (opts.json) {
        console.log(JSON.stringify({
          ...d, result,
          ...(reload ? { reloadResult: reload.result } : {}),
          ...(noValue ? { hint: EVAL_NO_VALUE_HINT } : {}),
        }));
        return;
      }

      console.log(`${brand('Eval')} ${bold(d.url || url)}`);
      if (d.navigationIncomplete) {
        console.log(`${warning('⚠ Navigation incomplete:')} ${d.note || 'page did not reach full load'}`);
      }
      // Auth state: without this line an agent can't distinguish "signed-in
      // eval" from "--auth silently no-op'd against the anonymous page".
      if (d.auth?.requested) {
        const who = getAuth()?.email;
        console.log(d.auth.established
          ? `${muted('Auth:')} ${success('session established')}${who ? muted(` as ${who}`) : ''} ${muted('(what the page renders with it is app-defined)')}`
          : `${warning('Auth: session NOT established')}${d.auth.detail ? ` — ${d.auth.detail}` : ''} ${muted('(this is the anonymous view)')}`);
      }
      if (hosted.length) console.log(`${muted('Fixtures:')} ${hosted.map((h) => h.name).join(', ')}`);
      console.log(opts.file ? `${muted('Script:')} ${opts.file}` : `${muted('Expression:')} ${summarizeExpr(expr)}`);
      console.log(`\n${result.trim() ? result : muted('(empty result)')}`);
      if (noValue) console.log(muted(`\n${EVAL_NO_VALUE_HINT}`));
      if (d.truncated) console.log(muted('\n(result truncated to fit context - narrow the expression for the full value)'));
      if (reload) {
        console.log(`\n${bold('After reload')} ${muted('(page reloaded in place — storage preserved)')}`);
        console.log(reload.result.trim() ? reload.result : muted('(empty result)'));
        if (reload.noValue) console.log(muted(EVAL_NO_VALUE_HINT));
        if (d.reloadTruncated) console.log(muted('(reload result truncated to fit context - narrow the expression for the full value)'));
      }
    } finally {
      for (const h of hosted) {
        try {
          await deleteFixture(projectGuid!, h.guid);
        } catch (err) {
          console.error(warning(`⚠ Could not auto-delete fixture "${h.name}" (${h.guid}) — still hosted at ${h.url}: ${(err as Error).message}`));
        }
      }
    }
  }));

// Register the JS-intent flag guesses as hidden decoys (take a value so they
// swallow the script the agent passed) — the action turns any of them into the
// precise "JS is the positional arg" redirect above.
for (const f of JS_DECOY_FLAGS) pageEvalCommand.addOption(new Option(`${f} <value>`).hideHelp());

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
  # Verify a render/parse path against a REAL file: --fixture hosts it, injects a
  # fetch-able 'fixtureUrl', runs the eval, then deletes the hosted copy:
  gipity page eval "https://dev.gipity.ai/me/app/" --fixture ./sample.mp3 \\
    "(async()=>{ const b = await fetch(fixtureUrl).then(r=>r.arrayBuffer()); return window.App.parseId3(b); })()"
  # Verify persisted state survives a reload (localStorage/sessionStorage kept):
  # run <expr>, reload the page in place, then run the --reload expression:
  gipity page eval "https://dev.gipity.ai/me/app/" \\
    "localStorage.setItem('todo','milk'); document.title" \\
    --reload "({ restored: localStorage.getItem('todo'), heading: document.querySelector('h1')?.textContent })"

Module resolution: dynamic import() specifiers starting with ./ or ../ resolve
against the PAGE URL, so import('./packages/i18n/index.js') loads the app's own
module without hand-building the deployed /account/project/ path. Absolute paths
and full URLs pass through unchanged.

The eval body runs under a ~20s in-page execution budget (its own await/setTimeout
pauses count; --wait only sleeps BEFORE the eval and does not extend it). For a long
interactive sequence, split it into several shorter evals (one per state to verify)
rather than one body with many long waits.

Testing realtime/shared state across clients?
  Separate 'page eval' calls run sequentially (one finishes before the next
  starts), so they never overlap and will each see only themselves - a false
  negative. Use 'gipity page test <url> --observe <expr>' for genuinely
  concurrent clients with overlap verification.`);
