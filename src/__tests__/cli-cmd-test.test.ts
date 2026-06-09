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
