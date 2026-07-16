import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { runCliAsync, makeTmpHome } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';
import { scratchRefsInCode } from '../commands/sandbox.js';

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
  // Stage the output files on disk and report them in the remote tree with a
  // matching contentHash, so the post-run sync is a no-op and they survive it.
  // That is what "the pull landed" looks like from the command's point of view.
  const d = makeProjectDir({ apiBase: mock.apiBase });
  const files = { 'out/result.txt': 'result\n', 'out/chart.png': 'png-bytes\n' };
  const remote = Object.entries(files).map(([path, body], i) => {
    mkdirSync(join(d, dirname(path)), { recursive: true });
    writeFileSync(join(d, path), body);
    return {
      path, size: Buffer.byteLength(body), modified: new Date(0).toISOString(),
      type: 'file', guid: `f_${i}`, serverVersion: 1,
      contentHash: createHash('sha256').update(body).digest('hex'),
    };
  });
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: '', stderr: '', durationMs: 100, timedOut: false,
    outputFiles: Object.keys(files),
  } } });
  let treeFetched = false;
  mock.on('GET /projects/p_TestProj/files/tree', () => {
    treeFetched = true;
    return { body: { data: remote } };
  });
  const r = await runCliAsync(['--api-base', mock.apiBase, 'sandbox', 'run', 'bash', 'touch out/result.txt'], { env: { HOME: home }, cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(treeFetched, 'expected sandbox run to trigger a sync (files/tree fetch)');
  assert.match(r.stdout, /Output files synced to this directory/);
  assert.match(r.stdout, /result\.txt/);
});

test('gipity sandbox run does not claim a local sync for files that never landed', async () => {
  resetMock();
  // The server reports output files but the sync pulls nothing down (empty
  // remote tree), so nothing reaches local disk. The command must say so rather
  // than printing "synced to this directory" for files the caller cannot open.
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: '', stderr: '', durationMs: 100, timedOut: false,
    outputFiles: ['out/result.txt'],
  } } });
  const r = await fresh(['sandbox', 'run', 'bash', 'touch out/result.txt']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /synced to this directory/);
  assert.match(r.stdout, /Output files saved to project/);
  assert.match(r.stdout, /gipity sync/);
});

test('gipity sandbox run nudges toward tmp/ when a bare-filename output lands at the project root', async () => {
  resetMock();
  // A stray root-level output (test.mp3) alongside a real asset under src/. Only
  // the root file gets the "will deploy / use tmp/" nudge; the src/ one does not.
  const d = makeProjectDir({ apiBase: mock.apiBase });
  const files = { 'test.mp3': 'probe\n', 'src/keeper.mp3': 'asset\n' };
  const remote = Object.entries(files).map(([path, body], i) => {
    mkdirSync(join(d, dirname(path)), { recursive: true });
    writeFileSync(join(d, path), body);
    return {
      path, size: Buffer.byteLength(body), modified: new Date(0).toISOString(),
      type: 'file', guid: `f_${i}`, serverVersion: 1,
      contentHash: createHash('sha256').update(body).digest('hex'),
    };
  });
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: '', stderr: '', durationMs: 100, timedOut: false,
    outputFiles: Object.keys(files),
  } } });
  mock.on('GET /projects/p_TestProj/files/tree', () => ({ body: { data: remote } }));
  const r = await runCliAsync(['--api-base', mock.apiBase, 'sandbox', 'run', 'bash', 'touch test.mp3 src/keeper.mp3'], { env: { HOME: home }, cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /test\.mp3 landed at the project root and will deploy/);
  assert.match(r.stdout, /write it under tmp\//);
  // The real asset under src/ is never flagged as a stray.
  assert.doesNotMatch(r.stdout, /src\/keeper\.mp3 landed at the project root/);
});

test('gipity sandbox run surfaces a truncation notice when the server clipped output', async () => {
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: 'partial', stderr: '', durationMs: 10, timedOut: false,
    stdoutTruncated: true,
  } } });
  const r = await fresh(['sandbox', 'run', '--language', 'js', 'console.log("x")']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /partial/);
  assert.match(r.stderr, /truncated at 256 KB/);
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

// The language is never guessed for CODE snippets - `x = 1` parses as Python
// AND bash-adjacent, `a[0]` as JS or Python, so a blanket default silently runs
// some inputs in the wrong interpreter. Those still fail locally, immediately,
// and name the three ways to pin the language.
test('gipity sandbox run refuses to guess a language for ambiguous inline code', async () => {
  resetMock();
  const r = await fresh(['sandbox', 'run', 'x = 1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No language specified/i);
  assert.match(r.stderr, /sandbox run bash/);
  assert.match(r.stderr, /--language bash/);
  assert.match(r.stderr, /--file script\.sh/);
});

// But an unambiguous shell COMMAND LINE runs as bash without ceremony - it was
// the single most common rejected invocation (`sandbox run "node tests/x.js"`),
// and no code snippet matches the command-line shape.
test('gipity sandbox run runs a bare command line as bash', async () => {
  resetMock();
  let posted: { language?: string; code?: string } | undefined;
  mock.on('POST /projects/p_TestProj/sandbox/execute', async (req) => {
    posted = req.body as { language?: string; code?: string };
    return { body: { data: { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 50, timedOut: false } } };
  });
  const r = await fresh(['sandbox', 'run', 'node tests/game.test.js']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posted?.language, 'bash');
  assert.equal(posted?.code, 'node tests/game.test.js');
});

test('gipity sandbox run fails before syncing or calling the server when no language is pinned', async () => {
  resetMock();
  const r = await fresh(['sandbox', 'run', 'x = 1']);
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

// `tmp/` (and the other scratch namespaces) are never synced, so they never
// reach the VFS the sandbox mirrors from. Passing one as --input used to fail
// inside the container with a bare "no such file"; it's now caught locally.
test('gipity sandbox run rejects a scratch --input path without touching the API', async () => {
  mock.reset();
  const r = await fresh(['sandbox', 'run', 'bash', '--input', 'tmp/frame.png', 'echo hi']);

  assert.equal(r.status, 1);
  assert.match(r.stderr, /never mirrored into the sandbox/);
  assert.match(r.stderr, /tmp\/frame\.png/);
  assert.match(r.stderr, /Stage inputs at a real project path/);
  assert.deepEqual(mock.requests(), [], 'no API call should precede the scratch-input check');
});

// The same trap one step subtler: a scratch file read from INSIDE the code body
// (not via --input). The auto-mirror skips the scratch namespaces, so the
// container would hit a bare "No such file" for a path the caller can see on
// local disk. It's caught pre-sync whether the code names it project-relative
// (`tmp/sample.md`) or mirror-absolute (`/work/tmp/sample.md`, the path inside
// the container where the mirror lands the project).
test('gipity sandbox run rejects a scratch input read from the code body', async () => {
  resetMock();
  const d = makeProjectDir({ apiBase: mock.apiBase });
  mkdirSync(join(d, 'tmp'), { recursive: true });
  writeFileSync(join(d, 'tmp/sample.md'), '# staged input');
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'sandbox', 'run', 'python', "print(open('tmp/sample.md').read())"],
    { env: { HOME: home }, cwd: d },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /never mirrored into the sandbox/);
  assert.match(r.stderr, /tmp\/sample\.md/);
  assert.deepEqual(mock.requests(), [], 'no API call should precede the scratch check');
});

test('gipity sandbox run rejects a /work/-prefixed scratch input read from the code body', async () => {
  resetMock();
  const d = makeProjectDir({ apiBase: mock.apiBase });
  mkdirSync(join(d, 'tmp'), { recursive: true });
  writeFileSync(join(d, 'tmp/sample.md'), '# staged input');
  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'sandbox', 'run', 'bash', 'pandoc /work/tmp/sample.md -o out.pdf'],
    { env: { HOME: home }, cwd: d },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /never mirrored into the sandbox/);
  // Reported project-relative - the /work/ mirror prefix is stripped.
  assert.match(r.stderr, /tmp\/sample\.md/);
  assert.doesNotMatch(r.stderr, /work\/tmp/);
  assert.deepEqual(mock.requests(), [], 'no API call should precede the scratch check');
});

// Writing OUTPUT under tmp/ is the supported "look once" path, not a trap: the
// file doesn't exist yet, so the guard must let it through to the server.
test('gipity sandbox run allows writing a scratch OUTPUT under tmp/', async () => {
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: '', stderr: '', durationMs: 10, timedOut: false,
    scratchFiles: [{ path: 'tmp/preview.png', contentBase64: Buffer.from('x').toString('base64') }],
  } } });
  const r = await fresh(['sandbox', 'run', 'bash', 'pdftoppm -png docs/report.pdf tmp/preview']);
  assert.equal(r.status, 0, r.stderr);
});

// Unit coverage for the candidate matcher: it must surface every scratch
// namespace (including the `*_tmp/` glob and the /work/-prefixed form) while
// leaving the container's own /tmp and word-boundary lookalikes alone.
test('scratchRefsInCode surfaces every scratch shape and ignores lookalikes', () => {
  assert.deepEqual(scratchRefsInCode("open('tmp/a.pdf')"), ['tmp/a.pdf']);
  assert.deepEqual(scratchRefsInCode('pandoc /work/tmp/a.md -o out'), ['tmp/a.md']);
  assert.deepEqual(scratchRefsInCode('cat frames_tmp/b.png'), ['frames_tmp/b.png']);
  assert.deepEqual(scratchRefsInCode('read .gipityscratch/c.txt'), ['.gipityscratch/c.txt']);
  // The container's own writable /tmp, a nested tmp, and word-boundary lookalikes
  // must NOT be flagged.
  assert.deepEqual(scratchRefsInCode('convert x.png /tmp/out.png'), []);
  assert.deepEqual(scratchRefsInCode('cat mytmp/x'), []);
  assert.deepEqual(scratchRefsInCode('cat src/tmp/x'), []);
});

// ── --discard-output: per-run "drop this output entirely" globs ──────────────
//
// The filtering happens SERVER-side (in the output extractor) - a client-side
// skip would still write the files into project storage and churn every later
// sync. So the CLI's whole job is (a) sending the globs in the POST body
// (wire name: noSyncOutput) and (b) reporting what the server says it dropped.

test('gipity sandbox run sends --discard-output globs in the POST body and prints the discarded list', async () => {
  resetMock();
  let posted: { noSyncOutput?: string[] } | undefined;
  mock.on('POST /projects/p_TestProj/sandbox/execute', async (req) => {
    posted = req.body as { noSyncOutput?: string[] };
    return { body: { data: {
      exitCode: 0, stdout: '', stderr: '', durationMs: 10, timedOut: false,
      outputFiles: ['docs/report.pdf'],
      skippedOutputFiles: ['docs/frames-1.ppm', 'docs/frames-2.ppm'],
    } } };
  });
  const r = await fresh(['sandbox', 'run', 'bash', 'pdftoppm docs/report.pdf docs/frames',
    '--discard-output', 'docs/frames*', '--discard-output', '*.ppm']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(posted?.noSyncOutput, ['docs/frames*', '*.ppm'], 'both repeated globs must reach the server');
  assert.match(r.stdout, /Discarded \(--discard-output\):/);
  assert.match(r.stdout, /docs\/frames-1\.ppm/);
  assert.match(r.stdout, /docs\/frames-2\.ppm/);
  // The kept output still prints under the normal heading.
  assert.match(r.stdout, /docs\/report\.pdf/);
});

test('gipity sandbox run omits noSyncOutput from the POST body when the flag is absent', async () => {
  resetMock();
  let posted: Record<string, unknown> | undefined;
  mock.on('POST /projects/p_TestProj/sandbox/execute', async (req) => {
    posted = req.body as Record<string, unknown>;
    return { body: { data: { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 10, timedOut: false } } };
  });
  const r = await fresh(['sandbox', 'run', 'bash', 'echo hi']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(posted, 'expected the execute call');
  assert.ok(!('noSyncOutput' in posted!), 'no flag means no noSyncOutput key - server default behavior');
  assert.doesNotMatch(r.stdout, /Discarded/);
});

test('gipity sandbox run rejects an empty --discard-output glob without touching the API', async () => {
  mock.reset();
  const r = await outsideProject(['sandbox', 'run', '--language', 'bash', 'echo hi', '--discard-output', '']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /non-empty glob/);
  assert.deepEqual(mock.requests(), [], 'no API call should precede glob validation');
});

// ── scratch outputs: tmp/ files come back local-only, never into the project ─
//
// The server never persists scratch-namespace outputs to project storage;
// instead it returns their bytes inline (scratchFiles) and the CLI lands them
// at the same relative path locally, where sync ignores them in both
// directions. This is the "inspect an artifact without keeping it" path.

test('gipity sandbox run materializes inline scratchFiles locally and reports them as local-only', async () => {
  resetMock();
  const d = makeProjectDir({ apiBase: mock.apiBase });
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: '', stderr: '', durationMs: 10, timedOut: false,
    scratchFiles: [
      { path: 'tmp/preview-1.png', contentBase64: Buffer.from('png-bytes').toString('base64') },
      { path: 'tmp/../../evil.txt', contentBase64: Buffer.from('nope').toString('base64') },
    ],
  } } });
  const r = await runCliAsync(['--api-base', mock.apiBase, 'sandbox', 'run', 'bash', 'pdftoppm -png docs/report.pdf tmp/preview'], { env: { HOME: home }, cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(d, 'tmp/preview-1.png'), 'utf8'), 'png-bytes', 'scratch bytes must land at the local path');
  assert.ok(!existsSync(join(d, '..', 'evil.txt')), 'a traversal path must not escape the project root');
  assert.match(r.stdout, /Scratch outputs \(local only/);
  assert.match(r.stdout, /tmp\/preview-1\.png/);
});

test('gipity sandbox run --json reports scratchFiles as the list of locally written paths', async () => {
  resetMock();
  const d = makeProjectDir({ apiBase: mock.apiBase });
  mock.on('POST /projects/p_TestProj/sandbox/execute', { body: { data: {
    exitCode: 0, stdout: '', stderr: '', durationMs: 10, timedOut: false,
    scratchFiles: [{ path: 'tmp/x.txt', contentBase64: Buffer.from('x').toString('base64') }],
  } } });
  const r = await runCliAsync(['--api-base', mock.apiBase, 'sandbox', 'run', 'bash', 'echo x > tmp/x.txt', '--json'], { env: { HOME: home }, cwd: d });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.scratchFiles, ['tmp/x.txt'], '--json must list paths, not base64 payloads');
  assert.equal(readFileSync(join(d, 'tmp/x.txt'), 'utf8'), 'x');
});

test('gipity sandbox run allows a non-scratch input that merely starts with "tmp"', async () => {
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', () => ({
    body: { data: { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 10, timedOut: false } },
  }));
  const r = await fresh(['sandbox', 'run', 'bash', '--input', 'tmpfile.png', 'echo hi']);

  assert.equal(r.status, 0);
  assert.match(r.stdout, /ok/);
});

// ── --code as a working alias for the positional inline code ──────────────────
// `--code "<code>"` is the natural first guess for inline code; it must run the
// code, not bounce into an unknown-option --help detour.
test('gipity sandbox run --code works as an alias for the positional inline code', async () => {
  resetMock();
  mock.on('POST /projects/p_TestProj/sandbox/execute', async (req) => {
    const body = req.body as { code: string; language: string };
    assert.equal(body.code, 'print(7)');
    assert.equal(body.language, 'python');
    return { body: { data: { exitCode: 0, stdout: '7', stderr: '', durationMs: 50, timedOut: false } } };
  });
  const r = await fresh(['sandbox', 'run', '--language', 'py', '--code', 'print(7)']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /7/);
});

test('gipity sandbox run --code still requires a pinned language, pre-network', async () => {
  resetMock();
  const r = await fresh(['sandbox', 'run', '--code', 'import this']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No language specified/);
  assert.equal(mock.requests().length, 0, 'must fail before any API call');
});

test('gipity sandbox run rejects --code plus a positional arg', async () => {
  resetMock();
  const r = await fresh(['sandbox', 'run', '--language', 'py', '--code', 'print(1)', 'print(2)']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /either positionally or via --code/);
  assert.equal(mock.requests().length, 0, 'must fail before any API call');
});
