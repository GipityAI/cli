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

test('gipity sandbox run refuses --timeout above the wall-clock cap before submitting', async () => {
  mock.reset();
  let hit = false;
  mock.on('POST /projects/p_TestProj/sandbox/execute', () => {
    hit = true;
    return { body: { data: { exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false } } };
  });
  const r = await fresh(['sandbox', 'run', '--timeout', '120', 'console.log(1)']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /capped at 10s/);
  assert.equal(hit, false, 'must not POST to the server when over the cap');
});

test('gipity sandbox run surfaces the real wall-clock limit on a gateway 504', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { status: 504, raw: 'Gateway Time-out', contentType: 'text/html' });
  const r = await fresh(['sandbox', 'run', 'console.log(1)']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /exceeded sandbox wall-clock limit of 10s/);
  assert.doesNotMatch(r.stderr, /Gateway Time-out/);
});

test('gipity sandbox run lists output files when present', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: '', stderr: '', durationMs: 100, timedOut: false,
    outputFiles: ['out/result.txt', 'out/chart.png'],
  } } });
  const r = await fresh(['sandbox', 'run', 'touch out/result.txt']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Output files saved/);
  assert.match(r.stdout, /result\.txt/);
});
