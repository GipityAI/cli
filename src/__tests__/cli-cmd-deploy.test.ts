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

test('gipity deploy dev prints phase results from server', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', { body: { data: {
    fileCount: 5,
    totalBytes: 12345,
    url: 'https://dev.gipity.ai/test/test-project/',
    target: 'dev',
    elapsedMs: 800,
    batch: 1,
    phases: [
      { name: 'files', status: 'ok', summary: '5 files uploaded' },
      { name: 'functions', status: 'ok', summary: '2 functions deployed' },
    ],
  } } });
  const r = await fresh(['deploy', 'dev', '--no-sync']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Deploy to dev/);
  assert.match(r.stdout, /files/);
  assert.match(r.stdout, /5 files uploaded/);
  assert.match(r.stdout, /Deployed to dev/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity deploy --json emits raw data', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', { body: { data: {
    fileCount: 1, totalBytes: 100, url: 'https://dev.gipity.ai/x/y/', target: 'dev', elapsedMs: 200, phases: [],
  } } });
  const r = await fresh(['deploy', 'dev', '--no-sync', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.target, 'dev');
  assert.equal(parsed.fileCount, 1);
});

test('gipity deploy fails when target is invalid', async () => {
  mock.reset();
  const r = await fresh(['deploy', 'staging', '--no-sync']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Target must be "dev" or "prod"/);
});
