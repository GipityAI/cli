import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

// `sandbox run` now syncs the local tree up before every run so inputs staged
// outside an editor (a Bash `cp`/`ffmpeg`, etc.) are mirrored into the sandbox.
// That sync fetches the remote tree, so every test needs the route stubbed;
// default it to an empty tree. Tests that track the fetch override this after.
function resetMock() {
  mock.reset();
  mock.on('GET /projects/p_TestProj/files/tree', () => ({ body: { data: [] } }));
}

test('gipity sandbox run prints stdout from the server', async () => {
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: 'hello from sandbox', stderr: '', durationMs: 100, timedOut: false,
  } } });
  const r = await fresh(['sandbox', 'run', 'console.log("hello from sandbox")']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hello from sandbox/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity sandbox run with --language python posts language=python', async () => {
  resetMock();
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
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: '', stderr: '', durationMs: 100, timedOut: false,
    outputFiles: ['out/result.txt', 'out/chart.png'],
  } } });
  // When the run reports output files, the command pulls them down - proven by
  // the "synced to this directory" message and the filename in stdout below.
  // (A remote-tree fetch alone no longer distinguishes pull from the pre-run
  // push, which always fetches the tree too.)
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

test('gipity sandbox run --file reads the body and infers language from the extension', async () => {
  resetMock();
  let posted: { code: string; language: string } | undefined;
  mock.on('POST /projects/p_TestProj/sandbox/execute', async (req) => {
    posted = req.body as { code: string; language: string };
    return { body: { data: { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 10, timedOut: false } } };
  });
  const d = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(d, 'build_report.py'), 'print("from file")\n');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'sandbox', 'run', '--file', 'build_report.py'], { env: { HOME: home }, cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posted?.code, 'print("from file")\n');
  assert.equal(posted?.language, 'python');
});

test('gipity sandbox run <interpreter> <file> shorthand reads the file and pins the language', async () => {
  resetMock();
  let posted: { code: string; language: string } | undefined;
  mock.on('POST /projects/p_TestProj/sandbox/execute', async (req) => {
    posted = req.body as { code: string; language: string };
    return { body: { data: { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 10, timedOut: false } } };
  });
  const d = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(d, 'build_report.py'), 'print("from file")\n');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'sandbox', 'run', 'python', 'build_report.py'], { env: { HOME: home }, cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posted?.code, 'print("from file")\n');
  assert.equal(posted?.language, 'python');
});

test('gipity sandbox run node <file> shorthand maps node to javascript', async () => {
  resetMock();
  let posted: { language: string } | undefined;
  mock.on('POST /projects/p_TestProj/sandbox/execute', async (req) => {
    posted = req.body as { language: string };
    return { body: { data: { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 10, timedOut: false } } };
  });
  const d = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(d, 'app.js'), 'console.log(1)\n');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'sandbox', 'run', 'node', 'app.js'], { env: { HOME: home }, cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posted?.language, 'javascript');
});

test('gipity sandbox run <interpreter> <inline-code> pins the language for a non-file body', async () => {
  resetMock();
  let posted: { code: string; language: string } | undefined;
  mock.on('POST /projects/p_TestProj/sandbox/execute', async (req) => {
    posted = req.body as { code: string; language: string };
    return { body: { data: { exitCode: 0, stdout: 'hi', stderr: '', durationMs: 10, timedOut: false } } };
  });
  const r = await fresh(['sandbox', 'run', 'bash', 'echo hi']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posted?.language, 'bash');
  assert.equal(posted?.code, 'echo hi');
});

test('gipity sandbox run hints at the JS default when a shell snippet fails as JavaScript', async () => {
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 1, stdout: '', stderr: "/work/_run.js:1\necho hi\n^^^^\nSyntaxError: Unexpected identifier 'hi'\n    at wrapSafe (node:internal/modules/cjs/loader:1464:18)",
    durationMs: 10, timedOut: false,
  } } });
  const r = await fresh(['sandbox', 'run', 'echo hi; node --version']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ran as JavaScript/);
  assert.match(r.stderr, /--language bash/);
});

test('gipity sandbox run does NOT hint at the JS default when the language was explicit', async () => {
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 1, stdout: '', stderr: 'SyntaxError: bad', durationMs: 10, timedOut: false,
  } } });
  const r = await fresh(['sandbox', 'run', '--language', 'bash', 'echo hi']);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /ran as JavaScript/);
});

test('gipity sandbox run rejects passing both inline code and --file', async () => {
  resetMock();
  const d = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(d, 'x.js'), 'console.log(1)\n');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'sandbox', 'run', '--file', 'x.js', 'console.log(2)'], { env: { HOME: home }, cwd: d });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not both/);
});

test('gipity sandbox run pushes local inputs up before running, even with no output files', async () => {
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: 'done', stderr: '', durationMs: 100, timedOut: false,
  } } });
  // The sandbox mirrors server state, so the CLI syncs the local tree up before
  // executing - otherwise a Bash-staged input would be invisible to the run.
  // Proven by the remote-tree fetch being hit even though this run produced no
  // output files (so no post-run pull happened - only the pre-run push).
  let treeFetched = false;
  mock.on('GET /projects/p_TestProj/files/tree', () => {
    treeFetched = true;
    return { body: { data: [] } };
  });
  const r = await fresh(['sandbox', 'run', 'console.log("done")']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(treeFetched, 'expected sandbox run to push local inputs up before executing');
});

test('gipity sandbox run syncs local inputs up before the execute call', async () => {
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: 'ok', stderr: '', durationMs: 10, timedOut: false,
  } } });
  const r = await fresh(['sandbox', 'run', 'bash', 'identify foo.png']);
  assert.equal(r.status, 0, r.stderr);
  // Order matters: the input push (files/tree fetch) must land before execute,
  // or the run mirrors stale server state and misses freshly-staged inputs.
  const reqs = mock.requests();
  const treeIdx = reqs.findIndex(q => q.method === 'GET' && q.url.startsWith('/projects/p_TestProj/files/tree'));
  const execIdx = reqs.findIndex(q => q.method === 'POST' && q.url === '/projects/p_TestProj/sandbox/execute');
  assert.ok(treeIdx >= 0, 'expected a pre-run sync (files/tree fetch)');
  assert.ok(execIdx >= 0, 'expected the execute call');
  assert.ok(treeIdx < execIdx, 'expected the input sync to happen before execute');
});
