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

test('gipity job list shows jobs with name + runtime + compute + version', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/jobs', { body: { data: [
    { name: 'align', runtime: 'python-3.11', compute: 'gpu-small', version: 2, on_complete: 'notify', description: 'Forced alignment' },
    { name: 'render', runtime: 'node-20', compute: 'cpu-large', version: 1, description: null },
  ] } });
  const r = await fresh(['job', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /align/);
  assert.match(r.stdout, /python-3\.11/);
  assert.match(r.stdout, /gpu-small/);
  assert.match(r.stdout, /v2/);
  assert.match(r.stdout, /→ notify/);
  assert.match(r.stdout, /render/);
  assert.match(r.stdout, /cpu-large/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity job submit <name> posts and prints run_guid + status', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/jobs/align/submit', { body: { data: { run_guid: 'jr_xx1234', status: 'queued', replayed: false } } });
  const r = await fresh(['job', 'submit', 'align', '{"audio":"foo.wav"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /jr_xx1234/);
  assert.match(r.stdout, /queued/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity job submit with --idempotency-key shows replayed marker', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/jobs/align/submit', { body: { data: { run_guid: 'jr_xx1234', status: 'success', replayed: true } } });
  const r = await fresh(['job', 'submit', 'align', '--idempotency-key', 'k1']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /jr_xx1234/);
  assert.match(r.stdout, /replayed/);
});

test('gipity job status <guid> renders progress + status', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/jobs/runs/jr_xx1234', { body: { data: {
    guid: 'jr_xx1234',
    status: 'running',
    progress_pct: 0.42,
    progress_message: 'thinking',
    duration_ms: null,
    error: null,
    output: null,
  } } });
  const r = await fresh(['job', 'status', 'jr_xx1234']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /running/);
  assert.match(r.stdout, /42%/);
  assert.match(r.stdout, /thinking/);
});

test('gipity job runs <name> lists per-run rows with status + duration + guid', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/jobs/align/runs', { body: { data: [
    { status: 'success', duration_ms: 1234, trigger_type: 'cli', guid: 'jr_a', created_at: '2026-05-01T10:00:00Z' },
    { status: 'failed',  duration_ms: 200,  trigger_type: 'cli', guid: 'jr_b', created_at: '2026-05-02T10:00:00Z', error: 'kaboom' },
  ] } });
  const r = await fresh(['job', 'runs', 'align']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /success/);
  assert.match(r.stdout, /1234ms/);
  assert.match(r.stdout, /jr_a/);
  assert.match(r.stdout, /failed/);
  assert.match(r.stdout, /kaboom/);
});

test('gipity job cancel <guid> sends DELETE and prints cancelled', async () => {
  mock.reset();
  mock.on('DELETE /projects/p_TestProj/jobs/runs/jr_xx1234', { body: { data: { success: true, status: 'cancelled' } } });
  const r = await fresh(['job', 'cancel', 'jr_xx1234']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cancelled/);
});

test('gipity job logs <guid> --no-follow does a one-shot GET (no stream)', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/jobs/runs/jr_xx1234', { body: { data: {
    guid: 'jr_xx1234',
    status: 'success',
    progress_pct: 1,
    output: { result: 'ok' },
    duration_ms: 500,
  } } });
  const r = await fresh(['job', 'logs', 'jr_xx1234', '--no-follow']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /success/);
  assert.match(r.stdout, /result/);
});

test('gipity job run-local fails clearly when jobs/<name>/ does not exist', async () => {
  // No mock interaction needed - this is a local-only path that exits before
  // any HTTP / Docker call.
  const r = await fresh(['job', 'run-local', 'definitely-not-a-job']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not found/i);
});

test('gipity job run-local with a mocked docker binary builds the right docker run command', async () => {
  // Install a fake `docker` on PATH that records its argv to a temp file and
  // exits 0. Then run-local should: (1) pass `docker info` probe, (2) shell out
  // with `docker run --rm --network bridge --memory 1g --cpus 1 ...`. We assert
  // on the recorded argv to pin the contract.
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const sandboxRoot = mkdtempSync(`${tmpdir()}/gipity-runlocal-test-`);
  // Project dir with a jobs/hello/main.py handler
  const projDir = join(sandboxRoot, 'proj');
  mkdirSync(join(projDir, 'jobs', 'hello'), { recursive: true });
  writeFileSync(join(projDir, 'jobs', 'hello', 'main.py'), '# @gipity:job runtime=python-3.11\nprint("ok")\n');
  // Make it a Gipity-linked project so requireConfig doesn't bail out.
  writeFileSync(join(projDir, '.gipity.json'), JSON.stringify({
    projectGuid: 'p_TestProj',
    projectSlug: 'proj',
    accountSlug: 'me',
    agentGuid: 'a_x',
    apiBase: mock.apiBase,
    ignore: [],
  }));

  // Fake docker shim - records argv to a file and exits 0.
  const fakeBin = join(sandboxRoot, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  const recordFile = join(sandboxRoot, 'docker-argv.txt');
  const fakeDocker = `#!/usr/bin/env bash
echo "$@" >> "${recordFile}"
exit 0
`;
  writeFileSync(join(fakeBin, 'docker'), fakeDocker);
  chmodSync(join(fakeBin, 'docker'), 0o755);

  const r = await runCliAsync(['--api-base', mock.apiBase, 'job', 'run-local', 'hello'], {
    env: {
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
    },
    cwd: projDir,
  });
  assert.equal(r.status, 0, r.stderr);

  const recorded = readFileSync(recordFile, 'utf-8');
  // Two invocations: docker info (probe) + docker run ...
  const lines = recorded.trim().split('\n');
  assert.ok(lines.length >= 2, `expected at least 2 docker invocations, got ${lines.length}: ${recorded}`);
  assert.match(lines[0], /^info$/);
  const runLine = lines.find(l => l.startsWith('run ')) ?? '';
  assert.match(runLine, /--rm/);
  assert.match(runLine, /--network bridge/);
  assert.match(runLine, /--memory 1g/);
  assert.match(runLine, /--cpus 1/);
  assert.match(runLine, /--user sandbox/);
  assert.match(runLine, /--workdir \/work/);
  assert.match(runLine, /-v .*\/jobs\/hello:\/work/);
  assert.match(runLine, /python3 \/work\/main\.py/);
});

test('gipity job run-local exits non-zero when docker is not on PATH', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const emptyBin = mkdtempSync(`${tmpdir()}/gipity-nodocker-`);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const projDir = mkdtempSync(`${tmpdir()}/gipity-nodocker-proj-`);
  mkdirSync(join(projDir, 'jobs', 'hello'), { recursive: true });
  writeFileSync(join(projDir, 'jobs', 'hello', 'main.py'), 'print("x")\n');
  writeFileSync(join(projDir, '.gipity.json'), JSON.stringify({
    projectGuid: 'p_TestProj', projectSlug: 'proj', accountSlug: 'me',
    agentGuid: 'a_x', apiBase: mock.apiBase, ignore: [],
  }));
  const r = await runCliAsync(['--api-base', mock.apiBase, 'job', 'run-local', 'hello'], {
    env: { HOME: home, PATH: emptyBin },
    cwd: projDir,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /docker daemon not reachable/i);
});

test('gipity job logs <guid> --follow parses SSE events and prints stdout/stderr chunks', async () => {
  // Pre-built SSE blob (mock server writes the body as one chunk + closes;
  // the CLI's reader still processes each `event:`/`data:` pair correctly).
  mock.reset();
  const sse = [
    `event: status\ndata: ${JSON.stringify({ status: 'running', progress_pct: null, progress_message: null, attempt: 1 })}\n\n`,
    `event: log\ndata: ${JSON.stringify({ type: 'stdout', chunk: 'hello stdout\n' })}\n\n`,
    `event: log\ndata: ${JSON.stringify({ type: 'stderr', chunk: 'an error\n' })}\n\n`,
    `event: status\ndata: ${JSON.stringify({ status: 'success', progress_pct: 1, progress_message: 'done', attempt: 1 })}\n\n`,
    `event: output\ndata: ${JSON.stringify({ result: 'ok' })}\n\n`,
  ].join('');
  mock.on('GET /projects/p_TestProj/jobs/runs/jr_xx1234/logs/stream', {
    raw: sse,
    contentType: 'text/event-stream',
  });
  const r = await fresh(['job', 'logs', 'jr_xx1234']);
  assert.equal(r.status, 0, `expected 0 got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stdout, /hello stdout/);
  assert.match(r.stderr, /an error/);
  assert.match(r.stderr, /running/);
  assert.match(r.stderr, /success/);
});
