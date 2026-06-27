import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

const RUN_GUID = 'tr_TestRun01';

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function fresh(args: string[]) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

test('gipity test --no-sync runs and prints pass/fail summary', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/test/run', { body: { data: { runGuid: RUN_GUID, status: 'running' } } });
  // First poll returns completed (single shot, so the loop exits immediately).
  mock.on(`GET /projects/p_TestProj/test/status/${RUN_GUID}`, { body: { data: {
    runGuid: RUN_GUID, status: 'passed', total: 3, passed: 3, failed: 0, skipped: 0,
    durationMs: 1234, totalFiles: 1, completedFiles: 1,
    startedAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:01Z', finishedAt: '2026-05-01T10:00:01Z',
    results: [
      { path: 'api/health.test.js', name: 'health endpoint', status: 'passed', durationMs: 50, retryCount: 0, isFlaky: false },
      { path: 'api/health.test.js', name: 'auth required',  status: 'passed', durationMs: 80, retryCount: 0, isFlaky: false },
      { path: 'api/users.test.js',  name: 'list users',     status: 'passed', durationMs: 120, retryCount: 0, isFlaky: false },
    ],
  } } });
  const r = await fresh(['test', '--no-sync']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 passed/);
  assert.match(r.stdout, /health endpoint/);
  assert.doesNotMatch(r.stdout, /undefined/);
  // The run prints a discoverable retrieval path so details can be re-fetched
  // by GUID later without re-running the (possibly paid) suite.
  assert.match(r.stdout, new RegExp(`gipity test status ${RUN_GUID} --json`));
});

test('gipity test --filter <path> runs tests for that path', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/test/run', { body: { data: { runGuid: RUN_GUID, status: 'running' } } });
  mock.on(`GET /projects/p_TestProj/test/status/${RUN_GUID}`, { body: { data: {
    runGuid: RUN_GUID, status: 'passed', total: 1, passed: 1, failed: 0, skipped: 0,
    durationMs: 321, totalFiles: 1, completedFiles: 1,
    startedAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:01Z', finishedAt: '2026-05-01T10:00:01Z',
    results: [
      { path: 'api/library.test.js', name: 'library endpoint', status: 'passed', durationMs: 30, retryCount: 0, isFlaky: false },
    ],
  } } });

  const r = await fresh(['test', '--filter', 'api/library', '--no-sync']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Running tests: api\/library/);
  assert.deepEqual(mock.requests()[0]?.body, { filterPath: 'api/library', timeout: 30000, retry: 0 });
});

test('gipity test <path> still sends the path as filterPath', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/test/run', { body: { data: { runGuid: RUN_GUID, status: 'running' } } });
  mock.on(`GET /projects/p_TestProj/test/status/${RUN_GUID}`, { body: { data: {
    runGuid: RUN_GUID, status: 'passed', total: 1, passed: 1, failed: 0, skipped: 0,
    durationMs: 321, totalFiles: 1, completedFiles: 1,
    startedAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:01Z', finishedAt: '2026-05-01T10:00:01Z',
    results: [
      { path: 'api/library.test.js', name: 'library endpoint', status: 'passed', durationMs: 30, retryCount: 0, isFlaky: false },
    ],
  } } });

  const r = await fresh(['test', 'api/library', '--no-sync']);

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Running tests: api\/library/);
  assert.deepEqual(mock.requests()[0]?.body, { filterPath: 'api/library', timeout: 30000, retry: 0 });
});

test('gipity test <path> fails clearly when no tests match', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/test/run', { body: { data: { runGuid: RUN_GUID, status: 'running' } } });
  mock.on(`GET /projects/p_TestProj/test/status/${RUN_GUID}`, { body: { data: {
    runGuid: RUN_GUID, status: 'passed', total: 0, passed: 0, failed: 0, skipped: 0,
    durationMs: 77, totalFiles: 0, completedFiles: 0,
    startedAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:01Z', finishedAt: '2026-05-01T10:00:01Z',
    results: [],
  } } });

  const r = await fresh(['test', 'api/library', '--no-sync']);

  assert.equal(r.status, 1);
  assert.match(r.stdout, /No tests matched filter: api\/library/);
});

test('gipity test emits newline heartbeats while running (non-TTY/background)', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/test/run', { body: { data: { runGuid: RUN_GUID, status: 'running' } } });
  let polls = 0;
  mock.on(`GET /projects/p_TestProj/test/status/${RUN_GUID}`, () => {
    polls++;
    const done = polls >= 3;  // stay "running" for the first couple of polls
    return { body: { data: {
      runGuid: RUN_GUID, status: done ? 'passed' : 'running',
      total: 1, passed: done ? 1 : 0, failed: 0, skipped: 0,
      durationMs: done ? 1234 : 0, totalFiles: 1, completedFiles: done ? 1 : 0,
      startedAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:01Z',
      finishedAt: done ? '2026-05-01T10:00:01Z' : null,
      results: done ? [
        { path: 'api/health.test.js', name: 'health endpoint', status: 'passed', durationMs: 50, retryCount: 0, isFlaky: false },
      ] : [],
    } } };
  });
  // CLI stdout is piped here (not a TTY), so the in-place \r progress is suppressed
  // and the heartbeat path must produce visible newline output instead.
  const r = await fresh(['test', '--no-sync']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /still running/);
  assert.match(r.stdout, /elapsed/);
  assert.match(r.stdout, /1 passed/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity test status <runGuid> shows current run state', async () => {
  mock.reset();
  mock.on(`GET /projects/p_TestProj/test/status/${RUN_GUID}`, { body: { data: {
    runGuid: RUN_GUID, status: 'passed', total: 5, passed: 5, failed: 0, skipped: 0,
    durationMs: 800, totalFiles: 2, completedFiles: 2,
    startedAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:01Z', finishedAt: '2026-05-01T10:00:01Z',
    results: [],
  } } });
  const r = await fresh(['test', 'status', RUN_GUID]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /passed/);
  assert.match(r.stdout, /5\/5 passed/);
});

test('gipity test results <runGuid> --json re-fetches a finished run without re-running', async () => {
  mock.reset();
  mock.on(`GET /projects/p_TestProj/test/status/${RUN_GUID}`, { body: { data: {
    runGuid: RUN_GUID, status: 'failed', total: 6, passed: 4, failed: 2, skipped: 0,
    durationMs: 13467, totalFiles: 2, completedFiles: 2,
    startedAt: '2026-05-01T10:00:00Z', updatedAt: '2026-05-01T10:00:01Z', finishedAt: '2026-05-01T10:00:01Z',
    results: [
      { path: 'api/gen.test.js', name: 'image gen', status: 'failed', durationMs: 9000, error: 'boom', retryCount: 0, isFlaky: false },
    ],
  } } });
  // `results` is an alias for `status`; no /test/run POST should be issued.
  const r = await fresh(['test', 'results', RUN_GUID, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.runGuid, RUN_GUID);
  assert.equal(parsed.failed, 2);
  assert.equal(parsed.results[0].error, 'boom');
  assert.ok(!mock.requests().some((q) => q.url.endsWith('/test/run')), 'must not start a new run');
});

test('gipity test list shows test files grouped by directory (no run)', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/test/list', { body: { data: {
    files: [
      { path: 'api', name: 'health.test.js', vfsPath: 'tests/api/health.test.js' },
      { path: 'api', name: 'users.test.js', vfsPath: 'tests/api/users.test.js' },
      { path: 'e2e/portal', name: 'login.test.js', vfsPath: 'tests/e2e/portal/login.test.js' },
      { path: '', name: 'smoke.test.js', vfsPath: 'tests/smoke.test.js' },
    ],
    total: 4,
  } } });
  const r = await fresh(['test', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Test files: 4/);
  assert.match(r.stdout, /health\.test\.js/);
  assert.match(r.stdout, /e2e\/portal/);
  // A file with no directory groups under a "(root)" header rather than a blank line.
  assert.match(r.stdout, /\(root\)/);
  assert.match(r.stdout, /smoke\.test\.js/);
  // No run should be kicked off.
  assert.ok(!mock.requests().some((q) => q.url.endsWith('/test/run')), 'list must not start a run');
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity test list <path> passes filterPath to the server', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/test/list', { body: { data: {
    files: [{ path: 'api', name: 'health.test.js', vfsPath: 'tests/api/health.test.js' }],
    total: 1,
  } } });
  const r = await fresh(['test', 'list', 'api']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /filter: api/);
  assert.ok(mock.requests().some((q) => q.url.includes('filterPath=api')), 'must send filterPath query');
});

test('gipity test list --json emits the raw payload', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/test/list', { body: { data: {
    files: [{ path: 'api', name: 'health.test.js', vfsPath: 'tests/api/health.test.js' }],
    total: 1,
  } } });
  const r = await fresh(['test', 'list', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.total, 1);
  assert.equal(parsed.files[0].vfsPath, 'tests/api/health.test.js');
});

test('gipity test list reports clearly when no test files match', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/test/list', { body: { data: { files: [], total: 0 } } });
  const r = await fresh(['test', 'list', 'nope']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No test files matched filter: nope/);
});

test('gipity test history shows recent runs', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/test/history', { body: { data: [
    { run_guid: RUN_GUID, status: 'passed', total: 3, passed: 3, failed: 0, duration_ms: 500, started_at: '2026-05-01T10:00:00Z' },
  ] } });
  const r = await fresh(['test', 'history']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Test History/);
  assert.match(r.stdout, /3\/3 passed/);
});
