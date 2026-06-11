// Real platform e2e for `gipity page test` URL parameterization and
// `gipity test results` re-fetch. Skipped unless GIPITY_E2E=1.
//
// Nothing here is mocked: it deploys a real web-fullstack app, then
//   - launches real headless browser clients at a URL carrying {{i}} and proves
//     each client's page ACTUALLY saw a distinct substituted value — the page
//     itself logs its ?name= param to the console, and we assert on the console
//     lines that came back from the real browsers (issue #55's failure was four
//     clients all literally named "Bot{{i}}"; this would catch it end-to-end);
//   - runs the real test suite once, then re-fetches the finished run by GUID
//     via `gipity test results <guid> --json` and proves via `test history`
//     that NO second run was started (issue #55's other failure: the only way
//     to see failure detail was to re-run the whole — possibly paid — suite).
//
// Cost profile: free platform CRUD + one fullstack deploy + two headless page
// loads + one sandboxed test run (no LLM tokens). Uses dev-bypass auth (magic
// code 914914) with an `ec-` prefixed @914-6.com email so the platform
// suppresses real outbound mail (see platform/CLAUDE.md).
//
//   GIPITY_E2E=1                     enable the suite
//   GIPITY_E2E_API_BASE=...          default https://a.gipity.ai
//   GIPITY_E2E_EMAIL=ec-cli-e2e@914-6.com
//   GIPITY_E2E_CODE=914914
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runCli, makeTmpHome } from './helpers/spawn-cli.js';

const E2E_ENABLED = process.env['GIPITY_E2E'] === '1';
const API_BASE = process.env['GIPITY_E2E_API_BASE'] ?? 'https://a.gipity.ai';
const EMAIL = process.env['GIPITY_E2E_EMAIL'] ?? 'ec-cli-e2e@914-6.com';
const CODE = process.env['GIPITY_E2E_CODE'] ?? '914914';

if (E2E_ENABLED && !EMAIL.startsWith('ec')) {
  throw new Error(`E2E test email must start with "ec" to suppress real outbound mail: got "${EMAIL}"`);
}

// The deployed page logs this marker + its ?name= param; the assertion reads it
// back out of each real client's captured console.
const PAGE = 'e2e-page-test.html';
const MARKER = 'E2E_NAME=';

describe('cli-e2e-page-test-live', { skip: !E2E_ENABLED && 'set GIPITY_E2E=1 to run' }, () => {
  const tmpHome = makeTmpHome();
  const projectDir = mkdtempSync(join(tmpdir(), 'gipity-e2e-pagetest-'));
  const projectSlug = `gip-e2e-pt-${Date.now().toString(36)}`;
  const env = { HOME: tmpHome };
  let appUrl = '';
  let runGuid = '';

  const cli = (args: string[], opts: { timeout?: number } = {}) =>
    runCli(['--api-base', API_BASE, ...args], {
      env,
      cwd: projectDir,
      timeout: opts.timeout ?? 60000,
      enableUpdater: false,
    });

  before(() => {
    const r = cli(['login', '--email', EMAIL, '--code', CODE]);
    assert.equal(r.status, 0, `login failed: ${r.stderr || r.stdout}`);
  });

  after(() => {
    try { cli(['-y', 'project', 'delete', projectSlug]); } catch { /* ignore */ }
    try { cli(['logout']); } catch { /* ignore */ }
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('1. scaffolds web-fullstack and injects a page that echoes its ?name= param', () => {
    const init = cli(['init', projectSlug]);
    assert.equal(init.status, 0, `init failed: ${init.stderr || init.stdout}`);

    const add = cli(['add', 'web-fullstack'], { timeout: 120000 });
    assert.equal(add.status, 0, `add web-fullstack failed: ${add.stderr || add.stdout}`);
    assert.ok(existsSync(join(projectDir, 'src')), 'web-fullstack did not produce src/');
    assert.ok(existsSync(join(projectDir, 'tests')), 'web-fullstack did not produce tests/');

    writeFileSync(join(projectDir, 'src', PAGE), `<!doctype html>
<html><head><meta charset="utf-8"><title>page-test e2e</title></head>
<body><script>
  console.log(${JSON.stringify(MARKER)} + new URLSearchParams(location.search).get('name'));
</script></body></html>
`);
  });

  it('2. deploys to dev and captures the live URL', () => {
    const r = cli(['deploy', 'dev', '--json'], { timeout: 180000 });
    assert.equal(r.status, 0, `deploy failed: ${r.stderr || r.stdout}`);
    const data = JSON.parse(r.stdout) as { url?: string };
    assert.ok(data.url && /^https?:\/\//.test(data.url), `deploy did not return a url: ${r.stdout}`);
    appUrl = data.url.replace(/\/?$/, '/');
  });

  it('3. page test {{i}}: each REAL headless client loads a distinct URL and its page sees the substituted name', () => {
    const r = cli(
      ['page', 'test', `${appUrl}${PAGE}?name=Bot{{i}}`, '--clients', '2', '--stagger', '0', '--wait', '3000', '--json'],
      { timeout: 120000 },
    );
    assert.equal(r.status, 0, `page test failed: ${r.stderr || r.stdout}`);
    const out = JSON.parse(r.stdout.trim()) as {
      problems: number;
      results: { i: number; lines: string[]; error?: string }[];
    };
    assert.equal(out.results.length, 2);
    for (const c of out.results) assert.equal(c.error, undefined, `client ${c.i} errored: ${c.error}`);

    // The substituted value round-tripped through a real browser: the deployed
    // page read it from ITS OWN location.search and logged it.
    const linesFor = (i: number) => out.results.find((c) => c.i === i)?.lines ?? [];
    assert.ok(linesFor(0).some((l) => l.includes(`${MARKER}Bot0`)), `client 0 console: ${JSON.stringify(linesFor(0))}`);
    assert.ok(linesFor(1).some((l) => l.includes(`${MARKER}Bot1`)), `client 1 console: ${JSON.stringify(linesFor(1))}`);

    // Issue #55's exact failure mode: the literal placeholder reaching the app.
    const allLines = out.results.flatMap((c) => c.lines);
    assert.ok(!allLines.some((l) => l.includes('{{i}}')), `literal {{i}} reached a real client: ${JSON.stringify(allLines)}`);
  });

  it('4. gipity test: real run passes and prints the re-fetch hint with the run GUID', () => {
    const r = cli(['test'], { timeout: 180000 });
    assert.equal(r.status, 0, `test run failed: ${r.stderr || r.stdout}`);
    // Don't pin the template's exact test count — just that it ran and passed.
    assert.match(r.stdout, /✓ example returns ok/);
    assert.match(r.stdout, /\d+ passed/);
    assert.doesNotMatch(r.stdout, /\d+ failed/);

    const m = r.stdout.match(/Re-fetch this run's details \(no re-run\): gipity test status (tr_\w+) --json/);
    assert.ok(m, `re-fetch hint missing from run output:\n${r.stdout}`);
    runGuid = m![1]!;
  });

  it('5. gipity test results <guid> --json re-fetches the SAME stored run with full detail', () => {
    const r = cli(['test', 'results', runGuid, '--json'], { timeout: 30000 });
    assert.equal(r.status, 0, `results fetch failed: ${r.stderr || r.stdout}`);
    // --json must not be swallowed by the parent command (the optsWithGlobals
    // fix): stdout must be machine-parseable run detail, not the human render.
    const data = JSON.parse(r.stdout.trim()) as {
      runGuid: string; status: string; total: number; passed: number; failed: number;
      results: { name: string; status: string }[];
    };
    assert.equal(data.runGuid, runGuid, 'must return the run we already paid for, not a new one');
    assert.ok(data.passed >= 1, `expected stored passes: ${r.stdout}`);
    assert.equal(data.failed, 0);
    assert.ok(data.results.some((t) => t.name === 'example returns ok' && t.status === 'passed'),
      `stored per-test detail missing: ${r.stdout}`);
  });

  it('6. test history --json parses and shows exactly one run — the re-fetch did NOT start a new run', () => {
    const r = cli(['test', 'history', '--json'], { timeout: 30000 });
    assert.equal(r.status, 0, `history failed: ${r.stderr || r.stdout}`);
    const runs = JSON.parse(r.stdout.trim()) as { run_guid: string }[];
    assert.equal(runs.length, 1, `expected exactly the one original run, got: ${r.stdout}`);
    assert.equal(runs[0]!.run_guid, runGuid);
  });
});
