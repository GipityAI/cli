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

const GB = 1024 ** 3;

// 3 GB billed against a 5 GB quota: under quota, with history and dedup in play.
const USAGE = {
  quotaBytes: 5 * GB,
  usedBytes: 3 * GB,
  storage: {
    liveBytes: 2 * GB, liveFiles: 1203,
    physicalBytes: 3 * GB, storedObjects: 900,
    versionedBytes: 4 * GB, versionCount: 3400,
    dedupSavedBytes: 1 * GB, dedupedObjects: 120,
  },
  versionRetention: { days: 3, count: 10, maxDays: 30, maxCount: 50 },
  projects: [
    { projectShortGuid: 'p_aaa', projectName: 'my-app', liveBytes: 1.5 * GB, liveFiles: 800 },
    { projectShortGuid: null, projectName: null, liveBytes: 0.5 * GB, liveFiles: 403 },
  ],
};

test('gipity storage usage shows the billed figure, the live/versions/dedup split, and projects', async () => {
  mock.reset();
  mock.on('GET /users/me/storage', { body: { data: USAGE } });
  const r = await fresh(['storage', 'usage']);
  assert.equal(r.status, 0, r.stderr);
  // Billed usage against the quota, with a percentage.
  assert.match(r.stdout, /3\.00 GB of 5\.00 GB used \(60%\)/);
  // The versions-vs-live split the user needs to explain the bill.
  assert.match(r.stdout, /Live files\s+2\.00 GB\s+1,203 files/);
  assert.match(r.stdout, /All versions\s+4\.00 GB\s+3,400 versions/);
  assert.match(r.stdout, /Dedup saved\s+1\.00 GB/);
  assert.match(r.stdout, /Billed\s+3\.00 GB/);
  // Per-project attribution, including files that belong to no project.
  assert.match(r.stdout, /my-app\s+1\.50 GB\s+800 files/);
  assert.match(r.stdout, /\(no project\)\s+512\.0 MB\s+403 files/);
  assert.match(r.stdout, /Version retention: 3 days \/ 10 copies/);
  // Under quota: no "over quota" nag.
  assert.doesNotMatch(r.stdout, /Over quota/);
  assert.doesNotMatch(r.stdout, /undefined|NaN/);
});

test('gipity storage usage flags an over-quota account and points at freeing space', async () => {
  mock.reset();
  mock.on('GET /users/me/storage', { body: { data: {
    ...USAGE, usedBytes: 6 * GB, storage: { ...USAGE.storage, physicalBytes: 6 * GB },
  } } });
  const r = await fresh(['storage', 'usage']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /6\.00 GB of 5\.00 GB used \(120%\)/);
  assert.match(r.stdout, /Over quota/);
  // The remedy that actually works on every plan - never a bare upgrade nudge.
  assert.match(r.stdout, /storage retention/);
  assert.doesNotMatch(r.stdout, /credits buy/);
});

test('gipity storage usage --json prints the raw data object', async () => {
  mock.reset();
  mock.on('GET /users/me/storage', { body: { data: USAGE } });
  const r = await fresh(['storage', 'usage', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), USAGE);
});

test('gipity storage usage renders an empty account without a project section', async () => {
  mock.reset();
  mock.on('GET /users/me/storage', { body: { data: {
    quotaBytes: 5 * GB,
    usedBytes: 0,
    storage: {
      liveBytes: 0, liveFiles: 0, physicalBytes: 0, storedObjects: 0,
      versionedBytes: 0, versionCount: 0, dedupSavedBytes: 0, dedupedObjects: 0,
    },
    versionRetention: { days: 3, count: 10, maxDays: 30, maxCount: 50 },
    projects: [],
  } } });
  const r = await fresh(['storage', 'usage']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 B of 5\.00 GB used \(0%\)/);
  assert.doesNotMatch(r.stdout, /By project/);
  assert.doesNotMatch(r.stdout, /undefined|NaN/);
});

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
