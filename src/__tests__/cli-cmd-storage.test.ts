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

const RETENTION = {
  days: 3, count: 10, maxDays: 30, maxCount: 50, customDays: true, customCount: false,
};

test('gipity storage retention (no args) views effective values + plan cap', async () => {
  mock.reset();
  mock.on('GET /users/me/retention', { body: { data: RETENTION } });
  const r = await fresh(['storage', 'retention']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /3 days/);
  assert.match(r.stdout, /10 copies/);
  assert.match(r.stdout, /up to 30 days \/ 50 copies/);
  // customDays=true, customCount=false → each is annotated distinctly.
  assert.match(r.stdout, /days: custom, copies: plan default/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity storage retention --json prints the raw data object', async () => {
  mock.reset();
  mock.on('GET /users/me/retention', { body: { data: RETENTION } });
  const r = await fresh(['storage', 'retention', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.deepEqual(parsed, RETENTION);
});

test('gipity storage retention --days --count PATCHes both values', async () => {
  mock.reset();
  mock.on('PATCH /users/me/retention', { body: { data: {
    ...RETENTION, days: 5, count: 20, customDays: true, customCount: true,
  } } });
  const r = await fresh(['storage', 'retention', '--days', '5', '--count', '20']);
  assert.equal(r.status, 0, r.stderr);
  const sent = mock.requests().find(x => x.method === 'PATCH');
  assert.ok(sent, 'expected a PATCH request');
  assert.deepEqual(sent!.body, { days: 5, count: 20 });
  assert.match(r.stdout, /updated/);
  assert.match(r.stdout, /5 days/);
  assert.match(r.stdout, /20 copies/);
});

test('gipity storage retention --days only sends just that field', async () => {
  mock.reset();
  mock.on('PATCH /users/me/retention', { body: { data: { ...RETENTION, days: 7, customDays: true } } });
  const r = await fresh(['storage', 'retention', '--days', '7']);
  assert.equal(r.status, 0, r.stderr);
  const sent = mock.requests().find(x => x.method === 'PATCH');
  assert.deepEqual(sent!.body, { days: 7 });
});

test('gipity storage retention --reset PATCHes nulls for both fields', async () => {
  mock.reset();
  mock.on('PATCH /users/me/retention', { body: { data: {
    ...RETENTION, days: 30, count: 50, customDays: false, customCount: false,
  } } });
  const r = await fresh(['storage', 'retention', '--reset']);
  assert.equal(r.status, 0, r.stderr);
  const sent = mock.requests().find(x => x.method === 'PATCH');
  assert.deepEqual(sent!.body, { days: null, count: null });
  assert.match(r.stdout, /30 days/);
  assert.match(r.stdout, /plan default/);
});

test('gipity storage retention rejects a non-positive value locally (no request)', async () => {
  mock.reset();
  mock.on('PATCH /users/me/retention', { body: { data: RETENTION } });
  const r = await fresh(['storage', 'retention', '--days', '0']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--days must be a positive whole number/);
  assert.equal(mock.requests().filter(x => x.method === 'PATCH').length, 0);
});

test('gipity storage retention surfaces a server 400 (value over cap)', async () => {
  mock.reset();
  mock.on('PATCH /users/me/retention', { status: 400, body: { error: {
    code: 'INVALID_RETENTION', message: 'days must be between 1 and 30 (your plan cap)',
  } } });
  const r = await fresh(['storage', 'retention', '--days', '999']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /days must be between 1 and 30/);
});
