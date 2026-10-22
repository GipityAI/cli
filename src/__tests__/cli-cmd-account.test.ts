/**
 * `gipity account nsfw status|on|off`. Mocked API; subprocess spawn. Covers the
 * terms + confirmation on `on`, the non-interactive refusal without --yes, the
 * JSON shapes, and a server refusal surfacing as a non-zero exit.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

const OFF = { allow_nsfw_services: false, nsfw_attested_at: null, self_serve_open: true };
const ON = { allow_nsfw_services: true, nsfw_attested_at: '2026-10-22T16:00:00.000Z', self_serve_open: true };

before(async () => {
  mock = await startMockServer();
  home = makeAuthedHome();
});

after(async () => {
  await mock.stop();
});

const cli = (args: string[]) => runCliAsync(['--api-base', mock.apiBase, 'account', 'nsfw', ...args], { env: { HOME: home } });

test('gipity account nsfw (status is the default) shows off, and "not open yet" when self-serve is closed', async () => {
  mock.reset();
  mock.on('GET /users/me/nsfw', { body: { data: { ...OFF, self_serve_open: false } } });
  const r = await cli([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /NSFW services:\s*off/);
  assert.match(r.stdout, /Not open for self-serve yet/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity account nsfw status --json prints the state', async () => {
  mock.reset();
  mock.on('GET /users/me/nsfw', { body: { data: ON } });
  const r = await cli(['status', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ON);
});

test('gipity account nsfw on --yes shows the terms, PATCHes with the attestation, and says payments stop', async () => {
  mock.reset();
  mock.on('PATCH /users/me/nsfw', { body: { data: ON } });
  const r = await cli(['on', '--yes']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /18 or older/);
  assert.match(r.stdout, /Stripe Connect\) stop working/);
  assert.match(r.stdout, /NSFW services:\s*on/);
  const req = mock.requests().find((q) => q.method === 'PATCH');
  assert.deepEqual(req?.body, { allow: true, attest: true });
});

test('gipity account nsfw on without --yes, non-interactive, refuses and sends nothing', async () => {
  mock.reset();
  mock.on('PATCH /users/me/nsfw', { body: { data: ON } });
  const r = await cli(['on']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--yes/);
  assert.equal(mock.requests().filter((q) => q.method === 'PATCH').length, 0);
});

test('gipity account nsfw on surfaces a server refusal (Stripe conflict) with a non-zero exit', async () => {
  mock.reset();
  mock.on('PATCH /users/me/nsfw', { status: 409, body: { error: { code: 'NSFW_STRIPE_CONFLICT', message: "NSFW services can't be turned on while an app takes payments through Stripe. Disconnect payments first on: shop." } } });
  const r = await cli(['on', '--yes']);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /Disconnect payments first on: shop/);
});

test('gipity account nsfw off --json PATCHes allow=false', async () => {
  mock.reset();
  mock.on('PATCH /users/me/nsfw', { body: { data: { ...ON, allow_nsfw_services: false } } });
  const r = await cli(['off', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).allow_nsfw_services, false);
  assert.deepEqual(mock.requests().find((q) => q.method === 'PATCH')?.body, { allow: false });
});
