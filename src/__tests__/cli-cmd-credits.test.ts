/**
 * Happy-path tests for `gipity credits` + subcommands (the consolidated plan +
 * credits + purchase hub). Mocked API; subprocess spawn. Every test asserts:
 * exit 0, expected substring present, no "undefined" in stdout (universal canary
 * for field-name drift).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

const FREE_LIMITS = {
  maxProjects: 10, maxDatabases: 3, storageQuotaBytes: 1073741824, maxWorkflows: 2,
  minCronIntervalHours: 24, maxConcurrentChats: 1, deployRatePerMinute: 5, testFileConcurrency: 2,
  serviceLimits: { video: 0, music: 0, image: 3, audio: 3 },
};
const PRO_LIMITS = {
  maxProjects: 1000, maxDatabases: 25, storageQuotaBytes: 10737418240, maxWorkflows: 50,
  minCronIntervalHours: 0, maxConcurrentChats: 3, deployRatePerMinute: 10, testFileConcurrency: 4,
  serviceLimits: { video: -1, music: -1, image: -1, audio: -1 },
};
const FREE_PLAN = {
  shortGuid: 'pln_freeplan', tier: 'free', displayName: 'Free', monthlyPriceUsd: 0,
  monthlyCredits: 0, creditExpiryDays: 0, stripePriceId: null, limits: FREE_LIMITS,
};
const PRO_PLAN = {
  shortGuid: 'pln_proplan2', tier: 'pro', displayName: 'Pro', monthlyPriceUsd: 20,
  monthlyCredits: 20000, creditExpiryDays: 31, stripePriceId: 'price_test_pro', limits: PRO_LIMITS,
};
const PACK = { priceId: 'price_pack_20k', type: 'one_time', name: '20,000 Credits', amountUsd: 20, credits: 20000 };

before(async () => {
  mock = await startMockServer();
  home = makeAuthedHome();
});

after(async () => {
  await mock.stop();
});

test('gipity credits prints plan, balance breakdown, and full limits', async () => {
  mock.reset();
  mock.on('GET /credits/balance', { body: { data: {
    available: 500,
    bySource: { subscription: 200, purchase: 0, bonus: 300 },
    balances: [{ source: 'bonus', creditsRemaining: 300, expiresAt: '2026-12-01T00:00:00Z' }],
  } } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'pro', status: 'active' } } });
  mock.on('GET /users/me/limits', { body: { data: { tier: 'pro', planAppliedAt: '2026-05-01T00:00:00Z', limits: PRO_LIMITS } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits'], { env: { HOME: home } });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /Plan:\s*Gipity Pro\s*\(active\)/);
  assert.match(r.stdout, /Credits:\s*500/);
  assert.match(r.stdout, /bonus:\s*300/);
  assert.match(r.stdout, /Projects\s+1,000/);
  assert.match(r.stdout, /Databases\s+25/);
  assert.match(r.stdout, /10\.0 GB/);
  assert.match(r.stdout, /Video generation\s+unlimited/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity credits shows Free plan + an upgrade nudge for a non-pro user', async () => {
  mock.reset();
  mock.on('GET /credits/balance', { body: { data: {
    available: 1000, bySource: { subscription: 0, purchase: 0, bonus: 1000 }, balances: [],
  } } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'free', status: 'active' } } });
  mock.on('GET /users/me/limits', { body: { data: { tier: 'free', planAppliedAt: null, limits: FREE_LIMITS } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan:\s*Free\s*\(active\)/);
  assert.match(r.stdout, /Image generation\s+3\/mo free/);
  assert.match(r.stdout, /gipity credits buy/); // upgrade nudge
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity credits --json emits subscription + balance + limits', async () => {
  mock.reset();
  mock.on('GET /credits/balance', { body: { data: { available: 42, bySource: { subscription: 42, purchase: 0, bonus: 0 }, balances: [] } } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'pro', status: 'active' } } });
  mock.on('GET /users/me/limits', { body: { data: { tier: 'pro', planAppliedAt: null, limits: PRO_LIMITS } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.balance.available, 42);
  assert.equal(parsed.subscription.tier, 'pro');
  assert.equal(parsed.limits.limits.maxDatabases, 25);
});

test('gipity credits list compares every plan (with limits) + credit packs, marks current', async () => {
  mock.reset();
  mock.on('GET /plans', { body: { data: [FREE_PLAN, PRO_PLAN] } });
  mock.on('GET /credits/products', { body: { data: [
    { priceId: 'price_test_pro', type: 'subscription', name: 'Pro', amountUsd: 20, credits: 20000, available: false },
    { ...PACK, available: true },
  ] } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'pro', status: 'active' } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'list'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Databases\s+3/);
  assert.match(r.stdout, /Databases\s+25/);
  assert.match(r.stdout, /Credit packs/);
  assert.match(r.stdout, /20,000 Credits/);
  assert.match(r.stdout, /current plan/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity credits buy prints a Stripe checkout link for the upgrade', async () => {
  mock.reset();
  mock.on('GET /credits/products', { body: { data: [
    { priceId: 'price_test_pro', type: 'subscription', name: 'Pro', amountUsd: 20, credits: 20000, available: true },
  ] } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'free', status: 'active' } } });
  mock.on('POST /credits/purchase', { body: { data: {
    checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_123', sessionId: 'cs_test_123', creditsRequested: 20000, amountUsd: 20,
  } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'buy'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Upgrading to\s.*Pro/);
  assert.match(r.stdout, /https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_123/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity credits list --json emits JSON, not the human table (parent/child --json collision)', async () => {
  mock.reset();
  mock.on('GET /plans', { body: { data: [FREE_PLAN, PRO_PLAN] } });
  mock.on('GET /credits/products', { body: { data: [
    { priceId: 'price_test_pro', type: 'subscription', name: 'Pro', amountUsd: 20, credits: 20000, available: false },
    { ...PACK, available: true },
  ] } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'pro', status: 'active' } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'list', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.currentTier, 'pro');
  assert.equal(parsed.plans.length, 2);
  assert.ok(Array.isArray(parsed.products));
});

test('gipity credits buy 20000 (as a Pro user) buys the PACK, not the Pro subscription', async () => {
  // Pro's monthly_credits (20,000) equals the 20k pack's credits - the resolver
  // must not match the subscription by that number for a pack request.
  mock.reset();
  mock.on('GET /credits/products', { body: { data: [
    { priceId: 'price_test_pro', type: 'subscription', name: 'Pro', amountUsd: 20, credits: 20000, available: false },
    { priceId: 'price_pack_20k', type: 'one_time', name: '20,000 Credits', amountUsd: 20, credits: 20000, available: true },
  ] } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'pro', status: 'active' } } });
  mock.on('POST /credits/purchase', { body: { data: {
    checkoutUrl: 'https://checkout.stripe.com/pack', sessionId: 's', creditsRequested: 20000, amountUsd: 20,
  } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'buy', '20000', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  // Must resolve to the pack (its checkout), not dead-end on "already on Pro".
  assert.equal(parsed.checkoutUrl, 'https://checkout.stripe.com/pack');
  assert.equal(parsed.product, '20,000 Credits');
});

test('gipity credits buy --json emits a JSON error (not prose) on a non-happy path', async () => {
  mock.reset();
  mock.on('GET /credits/products', { body: { data: [
    { priceId: 'price_test_pro', type: 'subscription', name: 'Pro', amountUsd: 20, credits: 20000, available: true },
  ] } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'free', status: 'active' } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'buy', 'bogus', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim()); // must be valid JSON, not "Unknown option..."
  assert.match(parsed.error, /Unknown option/);
});

test('gipity credits buy --json emits the checkout URL', async () => {
  mock.reset();
  mock.on('GET /credits/products', { body: { data: [
    { priceId: 'price_test_pro', type: 'subscription', name: 'Pro', amountUsd: 20, credits: 20000, available: true },
  ] } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'free', status: 'active' } } });
  mock.on('POST /credits/purchase', { body: { data: { checkoutUrl: 'https://checkout.stripe.com/x', sessionId: 's', creditsRequested: 20000, amountUsd: 20 } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'buy', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.checkoutUrl, 'https://checkout.stripe.com/x');
});

test('gipity credits buy --open exits cleanly when no browser launcher is available', async () => {
  // Empty PATH so the browser-launcher spawn (xdg-open / open) fails to resolve,
  // reproducing the WSL/minimal-Linux case where it errors ASYNCHRONOUSLY. The CLI
  // must swallow that 'error' event and still exit 0 - previously an unhandled
  // 'error' event crashed the process with a node:events stack trace.
  mock.reset();
  mock.on('GET /credits/products', { body: { data: [
    { priceId: 'price_test_pro', type: 'subscription', name: 'Pro', amountUsd: 20, credits: 20000, available: true },
  ] } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'free', status: 'active' } } });
  mock.on('POST /credits/purchase', { body: { data: { checkoutUrl: 'https://checkout.stripe.com/x', sessionId: 's', creditsRequested: 20000, amountUsd: 20 } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'buy', '--open'], { env: { HOME: home, PATH: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /checkout\.stripe\.com/);
  assert.doesNotMatch(r.stderr, /Unhandled 'error' event|node:events/);
});

test('gipity credits manage prints the Stripe billing portal link', async () => {
  mock.reset();
  mock.on('POST /credits/portal', { body: { data: { portalUrl: 'https://billing.stripe.com/p/session/bps_test' } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'manage'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /https:\/\/billing\.stripe\.com\/p\/session\/bps_test/);
  assert.match(r.stdout, /cancel/i);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity credits manage --json emits the portal URL', async () => {
  mock.reset();
  mock.on('POST /credits/portal', { body: { data: { portalUrl: 'https://billing.stripe.com/p/session/bps_test' } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'manage', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.portalUrl, 'https://billing.stripe.com/p/session/bps_test');
});

test('gipity credits manage --json falls back to the pricing page on an API error', async () => {
  // e.g. a free user with no billing account: the server 400s; the CLI must
  // emit parseable JSON with a fallback URL, not prose or a crash.
  mock.reset();
  mock.on('POST /credits/portal', { status: 400, body: {
    error: { code: 'VALIDATION_ERROR', message: "No billing account found - you haven't purchased anything yet." },
  } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'manage', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.match(parsed.error, /billing account/i);
  assert.equal(parsed.portalUrl, null);
  assert.match(parsed.fallbackUrl, /pricing/);
});

test('gipity credits usage shows recent operations with credits and timestamps', async () => {
  mock.reset();
  mock.on('GET /credits/usage', { body: { data: [
    { operation: 'llm_chat', creditsDeducted: 12, costUsd: 0.012, modelId: 'claude-sonnet-4-6', createdAt: '2026-05-01T10:00:00Z' },
    { operation: 'image_gen', creditsDeducted: 50, costUsd: 0.05, modelId: 'gpt-image-2', createdAt: '2026-05-01T11:00:00Z' },
  ] } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'usage'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /llm_chat/);
  assert.match(r.stdout, /-12/);
  assert.match(r.stdout, /image_gen/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity credits usage prints empty-history message when no rows', async () => {
  mock.reset();
  mock.on('GET /credits/usage', { body: { data: [] } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'usage'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No usage history/);
});

test('gipity credits usage --json emits raw entries (parent/child --json collision fixed)', async () => {
  mock.reset();
  mock.on('GET /credits/usage', { body: { data: [
    { operation: 'llm_chat', creditsDeducted: 12, costUsd: 0.012, modelId: 'claude-sonnet-4-6', createdAt: '2026-05-01T10:00:00Z' },
  ] } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', 'usage', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed[0].operation, 'llm_chat');
});
