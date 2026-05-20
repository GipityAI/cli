import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

const FREE_PLAN = {
  shortGuid: 'pln_freeplan',
  tier: 'free',
  displayName: 'Free',
  monthlyPriceUsd: 0,
  monthlyCredits: 0,
  creditExpiryDays: 0,
  stripePriceId: null,
  limits: { maxDatabases: 3, storageQuotaBytes: 1073741824, maxWorkflows: 2, minCronIntervalHours: 24, maxConcurrentChats: 1, deployRatePerMinute: 5 },
};
const PRO_PLAN = {
  shortGuid: 'pln_proplan2',
  tier: 'pro',
  displayName: 'Pro',
  monthlyPriceUsd: 20,
  monthlyCredits: 20000,
  creditExpiryDays: 31,
  stripePriceId: 'price_test_pro',
  limits: { maxDatabases: 25, storageQuotaBytes: 10737418240, maxWorkflows: 50, minCronIntervalHours: 0, maxConcurrentChats: 3, deployRatePerMinute: 10 },
};

before(async () => {
  mock = await startMockServer();
  home = makeAuthedHome();
});

after(async () => {
  await mock.stop();
});

test('gipity plan shows current plan name, price, credits, and limits', async () => {
  mock.reset();
  mock.on('GET /users/me/limits', { body: { data: {
    tier: 'pro',
    planAppliedAt: '2026-05-01T00:00:00Z',
    limits: PRO_PLAN.limits,
  } } });
  mock.on('GET /plans', { body: { data: [FREE_PLAN, PRO_PLAN] } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'plan'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan:.*Pro.*pro/);
  assert.match(r.stdout, /\$20\/mo/);
  assert.match(r.stdout, /20,000 credits\/mo/);
  assert.match(r.stdout, /Databases\s+25/);
  assert.match(r.stdout, /10\.0 GB/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity plan list shows all plans with limits + marks the current one', async () => {
  mock.reset();
  mock.on('GET /plans', { body: { data: [FREE_PLAN, PRO_PLAN] } });
  mock.on('GET /users/me/limits', { body: { data: {
    tier: 'free',
    planAppliedAt: '2026-05-01T00:00:00Z',
    limits: FREE_PLAN.limits,
  } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'plan', 'list'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Free.*free.*Free/); // current marker + name + price label
  assert.match(r.stdout, /Pro.*pro.*\$20\/mo/);
  assert.match(r.stdout, /Databases\s+3/);
  assert.match(r.stdout, /Databases\s+25/);
  assert.match(r.stdout, /current plan/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity plan --json emits raw API data', async () => {
  mock.reset();
  mock.on('GET /users/me/limits', { body: { data: {
    tier: 'free', planAppliedAt: null, limits: FREE_PLAN.limits,
  } } });
  mock.on('GET /plans', { body: { data: [FREE_PLAN, PRO_PLAN] } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'plan', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.user.tier, 'free');
  assert.equal(parsed.plans.length, 2);
});
