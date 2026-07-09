import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCliAsync, makeTmpHome } from './helpers/spawn-cli.js';
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
  const r = await fresh(['sandbox', 'run', '--language', 'js', 'console.log("hello from sandbox")']);
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
  const r = await fresh(['sandbox', 'run', 'bash', 'touch out/result.txt']);
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

// The language is never guessed. A shell one-liner used to run as JavaScript and
// die with a Node SyntaxError at /work/_run.js - after a project sync and a server
// round trip. Now it fails locally, immediately, and names the three ways to pin it.
test('gipity sandbox run refuses to guess a language for inline code', async () => {
  resetMock();
  const r = await fresh(['sandbox', 'run', 'echo hi; node --version']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No language specified/i);
  assert.match(r.stderr, /sandbox run bash/);
  assert.match(r.stderr, /--language bash/);
  assert.match(r.stderr, /--file script\.sh/);
});

test('gipity sandbox run fails before syncing or calling the server when no language is pinned', async () => {
  resetMock();
  const r = await fresh(['sandbox', 'run', 'echo hi']);
  assert.notEqual(r.status, 0);
  const reqs = mock.requests();
  assert.ok(!reqs.some(q => q.url === '/projects/p_TestProj/sandbox/execute'), 'must not reach the server');
  assert.ok(!reqs.some(q => q.url.startsWith('/projects/p_TestProj/files/tree')), 'must not sync the project');
});

test('gipity sandbox run --file with an unrecognized extension asks for --language', async () => {
  resetMock();
  const d = makeProjectDir({ apiBase: mock.apiBase });
  writeFileSync(join(d, 'script.txt'), 'echo hi');
  const r = await runCliAsync(['--api-base', mock.apiBase, 'sandbox', 'run', '--file', 'script.txt'], { env: { HOME: home }, cwd: d });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Cannot infer the language/i);
  assert.match(r.stderr, /--language/);
});

test('gipity sandbox run surfaces a failing run\'s stderr as-is when the language was explicit', async () => {
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
  const r = await fresh(['sandbox', 'run', '--language', 'js', 'console.log("done")']);
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

// ── Malformed invocations are rejected before any project/network work ────────
//
// `sandbox run` used to call resolveProjectContext() first, so a command that
// could never run still paid for a project lookup - and outside a linked project
// dir that lookup is a real API round trip (the Home fallback fetches
// /projects/default) that can even fail with "Not logged in" and mask the actual
// mistake. Argument validation reads only the local filesystem, so it goes first.

/** Run from a NON-project cwd, where resolveProjectContext() would take the Home
 *  fallback and hit the API. Any request reaching the mock means we resolved the
 *  project before validating the args. */
function outsideProject(args: string[]) {
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: makeTmpHome() });
}

test('gipity sandbox run rejects shell-split inline code without touching the API', async () => {
  mock.reset();
  const r = await outsideProject(['sandbox', 'run', '--language', 'bash', 'echo', 'hi']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /Inline code must be a single argument, but 2 were received/);
  // The received fragments are the evidence for where the shell split it.
  assert.match(r.stderr, /1: echo/);
  assert.match(r.stderr, /2: hi/);
  assert.match(r.stderr, /--file script\.sh/);
  assert.deepEqual(mock.requests(), [], 'no API call should precede argument validation');
  assert.doesNotMatch(r.stderr, /project:/);
});

test('gipity sandbox run explains PowerShell quoting only when it sees interpolation', async () => {
  mock.reset();
  // The real-world break: `"... $(find ...) ... \"$f\" ..."` in PowerShell.
  const withSubshell = await outsideProject([
    'sandbox', 'run', '--language', 'bash', 'for f in $(find src -name', "'*.js');", 'do echo "$f"; done',
  ]);
  assert.equal(withSubshell.status, 1);
  assert.match(withSubshell.stderr, /PowerShell/);

  mock.reset();
  const plain = await outsideProject(['sandbox', 'run', '--language', 'bash', 'echo', 'hi']);
  assert.equal(plain.status, 1);
  // No `$(` or backtick in the args - don't blame a shell the caller isn't using.
  assert.doesNotMatch(plain.stderr, /PowerShell/);
});

test('gipity sandbox run rejects an invalid --language without touching the API', async () => {
  mock.reset();
  const r = await outsideProject(['sandbox', 'run', '--language', 'cobol', 'x = 1']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid language: cobol/);
  assert.deepEqual(mock.requests(), [], 'no API call should precede argument validation');
});

test('gipity sandbox run rejects inline code plus --file without touching the API', async () => {
  mock.reset();
  const script = join(makeTmpHome(), 'script.sh');
  writeFileSync(script, 'echo hi\n');
  const r = await outsideProject(['sandbox', 'run', '--file', script, 'echo hi']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /not both/);
  assert.deepEqual(mock.requests(), [], 'no API call should precede argument validation');
});
