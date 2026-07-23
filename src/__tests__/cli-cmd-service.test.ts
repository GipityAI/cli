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

test('gipity service list shows the service catalog', async () => {
  mock.reset();
  const r = await fresh(['service', 'list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /llm/);
  assert.match(r.stdout, /image/);
  assert.match(r.stdout, /music/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity service call <name> [body] POSTs to /services/<name> and prints the raw response', async () => {
  mock.reset();
  // Service responses are NOT wrapped in { data } - the whole body is printed.
  mock.on('POST /api/p_TestProj/services/llm', { body: { choices: [{ message: { content: 'ok' } }] } });
  const r = await fresh(['service', 'call', 'llm', '{"prompt":"hi"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /choices/);
  assert.match(r.stdout, /ok/);
  assert.doesNotMatch(r.stdout, /undefined/);
});

test('gipity service call preserves subpaths (location/geocode)', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/location/geocode', { body: { city: 'Portland' } });
  const r = await fresh(['service', 'call', 'location/geocode', '{"lat":45.5,"lon":-122.6}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Portland/);
});

test('gipity service call --get issues a GET (listing endpoints)', async () => {
  mock.reset();
  mock.on('GET /api/p_TestProj/services/llm/models', { body: { data: { models: [{ id: 'claude-sonnet-4-6' }] } } });
  const r = await fresh(['service', 'call', 'llm/models', '--get']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude-sonnet-4-6/);
});

// ── the anonymous visitor path ────────────────────────────────────────────────
// An owner-authenticated service call succeeds no matter what billing_mode the
// app declares, so it proves nothing about the signed-out visitors a public page
// actually serves. --anon calls the same endpoint with the visitor's app token,
// which is the only way to see the user_pays 401 before a real customer does.

test('gipity service call --anon mints a visitor token and calls the public path', async () => {
  mock.reset();
  mock.on('POST /api/token', { body: { data: { token: 'app_tok_1' } } });
  mock.on('POST /api/p_TestProj/services/llm', { body: { choices: [{ message: { content: 'we close at 2pm' } }] } });
  const r = await fresh(['service', 'call', 'llm', '{"prompt":"closing time?"}', '--anon']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /we close at 2pm/);
  // Identity is named on stderr so a "the service works" check can't quietly be
  // the owner persona.
  assert.match(r.stderr, /anonymous visitor/);
  // The visitor token is minted first, then spent on the service call.
  const urls = mock.requests().map((q) => q.url);
  assert.ok(urls.includes('/api/token'), 'expected a visitor token to be minted');
  assert.ok(urls.includes('/api/p_TestProj/services/llm'), 'expected the service to be called');
});

test('gipity service call names the owner persona (and points at --anon) by default', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/llm', { body: { choices: [] } });
  const r = await fresh(['service', 'call', 'llm', '{"prompt":"hi"}']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /owner persona/);
  assert.match(r.stderr, /--anon/);
});

test('gipity service call --anon turns a LOGIN_REQUIRED 401 into the billing_mode fix', async () => {
  mock.reset();
  mock.on('POST /api/token', { body: { data: { token: 'app_tok_1' } } });
  mock.on('POST /api/p_TestProj/services/llm', {
    status: 401,
    body: { error: { code: 'LOGIN_REQUIRED', message: 'Please log in to use this feature' } },
  });
  const r = await fresh(['service', 'call', 'llm', '{"prompt":"hi"}', '--anon']);
  assert.notEqual(r.status, 0);
  const out = r.stdout + r.stderr;
  assert.match(out, /user_pays/);
  assert.match(out, /billing_mode: owner_pays/);
  assert.match(out, /gipity\.yaml/);
});

test('gipity service call -d and --field work like fn call', async () => {
  mock.reset();
  mock.on('POST /api/p_TestProj/services/llm', { body: { choices: [{ message: { content: 'hello' } }] } });
  const r = await fresh(['service', 'call', 'llm', '-d', '{"prompt":"hi"}', '--field', 'choices.0.message.content']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'hello');
});
