// App environments in the CLI: `gipity deploy [env]`, the global `--env`
// flag, and `gipity env`. Mock server stands in for the platform API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => { mock = await startMockServer(); home = makeAuthedHome(); });
after(async () => { await mock.stop(); });

function cli(args: string[]) {
  const d = makeProjectDir({ apiBase: mock.apiBase });
  return runCliAsync(['--api-base', mock.apiBase, ...args], { env: { HOME: home }, cwd: d });
}

const deployed = (extra: Record<string, unknown> = {}) => ({ body: { data: {
  fileCount: 1, totalBytes: 10, url: 'https://app.gipity.ai/test-account/test-project/', target: 'prod', elapsedMs: 100,
  phases: [{ name: 'files', status: 'ok', summary: '1 files deployed' }, { name: 'functions', status: 'ok', summary: '1 registered' }],
  ...extra,
} } });

function deployBody() {
  const req = mock.requests().find((q) => q.url === '/projects/p_TestProj/deploy');
  assert.ok(req, 'deploy was never posted');
  return req!.body as Record<string, unknown>;
}

test('bare gipity deploy sends no env (the server decides: prod while there are no envs)', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', deployed({ env: 'prod' }));
  const r = await cli(['deploy', '--no-sync']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(deployBody().env, undefined);
  assert.equal(deployBody().target, undefined);
  assert.match(r.stdout, /Deploy to prod/);
  assert.match(r.stdout, /Deployed to prod/);
  assert.match(r.stdout, /Live: https:\/\/app\.gipity\.ai\//);
});

test('gipity deploy <env> sends it, names a new env, and gives its own function address', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', deployed({
    env: 'staging', target: 'dev', appGuid: 'p_StagEnv', created: true,
    url: 'https://dev.gipity.ai/test-account/test-project--staging/',
  }));
  const r = await cli(['deploy', 'staging', '--no-sync']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(deployBody().env, 'staging');
  assert.match(r.stdout, /Deploy to staging.*new environment/);
  assert.match(r.stdout, /Functions: POST .*\/api\/p_StagEnv\/fn\/<name>/);
  assert.match(r.stdout, /gipity fn list --env staging/);
  assert.doesNotMatch(r.stdout, /same address on dev and prod/);
});

test('gipity deploy --env staging is the same as gipity deploy staging', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', deployed({ env: 'staging', target: 'dev', appGuid: 'p_StagEnv' }));
  const r = await cli(['deploy', '--no-sync', '--env', 'staging']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(deployBody().env, 'staging');
  // deploy never resolves the env first (it may not exist yet).
  assert.equal(mock.requests().filter((q) => q.url.includes('/envs/')).length, 0);
});

test('--yes-destructive is forwarded', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', deployed({ env: 'prod' }));
  const r = await cli(['deploy', 'prod', '--no-sync', '--yes-destructive']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual({ env: deployBody().env, yes: deployBody().yesDestructive }, { env: 'prod', yes: true });
});

test('a bare deploy refused because the app has envs prints the server\'s message and fails', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', { status: 409, body: { error: {
    code: 'ENV_REQUIRED',
    message: 'This app has environments (dev), so say where to deploy: `gipity deploy dev` or `gipity deploy prod`.',
  } } });
  const r = await cli(['deploy', '--no-sync']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /say where to deploy/);
  assert.match(r.stdout + r.stderr, /gipity deploy prod/);
});

test('server hints after a prod deploy are printed', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', deployed({ env: 'prod', hints: ['This app has visitors. Keep prod stable by working in an environment: `gipity deploy dev`.'] }));
  const r = await cli(['deploy', '--no-sync']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /This app has visitors/);
});

test('--env re-points a project command at the env\'s project', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/envs/dev', { body: { data: { name: 'dev', guid: 'p_DevEnv', slug: 'test-project--dev' } } });
  mock.on('POST /api/p_DevEnv/fn/hello', { body: { data: { from: 'dev' } } });
  const r = await cli(['fn', 'call', 'hello', '--env', 'dev']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"from": ?"dev"/);
  assert.equal(mock.requests().filter((q) => q.url === '/api/p_TestProj/fn/hello').length, 0);
});

test('--env before the subcommand works too', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/envs/dev', { body: { data: { name: 'dev', guid: 'p_DevEnv', slug: 'test-project--dev' } } });
  mock.on('POST /api/p_DevEnv/fn/hello', { body: { data: { from: 'dev' } } });
  const r = await cli(['--env', 'dev', 'fn', 'call', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dev/);
});

test('--env with an unknown env fails with the server\'s list of envs', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/envs/nope', { status: 404, body: { error: { code: 'NOT_FOUND', message: 'No environment "nope". This app has: dev, staging' } } });
  const r = await cli(['fn', 'call', 'hello', '--env', 'nope']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /This app has: dev, staging/);
  assert.equal(mock.requests().filter((q) => q.url.startsWith('/api/')).length, 0);
});

test('gipity status --env shows the env and its URL', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/envs/staging', { body: { data: { name: 'staging', guid: 'p_StagEnv', slug: 'test-project--staging' } } });
  mock.on('GET *', { body: { data: {} } });
  const r = await cli(['status', '--json', '--env', 'staging']);
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout.trim());
  assert.equal(s.project.guid, 'p_StagEnv');
  assert.equal(s.project.env, 'staging');
  assert.equal(s.project.url, 'https://dev.gipity.ai/test-account/test-project--staging/');
});

test('gipity status without --env shows the prod URL', async () => {
  mock.reset();
  mock.on('GET *', { body: { data: {} } });
  const r = await cli(['status', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout.trim()).project.url, 'https://app.gipity.ai/test-account/test-project/');
});

test('gipity env list prints prod and each env', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/envs', { body: { data: {
    app: { guid: 'p_TestProj', name: 'Test', slug: 'test-project' },
    prod: { url: 'https://app.gipity.ai/test-account/test-project/' },
    envs: [
      { name: 'dev', guid: 'p_DevEnv', url: 'https://dev.gipity.ai/test-account/test-project/', lastDeploy: '2026-10-16T20:00:00Z', schedules: false, dbBytes: 2048, customDomains: [] },
      { name: 'staging', guid: 'p_StagEnv', url: 'https://dev.gipity.ai/test-account/test-project--staging/', lastDeploy: null, schedules: true, dbBytes: 0, customDomains: ['staging.example.com'] },
    ],
  } } });
  const r = await cli(['env']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /prod\s+https:\/\/app\.gipity\.ai\/test-account\/test-project\//);
  assert.match(r.stdout, /dev\s+https:\/\/dev\.gipity\.ai\/test-account\/test-project\/\s.*schedules off/);
  assert.match(r.stdout, /staging\s+.*never deployed.*schedules on.*staging\.example\.com/);
});

test('gipity env list with no envs says how to make one', async () => {
  mock.reset();
  mock.on('GET /projects/p_TestProj/envs', { body: { data: {
    app: { guid: 'p_TestProj', name: 'Test', slug: 'test-project' }, prod: { url: 'https://app.gipity.ai/a/b/' }, envs: [],
  } } });
  const r = await cli(['env', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gipity deploy dev/);
});

test('gipity env create / set / delete call the env routes', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/envs', { status: 201, body: { data: {
    name: 'qa', guid: 'p_QaEnv', url: 'https://dev.gipity.ai/test-account/test-project--qa/', phases: [{ name: 'files', status: 'ok', summary: 'ok' }],
  } } });
  mock.on('PATCH /projects/p_TestProj/envs/qa', { body: { data: { name: 'qa', schedules: true } } });
  mock.on('DELETE /projects/p_TestProj/envs/qa', { body: { data: { deleted: 'qa' } } });

  const created = await cli(['env', 'create', 'qa']);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Created qa/);
  assert.match(created.stdout, /test-project--qa/);

  const set = await cli(['env', 'set', 'qa', '--schedules', 'on']);
  assert.equal(set.status, 0, set.stderr);
  const patchReq = mock.requests().find((q) => q.method === 'PATCH');
  assert.deepEqual(patchReq?.body, { schedules: true });

  const bad = await cli(['env', 'set', 'qa', '--schedules', 'maybe']);
  assert.notEqual(bad.status, 0);

  const del = await cli(['-y', 'env', 'delete', 'qa']);
  assert.equal(del.status, 0, del.stderr);
  assert.match(del.stdout, /Deleted qa/);
});

test('gipity env delete prod and env create prod are refused locally', async () => {
  mock.reset();
  const del = await cli(['-y', 'env', 'delete', 'prod']);
  assert.notEqual(del.status, 0);
  const create = await cli(['env', 'create', 'prod']);
  assert.notEqual(create.status, 0);
  assert.equal(mock.requests().length, 0);
});
