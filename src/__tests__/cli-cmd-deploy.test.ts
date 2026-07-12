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

test('gipity deploy database-cap failure points at db list --all / db drop', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', { body: { data: {
    fileCount: 19, totalBytes: 1000, target: 'dev', elapsedMs: 500, batch: 1,
    phases: [
      { name: 'files', status: 'ok', summary: '19 files deployed' },
      { name: 'database', status: 'failed', summary: 'Failed to create database: Maximum of 100 databases reached. Drop one first.' },
      { name: 'functions', status: 'skipped', summary: 'previous phase failed' },
    ],
  } } });
  const r = await fresh(['deploy', 'dev', '--no-sync']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /gipity db list --all/);
  assert.match(r.stdout, /gipity db drop <name> --project <slug>/);
  assert.match(r.stdout, /Deploy failed/);
});

// `deploy --inspect` verifies the page it just shipped — but an app whose first
// paint waits on an async boot (a vision model, a WASM download) inspects as an
// empty page unless you can settle first. An agent reached for exactly this
// (`deploy dev --inspect --wait-for '[data-vision="ready"]'`), got a usage dump,
// and fell back to two separate commands. The settle knobs now live here too,
// and asking for one is itself the request to inspect.
test('gipity deploy --inspect forwards --wait-for to the inspect probe', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', { body: { data: {
    fileCount: 1, totalBytes: 100, url: 'https://dev.gipity.ai/x/y/', target: 'dev', elapsedMs: 200, phases: [],
  } } });
  mock.on('POST /tools/browser/inspect', { body: { data: {
    url: 'https://dev.gipity.ai/x/y/', title: 'Y', console: [], failedResources: [],
    timing: { ttfb: 1, domReady: 2, load: 3 }, elementCount: 1, totalBytes: 1,
    largeResources: [], renderBlocking: [], oversizedImages: [], lcp: null, overflow: null,
  } } });
  const r = await fresh(['deploy', 'dev', '--no-sync', '--inspect', '--wait-for', '[data-vision="ready"]', '--wait-timeout', '20000']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/inspect');
  assert.ok(req, 'inspect never ran');
  const body = req!.body as { waitForSelector?: string; waitForTimeoutMs?: number };
  assert.equal(body.waitForSelector, '[data-vision="ready"]');
  assert.equal(body.waitForTimeoutMs, 20000);
});

test('gipity deploy treats a settle flag as a request to inspect', async () => {
  mock.reset();
  mock.on('POST /projects/p_TestProj/deploy', { body: { data: {
    fileCount: 1, totalBytes: 100, url: 'https://dev.gipity.ai/x/y/', target: 'dev', elapsedMs: 200, phases: [],
  } } });
  mock.on('POST /tools/browser/inspect', { body: { data: {
    url: 'https://dev.gipity.ai/x/y/', title: 'Y', console: [], failedResources: [],
    timing: { ttfb: 1, domReady: 2, load: 3 }, elementCount: 1, totalBytes: 1,
    largeResources: [], renderBlocking: [], oversizedImages: [], lcp: null, overflow: null,
  } } });
  const r = await fresh(['deploy', 'dev', '--no-sync', '--wait', '3000']);
  assert.equal(r.status, 0, r.stderr);
  const req = mock.requests().find(q => q.url === '/tools/browser/inspect');
  assert.ok(req, 'a --wait alone should still inspect');
  assert.equal((req!.body as { waitMs?: number }).waitMs, 3000);
});

test('gipity deploy fails when target is invalid', async () => {
  mock.reset();
  const r = await fresh(['deploy', 'staging', '--no-sync']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Target must be "dev" or "prod"/);
});
