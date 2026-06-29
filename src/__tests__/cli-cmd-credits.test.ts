/**
 * Happy-path tests for `gipity credits` + subcommands. Mocked API; subprocess
 * spawn. Every test asserts: exit 0, expected substring present, no
 * "undefined" in stdout (universal canary for field-name drift).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runCliAsync } from './helpers/spawn-cli.js';
import { startMockServer, MockServer } from './helpers/mock-server.js';
import { makeAuthedHome } from './helpers/test-home.js';

let mock: MockServer;
let home: string;

before(async () => {
  mock = await startMockServer();
  home = makeAuthedHome();
});

after(async () => {
  await mock.stop();
});

test('gipity credits prints plan, available balance + per-source breakdown', async () => {
  mock.reset();
  mock.on('GET /credits/balance', { body: { data: {
    available: 500,
    bySource: { subscription: 200, purchase: 0, bonus: 300 },
    balances: [{ source: 'bonus', creditsRemaining: 300, creditsGranted: 300, creditsUsed: 0, expiresAt: '2026-12-01T00:00:00Z', grantedAt: '2026-01-01T00:00:00Z' }],
  } } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'pro', status: 'active' } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits'], { env: { HOME: home } });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /Plan:\s*Gipity Pro\s*\(active\)/, `expected plan line; got:\n${r.stdout}`);
  assert.match(r.stdout, /Credits:\s*500/, `expected balance line; got:\n${r.stdout}`);
  assert.match(r.stdout, /bonus:\s*300/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity credits shows Free plan for a non-pro user', async () => {
  mock.reset();
  mock.on('GET /credits/balance', { body: { data: {
    available: 1000,
    bySource: { subscription: 0, purchase: 0, bonus: 1000 },
    balances: [],
  } } });
  mock.on('GET /credits/subscription', { body: { data: { tier: 'free', status: 'active' } } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Plan:\s*Free\s*\(active\)/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity credits --json emits raw API data', async () => {
  mock.reset();
  const payload = {
    available: 42,
    bySource: { subscription: 42, purchase: 0, bonus: 0 },
    balances: [],
  };
  mock.on('GET /credits/balance', { body: { data: payload } });

  const r = await runCliAsync(['--api-base', mock.apiBase, 'credits', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim());
  assert.equal(parsed.available, 42);
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

test('gipity credits buy exits cleanly when no browser launcher is available (no unhandled spawn error)', async () => {
  // Empty PATH so the browser-launcher spawn (xdg-open / open) fails to resolve,
  // reproducing the WSL/minimal-Linux case where it errors ASYNCHRONOUSLY. The CLI
  // must swallow that 'error' event and still exit 0 - previously this crashed the
  // process with an unhandled 'error' event and a node:events stack trace.
  const r = await runCliAsync(['credits', 'buy'], { env: { HOME: home, PATH: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Opening .*\/pricing/);
  assert.doesNotMatch(r.stderr, /Unhandled 'error' event|node:events/);
});
