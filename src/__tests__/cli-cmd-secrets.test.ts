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

const meta = { name: 'WEBHOOK_TOKEN', preview: 'x9Qz', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z' };

// Values are write-only (platform#500): `get` must never leave something on
// stdout that a `$(...)` capture could mistake for the value.
test('gipity secrets get says values are write-only, prints nothing to stdout, exits 1', async () => {
  mock.reset();
  mock.on('GET /secrets', { body: { data: [meta] } });
  const r = await fresh(['secrets', 'get', 'WEBHOOK_TOKEN']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), '');
  assert.match(r.stderr, /write-only/);
  assert.match(r.stderr, /'WEBHOOK_TOKEN' exists \(ends in \.\.\.x9Qz\)/);
  assert.match(r.stderr, /secrets\.get\('WEBHOOK_TOKEN'\)/);
  assert.match(r.stderr, /gipity secrets set WEBHOOK_TOKEN "\$TOK"/);
  const req = mock.requests().find(q => q.method === 'GET' && q.url.startsWith('/secrets'));
  assert.ok(req, 'expected a list request');
  assert.match(req!.url, /scope=project&app_guid=p_TestProj/);
});

test('gipity secrets get --json returns a JSON error, not a value', async () => {
  mock.reset();
  mock.on('GET /secrets', { body: { data: [meta] } });
  const r = await fresh(['secrets', 'get', 'WEBHOOK_TOKEN', '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout.trim());
  assert.match(out.error.message, /write-only/);
});

test('gipity secrets get on a missing name says so and how to set it', async () => {
  mock.reset();
  mock.on('GET /secrets', { body: { data: [] } });
  const r = await fresh(['secrets', 'get', 'NOPE']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No project secret named 'NOPE'/);
  assert.match(r.stderr, /gipity secrets set NOPE VALUE/);
});
