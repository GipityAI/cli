import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function fresh(args: string[]) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

test('gipity sandbox run prints stdout from the server', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: 'hello from sandbox', stderr: '', durationMs: 100, timedOut: false,
  } } });
  const r = await fresh(['sandbox', 'run', 'console.log("hello from sandbox")']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hello from sandbox/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity sandbox run with --language python posts language=python', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/sandbox/execute', async (req) => {
    const body = req.body as { language: string };
    assert.equal(body.language, 'python');
    return { body: { data: { exitCode: 0, stdout: '42', stderr: '', durationMs: 50, timedOut: false } } };
  });
  const r = await fresh(['sandbox', 'run', '--language', 'python', 'print(42)']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /42/);
});

test('gipity sandbox run auto-pulls output files to the local cwd', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: '', stderr: '', durationMs: 100, timedOut: false,
    outputFiles: ['out/result.txt', 'out/chart.png'],
  } } });
  // When the run reports output files, the command must invoke sync to pull
  // them down - proven here by the sync's remote-tree fetch being hit.
  let treeFetched = false;
  mock.on('GET /projects/p_TestProj/files/tree', () => {
    treeFetched = true;
    return { body: { data: [] } };
  });
  const r = await fresh(['sandbox', 'run', 'touch out/result.txt']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(treeFetched, 'expected sandbox run to trigger a sync (files/tree fetch)');
  assert.match(r.stdout, /Output files synced to this directory/);
  assert.match(r.stdout, /result\.txt/);
});

test('gipity sandbox run does NOT sync when there are no output files', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: 'done', stderr: '', durationMs: 100, timedOut: false,
  } } });
  // No outputFiles => no sync. The files/tree route is intentionally left
  // unmocked; if the command synced anyway it would hit it and fail.
  let treeFetched = false;
  mock.on('GET /projects/p_TestProj/files/tree', () => {
    treeFetched = true;
    return { body: { data: [] } };
  });
  const r = await fresh(['sandbox', 'run', 'console.log("done")']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(treeFetched, false, 'expected no sync when the run produced no output files');
});
