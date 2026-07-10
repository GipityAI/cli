/**
 * `gipity bug report` must not lose the report it's trying to file just
 * because the thing it's reporting (a dead session, no network) is also what
 * blocks filing it. A submit that fails for a retryable reason (401, 5xx,
 * network) gets written to a local queue instead of erroring out, and that
 * queue is flushed opportunistically on the next login or bug report.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;

before(async () => { mock = await startMockServer(); });
after(async () => { await mock.stop(); });

function queueDir(home: string): string {
  return join(home, '.gipity', 'bug-queue');
}

function seedQueuedReport(home: string): void {
  mkdirSync(queueDir(home), { recursive: true });
  writeFileSync(join(queueDir(home), 'stale-report.json'), JSON.stringify({
    projectGuid: 'p_TestProj',
    category: 'cli',
    severity: 'S3',
    summary: 'stranded from an earlier outage',
  }));
}

test('gipity bug report queues locally when submit is unrecoverable (401) and says so', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/bug-report/submit', {
    status: 401,
    body: { error: { code: 'UNAUTHORIZED', message: 'Session expired' } },
  });
  mock.on('POST /auth/refresh', {
    status: 401,
    body: { error: { code: 'UNAUTHORIZED', message: 'Refresh token rejected' } },
  });
  const home = makeAuthedHome();
  const dir = makeProjectDir({ apiBase: mock.apiBase });

  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'bug', 'report', '--category', 'cli', '--severity', 'S2', '--summary', 'deploy fails session expired'],
    { env: { HOME: home }, cwd: dir },
  );

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /saved locally/i);
  assert.match(r.stdout, /next time you log in or file another report/i);

  const files = readdirSync(queueDir(home));
  assert.equal(files.length, 1);
  const queued = JSON.parse(readFileSync(join(queueDir(home), files[0]), 'utf-8'));
  assert.equal(queued.projectGuid, 'p_TestProj');
  assert.equal(queued.category, 'cli');
  assert.equal(queued.summary, 'deploy fails session expired');
});

test('gipity bug report surfaces a non-retryable failure (400) and does not queue it', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/bug-report/submit', {
    status: 400,
    body: { error: { code: 'BAD_REQUEST', message: 'category not recognized by the server' } },
  });
  const home = makeAuthedHome();
  const dir = makeProjectDir({ apiBase: mock.apiBase });

  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'bug', 'report', '--category', 'cli', '--severity', 'S2', '--summary', 'a report the server rejects'],
    { env: { HOME: home }, cwd: dir },
  );

  assert.notEqual(r.status, 0, 'a validation failure must not be swallowed as a soft success');
  assert.match(r.stdout + r.stderr, /category not recognized/);
  assert.doesNotMatch(r.stdout, /saved locally/i);
  assert.throws(() => readdirSync(queueDir(home)), 'nothing should have been queued');
});

test('gipity login delivers a queued bug report on success', async () => {
  mock.reset();
  mock.on('POST /auth/verify', { body: {
    accessToken: `${Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url')}.sig`,
    refreshToken: 'refresh-token',
    isNewUser: false,
  } });
  mock.on('POST /api/p_TestProj/services/bug-report/submit', {
    status: 201,
    body: { data: { report_guid: 'bug_recovered1' } },
  });
  const home = makeAuthedHome();
  seedQueuedReport(home);

  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'login', '--email', 'ec-test@914-6.com', '--code', '914914'],
    { env: { HOME: home } },
  );

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Logged in/);
  assert.match(r.stdout, /Delivered 1 queued bug report/i);
  assert.equal(readdirSync(queueDir(home)).length, 0, 'the queued report should be cleared after delivery');
});

test('gipity bug report flushes a previously queued report before filing the new one', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/bug-report/submit', {
    status: 201,
    body: { data: { report_guid: 'bug_new0001' } },
  });
  const home = makeAuthedHome();
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  seedQueuedReport(home);

  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'bug', 'report', '--category', 'cli', '--severity', 'S3', '--summary', 'brand new friction report'],
    { env: { HOME: home }, cwd: dir },
  );

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Delivered 1 previously queued bug report/i);
  assert.match(r.stdout, /bug_new0001/);
  assert.equal(readdirSync(queueDir(home)).length, 0);

  const submits = mock.requests().filter(q => q.url.endsWith('/bug-report/submit'));
  assert.equal(submits.length, 2, 'one for the flushed report, one for the new one');
});

test('gipity status delivers a queued bug report when the session is valid (the "back online" signal)', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/bug-report/submit', {
    status: 201,
    body: { data: { report_guid: 'bug_viastatus' } },
  });
  const home = makeAuthedHome();
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  seedQueuedReport(home);

  const r = await runCliAsync(
    ['--api-base', mock.apiBase, 'status'],
    { env: { HOME: home }, cwd: dir },
  );

  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /delivered 1 queued bug report/i);
  assert.equal(readdirSync(queueDir(home)).length, 0);
});

test('gipity status does not attempt to flush when the session itself is expired', async () => {
  mock.reset();
  const home = makeAuthedHome({ accessToken: 'fake-jwt' });
  // Overwrite auth.json with a refresh token that is already expired, so
  // sessionExpired() is true and status must not touch the network at all.
  const authPath = join(home, '.gipity', 'auth.json');
  const expiredJwt = `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 })).toString('base64url')}.s`;
  writeFileSync(authPath, JSON.stringify({
    accessToken: 'fake-jwt',
    refreshToken: expiredJwt,
    email: 'ec-test@914-6.com',
    expiresAt: new Date(Date.now() - 3600 * 1000).toISOString(),
  }));
  const dir = makeProjectDir({ apiBase: mock.apiBase });
  seedQueuedReport(home);

  const r = await runCliAsync(['--api-base', mock.apiBase, 'status'], { env: { HOME: home }, cwd: dir });

  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /delivered.*queued bug report/i);
  assert.equal(readdirSync(queueDir(home)).length, 1, 'the queued report must remain untouched');
  assert.equal(mock.requests().filter(q => q.url.endsWith('/bug-report/submit')).length, 0);
});
