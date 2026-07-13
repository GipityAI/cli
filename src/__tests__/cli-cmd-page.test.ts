import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as tarPack from 'tar-stream';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';
import { timestampSlug, defaultFilename, augmentSandboxTimeout } from '../commands/page-screenshot.js';
import {
  summarizeExpr, evalWorkBudgetMs, pollEvalResult, CAMERA_DEFAULT_WAIT_MS, slowRenderMessage,
  capScriptBudgetMs, budgetOverrunHint, isEmptyStateResult,
  EVAL_SCRIPT_BUDGET_MS, EVAL_SCRIPT_BUDGET_CAMERA_MS, EVAL_SCRIPT_BUDGET_MAX_MS,
} from '../commands/page-eval.js';
import { assertLocalAsset } from '../page-fixtures.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function run(args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home } });
}

const baseBundle = {
  url: 'https://example.com',
  title: 'Example Domain',
  console: ['Warning: deprecated API'],
  failedResources: [],
  timing: { ttfb: 120, domReady: 500, load: 800 },
  elementCount: 42,
  totalBytes: 12345,
  largeResources: [],
  renderBlocking: [],
  oversizedImages: [],
  lcp: null,
  overflow: { scrollWidth: 1280, clientWidth: 1280, overflowX: false, amount: 0, culprits: [] },
};

test('gipity page inspect prints title, timing, and console summary', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Example Domain/);
  assert.match(r.stdout, /TTFB:\s*120ms/);
  assert.match(r.stdout, /Warning: deprecated API/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity page inspect reports a clean layout when there is no horizontal overflow', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no horizontal overflow/);
});

test('gipity page inspect flags horizontal overflow and lists culprits under --all', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle,
    overflow: {
      scrollWidth: 1400, clientWidth: 1280, overflowX: true, amount: 120,
      culprits: [{ tag: 'div', cls: 'hero wide', left: 0, right: 1400, width: 1400 }],
    },
  } } });
  const r = await run(['page', 'inspect', 'https://example.com', '--all']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Horizontal overflow: \+120px/);
  assert.match(r.stdout, /div\.hero/);
});

test('gipity page inspect treats the implicit root /favicon.ico 404 as a note, not a failure', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle, failedResources: ['https://dev.gipity.ai/favicon.ico (404)'],
  } } });
  const r = await run(['page', 'inspect', 'https://dev.gipity.ai/steve/app/']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /Failed resources/);
  assert.match(r.stdout, /No root \/favicon\.ico/);
});

test('gipity page inspect still flags real failed resources alongside the favicon note', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle,
    failedResources: ['https://dev.gipity.ai/favicon.ico (404)', 'https://dev.gipity.ai/app.js (500)'],
  } } });
  const r = await run(['page', 'inspect', 'https://dev.gipity.ai/steve/app/']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Failed resources \(1\)/);
  assert.match(r.stdout, /app\.js \(500\)/);
  assert.doesNotMatch(r.stdout, /favicon\.ico \(404\)/);
  assert.match(r.stdout, /No root \/favicon\.ico/);
});

test("gipity page inspect drops the platform's own traffic/error-log 404 noise from console and failed resources", async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle,
    console: ['error: Failed to load resource: the server responded with a status of 404 ()'],
    failedResources: ['https://a.gipity.ai/api/abc123/log/traffic (404)'],
  } } });
  const r = await run(['page', 'inspect', 'https://dev.gipity.ai/steve/app/']);
  assert.equal(r.status, 0, r.stderr);
  // The injected analytics SDK's log POST is platform infra, not an app defect:
  // neither the failed resource nor its generic console error should surface.
  assert.match(r.stdout, /Console:\s*\(clean\)/);
  assert.doesNotMatch(r.stdout, /Failed resources/);
  assert.doesNotMatch(r.stdout, /Failed to load resource/);
});

test('gipity page inspect surfaces a real app 404 (with URL) under Failed resources, not as a bare console echo', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle,
    console: [
      'error: Failed to load resource: the server responded with a status of 404 ()',
      'error: Failed to load resource: the server responded with a status of 404 ()',
    ],
    failedResources: [
      'https://a.gipity.ai/api/abc123/log/traffic (404)',
      'https://dev.gipity.ai/steve/app/missing.js (404)',
    ],
  } } });
  const r = await run(['page', 'inspect', 'https://dev.gipity.ai/steve/app/']);
  assert.equal(r.status, 0, r.stderr);
  // The real 404 is named — with its URL — under Failed resources.
  assert.match(r.stdout, /Failed resources \(1\)/);
  assert.match(r.stdout, /missing\.js \(404\)/);
  assert.doesNotMatch(r.stdout, /log\/traffic/);
  // Both URL-less console echoes (one per attributed failure: the app 404 and the
  // platform-log 404) are gone — no bare "Failed to load resource" line remains
  // for the agent to chase or have to correlate by hand.
  assert.match(r.stdout, /Console:\s*\(clean\)/);
  assert.doesNotMatch(r.stdout, /Failed to load resource/);
});

test('gipity page inspect keeps an unattributed resource 404 in the console when failedResources cannot name it', async () => {
  // Safety net: if the CDP network drain comes back empty (so failedResources
  // can't account for a console 404), the echo is KEPT rather than silently
  // dropped — a real failure must never be hidden just because we lack its URL.
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle,
    console: ['error: Failed to load resource: the server responded with a status of 404 ()'],
    failedResources: [],
  } } });
  const r = await run(['page', 'inspect', 'https://dev.gipity.ai/steve/app/']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Console \(1\)/);
  assert.match(r.stdout, /Failed to load resource/);
});

test('gipity page eval redirects a JS-intent flag guess to the positional <expr> arg', async () => {
  mock.reset();
  const r = await run(['page', 'eval', 'https://example.com', '--js', 'document.title']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--js is not a flag/);
  assert.match(r.stderr, /positional <expr>/);
  // It must NOT have actually run an eval against the server.
  assert.equal(mock.requests().some(q => q.url === '/tools/browser/eval'), false);
});

// A headless browser with NO camera makes every getUserMedia app report a
// NotFoundError that says nothing about the page — and stops the app at its
// error path, so the pipeline the agent wanted inspected never runs. A real
// user has a camera, so the probe has one too, by default. A page that never
// asks for media is unaffected.
test('gipity page inspect grants the synthetic camera by default', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/inspect');
  assert.ok(req, 'inspect request was received');
  assert.equal((req!.body as { fakeMedia?: boolean }).fakeMedia, true);
});

// The no-device path is still reachable — but only by asking for it, because
// inspecting THAT fallback is a deliberate choice, not the default reading.
test('gipity page inspect --no-fake-media takes the camera away', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com', '--no-fake-media']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/inspect');
  assert.equal((req!.body as { fakeMedia?: boolean }).fakeMedia, undefined);
});

test('gipity page inspect clamps --wait over the 30s cap and explains instead of leaking a raw server error', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com', '--wait', '60000']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/inspect');
  assert.equal((req!.body as { waitMs?: number }).waitMs, 30000, 'waitMs clamped to the cap');
  assert.match(r.stderr, /30000ms cap/);
  assert.match(r.stderr, /page test/);
});

test('gipity page inspect forwards a sub-cap --wait unchanged with no warning', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com', '--wait', '5000']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/inspect');
  assert.equal((req!.body as { waitMs?: number }).waitMs, 5000);
  assert.doesNotMatch(r.stderr, /cap/);
});

test('gipity page eval clamps --wait over the 30s cap in the kickoff body', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-w', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-w', { body: { data: {
    status: 'done', url: 'https://example.com', result: '1', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', '1', '--wait', '90000']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/eval');
  assert.equal((req!.body as { waitMs?: number }).waitMs, 30000);
  assert.match(r.stderr, /30000ms cap/);
});

// ── the in-page budget must be a FLAG, not a wall you discover by hitting it ──
// The server has always taken a per-call script budget (`timeoutMs`, up to 90s)
// and its overrun message even says to "raise the eval timeout" — but the CLI
// exposed no way to do it. An agent tracing a game round guessed `--timeout
// 90000` (the right knob), got a usage dump, and spent two more calls grepping
// --help. The guess now IS the flag.
test('gipity page eval --timeout sets the in-page script budget on the kickoff body', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-t', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-t', { body: { data: {
    status: 'done', url: 'https://example.com', result: '1', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', '1', '--timeout', '90000']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/eval');
  assert.equal((req!.body as { timeoutMs?: number }).timeoutMs, 90000);
});

test('gipity page eval sends the default in-page budget when --timeout is omitted', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-t2', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-t2', { body: { data: {
    status: 'done', url: 'https://example.com', result: '1', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', '1']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/eval');
  assert.equal((req!.body as { timeoutMs?: number }).timeoutMs, EVAL_SCRIPT_BUDGET_MS);
});

test('capScriptBudgetMs defaults roomier under synthetic media and clamps over the max', () => {
  assert.equal(capScriptBudgetMs(undefined, false), EVAL_SCRIPT_BUDGET_MS);
  assert.equal(capScriptBudgetMs(undefined, true), EVAL_SCRIPT_BUDGET_CAMERA_MS);
  assert.equal(capScriptBudgetMs('60000', false), 60_000);
  assert.equal(capScriptBudgetMs('999999', false), EVAL_SCRIPT_BUDGET_MAX_MS);
  // Garbage falls back to the default rather than sending an invalid budget.
  assert.equal(capScriptBudgetMs('soon', false), EVAL_SCRIPT_BUDGET_MS);
});

// The server names the budget but not the flag that raises it. The CLI must.
test('budgetOverrunHint names --timeout, and stops recommending it at the max', () => {
  const hint = budgetOverrunHint('Your script was still running after its 45s in-page budget', 45_000);
  assert.match(hint!, /--timeout/);
  assert.match(hint!, new RegExp(String(EVAL_SCRIPT_BUDGET_MAX_MS)));
  const atMax = budgetOverrunHint('… in-page budget …', EVAL_SCRIPT_BUDGET_MAX_MS);
  assert.match(atMax!, /maximum/i);
  assert.match(atMax!, /--wait-for/);
  // Unrelated failures are never editorialized.
  assert.equal(budgetOverrunHint('404 Not Found', 30_000), null);
});

test('gipity page eval appends the --timeout hint to a server budget overrun', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-ov', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-ov', { body: { data: {
    status: 'error', httpStatus: 400, code: 'EVAL_STALLED',
    reason: 'Your script was still running after its 30s in-page budget, so it returned nothing.',
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'await forever()']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--timeout/);
});

// A fixed --wait samples ONE instant. When the state the script read is gone by
// then, the run "succeeds" with `{}` — the failure mode that cost an agent a
// whole turn of reasoning to even notice. Say it, don't make them infer it.
test('isEmptyStateResult flags empty containers, not real values', () => {
  assert.equal(isEmptyStateResult('{}'), true);
  assert.equal(isEmptyStateResult('[]'), true);
  assert.equal(isEmptyStateResult('{"you":null,"cpu":null,"winner":""}'), true);
  assert.equal(isEmptyStateResult('{"you":"rock","cpu":"scissors"}'), false);
  assert.equal(isEmptyStateResult('0'), false);
  assert.equal(isEmptyStateResult('"scissors"'), false);
});

test('gipity page eval explains an empty-state result instead of reporting a silent pass', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-e', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-e', { body: { data: {
    status: 'done', url: 'https://example.com', result: '{}', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'window.round']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--wait-for|Poll INSIDE the body/);
});

test('gipity page inspect --json emits the raw inspect bundle', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: {
    ...baseBundle, url: 'https://x.example', title: 'X', console: [],
  } } });
  const r = await run(['page', 'inspect', 'https://x.example', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.title, 'X');
  assert.equal(parsed.overflow.overflowX, false);
});

// A console error that recurs on the re-probe is a real defect — reported as-is.
test('gipity page inspect re-probes on console errors and reports reproducible ones', async () => {
  mock.reset();
  let calls = 0;
  mock.on('POST /tools/browser/inspect', () => {
    calls++;
    return { body: { data: { ...baseBundle, console: ['error: ReferenceError: foo is not defined'] } } };
  });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls, 2, 'inspect re-probes once when errors are present');
  assert.match(r.stdout, /ReferenceError: foo is not defined/);
  assert.doesNotMatch(r.stdout, /Transient console errors/);
});

// A real console error gone on the re-probe is a cold-load transient — demoted, not flagged.
test('gipity page inspect demotes a non-reproducible console error to transient', async () => {
  mock.reset();
  let calls = 0;
  mock.on('POST /tools/browser/inspect', () => {
    calls++;
    const console = calls === 1
      ? ['error: ReferenceError: foo is not defined']
      : [];
    return { body: { data: { ...baseBundle, console } } };
  });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls, 2);
  assert.match(r.stdout, /Transient console errors/);
  assert.match(r.stdout, /not reproduced on re-probe/);
});

// Message-less cross-origin errors are unactionable (no source/stack) and the
// platform's own injected SDK is cross-origin — so they're broken out into their
// own bucket, never reported as app console errors, and never re-probed.
test('gipity page inspect breaks message-less cross-origin errors out of the console list', async () => {
  mock.reset();
  let calls = 0;
  mock.on('POST /tools/browser/inspect', () => {
    calls++;
    return { body: { data: { ...baseBundle, console: [
      'error: (message-less error — details hidden by the browser\'s cross-origin policy)',
    ] } } };
  });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls, 1, 'cross-origin-only console is not re-probed');
  assert.match(r.stdout, /Cross-origin console errors/);
  assert.match(r.stdout, /clean/, 'no real console errors remain');
  assert.doesNotMatch(r.stdout, /THIRD-PARTY/);
});

test('gipity page inspect --json moves transient errors to transientConsole', async () => {
  mock.reset();
  let calls = 0;
  mock.on('POST /tools/browser/inspect', () => {
    calls++;
    const console = calls === 1 ? ['error: ReferenceError: x'] : [];
    return { body: { data: { ...baseBundle, console } } };
  });
  const r = await run(['page', 'inspect', 'https://example.com', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.deepEqual(parsed.console, []);
  assert.deepEqual(parsed.transientConsole, ['error: ReferenceError: x']);
});

test('gipity page inspect --json moves cross-origin errors to crossOriginConsole', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: { ...baseBundle, console: [
    'error: (message-less error — details hidden by the browser\'s cross-origin policy)',
  ] } } });
  const r = await run(['page', 'inspect', 'https://example.com', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.deepEqual(parsed.console, []);
  assert.equal(parsed.crossOriginConsole.length, 1);
});

// Eval is async: POST returns a job id, the CLI polls GET until the job is
// done. The mock returns a fixed evalJobId and the matching done record.
test('gipity page eval prints the serialized expression result', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-1', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-1', { body: { data: {
    status: 'done', url: 'https://example.com', result: 'Example Domain', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'document.title']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Example Domain/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity page eval --json emits url, result, and truncated', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-1', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-1', { body: { data: {
    status: 'done', url: 'https://example.com', result: '42', truncated: true,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', '1+41', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.result, '42');
  assert.equal(parsed.truncated, true);
});

test('gipity page eval --file sends the script file contents as the expr', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-1', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-1', { body: { data: {
    status: 'done', url: 'https://example.com', result: '{"ok":true}', truncated: false,
  } } });
  const scriptPath = join(home, 'draw-flow.js');
  const script = '(function(){ return JSON.stringify({ ok: true }); })()';
  writeFileSync(scriptPath, script);
  const r = await run(['page', 'eval', 'https://example.com', '--file', scriptPath, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/eval');
  assert.ok(req, 'eval request was received');
  assert.equal((req!.body as { expr: string }).expr, script);
});

test('gipity page eval rejects passing both an inline expr and --file', async () => {
  mock.reset();
  const scriptPath = join(home, 'flow.js');
  writeFileSync(scriptPath, 'document.title');
  const r = await run(['page', 'eval', 'https://example.com', 'document.title', '--file', scriptPath]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /either an inline <expr> arg or --file/);
});

test('gipity page eval requires an inline expr or --file', async () => {
  mock.reset();
  const r = await run(['page', 'eval', 'https://example.com']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Provide an inline <expr> arg or --file/);
});

test('gipity page eval reports an unreadable --file path', async () => {
  mock.reset();
  const r = await run(['page', 'eval', 'https://example.com', '--file', join(home, 'does-not-exist.js')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Cannot read file/);
});

test('gipity page eval surfaces a failed eval job', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-err', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-err', { body: { data: {
    status: 'error', httpStatus: 502, code: 'BROWSER_ERROR', reason: 'stayed on about:blank',
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'document.title']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /about:blank/);
});

// A script that runs but returns undefined (no `return`) comes back as the raw
// agent-browser envelope. The CLI must unwrap it to a clean value and explain
// how to shape a returnable result instead of printing an opaque blob.
test('gipity page eval explains a no-value (undefined) result and hides the raw envelope', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-nv', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-nv', { body: { data: {
    status: 'done', url: 'https://example.com', truncated: false,
    result: '{"success":true,"data":{"origin":"https://example.com","result":null},"error":null}',
  } } });
  const r = await run(['page', 'eval', 'https://example.com', "document.getElementById('x').value='hi'"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no JSON-serializable value/);
  assert.doesNotMatch(r.stdout, /"success":true/);  // raw envelope never shown
});

test('gipity page eval --json cleans the leaked envelope and attaches a hint', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-nvj', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-nvj', { body: { data: {
    status: 'done', url: 'https://example.com', truncated: false,
    result: '{"success":true,"data":{"origin":"https://example.com","result":null},"error":null}',
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'void 0', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.result, 'null');
  assert.match(parsed.hint, /no JSON-serializable value/);
});

test('gipity page eval hints on a bare null result', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-null', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-null', { body: { data: {
    status: 'done', url: 'https://example.com', result: 'null', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'window.missing', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.result, 'null');
  assert.match(parsed.hint, /no JSON-serializable value/);
});

// A genuine serialized value must pass through untouched — no spurious hint.
test('gipity page eval does not hint on a real value', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-ok', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-ok', { body: { data: {
    status: 'done', url: 'https://example.com', result: '{"n":1}', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', '({n:1})', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.result, '{"n":1}');
  assert.equal(parsed.hint, undefined);
});

// An eval body whose own awaits overrun the in-page execution budget comes back
// from agent-browser as a {success:false, error:"CDP command timed out:
// Runtime.evaluate"} envelope, surfaced verbatim as the result. The CLI must
// translate that into an actionable error, not print the opaque envelope.
test('gipity page eval translates the CDP execution-budget timeout into guidance', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-cdp', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-cdp', { body: { data: {
    status: 'done', url: 'https://example.com', truncated: false,
    result: '{"success":false,"data":null,"error":"CDP command timed out: Runtime.evaluate"}',
  } } });
  const r = await run(['page', 'eval', 'https://example.com', '(async()=>{})()']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /in-page budget/);
  assert.match(r.stderr, /--wait sleeps BEFORE the script and does not extend it/);
  // The budget is a flag, so the error names it (and the value this run used).
  assert.match(r.stderr, /--timeout/);
  assert.doesNotMatch(r.stderr, /CDP command timed out/);
  // A one-time init (a model/WASM download) is re-paid by every fresh page load,
  // so "just split the body up" is a trap: the guidance must name the pre-eval
  // window (--wait / --wait-for) as the lever instead of sending the caller into
  // a retry loop that hits the identical wall.
  assert.match(r.stderr, /ONE-TIME page init/);
  assert.match(r.stderr, /do NOT split the body/);
  assert.match(r.stderr, /--wait-for/);
});


// ── page eval --fixture (host a real file, inject fixtureUrl, auto-delete) ──
// --fixture uploads a local file to the app's public store, splices a fetch-able
// `fixtureUrl` into the eval scope, runs the eval, then deletes the hosted copy.
// Needs a linked project (cwd) so the upload targets p_TestProj.

/** Register the init → PUT → complete → delete chain for one fixture guid. */
function mockFixtureUpload(guid: string, mediaUrl: string) {
  mock.on(`POST /api/p_TestProj/uploads/init`, { body: { data: { upload_guid: guid, method: 'PUT', url: `${mock.apiBase}/presign/${guid}` } } });
  mock.on(`PUT /presign/${guid}`, { status: 200, raw: 'ok', contentType: 'text/plain' });
  mock.on(`POST /api/p_TestProj/uploads/complete`, { body: { data: { guid, url: mediaUrl } } });
  mock.on(`DELETE /api/p_TestProj/uploads/${guid}`, { body: { data: { guid, deleted: true } } });
}

test('page eval --fixture hosts a file, injects fixtureUrl + fixtures, and deletes it after', async () => {
  mock.reset();
  const mediaUrl = 'https://media.gipity.ai/app-files/p_TestProj/2026-06/f_1/sample.bin';
  mockFixtureUpload('f_1', mediaUrl);
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-fx', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-fx', { body: { data: {
    status: 'done', url: 'https://example.com', result: '{"ok":true}', truncated: false,
  } } });

  const fixturePath = join(home, 'sample.bin');
  writeFileSync(fixturePath, Buffer.from([1, 2, 3, 4]));
  const projectDir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'page', 'eval', 'https://example.com', 'await fetch(fixtureUrl)', '--fixture', fixturePath],
    { env: { HOME: home }, cwd: projectDir },
  );
  assert.equal(r.status, 0, r.stderr);

  // The bytes went up via PUT, and the eval body got the injected fixtureUrl.
  const evalReq = mock.requests().find((q) => q.url === '/tools/browser/eval');
  const expr = (evalReq!.body as { expr: string }).expr;
  assert.match(expr, /const fixtureUrl=/);
  assert.match(expr, /media\.gipity\.ai\/app-files\/p_TestProj\/2026-06\/f_1\/sample\.bin/);
  assert.match(expr, /"sample\.bin"/);  // basename key in the `fixtures` map
  assert.ok(mock.requests().some((q) => q.method === 'PUT' && q.url === '/presign/f_1'), 'bytes were PUT to the presigned URL');

  // Cleanup: the hosted fixture was deleted after the run.
  assert.ok(
    mock.requests().some((q) => q.method === 'DELETE' && q.url === '/api/p_TestProj/uploads/f_1'),
    'fixture was auto-deleted',
  );
});

// A camera app cannot produce a labelled frame inside the default 500ms pre-eval
// window: getUserMedia has to come up and the vision model (WASM + weights) has
// to download first. That warm-up does not fit in the eval body's own ~20s budget
// either, so the ONE window that isn't on the eval's clock has to be wide enough
// by default — otherwise every camera run either reads an empty DOM or trips the
// budget, and the caller learns both limits only by hitting them.
test('page eval --camera widens the pre-eval wait so a vision model can load', async () => {
  mock.reset();
  mockFixtureUpload('f_cam', 'https://media.gipity.ai/app-files/p_TestProj/2026-06/f_cam/rock.png');
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-cam', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-cam', { body: { data: {
    status: 'done', url: 'https://example.com', result: '"rock"', truncated: false,
  } } });

  const png = join(home, 'rock.png');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const projectDir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'page', 'eval', 'https://example.com', 'document.title', '--camera', png],
    { env: { HOME: home }, cwd: projectDir },
  );
  assert.equal(r.status, 0, r.stderr);

  const evalReq = mock.requests().find((q) => q.url === '/tools/browser/eval');
  const body = evalReq!.body as { waitMs: number; fakeMedia?: boolean; cameraUrl?: string };
  assert.equal(body.waitMs, 15_000, 'a --camera run waits long enough for the model to load');
  assert.equal(body.fakeMedia, true);
  assert.match(r.stderr, /vision model finish loading/);
});

// An empty read on a --camera run must NOT get the generic empty-state advice.
// That hint says "poll inside the body and raise --timeout" — sound on a normal
// page, actively wrong here: --camera loops ONE still, so a longer budget re-runs
// the same deterministic inference on the same pixels for the same nothing. The
// agent that filed this followed it into three escalating evals (60s → 70s → 80s)
// and learned nothing from any of them; the real question was always whether the
// FRAME was readable at all. Say that, and never advertise a bigger timeout.
test('page eval --camera: an empty detection says do-not-escalate, not raise --timeout', async () => {
  mock.reset();
  mockFixtureUpload('f_cam3', 'https://media.gipity.ai/app-files/p_TestProj/2026-06/f_cam3/fist.png');
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-cam3', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-cam3', { body: { data: {
    status: 'done', url: 'https://example.com', truncated: false,
    result: '{"gesture":null,"hands":null}',   // app ran fine; the model saw no hand
  } } });

  const png = join(home, 'fist.png');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const projectDir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'page', 'eval', 'https://example.com', 'readGesture()', '--camera', png],
    { env: { HOME: home }, cwd: projectDir },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /do not escalate/i);
  assert.match(r.stdout, /RAW output/);                  // the one run that disambiguates frame vs app
  assert.doesNotMatch(r.stdout, /raise --timeout/);      // the escalation that cost the turns
  assert.doesNotMatch(r.stdout, /A fixed --wait samples ONE moment/); // generic hint stayed away
});

// ── --step: N assertions, ONE page load ───────────────────────────────────────
// Verifying a camera app used to cost one full page load per assertion — and a
// camera page load is ~30s of getUserMedia + model download before it can answer
// anything. An agent checking a gesture, then the label, then the score therefore
// paid that boot three times (and got its batched shell loop killed by a command
// timeout). The page's expensive boot is a fixed cost: --step spends it once.
test('page eval --step runs extra expressions against the same page load', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-st', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-st', { body: { data: {
    status: 'done', url: 'https://example.com', result: '"Closed_Fist"', truncated: false,
    stepResults: ['"✊ Rock"', '{"score":"1","verdict":"You win"}'],
  } } });
  const r = await run([
    'page', 'eval', 'https://example.com', 'gesture()',
    '--step', "document.getElementById('see').textContent",
    '--step', '({ score: score.textContent, verdict: verdict.textContent })',
  ]);
  assert.equal(r.status, 0, r.stderr);

  const body = mock.requests().find((q) => q.url === '/tools/browser/eval')!.body as { steps?: string[] };
  assert.deepEqual(body.steps, [
    "document.getElementById('see').textContent",
    '({ score: score.textContent, verdict: verdict.textContent })',
  ], 'steps ride on the one eval request, not one request each');

  // Every step's result is reported, attributed to the expression that produced it.
  assert.match(r.stdout, /Closed_Fist/);
  assert.match(r.stdout, /Step 1/);
  assert.match(r.stdout, /✊ Rock/);
  assert.match(r.stdout, /Step 2/);
  assert.match(r.stdout, /You win/);
});

test('page eval refuses more steps than one page load carries', async () => {
  mock.reset();
  const r = await run([
    'page', 'eval', 'https://example.com', '1',
    '--step', '2', '--step', '3', '--step', '4', '--step', '5', '--step', '6',
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /at most 4 --step/);
  assert.equal(mock.requests().some((q) => q.url === '/tools/browser/eval'), false);
});

// ── --wait alongside --wait-for: gate, THEN settle ────────────────────────────
// The selector gate replaces the blind pre-eval sleep server-side, so a --wait
// passed with it was silently dropped: the script fired the instant the selector
// appeared and read a sequence still in flight (a round mid-countdown), which
// reads as an app bug — the agent that filed this went off debugging its own app.
// Both flags now mean what they say: wait for the gate, then settle.
test('page eval --wait with --wait-for settles AFTER the gate instead of being dropped', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-gs', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-gs', { body: { data: {
    status: 'done', url: 'https://example.com', result: '"done"', truncated: false,
  } } });
  const r = await run([
    'page', 'eval', 'https://example.com', 'verdict.textContent',
    '--wait-for', '[data-vision="ready"]', '--wait', '6000',
  ]);
  assert.equal(r.status, 0, r.stderr);

  const body = mock.requests().find((q) => q.url === '/tools/browser/eval')!.body as
    { expr: string; waitMs?: number; waitForSelector?: string; timeoutMs?: number };
  assert.equal(body.waitForSelector, '[data-vision="ready"]');
  // The settle moved INTO the script (the only place that runs after the gate),
  // so it is not also slept before it — and the script's budget covers it.
  assert.match(body.expr, /setTimeout\(r, 6000\)/);
  assert.match(body.expr, /return \(verdict\.textContent\);/);
  assert.equal(body.waitMs, 0, 'the pre-gate sleep must not double-count the settle');
  assert.equal(body.timeoutMs, EVAL_SCRIPT_BUDGET_MS + 6000);
});

// ...but a --wait with NO gate keeps its plain meaning: sleep, then evaluate.
test('page eval --wait without --wait-for stays a plain pre-eval sleep', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-gs2', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-gs2', { body: { data: {
    status: 'done', url: 'https://example.com', result: '"x"', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'document.title', '--wait', '4000']);
  assert.equal(r.status, 0, r.stderr);
  const body = mock.requests().find((q) => q.url === '/tools/browser/eval')!.body as { expr: string; waitMs?: number };
  assert.equal(body.waitMs, 4000);
  assert.doesNotMatch(body.expr, /setTimeout/);
});

// ...and an explicit --wait still wins: the widened default is a default, not a floor.
test('page eval --camera keeps an explicit --wait', async () => {
  mock.reset();
  mockFixtureUpload('f_cam2', 'https://media.gipity.ai/app-files/p_TestProj/2026-06/f_cam2/rock.png');
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-cam2', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-cam2', { body: { data: {
    status: 'done', url: 'https://example.com', result: '"rock"', truncated: false,
  } } });

  const png = join(home, 'rock2.png');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const projectDir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'page', 'eval', 'https://example.com', 'document.title', '--camera', png, '--wait', '3000'],
    { env: { HOME: home }, cwd: projectDir },
  );
  assert.equal(r.status, 0, r.stderr);
  const evalReq = mock.requests().find((q) => q.url === '/tools/browser/eval');
  assert.equal((evalReq!.body as { waitMs: number }).waitMs, 3000);
});

test('page eval --fixture still deletes the hosted file when the eval itself fails', async () => {
  mock.reset();
  mockFixtureUpload('f_2', 'https://media.gipity.ai/app-files/p_TestProj/2026-06/f_2/clip.mp3');
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-fxe', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-fxe', { body: { data: {
    status: 'error', httpStatus: 502, code: 'BROWSER_ERROR', reason: 'stayed on about:blank',
  } } });

  const fixturePath = join(home, 'clip.mp3');
  writeFileSync(fixturePath, Buffer.from([0, 1, 2]));
  const projectDir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'page', 'eval', 'https://example.com', '--fixture', fixturePath, 'fetch(fixtureUrl)'],
    { env: { HOME: home }, cwd: projectDir },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /about:blank/);
  // The eval failed, but the finally-block cleanup still ran.
  assert.ok(
    mock.requests().some((q) => q.method === 'DELETE' && q.url === '/api/p_TestProj/uploads/f_2'),
    'fixture was deleted even though the eval errored',
  );
});

// ── page test interactive mode (concurrent clients + overlap verification) ──
// Each client posts to /tools/browser/eval (a harness that runs --action then
// samples --observe) and polls the job. The mock keys off the per-client label
// spliced into the expr (Alice vs Bob) to hand back distinct sample series and
// in-page start/end timestamps, which the command uses to verify overlap.

/** A done eval record whose `result` is the JSON the in-browser harness returns. */
function evalDone(payload: { label: string; startedAt: number; endedAt: number; samples: unknown[] }) {
  return { body: { data: { status: 'done', url: 'https://app.example/', result: JSON.stringify(payload), truncated: false } } };
}

/** Register the eval kickoff + per-label poll routes for an interactive run. */
function mockInteractive(byLabel: Record<string, { label: string; startedAt: number; endedAt: number; samples: unknown[] }>) {
  mock.on('POST /tools/browser/eval', (req) => {
    const expr = String((req.body as { expr?: string }).expr ?? '');
    const label = Object.keys(byLabel).find((l) => expr.includes(l)) ?? 'unknown';
    return { body: { data: { evalJobId: `job-${label}`, status: 'queued' } } };
  });
  for (const [label, payload] of Object.entries(byLabel)) {
    mock.on(`GET /tools/browser/eval/job-${label}`, evalDone(payload));
  }
}

test('page test --observe runs concurrent clients, shows series, and confirms overlap', async () => {
  mock.reset();
  // Alice live [1000,9000], Bob live [2000,9000] → they coexist for ~7s. Each
  // sees the count rise from 1 to 2 the moment the other joins.
  mockInteractive({
    Alice: { label: 'Alice', startedAt: 1000, endedAt: 9000, samples: [1, 1, 2, 2, 2, 2] },
    Bob: { label: 'Bob', startedAt: 2000, endedAt: 9000, samples: [1, 2, 2, 2, 2, 2] },
  });
  const r = await run([
    'page', 'test', 'https://app.example/',
    '--clients', '2', '--labels', 'Alice,Bob',
    '--action', "document.querySelector('#name').value='{{label}}'; document.querySelector('form').requestSubmit();",
    '--observe', "document.querySelectorAll('.present').length",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /client 0 \(Alice\)/);
  assert.match(r.stdout, /client 1 \(Bob\)/);
  assert.match(r.stdout, /1 → 1 → 2/);
  assert.match(r.stdout, /overlapped for/);
  assert.doesNotMatch(r.stdout, /undefined/);
  // Per-client label was actually spliced into the action the browser ran.
  const evalPosts = mock.requests().filter((q) => q.url === '/tools/browser/eval');
  assert.equal(evalPosts.length, 2);
  assert.ok(evalPosts.some((q) => String((q.body as { expr: string }).expr).includes("value='Alice'")));
  assert.ok(evalPosts.some((q) => String((q.body as { expr: string }).expr).includes("value='Bob'")));
});

test('page test --observe flags a FALSE NEGATIVE and exits non-zero when clients never overlap', async () => {
  mock.reset();
  // Alice [1000,5000] ends before Bob [6000,10000] starts → zero overlap.
  mockInteractive({
    Alice: { label: 'Alice', startedAt: 1000, endedAt: 5000, samples: [1, 1, 1, 1, 1, 1] },
    Bob: { label: 'Bob', startedAt: 6000, endedAt: 10000, samples: [1, 1, 1, 1, 1, 1] },
  });
  const r = await run([
    'page', 'test', 'https://app.example/',
    '--clients', '2', '--labels', 'Alice,Bob',
    '--observe', "document.querySelectorAll('.present').length",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /did NOT overlap/);
  assert.match(r.stdout, /FALSE NEGATIVE/);
});

test('page test --observe --json emits overlapped flag and per-client results', async () => {
  mock.reset();
  mockInteractive({
    Alice: { label: 'Alice', startedAt: 1000, endedAt: 9000, samples: [1, 2] },
    Bob: { label: 'Bob', startedAt: 2000, endedAt: 9000, samples: [1, 2] },
  });
  const r = await run([
    'page', 'test', 'https://app.example/',
    '--clients', '2', '--labels', 'Alice,Bob', '--samples', '2',
    '--observe', "document.querySelectorAll('.present').length", '--json',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.mode, 'interactive');
  assert.equal(out.overlapped, true);
  assert.ok(out.overlapMs > 0);
  assert.equal(out.results.length, 2);
  assert.deepEqual(out.results[0].samples, [1, 2]);
});

test('page test --observe surfaces a client action failure and exits non-zero', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', (req) => {
    const expr = String((req.body as { expr?: string }).expr ?? '');
    return { body: { data: { evalJobId: expr.includes('Bob') ? 'job-Bob' : 'job-Alice', status: 'queued' } } };
  });
  mock.on('GET /tools/browser/eval/job-Alice', evalDone({ label: 'Alice', startedAt: 1000, endedAt: 9000, samples: [1, 2] }));
  // Bob's harness hit an action error - the result carries actionError instead of samples.
  mock.on('GET /tools/browser/eval/job-Bob', { body: { data: {
    status: 'done', url: 'https://app.example/', truncated: false,
    result: JSON.stringify({ label: 'Bob', startedAt: 2000, endedAt: 3000, samples: [], actionError: "Cannot read properties of null (reading 'value')" }),
  } } });
  const r = await run([
    'page', 'test', 'https://app.example/',
    '--clients', '2', '--labels', 'Alice,Bob',
    '--action', "document.querySelector('#missing').value='{{label}}';",
    '--observe', "document.querySelectorAll('.present').length",
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /action failed/);
});

// ── page test per-client URL substitution + unknown-token warning ──────────

test('page test substitutes {{i}} in the URL so each client loads a distinct URL', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run([
    'page', 'test', 'https://app.example/?name=Bot{{i}}',
    '--clients', '2', '--stagger', '0',
  ]);
  assert.equal(r.status, 0, r.stderr);
  const urls = mock.requests()
    .filter((q) => q.url === '/tools/browser/inspect')
    .map((q) => (q.body as { url: string }).url);
  assert.ok(urls.includes('https://app.example/?name=Bot0'), urls.join(', '));
  assert.ok(urls.includes('https://app.example/?name=Bot1'), urls.join(', '));
  // The literal placeholder must NOT survive into any request.
  assert.ok(!urls.some((u) => u.includes('{{i}}')));
});

test('page test warns when the URL carries an unrecognized {{...}} placeholder', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run([
    'page', 'test', 'https://app.example/?name=Bot{{name}}',
    '--clients', '1', '--stagger', '0',
  ]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Unrecognized placeholder \{\{name\}\}/);
  assert.match(r.stderr, /\{\{i\}\}/);
});

test('page test --observe substitutes {{label}} into the URL so each client gets a distinct role', async () => {
  mock.reset();
  // The kickoff keys the job off the per-client URL (role=host vs role=join),
  // proving one invocation launched two asymmetric roles concurrently.
  mock.on('POST /tools/browser/eval', (req) => {
    const url = String((req.body as { url?: string }).url ?? '');
    return { body: { data: { evalJobId: url.includes('role=host') ? 'job-host' : 'job-join', status: 'queued' } } };
  });
  mock.on('GET /tools/browser/eval/job-host', evalDone({ label: 'host', startedAt: 1000, endedAt: 9000, samples: ['lobby', 'game'] }));
  mock.on('GET /tools/browser/eval/job-join', evalDone({ label: 'join', startedAt: 2000, endedAt: 9000, samples: ['lobby', 'game'] }));
  const r = await run([
    'page', 'test', 'https://app.example/?role={{label}}',
    '--clients', '2', '--labels', 'host,join', '--samples', '2',
    '--observe', "document.querySelector('[data-screen]')?.dataset.screen",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /overlapped for/);
  const urls = mock.requests().filter((q) => q.url === '/tools/browser/eval').map((q) => (q.body as { url: string }).url);
  assert.equal(urls.length, 2);
  assert.ok(urls.includes('https://app.example/?role=host'), `expected a host URL, got ${urls.join(', ')}`);
  assert.ok(urls.includes('https://app.example/?role=join'), `expected a join URL, got ${urls.join(', ')}`);
});

test('page test --observe warns to stderr when --hold exceeds the cap, keeping json stdout clean', async () => {
  mock.reset();
  mockInteractive({
    Alice: { label: 'Alice', startedAt: 1000, endedAt: 9000, samples: [1, 2] },
    Bob: { label: 'Bob', startedAt: 2000, endedAt: 9000, samples: [1, 2] },
  });
  const r = await run([
    'page', 'test', 'https://app.example/',
    '--clients', '2', '--labels', 'Alice,Bob', '--samples', '2', '--hold', '45000',
    '--observe', "document.querySelectorAll('.present').length", '--json',
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /45000ms exceeds the 15000ms/);
  // stdout stays parseable JSON despite the warning.
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.hold, 15000);
});

test('page test --observe warns on an unrecognized {{token}} instead of sending it literally', async () => {
  mock.reset();
  mockInteractive({
    Alice: { label: 'Alice', startedAt: 1000, endedAt: 9000, samples: [1, 2] },
    Bob: { label: 'Bob', startedAt: 2000, endedAt: 9000, samples: [1, 2] },
  });
  const r = await run([
    'page', 'test', 'https://app.example/?name=Bot{{index}}',
    '--clients', '2', '--labels', 'Alice,Bob', '--samples', '2',
    '--observe', "document.querySelectorAll('.present').length",
  ]);
  assert.match(r.stderr, /Unrecognized placeholder/);
  assert.match(r.stderr, /\{\{index\}\}/);
  assert.match(r.stderr, /\{\{label\}\}/);
});

// ── screenshot --wait / --post-load-delay (request-body) ───────────────────

/** Pack a minimal screenshot tar (meta.json + one png) the CLI can parse. */
function screenshotTar(metaExtra: Record<string, unknown> = {}): Promise<Buffer> {
  const meta = {
    full: false, finalUrl: 'https://example.com/', title: 'Example', status: 200, performance: null,
    screenshots: [{
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      width: 1280, height: 720, screenshotSizeBytes: 4, phase: 'initial-load',
    }],
    ...metaExtra,
  };
  const pack = tarPack.pack();
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    pack.on('data', (c: Buffer) => chunks.push(c));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.entry({ name: 'meta.json' }, JSON.stringify(meta));
    pack.entry({ name: 'shot.png' }, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    pack.finalize();
  });
}

async function mockScreenshot(metaExtra: Record<string, unknown> = {}) {
  const tar = await screenshotTar(metaExtra);
  mock.on('POST /tools/browser/screenshot', { raw: tar, contentType: 'application/x-tar' });
}

// ── device emulation: --device mobile must request a real touch device ─────
// A phone-sized viewport alone leaves `'ontouchstart' in window` false, so an app
// that gates its mobile controls on touch renders its desktop layout instead.

type ShotBody = { viewports?: Array<{ width: number; height: number; device?: string }> };

test('gipity page screenshot --device mobile asks the server to emulate a touch device', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '--device', 'mobile', '-o', join(home, 'shot.png')]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  const vps = (req!.body as ShotBody).viewports!;
  assert.equal(vps.length, 1);
  assert.equal(vps[0].device, 'iPhone 15', '--device mobile must send a device name, not just a viewport');
});

test('gipity page screenshot --device desktop sends a plain viewport (no device emulation)', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '--device', 'desktop', '-o', join(home, 'shot.png')]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  const vps = (req!.body as ShotBody).viewports!;
  assert.equal(vps[0].device, undefined);
  assert.equal(vps[0].width, 1920);
});

test('gipity page screenshot accepts an exact device name', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '--device', 'Pixel 9', '-o', join(home, 'shot.png')]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  assert.equal((req!.body as ShotBody).viewports![0].device, 'Pixel 9');
});

test('gipity page screenshot rejects an unknown --device with the known names', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '--device', 'Nokia 3310']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Nokia 3310/);
  assert.match(r.stderr + r.stdout, /iPhone 15/);
});

test('gipity page inspect --device mobile resolves the alias to a server device name', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com', '--device', 'mobile']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/inspect');
  assert.equal((req!.body as { device?: string }).device, 'iPhone 15');
});

test('gipity page inspect without --device sends no device', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/inspect');
  assert.equal((req!.body as { device?: string }).device, undefined);
});

test('gipity page screenshot takes --wait, the name its sibling page commands use', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '--wait', '6000', '-o', join(home, 'shot.png')]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /undefined/);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  assert.equal((req!.body as { postLoadDelayMs?: number }).postLoadDelayMs, 6000, '--wait must reach the server, not be silently dropped');
});

test('gipity page screenshot lets the canonical --wait win over the --post-load-delay alias', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '--post-load-delay', '2000', '--wait', '6000', '-o', join(home, 'shot.png')]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  assert.equal((req!.body as { postLoadDelayMs?: number }).postLoadDelayMs, 6000);
});

// ── --wait-for parity across the page family ──────────────────────────────────
// `page eval` and `page inspect` both take --wait-for; screenshot took only a
// blind --wait. An agent that had just gated four evals on '[data-vision="ready"]'
// reached for the same flag on screenshot, got "unknown option", and fell back to
// guessing a duration (--wait 22000). One namespace, one wait vocabulary.
test('gipity page screenshot --wait-for gates the capture on a selector', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run([
    'page', 'screenshot', 'https://example.com',
    '--wait-for', '[data-vision="ready"]', '-o', join(home, 'shot.png'),
  ]);
  assert.equal(r.status, 0, r.stderr);
  const body = mock.requests().find((q) => q.url === '/tools/browser/screenshot')!.body as { action?: string };
  assert.match(body.action!, /data-vision/, 'the gate must reach the page as a pre-capture script');
  assert.match(body.action!, /querySelector/);
});

test('gipity page screenshot composes --wait-for with --action, gate first', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run([
    'page', 'screenshot', 'https://example.com',
    '--wait-for', '#ready', '--action', "document.getElementById('play').click()",
    '-o', join(home, 'shot.png'),
  ]);
  assert.equal(r.status, 0, r.stderr);
  const action = (mock.requests().find((q) => q.url === '/tools/browser/screenshot')!.body as { action: string }).action;
  assert.ok(action.indexOf('#ready') < action.indexOf("getElementById('play')"), 'the gate runs before the action');
});

// A gate that never matched must not hand back a plausible-looking picture of the
// wrong moment in silence — and it must not be reported as "--action failed" when
// the caller never passed one.
test('gipity page screenshot reports a --wait-for that never matched', async () => {
  mock.reset();
  await mockScreenshot({ actionError: 'EvalError: wait-for: nothing matched #never within 15000ms' });
  const r = await run([
    'page', 'screenshot', 'https://example.com', '--wait-for', '#never', '-o', join(home, 'shot.png'),
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--wait-for never matched/);
  assert.doesNotMatch(r.stdout, /--action failed/);
});

test('gipity page screenshot --wait-timeout without --wait-for is rejected', async () => {
  mock.reset();
  const r = await run(['page', 'screenshot', 'https://example.com', '--wait-timeout', '9000', '-o', join(home, 'shot.png')]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--wait-timeout only means something with --wait-for/);
});

// A camera app is a loading screen 1s after load: the model has not downloaded.
// Without a camera-sized default the caller has to guess a duration — which is
// exactly what happened (--wait 22000, picked out of the air).
test('gipity page screenshot --camera waits for the vision model by default', async () => {
  mock.reset();
  mockFixtureUpload('f_shot', 'https://media.gipity.ai/app-files/p_TestProj/2026-06/f_shot/rock.png');
  await mockScreenshot();
  const png = join(home, 'shot-rock.png');
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const projectDir = makeProjectDir({ apiBase: mock.apiBase });
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'page', 'screenshot', 'https://example.com', '--camera', png, '-o', join(home, 'shot.png')],
    { env: { HOME: home }, cwd: projectDir },
  );
  assert.equal(r.status, 0, r.stderr);
  const body = mock.requests().find((q) => q.url === '/tools/browser/screenshot')!.body as
    { postLoadDelayMs?: number; fakeMedia?: boolean };
  assert.equal(body.postLoadDelayMs, 15_000, 'a --camera capture must outlast the model load, not guess');
  assert.equal(body.fakeMedia, true);
  assert.match(r.stderr, /vision model finish loading/);
});

test('gipity page screenshot defaults to 1000ms when neither delay flag is given', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '-o', join(home, 'shot.png')]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  assert.equal((req!.body as { postLoadDelayMs?: number }).postLoadDelayMs, 1000);
});

test('gipity page screenshot help points to --action, --full, and page eval for a specific state', async () => {
  // For a state behind an interaction the help must name --action (the supported
  // lever) and warn off the base64-via-eval anti-pattern; for off-screen regions
  // it points at --full / page eval. Rendered on any bad flag too, so a guessed
  // flag lands on the answer instead of grepping --help in circles.
  const r = await run(['page', 'screenshot', '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Use --action to run JS in the page/);
  assert.match(r.stdout, /page eval/);
  assert.match(r.stdout, /--full captures the ENTIRE scrollable page/);
});

test('gipity page screenshot forwards --action to the server request body', async () => {
  mock.reset();
  await mockScreenshot();
  const action = "document.getElementById('play').click()";
  const r = await run(['page', 'screenshot', 'https://example.com', '--action', action, '-o', join(home, 'shot.png')]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  assert.equal((req!.body as { action?: string }).action, action, '--action must reach the server so it runs before capture');
});

test('gipity page screenshot omits action from the body when --action is absent', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '-o', join(home, 'shot.png')]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  assert.equal((req!.body as { action?: string }).action, undefined);
});

test('gipity page screenshot rejects a guessed JS-intent flag but still shows the state-capture guidance', async () => {
  // --js and friends are hidden decoys: rather than a bare "unknown option",
  // the error names the real flag (--action), and still renders this command's
  // help (with the 'after' block) so the very first guess lands on the answer.
  // (--eval is no longer a decoy — it's the sibling subcommand's name for this
  // exact capability, so it works as an alias; see the alias tests.)
  mock.reset();
  const r = await run(['page', 'screenshot', 'https://example.com', '--js', 'foo']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--js is not a flag on screenshot/);
  assert.match(r.stderr, /--action/);
  assert.match(r.stderr, /page eval|--full captures the ENTIRE scrollable page/);
  // It must NOT have actually captured against the server.
  assert.equal(mock.requests().some((q) => q.url === '/tools/browser/screenshot'), false);
});

// ── screenshot VFS history (save payload) ──────────────────────────────────
// From a linked project dir, the CLI asks the server to persist the capture to
// the project's screenshots/ history under the SAME filename it writes locally.

type SaveBody = { save?: { project_guid: string; names?: string[] } };

test('gipity page screenshot from a linked project sends save with matching names', async () => {
  mock.reset();
  await mockScreenshot();
  const proj = makeProjectDir();
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'page', 'screenshot', 'https://example.com'],
    { env: { HOME: home }, cwd: proj },
  );
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  const save = (req!.body as SaveBody).save;
  assert.ok(save, 'expected a save block when a project is linked');
  assert.equal(save!.project_guid, 'p_TestProj');
  assert.equal(save!.names!.length, 1);
  assert.match(save!.names![0], /^ss-example-com-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.png$/);
  // The local copy landed in the project's screenshots/ dir under that name.
  assert.ok(existsSync(join(proj, 'screenshots', save!.names![0])));
});

test('gipity page screenshot --ephemeral skips the history save', async () => {
  mock.reset();
  await mockScreenshot();
  const proj = makeProjectDir();
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'page', 'screenshot', 'https://example.com', '--ephemeral'],
    { env: { HOME: home }, cwd: proj },
  );
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  assert.equal((req!.body as SaveBody).save, undefined);
});

test('gipity page screenshot outside a project sends no save block', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '-o', join(home, 'noproj.png')]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  assert.equal((req!.body as SaveBody).save, undefined);
});

test('gipity page screenshot prints the Gipity history line when the server saved to VFS', async () => {
  mock.reset();
  await mockScreenshot({
    screenshots: [{
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      width: 1280, height: 720, screenshotSizeBytes: 4, phase: 'initial-load',
      vfs: {
        guid: 'file-abc12345', url: '/files/vfs/file-abc12345',
        thumb_url: '/files/thumbnail/file-abc12345', path: 'screenshots/ss-example-com-x.png',
      },
    }],
  });
  const proj = makeProjectDir();
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'page', 'screenshot', 'https://example.com'],
    { env: { HOME: home }, cwd: proj },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Gipity history.*screenshots\/ss-example-com-x\.png/);
});

// ── screenshot default filename helpers (pure) ─────────────────────────────

test('timestampSlug renders yyyy-mm-dd_hh-mm-ss, zero-padded, sortable', () => {
  // 2026-05-31 09:07:03 local time
  const slug = timestampSlug(new Date(2026, 4, 31, 9, 7, 3));
  assert.equal(slug, '2026-05-31_09-07-03');
  // No colons (path-safe) and lexical order tracks chronological order.
  assert.doesNotMatch(slug, /:/);
  const earlier = timestampSlug(new Date(2026, 4, 31, 9, 7, 2));
  assert.ok(earlier < slug);
});

test('defaultFilename composes ss-<slug>-<ts>.png, inserting viewport suffix when present', () => {
  const ts = '2026-05-31_09-07-03';
  assert.equal(defaultFilename('example-com', ts), 'ss-example-com-2026-05-31_09-07-03.png');
  assert.equal(
    defaultFilename('example-com', ts, '1280x720'),
    'ss-example-com-1280x720-2026-05-31_09-07-03.png',
  );
});

// ── page fetch (raw-asset verification + SPA-shell trap detection) ──────────
// page fetch makes real HTTP requests against the <url> argument (not the API),
// so we point it at the mock server's own paths. `mock.on('GET *', …)` simulates
// a static host's catch-all that returns 200 + index.html for unknown paths —
// the exact trap this command exists to catch.

const SHELL = '<!doctype html><html><head><title>App</title></head><body>shell</body></html>';

test('page fetch: OK when a file is deployed with the right content-type', async () => {
  mock.reset();
  mock.on('GET *', { status: 200, raw: SHELL, contentType: 'text/html; charset=utf-8' });
  mock.on('GET /app/llms.txt', { status: 200, raw: 'Gipity llms marker', contentType: 'text/plain; charset=utf-8' });
  const r = await run(['page', 'fetch', `${mock.apiBase}/app/`, 'llms.txt']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK\s+llms\.txt/);
  assert.match(r.stdout, /all 1 file/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('page fetch: MISSING when a missing file is served as the SPA shell with a 200', async () => {
  mock.reset();
  // Only the catch-all is registered → llms.txt comes back as the shell, 200.
  mock.on('GET *', { status: 200, raw: SHELL, contentType: 'text/html; charset=utf-8' });
  const r = await run(['page', 'fetch', `${mock.apiBase}/app/`, 'llms.txt']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /MISSING\s+llms\.txt/);
  assert.match(r.stdout, /SPA shell/);
  assert.doesNotMatch(r.stdout, /\bOK\b/);
});

test('page fetch: MISSING on an honest 404 (host without a catch-all fallback)', async () => {
  mock.reset();
  // Nothing registered → the mock 404s every path, including the probe.
  const r = await run(['page', 'fetch', `${mock.apiBase}/app/`, 'robots.txt']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /MISSING\s+robots\.txt/);
  assert.match(r.stdout, /HTTP 404/);
});

test('page fetch: WRONG-TYPE when a real file is served with the wrong content-type', async () => {
  mock.reset();
  mock.on('GET *', { status: 200, raw: SHELL, contentType: 'text/html' });
  // Real JSON body, but mislabeled as text/html (and distinct from the shell).
  mock.on('GET /app/agent.json', { status: 200, raw: '{"name":"gip"}', contentType: 'text/html' });
  const r = await run(['page', 'fetch', `${mock.apiBase}/app/`, 'agent.json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /WRONG-TYPE\s+agent\.json/);
  assert.match(r.stdout, /expected json/);
});

test('page fetch --json: per-file verdicts and ok=false on a mixed batch', async () => {
  mock.reset();
  mock.on('GET *', { status: 200, raw: SHELL, contentType: 'text/html' });
  mock.on('GET /app/llms.txt', { status: 200, raw: 'present', contentType: 'text/plain' });
  const r = await run(['page', 'fetch', `${mock.apiBase}/app/`, 'llms.txt', 'missing.txt', '--json']);
  assert.notEqual(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.failed, 1);
  assert.equal(out.shellFallback, true);
  const byPath = Object.fromEntries(out.files.map((f: { path: string }) => [f.path, f]));
  assert.equal(byPath['llms.txt'].verdict, 'OK');
  assert.equal(byPath['missing.txt'].verdict, 'MISSING');
});

test('page fetch: exit 0 with --json when every file checks out', async () => {
  mock.reset();
  mock.on('GET *', { status: 200, raw: SHELL, contentType: 'text/html' });
  mock.on('GET /app/llms.txt', { status: 200, raw: 'a', contentType: 'text/plain' });
  mock.on('GET /app/agent.json', { status: 200, raw: '{"ok":true}', contentType: 'application/json' });
  const r = await run(['page', 'fetch', `${mock.apiBase}/app/`, 'llms.txt', 'agent.json', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.failed, 0);
});

test('page fetch: MISSING (fetch failed) when the host is unreachable', async () => {
  // Port 1 on localhost refuses connections immediately and deterministically.
  const r = await run(['page', 'fetch', 'http://127.0.0.1:1/app/', 'llms.txt']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /MISSING\s+llms\.txt/);
  assert.match(r.stdout, /unreachable/);
});

// ── page eval --reload: two-phase persistence check ─────────────────────────
// Runs <expr>, reloads the page in place (storage preserved), then runs the
// --reload expression against the post-reload DOM — all one command.

test('gipity page eval --reload sends reloadExpr and prints an After reload section', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-rl', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-rl', { body: { data: {
    status: 'done', url: 'https://example.com', result: '"seeded"', truncated: false,
    reloadResult: '{"restored":true}', reloadTruncated: false,
  } } });
  const r = await run([
    'page', 'eval', 'https://example.com',
    "localStorage.setItem('k','v')",
    '--reload', "localStorage.getItem('k')",
  ]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/eval');
  assert.equal((req!.body as { reloadExpr?: string }).reloadExpr, "localStorage.getItem('k')");
  assert.match(r.stdout, /"seeded"/);
  assert.match(r.stdout, /After reload/);
  assert.match(r.stdout, /"restored":true/);
});

test('gipity page eval --reload-file reads the post-reload expression from a file', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-rlf', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-rlf', { body: { data: {
    status: 'done', url: 'https://example.com', result: '1', truncated: false,
    reloadResult: '2', reloadTruncated: false,
  } } });
  const reloadPath = join(home, 'after-reload.js');
  const reloadScript = 'return document.querySelectorAll(".todo").length;';
  writeFileSync(reloadPath, reloadScript);
  const r = await run(['page', 'eval', 'https://example.com', '1', '--reload-file', reloadPath, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/eval');
  assert.equal((req!.body as { reloadExpr?: string }).reloadExpr, reloadScript);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.reloadResult, '2');
});

test('gipity page eval rejects passing both --reload and --reload-file', async () => {
  mock.reset();
  const reloadPath = join(home, 'after-reload-2.js');
  writeFileSync(reloadPath, '1');
  const r = await run(['page', 'eval', 'https://example.com', '1', '--reload', '2', '--reload-file', reloadPath]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /either --reload <expr> or --reload-file/);
});

test('gipity page eval without --reload sends no reloadExpr and prints no reload section', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-norl', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-norl', { body: { data: {
    status: 'done', url: 'https://example.com', result: '1', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', '1']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/eval');
  assert.equal((req!.body as { reloadExpr?: string }).reloadExpr, undefined);
  assert.doesNotMatch(r.stdout, /After reload/);
});

// ── auth-state parity: eval + screenshot report the --auth outcome ──────────
// inspect already prints an Auth: line; eval and screenshot must too, so an
// agent can tell a signed-in run from "--auth silently no-op'd".

test('gipity page eval prints the auth line when the job record carries auth state', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-auth', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-auth', { body: { data: {
    status: 'done', url: 'https://example.com', result: '"hi"', truncated: false,
    auth: { requested: true, established: true },
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'document.title', '--auth']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /session established/);
});

test('gipity page eval warns when --auth did not establish a session', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-noauth', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-noauth', { body: { data: {
    status: 'done', url: 'https://example.com', result: '"hi"', truncated: false,
    auth: { requested: true, established: false, detail: 'Invalid or expired token' },
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'document.title', '--auth']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /session NOT established/);
  assert.match(r.stdout, /Invalid or expired token/);
});

test('gipity page screenshot prints the auth line from meta.json', async () => {
  mock.reset();
  await mockScreenshot({ auth: { requested: true, established: true } });
  const r = await run(['page', 'screenshot', 'https://example.com', '--auth', '-o', join(home, 'shot-auth.png')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /session established/);
});

test('gipity page screenshot warns when --auth did not establish a session', async () => {
  mock.reset();
  await mockScreenshot({ auth: { requested: true, established: false, detail: 'Missing token' } });
  const r = await run(['page', 'screenshot', 'https://example.com', '--auth', '-o', join(home, 'shot-noauth.png')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /session NOT established/);
  assert.match(r.stdout, /Missing token/);
});

// ── identity on EVERY run, not just --auth ones ─────────────────────────────
// An unflagged eval used to run on whatever session the sticky jar held — after
// one --auth run, "anonymous" checks silently ran signed in as the owner (false
// nudge results, real DB rows). The server now wipes the jar per call, and the
// CLI must SAY which identity the page ran as even when --auth is off, so an
// agent never has to infer it from a stray database row.

test('gipity page eval without --auth names the anonymous identity', async () => {
  mock.reset();
  mock.on('POST /tools/browser/eval', { body: { data: { evalJobId: 'job-anon', status: 'queued' } } });
  mock.on('GET /tools/browser/eval/job-anon', { body: { data: {
    status: 'done', url: 'https://example.com', result: '"hi"', truncated: false,
  } } });
  const r = await run(['page', 'eval', 'https://example.com', 'document.title']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /anonymous visitor/);
  assert.match(r.stdout, /--auth/);
});

test('gipity page inspect without --auth names the anonymous identity', async () => {
  mock.reset();
  mock.on('POST /tools/browser/inspect', { body: { data: baseBundle } });
  const r = await run(['page', 'inspect', 'https://example.com']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /anonymous visitor/);
});

test('gipity page screenshot without --auth names the anonymous identity', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '-o', join(home, 'shot-anon.png')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /anonymous visitor/);
});

// ── cross-command JS spelling: --eval works on screenshot, --action redirects on eval ──
// The same capability is spelled `eval` as a subcommand in one place and
// `--action` as a flag in another, so an agent that learned one spelling
// guesses wrong on the other. `--eval <js>` on screenshot is unambiguous —
// accept it as an alias instead of burning a turn on a redirect error.

test('gipity page screenshot accepts --eval as an alias for --action', async () => {
  mock.reset();
  await mockScreenshot();
  const js = "document.getElementById('play').click()";
  const r = await run(['page', 'screenshot', 'https://example.com', '--eval', js, '-o', join(home, 'shot-eval.png')]);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find((q) => q.url === '/tools/browser/screenshot');
  assert.equal((req!.body as { action?: string }).action, js, '--eval must reach the server as the action script');
});

test('gipity page screenshot rejects --action and --eval together', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '--action', 'a()', '--eval', 'b()']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /not both/);
});

test('gipity page eval redirects --action (the screenshot spelling) to the positional <expr>', async () => {
  mock.reset();
  const r = await run(['page', 'eval', 'https://example.com', '--action', 'document.title']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /--action is not a flag/);
  assert.match(r.stderr + r.stdout, /positional <expr>/);
  assert.equal(mock.requests().some((q) => q.url === '/tools/browser/eval'), false);
});

// A multi-line driver script echoed back in full buries the result underneath
// its own source, and an echo landing right above "(empty result)" reads like
// the parser rejected the script rather than like the script returned nothing.
test('summarizeExpr echoes a short one-liner verbatim', () => {
  assert.equal(summarizeExpr('document.title'), 'document.title');
  assert.equal(summarizeExpr('  document.title  '), 'document.title');
});

test('summarizeExpr collapses a multi-line script to its first line plus a shape summary', () => {
  const out = summarizeExpr("const a = 1;\nconst b = 2;\nreturn a + b;");
  assert.match(out, /^const a = 1;/);
  assert.match(out, /\+2 more lines/);
  assert.doesNotMatch(out, /return a \+ b/);
});

test('summarizeExpr counts only meaningful lines and singularizes', () => {
  const out = summarizeExpr("const a = 1;\n\n\nreturn a;");
  assert.match(out, /\+1 more line,/);
});

test('summarizeExpr truncates a long single-line expr', () => {
  const long = `document.querySelector('${'x'.repeat(200)}')`;
  const out = summarizeExpr(long);
  assert.ok(out.length < long.length);
  assert.match(out, /…/);
  assert.match(out, /chars\)$/);
});

// A --action that throws still produces a screenshot — of the page the action
// never touched. Reporting success there hands the caller an image of the wrong
// state and lets them "verify" a feature that never ran.
test('gipity page screenshot warns when --action failed and the image is undriven', async () => {
  mock.reset();
  await mockScreenshot({ actionError: "Cannot read properties of null (reading 'click')" });
  const r = await run(['page', 'screenshot', 'https://example.com', '--action', "document.querySelector('#nope').click()", '-o', join(home, 'shot-action-err.png')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--action failed/);
  assert.match(r.stdout, /reading 'click'/);
  assert.match(r.stdout, /BEFORE the action ran/);
});

test('gipity page screenshot says nothing about --action when it ran clean', async () => {
  mock.reset();
  await mockScreenshot();
  const r = await run(['page', 'screenshot', 'https://example.com', '--action', 'document.title = "x"', '-o', join(home, 'shot-action-ok.png')]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /--action failed/);
});

// ── --camera: a real webcam feed for vision apps ────────────────────────────
// A headless browser has no webcam, so without this a camera app's getUserMedia
// rejects and the app's whole pipeline (frames → model → app logic) never runs —
// which is what pushes agents into stubbing the model and exporting internals
// just to test around the missing device. A wrong file type must fail locally,
// before an upload and a browser launch, and must name what IS accepted.
test('gipity page eval --camera rejects a non-media file locally, naming the accepted types', async () => {
  mock.reset();
  const bad = join(home, 'notes.txt');
  writeFileSync(bad, 'not a frame');
  const r = await run(['page', 'eval', 'https://example.com', '--camera', bad, 'document.title']);
  assert.notEqual(r.status, 0);
  const out = r.stderr + r.stdout;
  assert.match(out, /unsupported file type/);
  assert.match(out, /\.png/);
  assert.match(out, /\.mp4/);
  // Points at the in-platform way to produce a frame rather than leaving the
  // caller to find one.
  assert.match(out, /gipity generate image/);
  // Nothing was uploaded — the validation is local.
  assert.equal(mock.requests().filter((q) => q.url.includes('/uploads/')).length, 0);
});

test('gipity page screenshot --camera rejects a non-media file locally', async () => {
  mock.reset();
  const bad = join(home, 'notes2.txt');
  writeFileSync(bad, 'not a frame');
  const r = await run(['page', 'screenshot', 'https://example.com', '--camera', bad]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unsupported file type/);
});

// The sandbox budget covers the WHOLE capture, and --action's own runtime is
// spent inside it. The server's timeout text says the page was never reached —
// true, but it reads as "platform-side, nothing you can do", which leaves a
// slow --action (waiting on a model download) looking innocent and the caller
// with no lever. When --action was set, the CLI names it.
test('augmentSandboxTimeout points a sandbox timeout at the --action that spent the budget', () => {
  const raw = 'The browser sandbox did not respond within 42s, so https://x/ was never captured.';
  const out = augmentSandboxTimeout(raw);
  assert.match(out, /never captured/);          // the server's own text survives
  assert.match(out, /--action/);
  assert.match(out, /--wait/);                  // the lever the caller actually has
});

// Any other failure passes through untouched — this must not editorialize on
// errors that have nothing to do with the sandbox clock.
test('augmentSandboxTimeout leaves unrelated failures alone', () => {
  const raw = 'Page screenshot failed: 404 Not Found';
  assert.equal(augmentSandboxTimeout(raw), raw);
});

// ── the client's patience must cover the work the caller asked for ──
// The eval job runs server-side and the CLI polls it. The client budget used to
// be `--wait + 60s`, which counted NONE of the other legs the caller can pay
// for: the eval body's own 20s in-page budget, --wait-for's timeout, and (worst)
// --camera's feed fetch/encode. A --camera run therefore blew a deadline that
// was never big enough to hold it, and the CLI reported the caller's expression
// as the problem. Every leg is now inside the budget.
test('evalWorkBudgetMs covers the eval body, not just the pre-eval wait', () => {
  // Even the plainest eval may legitimately use its full in-page budget.
  assert.ok(evalWorkBudgetMs({ waitMs: 500 }) > 500 + 19_000);
});

test('evalWorkBudgetMs counts --wait-for, the reload leg, and --camera setup', () => {
  const base = evalWorkBudgetMs({ waitMs: 1000 });
  assert.ok(evalWorkBudgetMs({ waitMs: 1000, waitForTimeoutMs: 30_000 }) >= base + 30_000);
  assert.equal(evalWorkBudgetMs({ waitMs: 1000, hasReload: true }), base * 2);
  assert.ok(evalWorkBudgetMs({ waitMs: 1000, hasCamera: true }) > base);
});

// The regression guard for the actual failure: a default --camera run's budget
// must comfortably exceed the 15s warm-up wait the same flag imposes. (The old
// budget WAS that wait, so the deadline expired on work still in flight.)
test('evalWorkBudgetMs leaves a default --camera run room to finish', () => {
  const budget = evalWorkBudgetMs({ waitMs: CAMERA_DEFAULT_WAIT_MS, hasCamera: true });
  assert.ok(budget > CAMERA_DEFAULT_WAIT_MS * 3, `camera budget too tight: ${budget}ms`);
});

// ── a missing local asset must say where it looked, and where the file IS ──
// The bare `ENOENT: ... stat './tmp/fist.jpg'` from the upload path cost an
// agent an ls + a mv to work out that its generated frames were one directory
// up. The error now resolves the path, names the cwd it resolved against, and
// finds the file by basename inside the project.
test('assertLocalAsset points at the file when it exists elsewhere in the project', () => {
  const proj = makeProjectDir({ apiBase: mock.apiBase });
  const stray = join(proj, 'fist.jpg');
  writeFileSync(stray, 'x');
  const cwd0 = process.cwd();
  process.chdir(proj);
  try {
    assert.throws(
      () => assertLocalAsset('--camera', './tmp/fist.jpg'),
      (err: Error) => {
        assert.match(err.message, /no such file/);
        assert.match(err.message, /tmp[/\\]fist\.jpg/);           // the path we tried, resolved
        assert.match(err.message, /--camera .*fist\.jpg/);        // the path that WOULD work
        assert.match(err.message, /DOES exist/);
        return true;
      },
    );
  } finally { process.chdir(cwd0); }
});

test('assertLocalAsset says so plainly when the file is nowhere, and passes an existing file', () => {
  const proj = makeProjectDir({ apiBase: mock.apiBase });
  const real = join(proj, 'ok.jpg');
  writeFileSync(real, 'x');
  assert.doesNotThrow(() => assertLocalAsset('--camera', real));
  assert.throws(() => assertLocalAsset('--fixture', join(proj, 'nope.jpg')), /Nothing named "nope\.jpg"/);
});

// ── slow render on a --camera run must never invite a wall-clock escalation ──
// A vision app has no loop to step: it infers once per painted frame. Telling it
// to call `core.advance()` is noise. And --camera loops ONE still image, so every
// painted frame is the same pixels and the model is deterministic on them: a
// re-run with a bigger --wait/--timeout is guaranteed to return the identical
// answer. An earlier version of this message said "few frames — raise --wait and
// re-read", and that is exactly what it bought: three escalating 60s/70s/80s
// evals that each re-ran the same inference on the same picture. Whatever the
// frame count, the verdict is the same and the suspects are the frame or the app.
test('slowRenderMessage on a camera run reports frames seen and refuses to escalate', () => {
  for (const [fps, waitMs, frames] of [[0.8, 9000, /7 frames/], [5, 15_000, /75 frames/]] as const) {
    const msg = slowRenderMessage(fps, { camera: true, waitMs });
    assert.match(msg, frames);                       // fps × wait — what the model actually saw
    assert.match(msg, /Do not escalate the wait/);
    assert.doesNotMatch(msg, /raise --wait/);        // the advice that burned the agent that filed this
    assert.doesNotMatch(msg, /core\.advance/);
  }
});

test('slowRenderMessage without a camera keeps the animation-clock advice', () => {
  const msg = slowRenderMessage(2, { camera: false, waitMs: 500 });
  assert.match(msg, /core\.advance/);
  assert.doesNotMatch(msg, /frames/);
});

// When the client DOES give up, the message must not send the caller at --wait.
// On a camera run the wait is what lets the vision model load, so "lower --wait"
// trades a loud timeout for a silent empty read — the advice that burned the
// agent that filed this. A negative budget expires the deadline immediately.
test('an eval that outlives the client budget never advises lowering --wait', async () => {
  await assert.rejects(
    () => pollEvalResult('job-never', -60_000),
    (err: Error) => {
      assert.match(err.message, /does NOT help/);
      assert.match(err.message, /not your expression being too big/);
      assert.match(err.message, /run the same command again/);
      assert.doesNotMatch(err.message, /narrow the expression/);
      return true;
    },
  );
});
