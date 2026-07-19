/**
 * `gipity status` used to treat a live `GET /users/me` call as a pure
 * token-validity probe and threw away the account it returned - so a session
 * that had silently landed in the WRONG account (bug cli#S2) still rendered
 * as fully healthy. These tests cover the ownership cross-check and the
 * apiBase-divergence display added to close that gap.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome, makeProjectDir } from './helpers/test-home.js';

let mock: MockServer;

before(async () => { mock = await startMockServer(); });
after(async () => { await mock.stop(); });

test('gipity status shows no mismatch when the live account matches the linked project', async () => {
  mock.reset();
  mock.on('GET /users/me', { body: { data: { accountSlug: 'acme' } } });
  const home = makeAuthedHome();
  const dir = makeProjectDir({ accountSlug: 'acme', apiBase: mock.apiBase });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'status'], { env: { HOME: home }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /differs from this project's account/);
});

test('gipity status warns when the live account differs from the linked project\'s account', async () => {
  mock.reset();
  mock.on('GET /users/me', { body: { data: { accountSlug: 'home-x7f2' } } });
  const home = makeAuthedHome();
  const dir = makeProjectDir({ accountSlug: 'acme', apiBase: mock.apiBase });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'status'], { env: { HOME: home }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /differs from this project's account/);
  assert.match(r.stdout, /home-x7f2/);
  assert.match(r.stdout, /acme/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity status --json reports probe:"mismatch" and the live account, keeping existing keys intact', async () => {
  mock.reset();
  mock.on('GET /users/me', { body: { data: { accountSlug: 'home-x7f2' } } });
  const home = makeAuthedHome();
  const dir = makeProjectDir({ accountSlug: 'acme', apiBase: mock.apiBase });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'status', '--json'], { env: { HOME: home }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.auth.probe, 'mismatch');
  assert.equal(json.auth.account, 'home-x7f2');
  assert.equal(json.auth.valid, true);
  assert.ok(json.auth.email);
  assert.equal(json.project.account, 'acme');
});

test('gipity status --json still reports "rejected" (not mismatch) when the server 401s', async () => {
  mock.reset();
  mock.on('GET /users/me', { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Session expired' } } });
  mock.on('POST /auth/refresh', { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Refresh token rejected' } } });
  const home = makeAuthedHome();
  const dir = makeProjectDir({ accountSlug: 'acme', apiBase: mock.apiBase });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'status', '--json'], { env: { HOME: home }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.auth.probe, 'rejected');
  assert.equal(json.auth.account, null);
});

test('gipity status shows the API host actually in use when GIPITY_API_BASE overrides the project config', async () => {
  mock.reset();
  mock.on('GET /users/me', { body: { data: { accountSlug: 'acme' } } });
  const home = makeAuthedHome();
  // config.apiBase deliberately differs from the mock; GIPITY_API_BASE (not
  // --api-base) is what actually redirects every request to the mock.
  const dir = makeProjectDir({ accountSlug: 'acme', apiBase: 'https://a.gipity.ai' });

  const r = await runCliAsync(['status'], { env: { HOME: home, GIPITY_API_BASE: mock.apiBase }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /API \(in use\)/);
  assert.match(r.stdout, new RegExp(mock.apiBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('gipity status --json includes apiBaseInUse alongside the recorded apiBase', async () => {
  mock.reset();
  mock.on('GET /users/me', { body: { data: { accountSlug: 'acme' } } });
  const home = makeAuthedHome();
  const dir = makeProjectDir({ accountSlug: 'acme', apiBase: 'https://a.gipity.ai' });

  const r = await runCliAsync(['status', '--json'], { env: { HOME: home, GIPITY_API_BASE: mock.apiBase }, cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.project.apiBase, 'https://a.gipity.ai');
  assert.equal(json.project.apiBaseInUse, mock.apiBase);
});
