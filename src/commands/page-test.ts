import { Command } from 'commander';
import { post } from '../api.js';
import { brand, bold, muted, warning, success, error as clrError } from '../colors.js';
import { run } from '../helpers/index.js';
import { pollEvalResult } from './page-eval.js';

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

// ── interactive mode ────────────────────────────────────────────────────────
// Each client loads the URL, performs a one-time --action (e.g. submit a name),
// then samples an --observe expression across a hold window. The clients run
// genuinely concurrently (the browser pool hands each concurrent same-user call
// its own container, so they're independent overlapping browsers) and every
// client stamps its in-page start/end time, so the command can VERIFY the
// clients actually coexisted and never report a non-overlap as a broken app.

interface ObserveResult {
  i: number;
  label: string;
  samples: unknown[];
  startedAt: number; // epoch ms, from inside the browser
  endedAt: number;
  error?: string; // poll/eval failure, action error, lifecycle failure, or non-JSON result
  lifecycle?: TimelineEvent[]; // --at steps as the browser applied them
}

/** One applied --at step. `appliedMs` is when it actually happened, relative to
 *  the client's observe-window start (null when it failed). */
interface TimelineEvent { action: string; atMs: number; appliedMs: number | null; auto?: boolean; error?: string }

const MAX_HOLD_MS = 15_000; // keep each in-page await under the ~20s browser action timeout
const MIN_HOLD_MS = 1_000;

// ── lifecycle actions (--at) ───────────────────────────────────────────────
// Freeze, hide, or take one client offline partway through the hold window, so
// an app can test what its peers do when a phone locks (host handoff) instead
// of only a clean leave. The server applies them in the browser over CDP; the
// CLI parses and validates the specs and shows the timeline.

export const LIFECYCLE_ACTIONS = ['freeze', 'wake', 'hide', 'show', 'offline', 'online'] as const;
export type LifecycleAction = typeof LIFECYCLE_ACTIONS[number];
export interface AtStep { atMs: number; action: LifecycleAction }

/** Sample value recorded for an observe slot the page's JS never got to run
 *  (it was frozen, or blocked, when the sample was due). */
export const PAUSED_SAMPLE = '(paused)';
/** How late a sample may run before it counts as slept through. */
export const PAUSE_SLACK_MS = 1500;

const AT_SYNTAX = '"<label|index>:<action>@<ms>", e.g. --at host:freeze@5000';

/** Parse the repeatable --at specs into per-client step lists (index-aligned
 *  with `labels`, one entry per client). A target matches every client with
 *  that label (so `phone:hide@3000` hides every phone), else a 0-based index.
 *  Throws a caller-facing error on bad syntax, an unknown client or action, a
 *  time outside the hold window, or an impossible sequence (wake without a
 *  freeze, ...). The server re-checks the sequence; this is the early error. */
export function parseAtSpecs(specs: string[], labels: string[], holdMs: number): AtStep[][] {
  const perClient: AtStep[][] = labels.map(() => []);
  for (const raw of specs) {
    const m = /^\s*([^:@\s]+)\s*:\s*([A-Za-z]+)\s*@\s*(\d+)\s*(?:ms)?\s*$/.exec(raw);
    if (!m) throw new Error(`--at "${raw}": expected ${AT_SYNTAX}`);
    const [, target, rawAction, rawMs] = m;
    const action = rawAction.toLowerCase() as LifecycleAction;
    if (!LIFECYCLE_ACTIONS.includes(action)) {
      throw new Error(`--at "${raw}": unknown action "${rawAction}". Use one of: ${LIFECYCLE_ACTIONS.join(', ')}`);
    }
    const atMs = parseInt(rawMs, 10);
    if (atMs >= holdMs) {
      throw new Error(`--at "${raw}": ${atMs}ms is past the end of the ${holdMs}ms --hold window. Actions must happen inside it (raise --hold, max ${MAX_HOLD_MS}ms, or move the action earlier).`);
    }
    let targets = labels.flatMap((l, i) => (l === target ? [i] : []));
    if (targets.length === 0 && /^\d+$/.test(target) && Number(target) < labels.length) targets = [Number(target)];
    if (targets.length === 0) {
      throw new Error(`--at "${raw}": no client "${target}". Use a label (${[...new Set(labels)].join(', ')}) or an index 0-${labels.length - 1}.`);
    }
    for (const i of targets) perClient[i].push({ atMs, action });
  }
  perClient.forEach((steps, i) => {
    steps.sort((a, b) => a.atMs - b.atMs);
    const err = sequenceError(steps);
    if (err) throw new Error(`--at for client ${i} (${labels[i]}): ${err}`);
  });
  return perClient;
}

/** First impossible transition in a time-ordered step list, or null. Freeze
 *  already hides the page (as a locking phone does), so hide/freeze don't stack. */
function sequenceError(steps: AtStep[]): string | null {
  const on = { frozen: false, hidden: false, offline: false };
  for (const { action, atMs } of steps) {
    const at = `${action}@${atMs}`;
    if (action === 'freeze') {
      if (on.frozen) return `${at}: already frozen`;
      if (on.hidden) return `${at}: the page is hidden; show it first (freeze hides the page on its own)`;
      on.frozen = true;
    } else if (action === 'wake') {
      if (!on.frozen) return `${at}: not frozen (wake undoes freeze)`;
      on.frozen = false;
    } else if (action === 'hide') {
      if (on.hidden || on.frozen) return `${at}: already ${on.frozen ? 'frozen, which hides the page' : 'hidden'}`;
      on.hidden = true;
    } else if (action === 'show') {
      if (!on.hidden) return `${at}: not hidden (show undoes hide)`;
      on.hidden = false;
    } else if (action === 'offline') {
      if (on.offline) return `${at}: already offline`;
      on.offline = true;
    } else {
      if (!on.offline) return `${at}: not offline (online undoes offline)`;
      on.offline = false;
    }
  }
  return null;
}

function fmtTimeline(events: TimelineEvent[]): string {
  return events.map((e) => {
    const when = e.appliedMs === null ? `@${e.atMs}ms` : `+${(e.appliedMs / 1000).toFixed(1)}s`;
    const note = e.error ? clrError(` (failed: ${e.error})`) : e.auto ? muted(' (auto, end of hold)') : '';
    return `${e.action} ${when}${note}`;
  }).join(' → ');
}

/** Splice per-client values into a user string (URL, --action, or --observe).
 *  `{{label}}` → the client's label, `{{i}}` → its 0-based index. Plain string
 *  replace (no regex) so the string's own characters are never treated as
 *  patterns. */
function subst(expr: string, label: string, i: number): string {
  return expr.split('{{label}}').join(label).split('{{i}}').join(String(i));
}

/** Collect any `{{...}}` placeholders the runner does NOT recognize, so an
 *  invented token (e.g. `{{name}}`) is flagged instead of passing through
 *  verbatim into every client's URL/expression. */
function unknownTokens(...strings: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const s of strings) {
    for (const m of (s ?? '').match(/\{\{[^}]*\}\}/g) ?? []) {
      if (m !== '{{i}}' && m !== '{{label}}') out.add(m);
    }
  }
  return [...out];
}

/** One-time warning (to stderr, so --json stdout stays clean) for
 *  unrecognized placeholders left as-is. */
function warnUnknownTokens(unknown: string[]): void {
  if (unknown.length === 0) return;
  console.error(warning(
    `⚠ Unrecognized placeholder ${unknown.join(', ')} left as-is — only {{i}} (0-based client index) and {{label}} are substituted per client. Set per-client values with --labels and reference them as {{label}}.`,
  ));
}

/** Build the statement-body script one client runs: do the one-time action,
 *  then sample `observe` `samples` times across `holdMs`, stamping in-page
 *  start/end so the caller can confirm the clients overlapped. */
export function buildHarness(action: string | undefined, observe: string, label: string, holdMs: number, samples: number): string {
  const n = Math.max(2, samples);
  const interval = Math.max(0, Math.floor(holdMs / (n - 1)));
  const lines: string[] = [
    `const __label=${JSON.stringify(label)};`,
    `const __t0=Date.now();`,
  ];
  if (action && action.trim()) {
    lines.push(
      `try{ ${action} }catch(__e){ return {label:__label,startedAt:__t0,endedAt:Date.now(),samples:[],actionError:String((__e&&__e.message)||__e)}; }`,
    );
  }
  // Samples are due on a fixed schedule from the first one. A page that could
  // not run when a sample was due (frozen by --at, or blocked) records
  // PAUSED_SAMPLE for each slot it reached more than PAUSE_SLACK_MS late,
  // instead of a stale reading taken the moment it resumes. The slack keeps a
  // hidden page's throttled (about 1/s) timers from reading as paused. The
  // last slot always takes a reading.
  lines.push(
    `const __s=[]; const __ts=Date.now();`,
    `for(let __k=0;__k<${n};__k++){`,
    `  const __w=__ts+__k*${interval}-Date.now();`,
    `  if(__w>0) await new Promise(function(r){setTimeout(r,__w);});`,
    `  if(__k<${n - 1}&&Date.now()>__ts+__k*${interval}+${PAUSE_SLACK_MS}){ __s.push(${JSON.stringify(PAUSED_SAMPLE)}); continue; }`,
    `  let __v; try{ __v=(${observe}); }catch(__e){ __v='ObserveError: '+String((__e&&__e.message)||__e); }`,
    `  __s.push(__v);`,
    `}`,
    `return {label:__label,startedAt:__t0,endedAt:Date.now(),samples:__s};`,
  );
  return lines.join('\n');
}

/** Kick off and poll one client's eval job, then parse the harness payload. */
async function observeClient(
  url: string,
  expr: string,
  i: number,
  label: string,
  settleMs: number,
  holdMs: number,
  waitForSelector?: string,
  lifecycle?: AtStep[],
): Promise<ObserveResult> {
  const base: ObserveResult = { i, label, samples: [], startedAt: 0, endedAt: 0 };
  try {
    const kickoff = await post<{ data: { evalJobId: string } }>('/tools/browser/eval', {
      url,
      expr,
      waitMs: settleMs,
      waitForSelector: waitForSelector || undefined,
      waitForTimeoutMs: waitForSelector ? 5000 : undefined,
      // Timed from the start of the observe window; the server restores
      // anything still applied at the end of the hold so the harness finishes.
      lifecycle: lifecycle?.length ? { steps: lifecycle, untilMs: holdMs } : undefined,
    });
    // Server work ≈ nav + settle + the in-page hold; pollEvalResult adds 60s headroom.
    const d = await pollEvalResult(kickoff.data.evalJobId, settleMs + holdMs);
    const raw = d.result?.trim() ?? '';
    if (raw.startsWith('EvalError:') || raw.startsWith('ObserveError:')) {
      return { ...base, error: raw };
    }
    let parsed: { label?: string; samples?: unknown[]; startedAt?: number; endedAt?: number; actionError?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...base, error: `unparseable client result: ${raw.slice(0, 200)}` };
    }
    if (parsed.actionError) {
      return { ...base, error: `action failed: ${parsed.actionError}` };
    }
    const startedAt = typeof parsed.startedAt === 'number' ? parsed.startedAt : 0;
    const out: ObserveResult = {
      i,
      label: typeof parsed.label === 'string' ? parsed.label : label,
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      startedAt,
      endedAt: typeof parsed.endedAt === 'number' ? parsed.endedAt : 0,
    };
    if (lifecycle?.length) {
      // A step that silently didn't happen would make "the handoff works" a
      // false positive, so a missing or failed step fails the client.
      const report = d.lifecycle;
      out.lifecycle = (report?.events ?? []).map((e) => ({
        action: e.action,
        atMs: e.atMs,
        appliedMs: typeof e.appliedAt === 'number' && startedAt > 0 ? e.appliedAt - startedAt : null,
        ...(e.auto ? { auto: true } : {}),
        ...(e.error ? { error: e.error } : {}),
      }));
      const failed = out.lifecycle.find((e) => e.error);
      if (!report) out.error = 'lifecycle actions were not applied (the server did not report them; it may need updating)';
      else if (report.error) out.error = `lifecycle actions failed: ${report.error}`;
      else if (failed) out.error = `lifecycle ${failed.action}@${failed.atMs} failed: ${failed.error}`;
    }
    return out;
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Compute the window during which ALL successful clients were live at once.
 *  Intersection of every [startedAt, endedAt]; positive duration ⇒ they
 *  genuinely coexisted, so any shared-state reading is trustworthy. */
function overlapMs(results: ObserveResult[]): number {
  const live = results.filter((r) => !r.error && r.startedAt > 0 && r.endedAt > r.startedAt);
  if (live.length < 2) return 0;
  const start = Math.max(...live.map((r) => r.startedAt));
  const end = Math.min(...live.map((r) => r.endedAt));
  return Math.max(0, end - start);
}

function fmtSamples(samples: unknown[]): string {
  if (samples.length === 0) return muted('(no samples)');
  return samples.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).join(' → ');
}

async function runInteractive(url: string, observe: string, opts: TestOpts): Promise<void> {
  const clients = Math.max(1, parseInt(opts.clients, 10) || 2);
  const stagger = opts.stagger != null ? Math.max(0, parseInt(opts.stagger, 10) || 0) : 0;
  const rawHold = parseInt(opts.hold, 10) || 8000;
  const hold = Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, rawHold));
  if (rawHold > MAX_HOLD_MS) {
    // Surface the clamp (to stderr, so --json stdout stays clean) instead of
    // leaving the agent to infer it from the printed "hold Nms" line.
    console.error(warning(
      `--hold ${rawHold}ms exceeds the ${MAX_HOLD_MS}ms per-client cap (each client samples inside one browser eval, bounded by the server's eval budget) — using ${MAX_HOLD_MS}ms. ` +
      `Co-launch every role in this one command (put {{label}}/{{i}} in the URL) so all clients overlap for the whole window; a separately-started background client overlaps only the sliver of its window that lines up.`,
    ));
  }
  const samples = Math.min(30, Math.max(2, parseInt(opts.samples, 10) || 6));
  const settle = opts.waitFor ? 200 : 1000;
  const labels = (opts.labels ? String(opts.labels).split(',').map((s) => s.trim()) : []).filter(Boolean);
  const labelFor = (i: number) => labels[i] ?? `client-${i}`;

  // Only {{label}} and {{i}} are substituted. Warn once on any other {{token}}
  // (a natural guess like {{name}} or {{index}}) so it isn't sent literally to
  // every client — the silent wrong-behavior trap of identical clients.
  warnUnknownTokens(unknownTokens(url, opts.action, observe));

  const atSpecs = opts.at ?? [];
  const lifecycle = parseAtSpecs(atSpecs, Array.from({ length: clients }, (_, i) => labelFor(i)), hold);

  if (!opts.json) {
    console.log(`${brand('Page test')} ${muted('(interactive)')} ${bold(url)}`);
    console.log(muted(`${clients} client(s), stagger ${stagger}s, hold ${hold}ms, ${samples} samples each`));
    if (atSpecs.length) console.log(muted(`lifecycle (ms into each client's hold): ${atSpecs.map((s) => s.trim()).join(', ')}`));
  }

  const runs: Promise<ObserveResult>[] = [];
  for (let i = 0; i < clients; i++) {
    runs.push((async () => {
      await sleep(i * stagger * 1000);
      if (!opts.json) console.log(muted(`client ${i} (${labelFor(i)}) joining`));
      // {{label}}/{{i}} substitute into the URL too, so one invocation can launch
      // asymmetric roles concurrently (e.g. ?role={{label}} with --labels host,join)
      // and the overlap check still confirms they coexisted.
      const clientUrl = subst(url, labelFor(i), i);
      const expr = buildHarness(
        opts.action ? subst(opts.action, labelFor(i), i) : undefined,
        subst(observe, labelFor(i), i),
        labelFor(i),
        hold,
        samples,
      );
      return observeClient(clientUrl, expr, i, labelFor(i), settle, hold, opts.waitFor, lifecycle[i]);
    })());
  }
  const results = (await Promise.all(runs)).sort((a, b) => a.i - b.i);

  const errored = results.filter((r) => r.error);
  const ovl = overlapMs(results);
  const overlapped = ovl > 0;

  if (opts.json) {
    console.log(JSON.stringify({
      url, mode: 'interactive', clients, stagger, hold, samples,
      ...(atSpecs.length ? { at: atSpecs.map((s) => s.trim()) } : {}),
      overlapMs: ovl, overlapped, results,
    }));
    if (errored.length > 0 || (clients > 1 && !overlapped)) process.exitCode = 1;
    return;
  }

  for (const r of results) {
    console.log(`\n${bold(`=== client ${r.i} (${r.label}) ===`)}`);
    if (r.lifecycle?.length) console.log(`${muted('timeline:')} ${fmtTimeline(r.lifecycle)}`);
    if (r.error) { console.log(clrError(`✗ ${r.error}`)); continue; }
    console.log(`${muted('samples:')} ${fmtSamples(r.samples)}`);
  }

  console.log('');
  if (errored.length > 0) {
    console.log(clrError(`⚠ ${errored.length} client(s) failed (see above)`));
  }
  if (clients < 2) {
    console.log(muted('Note: a single client cannot verify cross-client visibility — run with --clients 2+.'));
  } else if (overlapped) {
    console.log(success(`✓ all clients overlapped for ~${(ovl / 1000).toFixed(1)}s — genuine concurrency, so the readings above are trustworthy`));
  } else {
    console.log(clrError(
      '⚠ clients did NOT overlap in time — each ran in isolation, so any shared-state reading here is a FALSE NEGATIVE, not proof the app is broken.',
    ));
    console.log(muted(
      '  Likely causes: --stagger ≥ --hold, or more --clients than free browser slots (they queued). Lower --stagger / raise --hold / fewer --clients and retry.',
    ));
  }

  if (errored.length > 0 || (clients > 1 && !overlapped)) process.exitCode = 1;
}

// ── command ─────────────────────────────────────────────────────────────────

interface TestOpts {
  clients: string;
  stagger?: string;
  wait: string;
  hold: string;
  samples: string;
  labels?: string;
  action?: string;
  observe?: string;
  waitFor?: string;
  at?: string[];
  json?: boolean;
}

async function runPassive(url: string, opts: TestOpts): Promise<void> {
  const clients = Math.max(1, parseInt(opts.clients, 10) || 2);
  const stagger = opts.stagger != null ? Math.max(0, parseInt(opts.stagger, 10) || 0) : 12;
  const wait = Math.min(30000, Math.max(2000, parseInt(opts.wait, 10) || 24000));
  const labels = (opts.labels ? String(opts.labels).split(',').map((s) => s.trim()) : []).filter(Boolean);
  const labelFor = (i: number) => labels[i] ?? `client-${i}`;

  warnUnknownTokens(unknownTokens(url));

  if (!opts.json) {
    console.log(`${brand('Page test')} ${bold(url)}`);
    console.log(`${muted(`${clients} client(s), stagger ${stagger}s, ${wait}ms open each`)}`);
  }

  const runs: Promise<ClientResult>[] = [];
  for (let i = 0; i < clients; i++) {
    runs.push((async () => {
      await sleep(i * stagger * 1000);
      if (!opts.json) console.log(`${muted(`client ${i}${i === 0 ? ' (first)' : ''} starting`)}`);
      return inspectClient(subst(url, labelFor(i), i), wait, i);
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
}

// Headless multi-client realtime check. Two modes:
//
//  Passive (default): spin N staggered browser clients at a deployed URL and
//  flag error/crash lines across their consoles. Each client just loads the URL
//  and settles - good for apps that connect on load (or via a URL-param test
//  mode; see the app-realtime skill).
//
//  Interactive (--observe, optionally with --action): each client loads the
//  URL, runs a one-time --action (e.g. submit a name), then samples --observe
//  across a hold window. The clients run genuinely concurrently and the command
//  VERIFIES they overlapped in time - so a presence/shared-state app whose
//  readings only make sense when clients coexist can't be misread as broken
//  just because the clients never actually ran together.
export const pageTestCommand = new Command('test')
  .description('Multi-client realtime check: load a URL in N concurrent headless clients; flag console errors, or drive an action and observe shared state (--observe)')
  .argument('<url>', 'Deployed URL to load in every client. {{label}}/{{i}} substitute per client in both modes (e.g. ?name=Bot{{i}}, or ?role={{label}} with --labels host,join), so one invocation can give each client a distinct role.')
  .option('--clients <n>', 'Number of headless clients to launch', '2')
  .option('--stagger <s>', 'Seconds between client starts (passive default 12; interactive default 0)')
  .option('--wait <ms>', 'Passive mode: ms each client stays open after load (max 30000)', '24000')
  // Interactive mode (--observe drives it):
  .option('--observe <expr>', 'Interactive: JS expression sampled in each client to read shared state (e.g. presence count). Switches on interactive mode.')
  .option('--action <expr>', 'Interactive: one-time JS run in each client before observing (e.g. fill a name + submit). {{label}}/{{i}} are substituted per client.')
  .option('--labels <csv>', 'Per-client labels substituted for {{label}} in the URL/--action/--observe (default client-0, client-1, ...)')
  .option('--hold <ms>', `Interactive: total observe window per client (${MIN_HOLD_MS}-${MAX_HOLD_MS}ms)`, '8000')
  .option('--samples <k>', 'Interactive: number of observations across the hold window (2-30)', '6')
  .option('--wait-for <selector>', 'Interactive: wait for this CSS selector before running --action (deterministic readiness gate)')
  .option('--at <spec>', `Interactive: lifecycle action on one client mid-run, "<label|index>:<action>@<ms>" (ms into that client's hold window). Actions: freeze|wake (locked phone: JS stops, socket stays open), hide|show (backgrounded tab), offline|online (network drop). Repeatable; anything still applied at the end of --hold is restored.`, (v: string, prev: string[] = []) => [...prev, v])
  .option('--json', 'Output as JSON')
  .addHelpText('after', `
Examples:
  # Passive: load in 3 staggered clients, flag console errors
  gipity page test "https://dev.gipity.ai/me/app/" --clients 3 --stagger 8

  # Per-client URL params: each client joins under a distinct name (Bot0, Bot1, …)
  gipity page test "https://dev.gipity.ai/me/app/?name=Bot{{i}}" --clients 2

  # Interactive: two concurrent clients each join with a name, then watch the
  # live presence count. The command confirms the clients actually overlapped.
  gipity page test "https://dev.gipity.ai/me/app/" --clients 2 \\
    --action "document.querySelector('#name').value='{{label}}'; document.querySelector('form').requestSubmit();" \\
    --observe "document.querySelectorAll('.present').length" \\
    --labels Alice,Bob

  # Asymmetric roles in ONE invocation: {{label}} in the URL routes client 0 to
  # host and client 1 to join. They overlap in time (verified), so the joiner
  # observes the live state the host is driving — no background-process dance.
  gipity page test "https://dev.gipity.ai/me/app/?test-action={{label}}" --clients 2 \\
    --labels host,join \\
    --observe "document.querySelector('[data-screen]')?.dataset.screen"

  # Host handoff: lock the host's phone 5s in (its JS stops, its socket stays
  # open, so nobody sees a leave) and watch who the phones think is host.
  gipity page test "https://dev.gipity.ai/me/app/?role={{label}}" --clients 3 \\
    --labels host,phone,phone --hold 15000 --at host:freeze@5000 --at host:wake@12000 \\
    --observe "window.game?.hostId"

freeze: the page's JS stops (timers, rendering, message handlers) and it fires
visibilitychange (hidden) then freeze, like a phone locking. Its WebSocket stays
open, so the server sees no leave. On wake the page resumes and Chrome drops that
socket (close code 1006), so the app's reconnect path runs. Samples due while a
client was frozen read (paused).
hide: backgrounded tab (document.hidden, rAF stops, timers throttle to ~1/s); JS
and the socket keep running.
offline: navigator.onLine false, new requests fail, and an open WebSocket stalls
without closing; online delivers the held traffic.`)
  .action((url: string, opts: TestOpts) => run('Page test', async () => {
    if (opts.at?.length && !opts.observe) {
      throw new Error('--at needs interactive mode: add --observe "<expr>" to watch what the other clients do while one is frozen, hidden, or offline');
    }
    if (opts.observe) {
      await runInteractive(url, opts.observe, opts);
    } else {
      await runPassive(url, opts);
    }
  }));
