import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import { post, get, ApiError } from '../api.js';
import { brand, bold, muted, warning, success } from '../colors.js';
import { run, parseDuration } from '../helpers/index.js';
import { getAuth } from '../auth.js';
import { resolveProjectContext } from '../config.js';
import { createCheckpoint, restoreCheckpoint, resolveDatabase } from '../db-checkpoint.js';
import { uploadPublicFixture, uploadCameraFeed, assertCameraFile, deleteFixture, HostedFixture } from '../page-fixtures.js';

export interface EvalResult {
  url: string;
  result: string;
  truncated: boolean;
  // Results of --step expressions, in order, each run against the SAME page load.
  stepResults?: string[];
  // Result of the second expression run after an in-place reload (--reload).
  reloadResult?: string;
  reloadTruncated?: boolean;
  // Auth handoff state when --auth ran (same shape page inspect reports).
  auth?: { requested: boolean; established: boolean; detail?: string };
  navigationIncomplete?: boolean;
  note?: string;
  // Present only when the page painted below the server's slow-render
  // threshold, which makes wall-clock waits under-advance its rAF-driven clock.
  slowRender?: { fps: number };
}

// Shown when an eval runs cleanly but returns nothing serializable. Turns a
// bare/opaque `null` into a deterministic, actionable nudge so the agent shapes
// a returnable value instead of guessing and retrying. (A body ending in a bare
// expression is auto-returned SERVER-side before this can fire — so this is the
// residue: block/loop endings, explicit undefined returns, DOM nodes, functions.)
export const EVAL_NO_VALUE_HINT =
  'The eval ran but returned no JSON-serializable value. A body ending in a loop/if-block, a `return` of undefined, or a DOM node/function all serialize to null. ' +
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

// Shown when a run returns a structurally empty value ({}, [], or an object whose
// every field is null/''). That is NOT the same as "no value": the script ran and
// read the page — it just read it at an instant where the state it wanted did not
// exist. A fixed --wait samples ONE moment, and transient state (a round result,
// a toast, a frame's detection) may have already been cleared by then, so the run
// looks like a pass and the agent has to reason its way to "I sampled too late".
export const EVAL_EMPTY_STATE_HINT =
  'The eval returned an empty value — the script ran, but the state it read was not there at that instant. ' +
  'A fixed --wait samples ONE moment; transient state (a round result, a toast, a detection) can be gone by then. ' +
  'Poll INSIDE the body and return the moment the condition holds (raise --timeout if the sequence needs longer), ' +
  "or gate the read on the app's own signal with --wait-for '<selector>'.";

// The one-run experiment that separates "the frame is unreadable" from "the app
// never routes frames to the model" — the ambiguity that otherwise costs a
// re-generate-and-re-run cycle per candidate image. Named once, reused by every
// camera-run message below so the caller is told the same thing wherever it
// notices something is off.
const CAMERA_FRAME_CHECK =
  "in the eval body, run the model on the frame YOURSELF (grab the app's <video> element, or the app's own "
  + "detector on it) and return its RAW output alongside the app's state. Model saw nothing => the frame is at fault: "
  + 'regenerate it (subject filling the frame, plain background, even light), do not re-run the same one. '
  + "Model saw it but the app's state is empty => the bug is in the app's wiring, not the picture.";

// A camera run that comes back empty must NOT be sent down the generic
// "raise --timeout and poll harder" path below: on a looped still frame that is
// a guaranteed-identical re-run, and that escalation (60s, then 70s, then 80s)
// is the single most expensive way a vision app gets verified. Give it the
// verdict and the disambiguating experiment instead.
export const EVAL_CAMERA_EMPTY_HINT =
  'The eval returned an empty value on a --camera run. --camera loops ONE still image, and the model is deterministic '
  + 'on it, so a longer --wait/--timeout re-runs the identical inference and returns the identical nothing — do not escalate. '
  + `Two suspects: the frame, or the app's wiring. Tell them apart in one run: ${CAMERA_FRAME_CHECK} `
  + "(If the app only starts its pipeline on a click, a headless run never clicks — start it on load and gate this eval on "
  + "the app's own ready signal with --wait-for '<selector>'.)";

/** True when the eval came back with a structurally empty container: `{}`, `[]`,
 *  or an object whose every value is null/undefined/''. Exported for tests. */
export function isEmptyStateResult(result: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) return parsed.length === 0;
  if (!parsed || typeof parsed !== 'object') return false;
  const values = Object.values(parsed as Record<string, unknown>);
  return values.every((v) => v === null || v === undefined || v === '');
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
  const head = first.length > EXPR_ECHO_MAX_CHARS ? `${first.slice(0, EXPR_ECHO_MAX_CHARS - 3)}...` : first;
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

// How many --step expressions may ride on one page load (mirrors the server's
// MAX_EVAL_STEPS). Past this, the run is really two verifications.
export const MAX_EVAL_STEPS = 4;

// Ceiling the server accepts for the --wait-for gate (its WAIT_FOR_MAX_MS).
export const WAIT_FOR_MAX_MS = 30_000;

/** Parse --wait-timeout, clamping to the gate's server-side ceiling. Over the cap
 *  the server answers with a zod 400 that names neither the flag nor the limit, so
 *  clamp and say so on stderr (--json stdout stays clean). Exported for tests. */
export function capWaitForTimeoutMs(raw: string): number {
  const parsed = parseInt(raw, 10);
  const ms = Number.isFinite(parsed) && parsed >= 0 ? parsed : 5_000;
  if (ms <= WAIT_FOR_MAX_MS) return ms;
  console.error(warning(
    `--wait-timeout ${ms}ms exceeds the ${WAIT_FOR_MAX_MS}ms cap on the selector gate — using ${WAIT_FOR_MAX_MS}ms. ` +
    `A state that takes longer than that to appear is not a settling delay: have the page reach it on load, ` +
    `or watch for it INSIDE the script (--timeout ${EVAL_SCRIPT_BUDGET_MAX_MS}).`,
  ));
  return WAIT_FOR_MAX_MS;
}

/** Read a --file/--reload-file script. `-` means stdin, so an agent can pipe a
 *  heredoc straight in — `gipity page eval <url> --file - <<'EOF' … EOF` — with
 *  no throwaway tmp file to write and then clean up. readFileSync(0) drains fd 0
 *  (stdin) to EOF. Any other value is a path on disk. */
export function readScriptFile(pathArg: string): string {
  return readFileSync(pathArg === '-' ? 0 : pathArg, 'utf8');
}

/** True when `s` is an expression (`document.title`, an IIFE) rather than a
 *  statement body (`const x = …; return x`). Mirrors the server's own parse
 *  choice: only an expression may be spliced into `return (…)`. Nothing is
 *  executed — Function() parses and throws on a statement body. */
export function parsesAsExpression(s: string): boolean {
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${s}\n);`);
    return true;
  } catch {
    return false;
  }
}

/** Prepend a prelude (fixture bindings, a post-gate settle) to a caller script.
 *  A prelude makes the whole thing a statement body, so an expression script has
 *  to become `return (expr)` — a statement-body script is spliced as-is. */
export function withPrelude(script: string, prelude: string): string {
  if (!prelude) return script;
  return parsesAsExpression(script)
    ? `${prelude}\nreturn (${script});`
    : `${prelude}\n${script}`;
}

// A camera app's first useful frame is never 500ms away: getUserMedia has to
// come up, then the vision pipeline downloads and initializes its model (WASM +
// weights) before it can label anything. Evaluating at the default --wait always
// reads an empty/"loading" DOM, and pushing that warm-up into the eval body
// instead blows the in-page execution budget. So --camera raises the pre-eval
// window (which is NOT on the eval's clock) to something a model load fits in.
export const CAMERA_DEFAULT_WAIT_MS = 15_000;

// Playing a real frame into the browser's webcam costs the server real time
// before the page is even navigated: it fetches the hosted feed and encodes it
// into the synthetic capture device. That is server-side setup the caller cannot
// shorten, so it has to be inside the client's patience — otherwise the CLI
// abandons a job that was always going to take this long.
const CAMERA_SETUP_BUDGET_MS = 30_000;

// How long the script may run INSIDE the page. The server enforces this (it is
// the `timeoutMs` on the eval request) and picks the roomier default on a
// synthetic-media run, where a WASM/model download IS the wait. These mirror the
// server's EVAL_SCRIPT_BUDGET_* constants; --timeout names any value up to MAX.
export const EVAL_SCRIPT_BUDGET_MS = 30_000;
export const EVAL_SCRIPT_BUDGET_CAMERA_MS = 45_000;
export const EVAL_SCRIPT_BUDGET_MAX_MS = 90_000;
// The smallest in-page budget the server will honour. A --timeout below this is
// floored to it, so any sub-floor value is useless as a real ms budget AND is
// almost always seconds typed as ms (--timeout 120 meaning 120s) — the guard in
// the action rejects it up front with the unit named, rather than letting it
// silently floor and then stall with an opaque "1s budget" error.
export const EVAL_SCRIPT_BUDGET_MIN_MS = 1_000;

/** The in-page budget this call gets: the caller's --timeout when given, else the
 *  default for the kind of run (roomier under --camera/--fake-media). Clamped to
 *  the server's accepted range — a value over the max is clamped and explained on
 *  stderr rather than bounced back as an opaque 400. Exported for tests. */
export function capScriptBudgetMs(rawTimeout: string | undefined, hasMedia: boolean): number {
  const fallback = hasMedia ? EVAL_SCRIPT_BUDGET_CAMERA_MS : EVAL_SCRIPT_BUDGET_MS;
  if (rawTimeout === undefined) return fallback;
  const parsed = parseInt(rawTimeout, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (parsed > EVAL_SCRIPT_BUDGET_MAX_MS) {
    console.error(warning(
      `--timeout ${parsed}ms exceeds the ${EVAL_SCRIPT_BUDGET_MAX_MS}ms max in-page budget — using ${EVAL_SCRIPT_BUDGET_MAX_MS}ms. ` +
      `A body that needs longer than that is doing its waiting in the wrong place: start the slow work on page load and ` +
      `absorb it in the pre-eval window (--wait-for '<ready-selector>'), keeping the body to a quick read.`,
    ));
    return EVAL_SCRIPT_BUDGET_MAX_MS;
  }
  return Math.max(EVAL_SCRIPT_BUDGET_MIN_MS, parsed);
}

/** Upper bound on the server-side work this eval asked for. EVERY leg the caller
 *  can lengthen has to be in here, or the client gives up on a job that is still
 *  legitimately running and reports it as the caller's fault:
 *    - the pre-eval window (--wait, and --wait-for's own timeout)
 *    - every script leg (<expr> plus each --step), each allowed its full in-page
 *      budget (--timeout) — they share ONE page load but not one clock
 *    - the reload leg, which repeats settle + eval
 *    - --camera's feed fetch/encode, paid before the page loads
 *  Browser cold-start/open overhead is NOT here; it's the flat headroom in
 *  pollEvalResult. Exported for tests. */
export function evalWorkBudgetMs(o: {
  waitMs: number;
  waitForTimeoutMs?: number;
  hasReload?: boolean;
  hasCamera?: boolean;
  scriptBudgetMs?: number;
  legs?: number;
}): number {
  const script = o.scriptBudgetMs ?? (o.hasCamera ? EVAL_SCRIPT_BUDGET_CAMERA_MS : EVAL_SCRIPT_BUDGET_MS);
  const legs = Math.max(1, o.legs ?? 1);
  const settle = o.waitMs + (o.waitForTimeoutMs ?? 0);
  const firstPass = settle + script * legs;
  return firstPass + (o.hasReload ? settle + script : 0) + (o.hasCamera ? CAMERA_SETUP_BUDGET_MS : 0);
}

/** The server refuses a script that outran its in-page budget with a message that
 *  names the budget and says to "raise the eval timeout" — but not the flag that
 *  does it. Name it, with the value this run actually used, so the fix is one
 *  edit away instead of a guess (or a trip through --help). */
export function budgetOverrunHint(reason: string, usedBudgetMs: number): string | null {
  if (!/in-page budget/i.test(reason)) return null;
  if (usedBudgetMs >= EVAL_SCRIPT_BUDGET_MAX_MS) {
    return `This run already used the maximum in-page budget (--timeout ${EVAL_SCRIPT_BUDGET_MAX_MS}). ` +
      `More time is not the answer: have the page start its slow work on load, wait it out in the pre-eval window ` +
      `(--wait-for '<ready-selector>' --wait-timeout ${MAX_WAIT_MS}), and keep the body to a quick read.`;
  }
  return `That budget was ${Math.round(usedBudgetMs / 1000)}s. Raise it with --timeout <ms> ` +
    `(up to ${EVAL_SCRIPT_BUDGET_MAX_MS}), e.g. --timeout ${EVAL_SCRIPT_BUDGET_MAX_MS} — ` +
    `or gate on a ready signal instead: --wait-for '<selector>' --wait-timeout ${MAX_WAIT_MS}.`;
}

/** The server aborts a script whose page navigated out from under it, and tells
 *  the caller to "split the check into two evals". For the case that actually
 *  produces this (seed state, reload, assert the state came back), that advice
 *  sends the caller down the wrong road: two evals are two independent page
 *  sessions, so the second one has to re-seed before it can read anything, and
 *  the thing being verified (a real reload restoring real persisted state) is
 *  never exercised. `--reload` is the primitive for it: one page load, reloaded
 *  IN PLACE with storage preserved, second expression against the post-reload
 *  DOM. Name it here, at the exact moment the caller hand-rolled it. */
export function navigationAbortHint(reason: string): string | null {
  if (!/navigated or reloaded/i.test(reason)) return null;
  return `If you were verifying that state SURVIVES a reload, that is what --reload is for (one command, one page): ` +
    `gipity page eval "<url>" '<seed/assert expr>' --reload '<assert-restored expr>'. ` +
    `It reloads the page in place (localStorage/sessionStorage/cookies preserved) and reports the second result ` +
    `separately. Splitting into two 'page eval' calls does NOT do this: each call is its own browser session, so ` +
    `the second one starts from empty storage and never exercises the restore path.`;
}

/** True when the submitted script already drives the app's clock itself
 *  (`core.advance(seconds)` on the 3D templates, the imported `advance(seconds)`
 *  on the 2D one). Such a script does not care what the renderer paints at, so
 *  the slow-render warning below has nothing to tell it. Exported for tests. */
export function stepsDeterministically(script: string): boolean {
  return /\badvance\s*\(/.test(script);
}

/** The headless browser paints slowly, and what that MEANS depends on what the
 *  page is doing — so the one-size warning was actively misleading on a --camera
 *  run. A vision app has no loop to step: its pipeline is driven by camera
 *  frames, one inference per painted frame.
 *
 *  The trap this message exists to close: a slow-render warning next to a "no
 *  detection" result reads as "the renderer starved you", so the caller re-runs
 *  with a bigger --wait/--timeout, several times, and gets the identical answer
 *  each time. It cannot be otherwise. A --camera still is played as a LOOPED
 *  feed — every painted frame is the same pixels — and a vision model is
 *  deterministic on the same pixels. Frame count therefore buys attempts, not
 *  information: once the model has run once, more time cannot change the verdict.
 *  So this says so, and names the two real suspects (the frame, the app) plus the
 *  deterministic way to wait (--wait-for) instead of inviting a wall-clock
 *  escalation that is guaranteed to be wasted. Exported for tests. */
export function slowRenderMessage(fps: number, o: { camera: boolean; waitMs: number; script?: string }): string | null {
  if (!o.camera && stepsDeterministically(o.script ?? '')) return null;
  if (o.camera) {
    const frames = Math.max(1, Math.round(fps * (o.waitMs / 1000)));
    return `${warning('⚠ Slow render:')} page painted at ${fps} fps, so the app's vision pipeline ran on roughly `
      + `${bold(`${frames} frame${frames === 1 ? '' : 's'}`)} during the ${Math.round(o.waitMs / 1000)}s before this eval `
      + `(it infers once per painted frame). ${bold('That is enough:')} --camera loops your still image, so every one of `
      + `those frames is the SAME pixels and the model returns the SAME answer on each — re-running with a bigger `
      + `--wait/--timeout cannot change the result. ${bold('Do not escalate the wait.')} If a detection landed, it is real. `
      + `If nothing was detected, the suspect is the ${bold('frame')} (a model needs the whole subject in shot — a tight crop, `
      + `an odd angle or a busy background reads as nothing) or the ${bold('app')} (frames never reach the model) — never the frame rate. `
      + `Settle it in ONE run: ${CAMERA_FRAME_CHECK}`;
  }
  return `${warning('⚠ Slow render:')} page painted at ${fps} fps. `
    + `Waiting on real time (setTimeout) advances animation/physics time far slower than it looks — `
    + `assertions after a wall-clock wait can report a false negative. `
    + `Step the app's own loop deterministically instead (3D templates: ${bold('core.advance(seconds)')}; `
    + `2D/Phaser template: ${bold("(await import('./js/config.js')).advance(seconds)")}).`;
}

/** Poll the async eval job until it finishes. Eval runs server-side as a
 *  short-lived job (so a long --wait can't trip the gateway idle timeout);
 *  we submit, then poll the result out of the job store. `expectedWorkMs` is
 *  the time the server-side work is expected to take (see evalWorkBudgetMs);
 *  the client budget is that plus 60s of headroom for browser open/cold start. */
export async function pollEvalResult(evalJobId: string, expectedWorkMs: number): Promise<EvalResult> {
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
  // This is the CLIENT giving up, not the page failing — and the budget above
  // already covers everything the caller asked for, so "your expression is too
  // big" is the one thing it is NOT. Never advise lowering --wait: on a camera /
  // vision run the wait is what lets the model load, so that "fix" swaps a
  // timeout for a silently empty read, which is worse.
  throw new ApiError(
    504,
    'EVAL_TIMEOUT',
    `the browser did not report back within ${Math.round((expectedWorkMs + 60_000) / 1000)}s — that budget already ` +
    `covers --wait, --wait-for, the eval body and any --camera setup, so this is the browser itself being slow or ` +
    `stuck (a cold sandbox, a heavy page), not your expression being too big. Lowering --wait does NOT help and on ` +
    `a --camera run actively hurts (the wait is what lets the vision model load — cut it and the eval reads an ` +
    `empty page instead). Just run the same command again: the sandbox is warm on the second hit.`,
  );
}

/** When the script's own runtime overruns the in-page budget, agent-browser can
 *  abort the `Runtime.evaluate` CDP call and the failure comes back as a
 *  `{success:false, error:"CDP command timed out: Runtime.evaluate"}` envelope
 *  that the server surfaces verbatim as the eval `result` — opaque to the caller
 *  (no budget named, no flag to raise it). Detect exactly that envelope and
 *  return an actionable message; null otherwise. */
export function evalExecTimeoutMessage(result: string, budgetMs: number): string | null {
  let parsed: { success?: unknown; error?: unknown };
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!parsed || parsed.success !== false || typeof parsed.error !== 'string') return null;
  if (!/CDP command timed out:\s*Runtime\.evaluate/i.test(parsed.error)) return null;
  const budget = Math.round(budgetMs / 1000);
  return (
    `the script hit its ${budget}s in-page budget — the body (including its own await/setTimeout ` +
    `pauses) ran longer than that. --wait sleeps BEFORE the script and does not extend it.\n` +
    (budgetOverrunHint('in-page budget', budgetMs) ?? '') + '\n' +
    `If the slow part is a ONE-TIME page init (a WASM/model download, a big asset, a first-frame ` +
    `pipeline warm-up), do NOT split the body across several 'page eval' calls — every call is a fresh ` +
    `page load that re-pays that init, so each one hits this same wall. Have the page kick it off on ` +
    `load (not behind a click) and absorb it in the pre-eval window instead.`
  );
}

// Agents instinctively reach for a flag to pass the script (`--js`, `--script`,
// `--code`, …); the JS is actually the positional <expr> (or --file for a saved
// script). Without these, commander answers `--js` with "did you mean --json?" —
// a trap, since --json is a real flag that changes output but still leaves the
// script unset, sending the agent in a loop. Capture the common guesses as
// hidden decoy options so the action can redirect to the positional arg exactly.
// `--action` rides along: it's the sibling `page screenshot`'s spelling of
// "run JS on the page", so an agent that learned it there guesses it here.
const JS_DECOY_FLAGS = ['--js', '--javascript', '--script', '--code', '--expr', '--eval', '--exec', '--action'];

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
  .argument('[expr]', `JavaScript to evaluate in page context (inline expression or statement body; await works, and the trailing expression is returned automatically — REPL-style — so no explicit return is needed; result is JSON-serialized). Omit when using --file. Time budget: the body has ${EVAL_SCRIPT_BUDGET_MS / 1000}s to finish after page load (${EVAL_SCRIPT_BUDGET_CAMERA_MS / 1000}s with --camera) - raise it with --timeout, max ${EVAL_SCRIPT_BUDGET_MAX_MS / 1000}s.`)
  .option('--file <path>', `Read the script body from a file instead of the inline <expr> arg (mutually exclusive), or --file - to read it from stdin (pipe a heredoc: --file - <<'EOF' ... EOF) with no tmp file. Runs as an async function body, so top-level return/await work. Same post-load budget as <expr> (--timeout).`)
  .option(
    '--step <expr>',
    `Run another expression against the SAME loaded page, after <expr> (repeat, max ${MAX_EVAL_STEPS}). Whatever that page load paid for — a vision model coming up, a game booting, a socket connecting — stays up for every step, so an N-part check costs ONE page load instead of N. Each step gets its own in-page budget and its own reported result.`,
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    '--fixture <path>',
    'Host a local file and expose it to the eval as `fixtureUrl` (and under `fixtures` by basename) to fetch in-page. For verifying a render/parse path against a real binary (an MP3, an image) - no size limit, auto-deleted after the run. The hosted URL has permissive CORS, so `new Image(); img.crossOrigin="anonymous"; img.src=fixtureUrl` decodes untainted for a canvas/pixel read - this is the UPLOAD analog of --camera: feed a known photo/video to a file-upload vision app (web-vision-detect) and run its detector, no need to deploy a throwaway test asset into the app. Repeat for several files (single-value so it never swallows the inline <expr>).',
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    '--reload <expr>',
    'After the first eval, reload the page IN PLACE (localStorage/sessionStorage/cookies preserved) and evaluate this second expression against the post-reload DOM. One command verifies persisted state survives a reload ("remember it when I come back"): seed/assert state with <expr>, then assert the restored UI here. This is the ONLY way to check that - reloading inside the body aborts the eval (the result is lost with the old page), and two separate `page eval` calls are two fresh browser profiles, so the second starts from empty storage.',
  )
  .option('--reload-file <path>', 'Read the post-reload expression from a file instead of inline --reload (mutually exclusive)')
  .option(
    '--camera <path>',
    `Play a local image or video (.png/.jpg/.webp/.mp4/.webm/.y4m/.mjpeg) as the browser's WEBCAM feed, so a camera app's real pipeline (getUserMedia → MediaPipe/YOLOX → your app logic) runs headlessly on a frame you choose. Implies --fake-media and waits ${CAMERA_DEFAULT_WAIT_MS / 1000}s for the vision model to load. No frame handy? gipity generate image "a hand making a closed fist, palm to camera".`,
  )
  .option('--fake-media', 'Grant a synthetic microphone + camera and auto-accept the getUserMedia prompt, so a voice/camera app runs headlessly instead of hitting its no-camera path. The feed is a built-in test pattern (and a tone) — nothing a vision model can recognize; to drive a vision app use --camera <path> instead.')
  .option('--wait <ms>', 'Sleep this many ms after DOMContentLoaded before evaluating (lets late async work settle; max 30000). With --wait-for, it elapses AFTER the selector appears - gate, then settle.', '500')
  .option('--wait-for <selector>', `Wait until this CSS selector appears before evaluating, then evaluate (deterministic - beats guessing a --wait). Gate on the state you are ASSERTING, not just a ready flag: '#verdict:not(:empty)' returns the instant the round lands, where a fixed wait snapshots mid-sequence. Same flag on page inspect/screenshot. Max ${WAIT_FOR_MAX_MS}ms (--wait-timeout).`)
  .option('--wait-timeout <ms>', `Max ms to wait for --wait-for before giving up (max ${WAIT_FOR_MAX_MS})`, '5000')
  .option(
    '--timeout <ms>',
    `How long the script itself may run IN the page. Bare number = MILLISECONDS (so 90s = 90000, NOT 90); or pass an explicit unit that means the same on both this and \`sandbox run --timeout\` — --timeout 90s. Its own await/setTimeout pauses count (default ${EVAL_SCRIPT_BUDGET_MS}, ${EVAL_SCRIPT_BUDGET_CAMERA_MS} with --camera/--fake-media; floor 1000 - a bare number under it is rejected as a unit mix-up, a suffixed one just floors; max ${EVAL_SCRIPT_BUDGET_MAX_MS}). Raise it to trace a sequence that unfolds over time (a game round, an animation). Distinct from --wait, which only sleeps BEFORE the script.`,
  )
  .option('--auth', 'Evaluate signed in as you (your Gipity account), so a page behind a Sign-in-with-Gipity login is reachable. Only works for apps using Sign in with Gipity, hosted on *.gipity.ai. Without this flag the page loads as a genuinely anonymous, signed-out visitor — nothing carries over from earlier --auth runs.')
  .option('--restore-db', "Snapshot the app database before the script runs and roll it back after, so a write-path check (click Approve, submit the form, edit a row) leaves the real data untouched. Use this whenever the eval WRITES - it is the undo for driving the deployed app against real project data. Same snapshot/undo standalone: gipity db checkpoint / gipity db restore.")
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
        expr = readScriptFile(opts.file);
      } catch {
        pageEvalCommand.error(opts.file === '-'
          ? 'error: --file - reads the script from stdin, but stdin was empty/unreadable - pipe it in, e.g. gipity page eval "<url>" --file - <<\'EOF\' ... EOF'
          : `error: Cannot read file: ${opts.file}`);
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
        reloadExpr = readScriptFile(opts.reloadFile);
      } catch {
        pageEvalCommand.error(`error: Cannot read file: ${opts.reloadFile}`);
      }
    }

    const steps: string[] = opts.step ?? [];
    if (steps.length > MAX_EVAL_STEPS) {
      pageEvalCommand.error(
        `error: at most ${MAX_EVAL_STEPS} --step expressions ride on one page load (got ${steps.length}) — ` +
        `do more per step, or split this into two evals`,
      );
    }

    // --timeout is native MILLISECONDS here but native SECONDS on the sibling
    // `sandbox run --timeout`. An explicit unit suffix reconciles them: `--timeout
    // 90s` means 90 seconds on BOTH commands. A suffixed value is normalized to ms
    // up front, so the rest of this action (and the bare-number guard below) sees a
    // plain ms number and the portable form just works.
    let timeoutHadSuffix = false;
    if (opts.timeout !== undefined) {
      const dur = parseDuration(opts.timeout, 'ms');
      if (dur?.hadSuffix) {
        opts.timeout = String(Math.round(dur.value));
        timeoutHadSuffix = true;
      }
    }
    // A BARE number below the in-page floor is the unit-mixup tell: a real ms
    // budget that small is useless (it just floors to the minimum), so a sub-floor
    // bare number is almost always seconds typed as ms (--timeout 90 meaning 90s).
    // Left alone it clamps SILENTLY to a ~1s budget and the script then stalls with
    // an opaque "1s budget" error that never reveals the unit mix-up. Reject it up
    // front, naming the unit AND the portable suffix form, so the fix is one obvious
    // edit instead of a doomed run.
    //
    // A SUFFIXED value is exempt: `--timeout 400ms` states the unit, so there is no
    // mix-up left to name. Sent through the guard it drew the one answer that is
    // certainly wrong for that caller - "pass --timeout 400s", a 400x jump they
    // never asked for. Let it floor in capScriptBudgetMs like any other small value.
    if (opts.timeout !== undefined && !timeoutHadSuffix) {
      const t = parseInt(opts.timeout, 10);
      if (Number.isFinite(t) && t > 0 && t < EVAL_SCRIPT_BUDGET_MIN_MS) {
        const overMax = t * 1000 > EVAL_SCRIPT_BUDGET_MAX_MS;
        const asMs = Math.min(t * 1000, EVAL_SCRIPT_BUDGET_MAX_MS);
        // A value-mixup, not an arg-SHAPE error: the message below already carries
        // the complete fix (pass `--timeout ${t}s`), so this does NOT go through
        // pageEvalCommand.error() — that dumps the whole options list bracketing
        // the message, and an agent piping the output through `| tail` reads the
        // option list as "it rejected me with help" and misses the one-line fix.
        // Throw instead: `run()` prints just the targeted message, nothing else.
        throw new Error(
          `--timeout is in MILLISECONDS (got ${t}, under the ${EVAL_SCRIPT_BUDGET_MIN_MS}ms in-page floor). ` +
          `Unlike \`sandbox run --timeout\` (seconds), page eval's is ms — or pass an explicit unit that means the ` +
          `same on both: --timeout ${t}s. ${t} looks like seconds, so for ${t} second${t === 1 ? '' : 's'} pass ` +
          `--timeout ${t}s (= ${asMs}ms)` +
          `${overMax ? ` (${t}s is over the ${EVAL_SCRIPT_BUDGET_MAX_MS / 1000}s max, so this is the ceiling)` : ''}.`,
        );
      }
    }

    let waitMs = capWaitMs(opts.wait, url);
    const waitForTimeoutMs = capWaitForTimeoutMs(opts.waitTimeout);

    // The in-page budget for the script itself. Always sent, so the caller (and
    // every error message below) is talking about one known number rather than a
    // server-side default nobody can see.
    const hasMedia = !!opts.camera || !!opts.fakeMedia;
    const scriptBudgetMs = capScriptBudgetMs(opts.timeout, hasMedia);

    // Camera runs get a model-load-sized pre-eval window unless the caller chose
    // their own wait (either flag). Doing this by default is the whole point: the
    // eval body must not be where a vision app's warm-up happens.
    const explicitWait = pageEvalCommand.getOptionValueSource('wait') !== 'default';
    const chosenWait = explicitWait || !!opts.waitFor;
    if (opts.camera && !chosenWait) {
      waitMs = CAMERA_DEFAULT_WAIT_MS;
      console.error(muted(
        `--camera: waiting ${CAMERA_DEFAULT_WAIT_MS / 1000}s before the eval so the camera and the app's ` +
        `vision model finish loading (they cannot warm up inside the eval body — that has a ` +
        `${scriptBudgetMs / 1000}s budget of its own, --timeout to change it). Override with --wait <ms>, or use ` +
        `--wait-for '<ready-selector>' to stop as soon as the app is ready.`,
      ));
    }

    // The selector gate REPLACES the blind pre-eval sleep server-side, so a
    // --wait passed alongside it was silently dropped: the script ran the instant
    // the selector appeared and read a half-finished sequence (a round still
    // counting down), which looks exactly like an app bug. Honour both, in the
    // only order that means anything — gate, THEN settle — by moving the sleep to
    // the head of the first script and paying for it out of that script's budget.
    const settleAfterGateMs = opts.waitFor && explicitWait ? waitMs : 0;
    const sentWaitMs = settleAfterGateMs > 0 ? 0 : waitMs;
    const sentScriptBudgetMs = Math.min(scriptBudgetMs + settleAfterGateMs, EVAL_SCRIPT_BUDGET_MAX_MS);

    // --fixture: host each file publicly, then splice `fixtures` / `fixtureUrl`
    // into the eval scope so the page can fetch the bytes. A prelude makes the
    // body a statement (const/return), so an expression script is spliced into
    // `return (...)` and a statement body is kept as-is (withPrelude). Every leg
    // (<expr> and each --step) gets the fixture bindings. Cleanup in `finally`.
    const fixturePaths: string[] = opts.fixture ?? [];
    const hosted: HostedFixture[] = [];
    // The webcam feed is hosted like a fixture but is NOT exposed to the eval
    // body as `fixtures`/`fixtureUrl` — the page never fetches it; the browser
    // plays it as the camera device. Tracked separately so it still gets
    // cleaned up, without shifting the fixture map the caller indexes into.
    let camera: HostedFixture | undefined;
    let projectGuid: string | undefined;
    // Completion-value semantics (a body ending in a bare expression returns it,
    // REPL-style) are applied SERVER-side to every leg — one source of truth for
    // every caller; the CLI sends the script as written.
    let sentExpr = expr;
    let sentSteps = steps;
    // Validate the camera file locally first: a wrong file type should cost one
    // instant error, not an upload plus an opaque browser-side failure.
    if (opts.camera) assertCameraFile(opts.camera);
    // Set when --restore-db took a checkpoint; the finally below rolls the app
    // database back to it, so a write-path smoke test leaves no residue in the
    // real data the user is about to look at.
    let restoreDb: { projectGuid: string; database: string } | undefined;
    try {
      if (opts.restoreDb) {
        const { config } = await resolveProjectContext({});
        projectGuid = config.projectGuid;
        const database = await resolveDatabase(config.projectGuid);
        if (!database) {
          console.error(muted('--restore-db: this project has no database - nothing to roll back.'));
        } else {
          const cp = await createCheckpoint(config.projectGuid, database);
          console.error(muted(`Checkpointed ${cp.tables.length} table(s), ${cp.rows} row(s) in '${database}' - rolled back when this eval finishes.`));
          restoreDb = { projectGuid: config.projectGuid, database };
        }
      }
      if (fixturePaths.length || opts.camera) {
        const { config } = await resolveProjectContext({});
        projectGuid = config.projectGuid;
      }
      if (opts.camera) {
        console.log(muted(`Hosting camera feed ${opts.camera}...`));
        camera = await uploadCameraFeed(projectGuid!, opts.camera);
      }
      if (fixturePaths.length) {
        for (const p of fixturePaths) {
          console.log(muted(`Hosting fixture ${p}...`));
          hosted.push(await uploadPublicFixture(projectGuid!, p));
        }
        const map: Record<string, string> = {};
        for (const h of hosted) map[h.name] = h.url;
        const prelude = `const fixtures=${JSON.stringify(map)};const fixtureUrl=${JSON.stringify(hosted[0].url)};`;
        sentExpr = withPrelude(sentExpr, prelude);
        sentSteps = sentSteps.map((s) => withPrelude(s, prelude));
      }
      // The post-gate settle rides at the head of the FIRST script only: the
      // later steps run on a page the gate + settle already carried forward.
      if (settleAfterGateMs > 0) {
        sentExpr = withPrelude(sentExpr, `await new Promise((r) => setTimeout(r, ${settleAfterGateMs}));`);
      }

      const kickoff = await post<{ data: { evalJobId: string } }>('/tools/browser/eval', {
        url, expr: sentExpr, waitMs: sentWaitMs,
        steps: sentSteps.length ? sentSteps : undefined,
        reloadExpr,
        waitForSelector: opts.waitFor || undefined,
        waitForTimeoutMs: opts.waitFor ? waitForTimeoutMs : undefined,
        timeoutMs: sentScriptBudgetMs,
        auth: opts.auth || undefined,
        // A camera feed needs the synthetic devices in place to be played into,
        // so --camera implies --fake-media rather than failing on the pairing.
        fakeMedia: opts.fakeMedia || !!camera || undefined,
        cameraUrl: camera?.url,
      });
      let d: EvalResult;
      try {
        d = await pollEvalResult(kickoff.data.evalJobId, evalWorkBudgetMs({
          waitMs: sentWaitMs,
          waitForTimeoutMs: opts.waitFor ? waitForTimeoutMs : 0,
          hasReload: reloadExpr !== undefined,
          hasCamera: !!camera,
          scriptBudgetMs: sentScriptBudgetMs,
          legs: 1 + sentSteps.length,
        }));
      } catch (err) {
        // The server's overrun message names the budget but not the flag that
        // raises it — and the flag is what the caller needs next. Name it, with
        // the value THIS run used, so the retry is an edit rather than a guess.
        const msg = (err as Error)?.message ?? '';
        const hint = budgetOverrunHint(msg, scriptBudgetMs)
          // A script aborted by its own reload is nearly always a persistence
          // check hand-rolled without --reload; point at the flag that does it.
          ?? (reloadExpr === undefined ? navigationAbortHint(msg) : null);
        if (!hint) throw err;
        throw new Error(`${msg}\n${hint}`);
      }
      const { result, noValue } = normalizeEvalResult(d.result);
      const reload = d.reloadResult !== undefined ? normalizeEvalResult(d.reloadResult) : undefined;

      const execTimeout = evalExecTimeoutMessage(d.result, scriptBudgetMs);
      if (execTimeout) throw new Error(execTimeout);

      // Each --step is reported on its own, against the expression that produced
      // it — N results in one blob would be unreadable and unattributable.
      const stepOut = steps.map((stepExpr, i) => {
        const raw = d.stepResults?.[i];
        const norm = raw !== undefined ? normalizeEvalResult(raw) : undefined;
        return { expr: stepExpr, result: norm?.result ?? '', noValue: norm?.noValue ?? true };
      });

      const emptyState = !noValue && isEmptyStateResult(result);
      // An empty read on a camera run has a different cause and a different fix
      // than an empty read on a normal page: the generic hint's "poll harder,
      // raise --timeout" is guaranteed-wasted advice against a looped still.
      const emptyHint = camera ? EVAL_CAMERA_EMPTY_HINT : EVAL_EMPTY_STATE_HINT;

      if (opts.json) {
        console.log(JSON.stringify({
          ...d, result,
          ...(stepOut.length ? { stepResults: stepOut.map((s) => s.result) } : {}),
          ...(reload ? { reloadResult: reload.result } : {}),
          ...(noValue ? { hint: EVAL_NO_VALUE_HINT } : {}),
          ...(emptyState ? { hint: emptyHint } : {}),
        }));
        return;
      }

      // Context echo (which URL, which script) goes to stderr: the caller
      // already knows what it sent, and keeping stdout = qualifiers + result
      // means `2>/dev/null` (or any stdout capture) yields just the answer.
      console.error(`${brand('Eval')} ${bold(d.url || url)}`);
      if (d.navigationIncomplete) {
        console.log(`${warning('⚠ Navigation incomplete:')} ${d.note || 'page did not reach full load'}`);
      }
      // A slow-painting page makes any wall-clock wait silently wrong: the
      // page's rAF loop is its clock, and engines cap the per-frame delta, so
      // `setTimeout(2000)` may advance only a fraction of a second of app time.
      // Without this line the eval returns a plausible-looking false negative.
      // A script that already steps the loop itself is immune to all of that, so
      // slowRenderMessage returns null for it rather than prescribing the fix it
      // is already applying.
      if (d.slowRender) {
        const slow = slowRenderMessage(d.slowRender.fps, {
          camera: !!camera,
          waitMs,
          script: [expr, ...steps, reloadExpr ?? ''].join('\n'),
        });
        if (slow) console.log(slow);
      }
      // Identity line on EVERY run: without it an agent can't distinguish
      // "signed-in eval" from "--auth silently no-op'd against the anonymous
      // page" — or, worse, assume an unflagged run carried a signed-in session.
      if (d.auth?.requested) {
        const who = getAuth()?.email;
        console.log(d.auth.established
          ? `${muted('Auth:')} ${success('session established')}${who ? muted(` as ${who}`) : ''} ${muted('(what the page renders with it is app-defined)')}`
          : `${warning('Auth: session NOT established')}${d.auth.detail ? ` — ${d.auth.detail}` : ''} ${muted('(this is the anonymous view)')}`);
      } else {
        console.log(muted('Auth: anonymous visitor (signed out; pass --auth to run as your Gipity account)'));
      }
      if (camera) console.log(`${muted('Camera:')} ${camera.name} ${muted('(played as the webcam feed; getUserMedia resolves)')}`);
      if (hosted.length) console.log(`${muted('Fixtures:')} ${hosted.map((h) => h.name).join(', ')}`);
      console.error(opts.file ? `${muted('Script:')} ${opts.file === '-' ? '(stdin)' : opts.file}` : `${muted('Expression:')} ${summarizeExpr(expr)}`);
      console.log(`\n${result.trim() ? result : muted('(empty result)')}`);
      if (noValue) console.log(muted(`\n${EVAL_NO_VALUE_HINT}`));
      if (emptyState) console.log(muted(`\n${emptyHint}`));
      if (d.truncated) console.log(muted('\n(result truncated to fit context - narrow the expression for the full value)'));
      for (let i = 0; i < stepOut.length; i++) {
        const s = stepOut[i];
        console.log(`\n${bold(`Step ${i + 1}`)} ${muted(summarizeExpr(s.expr))} ${muted('(same page load)')}`);
        console.log(s.result.trim() ? s.result : muted('(empty result)'));
        if (s.noValue) console.log(muted(EVAL_NO_VALUE_HINT));
      }
      if (reload) {
        console.log(`\n${bold('After reload')} ${muted('(page reloaded in place — storage preserved)')}`);
        console.log(reload.result.trim() ? reload.result : muted('(empty result)'));
        if (reload.noValue) console.log(muted(EVAL_NO_VALUE_HINT));
        if (d.reloadTruncated) console.log(muted('(reload result truncated to fit context - narrow the expression for the full value)'));
      }
    } finally {
      if (restoreDb) {
        try {
          const r = await restoreCheckpoint(restoreDb.projectGuid, restoreDb.database);
          console.error(muted(`Rolled ${r.tables.length} table(s) back to the checkpoint (${r.rows} row(s)) - nothing this eval wrote survives.`));
        } catch (err) {
          console.error(warning(`⚠ Could not roll back the database - the checkpoint is still there, retry with: gipity db restore (${(err as Error).message})`));
        }
      }
      for (const h of [...hosted, ...(camera ? [camera] : [])]) {
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
//
// This whole narrative renders ONLY on an explicit `--help`, never on an
// arg-shape error. An error dumps the command via outputHelp too, but appending
// ~70 lines of examples/time-budget/realtime guidance on top of a one-line "URL
// must be absolute" buries the actual error — and its trailing realtime block,
// off-topic for a plain probe, has misled agents into "fixing the eval syntax".
// The one realtime pointer worth keeping on error already lives in the command
// DESCRIPTION ("ONE client per call - use `page test --observe`"), which renders
// on error anyway, so nothing is lost by withholding the manual here.
pageEvalCommand.addHelpText('after', (context) => context.error ? '' : `
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

  # Camera app (MediaPipe / YOLOX / any getUserMedia app): play a real image as
  # the webcam so the app's OWN pipeline runs on a frame you control — no need to
  # stub the model or export internals just to test around a missing camera.
  # --camera waits ${CAMERA_DEFAULT_WAIT_MS / 1000}s before evaluating (model load + first frame); the script
  # itself then gets ${EVAL_SCRIPT_BUDGET_CAMERA_MS / 1000}s in the page (--timeout, max ${EVAL_SCRIPT_BUDGET_MAX_MS / 1000}s).
  gipity generate image "a hand making a closed fist, palm to camera, plain background" -o fist.png
  gipity page eval "https://dev.gipity.ai/me/app/" --camera fist.png \\
    "document.querySelector('#detected-gesture').textContent"
  # Camera app that only starts on a click? Start it on page load instead (a headless
  # run has no user), and expose a ready signal so the wait ends the moment it's up:
  gipity page eval "https://dev.gipity.ai/me/app/" --camera fist.png \\
    --wait-for "#detected-gesture:not(:empty)" --wait-timeout ${WAIT_FOR_MAX_MS} \\
    "document.querySelector('#detected-gesture').textContent"
  # Several assertions about the SAME page? Use --step, not several commands: a camera
  # page load pays for getUserMedia + the vision model ONCE and every step reuses it.
  gipity page eval "https://dev.gipity.ai/me/app/" --camera fist.png \\
    --wait-for '[data-vision="ready"]' \\
    "window.__vision.gesture()" \\
    --step "document.getElementById('see').textContent" \\
    --step "({ score: score.textContent, verdict: verdict.textContent })"
  # File-UPLOAD vision app (web-vision-detect, no camera)? --fixture is the analog of
  # --camera: it hosts your test photo at a CORS-permissive URL, so you feed the kit's
  # detector a known image and read back the labels - no deploying a throwaway asset into
  # the app tree (and no cleanup redeploy). crossOrigin='anonymous' keeps the canvas clean.
  gipity generate image "street scene: three people, two cars, one dog" -o street.jpg
  gipity page eval "https://dev.gipity.ai/me/app/" --fixture street.jpg \\
    "const { createDetector } = await import('./packages/web-vision-detect/index.js'); \\
     const det = await createDetector({ model: 'nano' }); \\
     const img = new Image(); img.crossOrigin = 'anonymous'; img.src = fixtureUrl; await img.decode(); \\
     const { detections } = await det.detect(img); return detections.map(d => d.label);"

Module resolution: dynamic import() specifiers starting with ./ or ../ resolve
against the PAGE URL, so import('./packages/i18n/index.js') loads the app's own
module without hand-building the deployed /account/project/ path. Absolute paths
and full URLs pass through unchanged.

Time budget: the script runs under a ${EVAL_SCRIPT_BUDGET_MS / 1000}s in-page budget (${EVAL_SCRIPT_BUDGET_CAMERA_MS / 1000}s with --camera/--fake-media),
counting its own await/setTimeout pauses. Two separate knobs:
  --timeout <ms>  how long the SCRIPT may run in the page (max ${EVAL_SCRIPT_BUDGET_MAX_MS}) — raise this to
                  trace a sequence that unfolds over time (a game round, an animation)
  --wait / --wait-for  how long to settle BEFORE the script runs — a blind sleep, a
                  selector gate, or both (gate first, then sleep). Neither extends --timeout.
Which one:
  - waiting for the app to REACH a state before you read it → --wait-for '<selector>'
    (gate on the end state — '#verdict:not(:empty)' — not just a ready flag; a bare
    --wait samples one arbitrary instant and can land mid-sequence). Passing both means
    gate first, then settle --wait ms.
  - watching state evolve (poll until a result lands, record a trace) → --timeout
  - a slow ONE-TIME init (WASM/model download, big asset) → do NOT split the body across
    calls; every call re-loads the page and re-pays it. Start that work on page load and
    absorb it in the pre-eval window: --wait <ms> (max ${MAX_WAIT_MS}) or, better,
    --wait-for '<ready-selector>' --wait-timeout ${WAIT_FOR_MAX_MS}.

Several things to check on one page? Pass --step (max ${MAX_EVAL_STEPS}) instead of running
'page eval' N times: the steps run in order against the ONE loaded page, so a slow
boot (vision model, game, socket) is paid once, not once per assertion.

Testing realtime/shared state across clients?
  Separate 'page eval' calls run sequentially (one finishes before the next
  starts), so they never overlap and will each see only themselves - a false
  negative. Use 'gipity page test <url> --observe <expr>' for genuinely
  concurrent clients with overlap verification.`);
