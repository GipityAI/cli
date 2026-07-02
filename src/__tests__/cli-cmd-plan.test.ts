/**
 * `plan` is an alias of the consolidated `credits` command (the one plan +
 * credits + purchase hub). These tests lock in that the old name still resolves
 * - `plan` for the hub, `plan list` for the comparison - so nobody's muscle
 * memory / docs break.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

const PRO_LIMITS = {
  maxProjects: 1000, maxDatabases: 25, storageQuotaBytes: 10737418240, maxWorkflows: 50,
  minCronIntervalHours: 0, maxConcurrentChats: 3, deployRatePerMinute: 10, testFileConcurrency: 4,
  serviceLimits: { video: -1, music: -1, image: -1, audio: -1 },
};
const FREE_PLAN = {
  shortGuid: 'pln_freeplan', tier: 'free', displayName: 'Free', monthlyPriceUsd: 0,
  monthlyCredits: 0, creditExpiryDays: 0, stripePriceId: null,
  limits: { maxDatabases: 3, storageQuotaBytes: 1073741824, maxWorkflows: 2, minCronIntervalHours: 24, maxConcurrentChats: 1, deployRatePerMinute: 5 },
};
const PRO_PLAN = {
  shortGuid: 'pln_proplan2', tier: 'pro', displayName: 'Pro', monthlyPriceUsd: 20,
  monthlyCredits: 20000, creditExpiryDays: 31, stripePriceId: 'price_test_pro', limits: PRO_LIMITS,
};

before(async () => {
  mock = await startMockServer();
  home = makeAuthedHome();
});

after(async () => {
  await mock.stop();
});

test('gipity plan (alias) resolves to the credits hub: plan + limits', async () => {
  mock.reset();
  mock.on('GET /credits/balance', { body: { data: { available: 500, bySource: { subscription: 500, purchase: 0, bonus: 0 }, balances: [] } } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'pro', status: 'active' } } });
  mock.on('GET /users/me/limits', { body: { data: { tier: 'pro', planAppliedAt: '2026-05-01T00:00:00Z', limits: PRO_LIMITS } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'plan'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan:\s*Gipity Pro/);
  assert.match(r.stdout, /Databases\s+25/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity plan list (alias) resolves to the credits comparison view', async () => {
  mock.reset();
  mock.on('GET /plans', { body: { data: [FREE_PLAN, PRO_PLAN] } });
  mock.on('GET /credits/products', { body: { data: [] } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'free', status: 'active' } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'plan', 'list'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Databases\s+3/);
  assert.match(r.stdout, /Databases\s+25/);
  assert.match(r.stdout, /current plan/);
  assert.doesNotMatch(r.stdout, /undefined/);
});
